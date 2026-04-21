// controller/complaintController.js  ✅ UPDATED for instituteId + departmentIds (INTEGER[])

const Complaint = require('../models/complaint');
const Staff = require('../models/staff');
const Department = require('../models/department');
const SubadminActivity = require('../models/subadminActivity');
const sequelize = require('../config/db');
const { Op } = require('sequelize');
const fs = require('fs');
const path = require('path');
const { buildTicketSubject, sendMail } = require('../utils/mailer');
const { buildTicketId } = require('../utils/ticketId');

// ---------------- helpers ----------------
const toInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};


const staffDeptIds = (staff) =>
  Array.isArray(staff?.departmentIds) ? staff.departmentIds : [];

const roleLower = (staff) => String(staff?.role || '').toLowerCase();

const isAdminLike = (staff) => ['superadmin', 'admin', 'subadmin'].includes(roleLower(staff));

const isDepartmentScopedRole = (staff) =>
  ['superadmin', 'admin', 'subadmin', 'engineer'].includes(roleLower(staff));

// Superadmin => allow all depts
const hasDeptAccess = (staff, deptId) => {
  if (!staff) return false;
  if (roleLower(staff) === 'superadmin') return true;
  const ids = staffDeptIds(staff).map(Number);
  return ids.includes(Number(deptId));
};

const fullNameOf = (s) =>
  `${s?.firstname || ''} ${s?.middlename || ''} ${s?.lastname || ''}`
    .replace(/\s+/g, ' ')
    .trim() || String(s?.id || '');

// ---------------- auth helper ----------------
const getCurrentStaff = async (req) => {
  const staffId = req.user?.id;
  if (!staffId) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }

  const staff = await Staff.findByPk(staffId);
  if (!staff) {
    const err = new Error(`Staff not found for id: ${staffId}`);
    err.statusCode = 404;
    throw err;
  }

  return staff;
};

const complaintAccessWhere = (staff) => {
  if (roleLower(staff) === 'superadmin') {
    return {};
  }

  const ownScope = [
    { staffId: staff.id },
    { assignStaffId: staff.id },
    { behalfId: staff.id },
  ];

  if (isDepartmentScopedRole(staff) && staffDeptIds(staff).length > 0) {
    ownScope.push({ departmentId: { [Op.in]: staffDeptIds(staff) } });
  }

  return { [Op.or]: ownScope };
};

const canViewComplaint = (staff, complaint) => {
  if (roleLower(staff) === 'superadmin') return true;
  if (complaint.staffId === staff.id || complaint.assignStaffId === staff.id || complaint.behalfId === staff.id) {
    return true;
  }

  return isDepartmentScopedRole(staff) && hasDeptAccess(staff, complaint.departmentId);
};

const generateComplaintTicketId = async (transaction) =>
  buildTicketId({
    model: Complaint,
    prefix: '#C',
    regex: /^#C(\d{4})(\d{3})$/,
    lockKey: 41001,
    transaction,
  });

const sendEmail = async (to, subject, html) => sendMail({ to, subject, html });

const notifyUsers = async (users, subject, html) => {
  const seen = new Set();
  const recipients = (users || []).filter((user) => {
    const email = String(user?.email || '').trim().toLowerCase();
    if (!email || seen.has(email)) return false;
    seen.add(email);
    return true;
  });

  await Promise.all(
    recipients.map((user) =>
      sendEmail(user.email, subject, html).catch((error) => {
        console.error(`Failed to send email to ${user.email}:`, error?.message || error);
      })
    )
  );
};

