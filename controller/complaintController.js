// controller/complaintController.js  ✅ UPDATED for instituteId + departmentIds (INTEGER[])

const Complaint = require('../models/complaint');
const Staff = require('../models/staff');
const Department = require('../models/department');
const SubadminActivity = require('../models/subadminActivity');
const sequelize = require('../config/db');
const { Op } = require('sequelize');
const fs = require('fs');
const path = require('path');
const { buildTicketSubject, renderEmailLayout, sendMail } = require('../utils/mailer');
const { buildTicketId } = require('../utils/ticketId');
const { emitTicketReminderRefresh } = require('../utils/realtime');

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
    // -------- create complaint ----------
    const newComplaint = await sequelize.transaction(async (transaction) => {
      const ticketId = await generateComplaintTicketId(transaction);

      return Complaint.create({
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
      }, { transaction });
    });

    const ticketId = newComplaint.ticketId;

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
          const emailHtml = renderEmailLayout({
            title: 'Complaint Notification',
            intro: `Dear ${targetName}, a new complaint has been generated for your department (${departmentName}).`,
            rows: [
              { label: 'Ticket ID', value: ticketId },
              { label: 'Ticket Type', value: 'Complaint' },
              { label: 'Department', value: departmentName },
              { label: 'Category', value: departmentCategory || 'N/A' },
              { label: 'Priority', value: priority || 'N/A' },
              { label: 'Status', value: status },
              { label: 'Subject', value: subject },
              { label: 'Description', value: description },
              { label: 'Location', value: location || 'N/A' },
              { label: 'Raised By', value: `${staffName}${behalfBool ? ` (on behalf of ${behalfUserName})` : ''}` },
              { label: 'Repeated Complaint', value: isRepeatedBool ? 'Yes' : null },
            ],
            outro: 'Please log in to MET Helpdesk to review and take necessary action.',
          });

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
    const requesterEmailHtml = renderEmailLayout({
      title: 'Complaint Created Successfully',
      intro: 'Your complaint has been registered in the helpdesk system.',
      rows: [
        { label: 'Ticket ID', value: ticketId },
        { label: 'Subject', value: subject },
        { label: 'Department', value: departmentName },
        { label: 'Status', value: status },
      ],
      outro: 'Please use the same ticket ID for future communication so this complaint stays in one thread.',
    });

    await notifyUsers([staff, behalfUser], requesterEmailSubject, requesterEmailHtml);
    emitTicketReminderRefresh({
      userIds: [staff.id, behalfUser?.id],
      roles: ['admin', 'subadmin', 'engineer'],
      departmentIds: [deptId],
      reason: 'complaint-created',
    });

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
    emitTicketReminderRefresh({
      userIds: [staff.id, complaint.staffId, complaint.behalfId],
      roles: ['admin', 'subadmin', 'engineer'],
      departmentIds: [complaint.departmentId],
      reason: 'complaint-assigned',
    });

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
    emitTicketReminderRefresh({
      userIds: [staff.id, assignToStaffId, complaint.staffId, complaint.behalfId],
      roles: ['admin', 'subadmin', 'engineer'],
      departmentIds: [complaint.departmentId],
      reason: 'complaint-assigned',
    });

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
    const closeEmailHtml = renderEmailLayout({
      title: 'Complaint Closed',
      intro: 'Your complaint has been marked as closed.',
      rows: [
        { label: 'Ticket ID', value: complaint.ticketId },
        { label: 'Subject', value: complaint.subject },
        { label: 'Problem Description', value: complaint.problemDescription },
        { label: 'Action Taken', value: complaint.actionTakenComment },
        { label: 'Closed By', value: fullNameOf(staff) },
      ],
    });

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
    emitTicketReminderRefresh({
      userIds: [staff.id, complaint.staffId, complaint.behalfId, complaint.assignStaffId],
      roles: ['admin', 'subadmin', 'engineer'],
      departmentIds: [complaint.departmentId],
      reason: 'complaint-closed',
    });

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
    emitTicketReminderRefresh({
      userIds: [staff.id, forwardToStaffId, complaint.staffId, complaint.behalfId],
      roles: ['admin', 'subadmin', 'engineer'],
      departmentIds: [complaint.departmentId],
      reason: 'complaint-forwarded',
    });

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