// ---------------- CREATE COMPLAINT ----------------
exports.createComplaint = async (req, res) => {
  try {
    const {
      staffId,
      behalf,
      behalfId,
      departmentId,
      departmentCategory,
      priority,
      subject,
      description,
      location,
      isRepeated,
    } = req.body;

    const deptId = toInt(departmentId);

    const behalfBool =
      behalf === true || behalf === 'true' || behalf === 1 || behalf === '1';

    const isRepeatedBool =
      isRepeated === true ||
      isRepeated === 'true' ||
      isRepeated === 1 ||
      isRepeated === '1';
    const status = 'Pending';

    if (!deptId || !subject || !description) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: departmentId, subject, description',
      });
    }

    const actor = await getCurrentStaff(req);
    const requestedStaffId = staffId ? toInt(staffId) : actor.id;

    if (!requestedStaffId) {
      return res.status(400).json({ success: false, message: `Invalid staffId: ${staffId}` });
    }

    if (requestedStaffId !== actor.id && !isAdminLike(actor)) {
      return res.status(403).json({
        success: false,
        message: 'You are not allowed to create complaints for another staff member.',
      });
    }

    let staff = actor;
    if (requestedStaffId !== actor.id) {
      staff = await Staff.findByPk(requestedStaffId);
      if (!staff) {
        return res.status(400).json({ success: false, message: `Invalid staffId: ${staffId}` });
      }
    }

    const targetDept = await Department.findByPk(deptId);
    if (!targetDept) {
      return res.status(400).json({
        success: false,
        message: `Invalid departmentId: ${deptId}`,
      });
    }
    const departmentName = targetDept.department;

    let behalfUser = null;
    if (behalfBool) {
      if (!isAdminLike(actor)) {
        return res.status(403).json({
          success: false,
          message: 'Only admin, subadmin, or superadmin can create complaints on behalf of another user.',
        });
      }

      if (!behalfId) {
        return res.status(400).json({
          success: false,
          message: 'behalf is true but behalfId is missing',
        });
      }
      behalfUser = await Staff.findByPk(behalfId);
      if (!behalfUser) {
        return res.status(400).json({
          success: false,
          message: `Invalid behalfId: ${behalfId}`,
        });
      }
    }

    // -------- attachments ----------
    let attachmentPaths = [];

    if (req.files && req.files.attachments) {
      const files = Array.isArray(req.files.attachments)
        ? req.files.attachments
        : [req.files.attachments];

      const allowedTypes = [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ];

      const uploadDir = path.join(__dirname, '..', 'uploads', 'complaints');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      for (const file of files) {
        if (!allowedTypes.includes(file.mimetype)) {
          return res.status(400).json({
            success: false,
            message:
              'Invalid file type. Only images and documents are allowed.',
          });
        }

        const ext = path.extname(file.name);
        const baseName = path.basename(file.name, ext);
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const finalFileName = `${baseName}-${unique}${ext}`;

        const savePath = path.join(uploadDir, finalFileName);
        await file.mv(savePath);

        attachmentPaths.push(`/uploads/complaints/${finalFileName}`);
      }
    }

    // -------- ticketId generation ----------
    const now = new Date();
    const year = now.getFullYear();
    const prefix = `#C${year}`;

    // ✅ only take last complaint of THIS YEAR
    const lastComplaint = await Complaint.findOne({
      where: {
        ticketId: { [Op.like]: `${prefix}%` },
      },
      order: [['createdAt', 'DESC'], ['id', 'DESC']],
    });

    let sequence = 1;

    if (lastComplaint?.ticketId) {
      // ✅ Extract last 3 digits from "#C2026001"
      const match = String(lastComplaint.ticketId).match(/^#C(\d{4})(\d{3})$/);

      if (match) {
        const lastYear = Number(match[1]);
        const lastSeq = Number(match[2]);

        if (lastYear === year && Number.isFinite(lastSeq)) {
          sequence = lastSeq + 1;
        }
      }
    }

    const counter = String(sequence).padStart(3, '0');
    const ticketId = `${prefix}${counter}`;


    // -------- create complaint ----------
    const newComplaint = await Complaint.create({
      ticketId,
      staffId: staff.id,
      behalf: behalfBool,
      behalfId: behalfBool ? behalfId : null,
      status,
      departmentId: deptId,
      departmentCategory,
      priority,
      subject,
      description,
      location,
      isRepeated: isRepeatedBool,
      attachments: attachmentPaths,
    });

    // -------- notify department staff ----------
    const isOtherDepartment = !hasDeptAccess(staff, deptId);

    if (isOtherDepartment) {
      let targetStaff = await Staff.findAll({
        where: {
          departmentIds: { [Op.contains]: [deptId] },
          role: { [Op.in]: ['admin', 'subadmin', 'engineer'] },
        },
        attributes: ['id', 'email', 'firstname', 'middlename', 'lastname', 'role'],
      });

      if (!Array.isArray(targetStaff)) targetStaff = [];

      if (targetStaff.length > 0) {
        const emailPromises = targetStaff.map(async (target) => {
          const targetName = fullNameOf(target) || target.role;
          const staffName = fullNameOf(staff);
          const behalfUserName = behalfUser ? fullNameOf(behalfUser) : '';
          const emailSubject = buildTicketSubject(ticketId, subject);
          const emailHtml = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Helpdesk Ticket Notification</title></head>
<body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff; border-radius: 5px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
    <div style="background-color: #DA251C; color: #ffffff; text-align: center; padding: 20px; border-top-left-radius: 5px; border-top-right-radius: 5px;">
      <h1 style="margin: 0; font-size: 24px;">MET Helpdesk</h1>
    </div>
    <div style="padding: 20px;">
      <h2 style="color: #0088cc; margin-top: 0;">Helpdesk Ticket Notification</h2>
      <p>Dear ${targetName},</p>
      <p>A new ticket has been generated and assigned to your department (${departmentName}) with the following details:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 10px 0;">
        <tr style="background-color: #f9f9f9;">
          <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Ticket ID:</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${ticketId}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Ticket Type:</td>
          <td style="padding: 8px; border: 1px solid #ddd;">Complaint</td>
        </tr>
        <tr style="background-color: #f9f9f9;">
          <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Department:</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${departmentName}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Category:</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${departmentCategory || ''}</td>
        </tr>
        <tr style="background-color: #f9f9f9;">
          <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Priority:</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${priority || ''}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Status:</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${status}</td>
        </tr>
        <tr style="background-color: #f9f9f9;">
          <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Subject:</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${subject}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Description:</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${description}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Location:</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${location || ''}</td>
        </tr>
        <tr style="background-color: #f9f9f9;">
          <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Raised by:</td>
          <td style="padding: 8px; border: 1px solid #ddd;">
            ${staffName}${behalfBool ? ` (on behalf of ${behalfUserName})` : ''}
          </td>
        </tr>
        ${isRepeatedBool
              ? `<tr style="background-color: #f9f9f9;">
                 <td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Repeated Complaint:</td>
                 <td style="padding: 8px; border: 1px solid #ddd;">Yes</td>
               </tr>`
              : ''
            }
      </table>
      <p style="margin-top: 20px;">Please log in to the helpdesk system to review and take necessary action.</p>
      <p>Best regards,<br><strong>The Helpdesk Team</strong></p>
    </div>
    <div style="text-align: center; padding: 10px; background-color: #f4f4f4; border-bottom-left-radius: 5px; border-bottom-right-radius: 5px; font-size: 12px; color: #666;">
      <p>This is an automated email. Please do not reply.</p>
    </div>
  </div>
</body>
</html>`;

          try {
            await sendEmail(target.email, emailSubject, emailHtml);
          } catch (emailError) {
            console.error(
              `Failed to send email to ${target.email}:`,
              emailError?.message || emailError
            );
          }
        });

        await Promise.all(emailPromises);
      } else {
        console.log(
          `No target staff found for departmentId "${deptId}" with roles admin/subadmin/engineer.`
        );
      }
    } else {
      console.log(
        `Not sending notifications: Complaint filed within staff's own departmentIds`
      );
    }

    const behalfUserName = behalfUser ? fullNameOf(behalfUser) : '';
    const requesterEmailSubject = buildTicketSubject(ticketId, subject);
    const requesterEmailHtml = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Complaint Created</title></head>
<body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff; border-radius: 5px;">
    <h2 style="color: #0088cc;">Complaint Created Successfully</h2>
    <p>Your complaint has been registered in the helpdesk system.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 10px 0;">
      <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Ticket ID</td><td style="padding: 8px; border: 1px solid #ddd;">${ticketId}</td></tr>
      <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Subject</td><td style="padding: 8px; border: 1px solid #ddd;">${subject}</td></tr>
      <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Department</td><td style="padding: 8px; border: 1px solid #ddd;">${departmentName}</td></tr>
      <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Status</td><td style="padding: 8px; border: 1px solid #ddd;">${status}</td></tr>
    </table>
    <p>Please use the same ticket ID for future communication so this request stays in one thread.</p>
    <p>Best regards,<br><strong>The Helpdesk Team</strong></p>
  </div>
</body>
</html>`;

    await notifyUsers([staff, behalfUser], requesterEmailSubject, requesterEmailHtml);

    return res.status(201).json({
      success: true,
      message: behalfBool
        ? `Complaint created successfully on behalf of ${behalfUserName}`
        : 'Complaint created successfully',
      data: newComplaint,
    });
  } catch (error) {
    console.error('Full error stack in createComplaint:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create complaint',
      error:
        process.env.NODE_ENV === 'development'
          ? error.message
          : 'Internal server error',
    });
  }
};

// ---------------- GET ALL ----------------
exports.getAllComplaints = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);
    const complaintData = await Complaint.findAll({
      where: complaintAccessWhere(staff),
      order: [['createdAt', 'DESC']],
    });

    return res.status(200).json({
      success: true,
      count: complaintData.length,
      data: complaintData,
    });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: 'Server error', error: error.message });
  }
};

// ---------------- GET BY ID ----------------
exports.getComplaintById = async (req, res) => {
  try {
    const { id } = req.params;
    const staff = await getCurrentStaff(req);

    const complaint = await Complaint.findByPk(id);

    if (!complaint) {
      return res.status(404).json({
        success: false,
        message: 'Complaint not found',
      });
    }

    if (!canViewComplaint(staff, complaint)) {
      return res.status(403).json({
        success: false,
        message: 'You are not allowed to view this complaint.',
      });
    }

    return res.status(200).json({
      success: true,
      data: complaint,
    });
  } catch (error) {
    console.error('Error fetching complaint:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch complaint',
      error: error.message,
    });
  }
};

// ---------------- INCOMING (based on staff departmentIds) ----------------
exports.incommingComplaints = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);

    // ✅ superadmin -> all complaints
    if (String(staff.role).toLowerCase() === 'superadmin') {
      const all = await Complaint.findAll({ order: [['createdAt', 'DESC']] });
      return res.status(200).json({ success: true, count: all.length, data: all });
    }

    // ✅ deptId must come from active department middleware
    const deptId = Number(req.departmentId);
    if (!Number.isInteger(deptId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid departmentId (active department not set / middleware missing)',
      });
    }

    // ✅ staff must belong to this dept (admin/subadmin/engineer)
    if (!hasDeptAccess(staff, deptId)) {
      // you can make it 403 too
      return res.status(200).json({ success: true, count: 0, data: [] });
    }

    // ✅ department must be service for Incoming
    const dept = await Department.findByPk(deptId);
    const deptType = String(dept?.type || '').toLowerCase();

    if (!dept || deptType !== 'service') {
      return res.status(200).json({ success: true, count: 0, data: [] });
    }

    // ✅ ONLY complaints where departmentId == active deptId
    const incoming = await Complaint.findAll({
      where: { departmentId: deptId },
      order: [['createdAt', 'DESC']],
    });

    return res.status(200).json({
      success: true,
      count: incoming.length,
      data: incoming,
    });
  } catch (error) {
    console.error('Error in incommingComplaints:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch incoming complaints',
    });
  }
};



// ---------------- MY COMPLAINTS ----------------
exports.myComplaints = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);

    const myComplaints = await Complaint.findAll({
      where: { staffId: staff.id },
      order: [['createdAt', 'DESC']],
    });

    return res.status(200).json({
      success: true,
      count: myComplaints.length,
      data: myComplaints,
    });
  } catch (error) {
    console.error('Error in myComplaints:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch my complaints',
      error:
        process.env.NODE_ENV === 'development'
          ? error.message
          : 'Internal server error',
    });
  }
};

// ---------------- DEPARTMENT COMPLAINTS (service + regular) ----------------
exports.departmentComplaints = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);

    if (String(staff.role).toLowerCase() === 'superadmin') {
      const all = await Complaint.findAll({ order: [['createdAt', 'DESC']] });
      return res
        .status(200)
        .json({ success: true, count: all.length, data: all });
    }

    const deptId = Number(req.departmentId); // ✅ middleware se
    if (!Number.isInteger(deptId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid departmentId from middleware',
      });
    }

    // ✅ check department type
    const dept = await Department.findByPk(deptId);
    const deptType = String(dept?.type || '').toLowerCase();

    // ✅ Department complaints allowed for service + regular
    if (!dept || !['service', 'regular'].includes(deptType)) {
      return res.status(200).json({ success: true, count: 0, data: [] });

      // (strict option)
      // return res.status(403).json({ success:false, message:"Department complaints are allowed only for Service/Regular departments."});
    }

    const sameDeptStaff = await Staff.findAll({
      where: { departmentIds: { [Op.contains]: [deptId] } },
      attributes: ['id'],
    });

    const staffIds = (sameDeptStaff || []).map((s) => s.id);

    const deptComplaints = await Complaint.findAll({
      where: { staffId: { [Op.in]: staffIds } },
      order: [['createdAt', 'DESC']],
    });

    return res.status(200).json({
      success: true,
      count: deptComplaints.length,
      data: deptComplaints,
    });
  } catch (error) {
    console.error('Error in departmentComplaints:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch department complaints',
    });
  }
};

// ---------------- ASSIGN TO SELF ----------------
exports.assignComplaintToSelf = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);
    const { id } = req.params;

    const complaint = await Complaint.findByPk(id);
    if (!complaint) {
      return res
        .status(404)
        .json({ success: false, message: 'Complaint not found' });
    }

    const deptId = toInt(complaint.departmentId);
    if (!deptId) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid complaint.departmentId' });
    }

    if (!hasDeptAccess(staff, deptId)) {
      return res.status(403).json({
        success: false,
        message:
          'You are not part of this department, so you cannot assign this complaint to yourself.',
      });
    }

    if (!['engineer', 'admin', 'subadmin'].includes(String(staff.role).toLowerCase())) {
      return res.status(403).json({
        success: false,
        message: 'Only engineer/admin/subadmin can assign complaints to themselves.',
      });
    }

    if (complaint.assignStaffId && complaint.assignStaffId !== staff.id) {
      return res.status(400).json({
        success: false,
        message: 'This complaint is already assigned to another staff.',
      });
    }

    complaint.assignStaffId = staff.id;

    complaint.assignedAt = new Date();
    complaint.assignedById = staff.id;
    complaint.lastStatusChangedAt = new Date();

    if (String(complaint.status || '').toLowerCase() === 'pending') {
      complaint.status = 'In Progress';
    }

    // ✅ ensure forward fields are cleared
    complaint.forwardToStaffId = null;
    complaint.forwardComment = null;
    complaint.forwardAt = null;

    await complaint.save();

    if (String(staff.role).toLowerCase() === 'subadmin') {
      await SubadminActivity.create({
        subadminId: staff.id,
        departmentId: complaint.departmentId,
        actionTaken: 'COMPLAINT_ASSIGNED',
        entityType: 'COMPLAINT',
        entityId: complaint.id
      });
    }

    return res.status(200).json({
      success: true,
      message: `Complaint assigned to you successfully (${fullNameOf(staff)}).`,
      data: complaint,
    });
  } catch (error) {
    console.error('Error in assignComplaintToSelf:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to assign complaint to self',
      error:
        process.env.NODE_ENV === 'development'
          ? error.message
          : 'Internal server error',
    });
  }
};

// ---------------- ✅ ASSIGN TO STAFF (Admin/Subadmin) ----------------
exports.assignComplaintToStaff = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);
    const { id } = req.params;
    const { assignToStaffId, assignComment } = req.body;

    const role = String(staff.role || '').toLowerCase();
    if (!['admin', 'subadmin'].includes(role)) {
      return res.status(403).json({
        success: false,
        message: 'Only admin/subadmin can assign complaints to staff.',
      });
    }

    if (!assignToStaffId) {
      return res
        .status(400)
        .json({ success: false, message: 'assignToStaffId is required.' });
    }

    const complaint = await Complaint.findByPk(id);
    if (!complaint) {
      return res
        .status(404)
        .json({ success: false, message: 'Complaint not found' });
    }

    const deptId = toInt(complaint.departmentId);
    if (!deptId) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid complaint.departmentId' });
    }

    if (!hasDeptAccess(staff, deptId)) {
      return res.status(403).json({
        success: false,
        message: 'You are not allowed to assign this complaint (department mismatch).',
      });
    }

    const targetStaff = await Staff.findByPk(assignToStaffId);
    if (!targetStaff) {
      return res.status(404).json({
        success: false,
        message: `Target staff not found for id: ${assignToStaffId}`,
      });
    }

    const targetSameDept = hasDeptAccess(targetStaff, deptId);
    const targetRole = String(targetStaff.role || '').toLowerCase();
    const targetAllowed = ['engineer', 'subadmin'].includes(targetRole);

    if (!targetSameDept || !targetAllowed) {
      return res.status(400).json({
        success: false,
        message: 'Can only assign to engineer/subadmin within the same department.',
      });
    }

    // ✅ ASSIGN ONLY
    complaint.assignStaffId = Number(assignToStaffId);
    complaint.assignedAt = new Date();
    complaint.assignedById = staff.id;
    complaint.lastStatusChangedAt = new Date();

    // OPTIONAL: if you add columns in DB, use them:
    // complaint.assignComment = (assignComment || '').trim();
    // complaint.assignAt = new Date();

    // ✅ CLEAR forward fields so it doesn't show forwarded in UI
    complaint.forwardToStaffId = null;
    complaint.forwardComment = null;
    complaint.forwardAt = null;

    if (String(complaint.status || '').toLowerCase() === 'pending') {
      complaint.status = 'In Progress';
    }

    await complaint.save();

    if (role === 'subadmin') {
      await SubadminActivity.create({
        subadminId: staff.id,
        departmentId: complaint.departmentId,
        actionTaken: 'COMPLAINT_ASSIGNED_TO_STAFF',
        entityType: 'COMPLAINT',
        entityId: complaint.id,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Complaint assigned to staff id ${assignToStaffId} successfully.`,
      data: complaint,
    });
  } catch (error) {
    console.error('Error in assignComplaintToStaff:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to assign complaint to staff',
      error:
        process.env.NODE_ENV === 'development'
          ? error.message
          : 'Internal server error',
    });
  }
};

// ---------------- CLOSE COMPLAINT ----------------
exports.closeComplaint = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);
    const { id } = req.params;
    const { actionTakenComment, problemDescription } = req.body;

    const complaint = await Complaint.findByPk(id);
    if (!complaint) {
      return res
        .status(404)
        .json({ success: false, message: 'Complaint not found' });
    }

    const deptId = toInt(complaint.departmentId);
    if (!deptId) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid complaint.departmentId' });
    }

    const isSameDept = hasDeptAccess(staff, deptId);
    const isAssignee = complaint.assignStaffId === staff.id;
    const isDeptAdmin =
      isSameDept && ['admin', 'subadmin'].includes(String(staff.role).toLowerCase());

    if (!isAssignee && !isDeptAdmin) {
      return res
        .status(403)
        .json({ success: false, message: 'You are not allowed to close this complaint.' });
    }

    if (!problemDescription || !problemDescription.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Problem description is required to close the complaint.',
      });
    }

    if (!actionTakenComment || !actionTakenComment.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Action taken description is required to close the complaint.',
      });
    }

    complaint.problemDescription = problemDescription.trim();
    complaint.actionTakenComment = actionTakenComment.trim();
    complaint.status = 'Closed';
    complaint.resolvedAt = new Date();

    complaint.closedById = staff.id;
    complaint.lastStatusChangedAt = new Date();

    await complaint.save();

    const [requester, behalfUser] = await Promise.all([
      Staff.findByPk(complaint.staffId, { attributes: ['email', 'firstname', 'middlename', 'lastname'] }),
      complaint.behalfId
        ? Staff.findByPk(complaint.behalfId, { attributes: ['email', 'firstname', 'middlename', 'lastname'] })
        : Promise.resolve(null),
    ]);

    const closeEmailSubject = buildTicketSubject(complaint.ticketId, complaint.subject);
    const closeEmailHtml = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Complaint Closed</title></head>
<body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff; border-radius: 5px;">
    <h2 style="color: #0088cc;">Complaint Closed</h2>
    <p>Your complaint has been marked as closed.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 10px 0;">
      <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Ticket ID</td><td style="padding: 8px; border: 1px solid #ddd;">${complaint.ticketId}</td></tr>
      <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Subject</td><td style="padding: 8px; border: 1px solid #ddd;">${complaint.subject}</td></tr>
      <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Problem Description</td><td style="padding: 8px; border: 1px solid #ddd;">${complaint.problemDescription}</td></tr>
      <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Action Taken</td><td style="padding: 8px; border: 1px solid #ddd;">${complaint.actionTakenComment}</td></tr>
      <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Closed By</td><td style="padding: 8px; border: 1px solid #ddd;">${fullNameOf(staff)}</td></tr>
    </table>
    <p>Best regards,<br><strong>The Helpdesk Team</strong></p>
  </div>
</body>
</html>`;

    await notifyUsers([requester, behalfUser], closeEmailSubject, closeEmailHtml);

    if (String(staff.role).toLowerCase() === 'subadmin') {
      await SubadminActivity.create({
        subadminId: staff.id,
        departmentId: complaint.departmentId,
        actionTaken: 'COMPLAINT_CLOSED',
        entityType: 'COMPLAINT',
        entityId: complaint.id,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Complaint closed successfully.',
      data: complaint,
    });
  } catch (error) {
    console.error('Error in closeComplaint:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to close complaint',
      error:
        process.env.NODE_ENV === 'development'
          ? error.message
          : 'Internal server error',
    });
  }
};

// ---------------- FORWARD COMPLAINT (ONLY ASSIGNEE) ----------------
exports.forwardComplaint = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);
    const { id } = req.params;
    const { forwardToStaffId, forwardComment } = req.body;

    if (!forwardToStaffId) {
      return res
        .status(400)
        .json({ success: false, message: 'forwardToStaffId is required.' });
    }
    if (!forwardComment || !forwardComment.trim()) {
      return res
        .status(400)
        .json({ success: false, message: 'Forward comment is required.' });
    }

    const complaint = await Complaint.findByPk(id);
    if (!complaint) {
      return res
        .status(404)
        .json({ success: false, message: 'Complaint not found' });
    }

    const deptId = toInt(complaint.departmentId);
    if (!deptId) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid complaint.departmentId' });
    }

    // ✅ ONLY CURRENT ASSIGNEE CAN FORWARD
    const isAssignee = complaint.assignStaffId === staff.id;
    if (!isAssignee) {
      return res.status(403).json({
        success: false,
        message: 'Only assigned staff can forward this complaint.',
      });
    }

    const targetStaff = await Staff.findByPk(forwardToStaffId);
    if (!targetStaff) {
      return res.status(404).json({
        success: false,
        message: `Target staff not found for id: ${forwardToStaffId}`,
      });
    }

    const targetSameDept = hasDeptAccess(targetStaff, deptId);
    const isTargetAllowedRole = ['engineer', 'subadmin'].includes(
      String(targetStaff.role).toLowerCase()
    );

    if (!targetSameDept || !isTargetAllowedRole) {
      return res.status(400).json({
        success: false,
        message: 'Can only forward to engineer/subadmin within the same department.',
      });
    }

    complaint.assignStaffId = Number(forwardToStaffId);
    complaint.forwardToStaffId = Number(forwardToStaffId);
    complaint.forwardComment = forwardComment.trim();
    complaint.forwardAt = new Date();

    complaint.assignedAt = new Date();
    complaint.assignedById = staff.id;
    complaint.lastStatusChangedAt = new Date();

    if (String(complaint.status || '').toLowerCase() === 'pending') {
      complaint.status = 'In Progress';
    }

    await complaint.save();

    if (String(staff.role).toLowerCase() === 'subadmin') {
      await SubadminActivity.create({
        subadminId: staff.id,
        departmentId: complaint.departmentId,
        actionTaken: 'COMPLAINT_FORWARDED',
        entityType: 'COMPLAINT',
        entityId: complaint.id
      });
    }

    return res.status(200).json({
      success: true,
      message: `Complaint forwarded to staff id ${forwardToStaffId} successfully.`,
      data: complaint,
    });
  } catch (error) {
    console.error('Error in forwardComplaint:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to forward complaint',
      error:
        process.env.NODE_ENV === 'development'
          ? error.message
          : 'Internal server error',
    });
  }
};
