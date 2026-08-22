// controller/requestController.js ✅ UPDATED with Active Department (req.departmentId)

const Request = require("../models/request");
const Staff = require("../models/staff");
const Department = require("../models/department");
const SubadminActivity = require("../models/subadminActivity");
const sequelize = require("../config/db");
const { Op } = require("sequelize");
const fs = require("fs");
const path = require("path");
const { buildTicketSubject, renderEmailLayout, sendMail } = require("../utils/mailer");
const { buildTicketId } = require("../utils/ticketId");

/* ========================= HELPERS ========================= */

const toInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

const deptIdsOf = (staff) =>
  Array.isArray(staff?.departmentIds) ? staff.departmentIds : [];

const roleLower = (staff) => String(staff?.role || "").toLowerCase();

const isAdminLike = (staff) => ["superadmin", "admin", "subadmin"].includes(roleLower(staff));

const isEngineerLike = (staff) => {
  const r = roleLower(staff);
  return r === "engineer" || r === "engineers";
};

const normalizeBool = (val) => val === true || val === "true" || val === 1 || val === "1";

const getStaffFullName = (s) =>
  `${s?.firstname || ""} ${s?.middlename || ""} ${s?.lastname || ""}`
    .replace(/\s+/g, " ")
    .trim() ||
  s?.email ||
  s?.id;

const hasDeptAccess = (staff, deptId) => {
  if (!staff || !deptId) return false;
  if (roleLower(staff) === "superadmin") return true;
  return deptIdsOf(staff).includes(Number(deptId));
};

// ✅ active department validator (middleware se req.departmentId)
const ensureActiveDeptAllowed = (staff, req) => {
  const activeDeptId = toInt(req.departmentId);
  if (!activeDeptId) {
    const err = new Error("Active department missing (x-department-id required)");
    err.statusCode = 400;
    throw err;
  }
  if (!hasDeptAccess(staff, activeDeptId)) {
    const err = new Error("Not allowed for this department (switch active department)");
    err.statusCode = 403;
    throw err;
  }
  return activeDeptId;
};

// ✅ current staff from JWT only (recommended, like your complaint controller)
const getCurrentStaff = async (req) => {
  const staffId = req.user?.id;
  if (!staffId) {
    const err = new Error("Unauthorized");
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

const requestAccessWhere = (staff) => {
  if (roleLower(staff) === "superadmin") {
    return {};
  }

  const ownScope = [
    { staffId: staff.id },
    { assignStaffId: staff.id },
    { behalfId: staff.id },
  ];

  if (["admin", "subadmin", "engineer"].includes(roleLower(staff)) && deptIdsOf(staff).length > 0) {
    ownScope.push({ departmentId: { [Op.in]: deptIdsOf(staff) } });
  }

  return { [Op.or]: ownScope };
};

const canViewRequest = async (staff, request) => {
  if (roleLower(staff) === "superadmin") return true;
  if (request.staffId === staff.id || request.assignStaffId === staff.id || request.behalfId === staff.id) {
    return true;
  }

  if (!["admin", "subadmin", "engineer"].includes(roleLower(staff))) {
    return false;
  }

  if (hasDeptAccess(staff, request.departmentId)) {
    return true;
  }

  const requester = await Staff.findByPk(request.staffId, {
    attributes: ["departmentIds"],
  });

  const requesterDeptIds = deptIdsOf(requester);
  return requesterDeptIds.some((deptId) => hasDeptAccess(staff, deptId));
};

/* ========================= MAIL ========================= */
// ⚠️ Hardcoded creds (same as your original). Prefer ENV vars in production.
const transporter = {
  sendMail,
};

const sendEmail = async (to, subject, html) => {
  await transporter.sendMail({ to, subject, html });
};

const notifyUsers = async (users, subject, html) => {
  const seen = new Set();
  const recipients = (users || []).filter((user) => {
    const email = String(user?.email || "").trim().toLowerCase();
    if (!email || seen.has(email)) return false;
    seen.add(email);
    return true;
  });

  await Promise.all(
    recipients.map((user) =>
      sendEmail(user.email, subject, html).catch((error) => {
        console.error(`Failed to send email to ${user.email}`, error);
      })
    )
  );
};

/* ========================= TICKET ID ========================= */

const generateRequestTicketId = async (transaction) =>
  buildTicketId({
    model: Request,
    prefix: "#R",
    regex: /^#R(\d{4})(\d{3})$/,
    lockKey: 41002,
    transaction,
  });

/* ========================= CREATE REQUEST ========================= */
/**
 * Create request can remain same (no active dept enforcement mandatory),
 * because user can raise request to ANY target department.
 */
exports.createRequest = async (req, res) => {
  try {
    const {
      staffId, // (kept as you had)
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

    const behalfBool = normalizeBool(behalf);
    const isRepeatedBool = normalizeBool(isRepeated);
    const status = "pending";

    if (!departmentId || !subject || !description) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: departmentId, subject, description",
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
        message: "You are not allowed to create requests for another staff member.",
      });
    }

    let staff = actor;
    if (requestedStaffId !== actor.id) {
      staff = await Staff.findByPk(requestedStaffId);
      if (!staff) {
        return res.status(400).json({ success: false, message: `Invalid staffId: ${staffId}` });
      }
    }

    const targetDept = await Department.findByPk(departmentId);
    if (!targetDept) {
      return res.status(400).json({ success: false, message: `Invalid departmentId: ${departmentId}` });
    }
    const targetDeptName = targetDept.department;

    let behalfUser = null;
    if (behalfBool) {
      if (!isAdminLike(actor)) {
        return res.status(403).json({
          success: false,
          message: "Only admin, subadmin, or superadmin can create requests on behalf of another user.",
        });
      }

      if (!behalfId) {
        return res.status(400).json({ success: false, message: "behalf is true but behalfId missing" });
      }
      behalfUser = await Staff.findByPk(behalfId);
      if (!behalfUser) {
        return res.status(400).json({ success: false, message: `Invalid behalfId: ${behalfId}` });
      }
    }

    // ===== Attachments =====
    let attachmentPaths = [];
    if (req.files && req.files.attachments) {
      const files = Array.isArray(req.files.attachments)
        ? req.files.attachments
        : [req.files.attachments];

      const allowedTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ];

      const uploadDir = path.join(__dirname, "..", "uploads", "requests");
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

      for (const file of files) {
        if (!allowedTypes.includes(file.mimetype)) {
          return res.status(400).json({
            success: false,
            message: "Invalid file type. Only images and documents are allowed.",
          });
        }

        const ext = path.extname(file.name);
        const baseName = path.basename(file.name, ext);
        const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const finalFileName = `${baseName}-${unique}${ext}`;

        const savePath = path.join(uploadDir, finalFileName);
        await file.mv(savePath);

        attachmentPaths.push(`/uploads/requests/${finalFileName}`);
      }
    }

    const newRequest = await sequelize.transaction(async (transaction) => {
      const ticketId = await generateRequestTicketId(transaction);

      return Request.create({
        ticketId,
        staffId: staff.id,
        behalf: behalfBool,
        behalfId: behalfBool ? behalfId : null,
        status,
        departmentId,
        departmentCategory,
        priority,
        subject,
        description,
        location,
        isRepeated: isRepeatedBool,
        attachments: attachmentPaths,
      }, { transaction });
    });

    const ticketId = newRequest.ticketId;
    const ticketSubject = buildTicketSubject(ticketId, subject);

    /* ===== HOD1 MAIL (requester departments) ===== */
    const requesterDeptIds = deptIdsOf(staff);

    if (requesterDeptIds.length > 0) {
      const hod1Candidates = await Staff.findAll({
        where: {
          departmentIds: { [Op.overlap]: requesterDeptIds },
          role: { [Op.in]: ["admin", "subadmin"] },
        },
        attributes: ["id", "email", "firstname", "middlename", "lastname", "departmentIds", "role"],
      });

      if (hod1Candidates.length > 0) {
        const staffName = getStaffFullName(staff);
        const behalfUserName = behalfUser ? getStaffFullName(behalfUser) : "";

        const emailPromises = hod1Candidates.map((hod) => {
          const hodName = getStaffFullName(hod);
          const emailSubject = ticketSubject;

          const emailHtml = renderEmailLayout({
            title: "HOD1 Approval Required",
            intro: `Dear ${hodName}, a new request ticket has been generated and needs your HOD1 approval.`,
            rows: [
              { label: "Ticket ID", value: ticketId },
              { label: "Target Department", value: targetDeptName },
              { label: "Category", value: departmentCategory || "N/A" },
              { label: "Priority", value: priority || "N/A" },
              { label: "Status", value: status },
              { label: "Subject", value: subject },
              { label: "Description", value: description },
              { label: "Location", value: location || "N/A" },
              { label: "Raised By", value: `${staffName}${behalfBool ? ` (on behalf of ${behalfUserName})` : ""}` },
              { label: "Repeated", value: isRepeatedBool ? "Yes" : null },
            ],
            outro: "Please log in to MET Helpdesk to review and take the next action.",
          });

          return sendEmail(hod.email, emailSubject, emailHtml).catch((err) => {
            console.error(`Failed to send HOD1 mail to ${hod.email}`, err);
          });
        });

        await Promise.all(emailPromises);
      }
    }

    const behalfUserName = behalfUser ? getStaffFullName(behalfUser) : "";
    const requesterEmailHtml = renderEmailLayout({
      title: "Request Created Successfully",
      intro: "Your request has been registered in the helpdesk system.",
      rows: [
        { label: "Ticket ID", value: ticketId },
        { label: "Target Department", value: targetDeptName },
        { label: "Subject", value: subject },
        { label: "Status", value: status },
      ],
      outro: "Please use the same ticket ID for future communication so this request stays in one thread.",
    });

    await notifyUsers([staff, behalfUser], ticketSubject, requesterEmailHtml);

    return res.status(201).json({
      success: true,
      message: behalfBool
        ? `Request created successfully on behalf of ${behalfUserName}`
        : "Request created successfully",
      data: newRequest,
    });
  } catch (error) {
    console.error("Error in createRequest:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create request",
      error: process.env.NODE_ENV === "development" ? error.message : "Internal server error",
    });
  }
};

/* ========================= GET ALL / GET BY ID ========================= */

exports.getAllRequests = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);
    const data = await Request.findAll({
      where: requestAccessWhere(staff),
      order: [["createdAt", "DESC"]],
    });
    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("Error getAllRequests:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

exports.getRequestById = async (req, res) => {
  try {
    const { id } = req.params;
    const staff = await getCurrentStaff(req);
    const r = await Request.findByPk(id);

    if (!r) return res.status(404).json({ success: false, message: "Request not found" });
    if (!(await canViewRequest(staff, r))) {
      return res.status(403).json({ success: false, message: "You are not allowed to view this request." });
    }

    return res.status(200).json({ success: true, data: r });
  } catch (error) {
    console.error("Error getRequestById:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

/* ========================= INCOMING / MY / DEPARTMENT ========================= */
exports.incomingRequests = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);

    // ✅ superadmin gets all
    if (roleLower(staff) === "superadmin") {
      const all = await Request.findAll({ order: [["createdAt", "DESC"]] });
      return res.status(200).json({ success: true, count: all.length, data: all });
    }

    // ✅ active dept (middleware/helper)
    const activeDeptId = ensureActiveDeptAllowed(staff, req);

    // ✅ fetch active dept to check type
    const dept = await Department.findOne({ where: { id: activeDeptId } });

    // if dept not found OR not service => return empty
    if (!dept || String(dept.type || "").toLowerCase() !== "service") {
      // Option 1: return empty list (safer UX)
      return res.status(200).json({ success: true, count: 0, data: [] });

      // Option 2 (strict): forbid
      // return res.status(403).json({ success: false, message: "Active department is not a service department." });
    }

    // ✅ only service dept requests
    const data = await Request.findAll({
      where: { departmentId: activeDeptId },
      order: [["createdAt", "DESC"]],
    });

    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("Error incomingRequests:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to fetch incoming requests",
    });
  }
};

exports.myRequests = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);

    const data = await Request.findAll({
      where: { staffId: staff.id },
      order: [["createdAt", "DESC"]],
    });

    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("Error myRequests:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch my requests",
      error: error.message,
    });
  }
};

// ✅ DEPARTMENT = active department staff requests
exports.departmentRequests = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);

    if (roleLower(staff) === "superadmin") {
      const all = await Request.findAll({ order: [["createdAt", "DESC"]] });
      return res.status(200).json({ success: true, count: all.length, data: all });
    }

    const activeDeptId = ensureActiveDeptAllowed(staff, req);

    const sameDeptStaff = await Staff.findAll({
      where: { departmentIds: { [Op.contains]: [activeDeptId] } },
      attributes: ["id"],
    });

    const staffIds = (sameDeptStaff || []).map((s) => s.id);

    const data = await Request.findAll({
      where: {
        [Op.or]: [
          { staffId: { [Op.in]: staffIds } },
          { departmentId: activeDeptId },
        ],
      },
      order: [["createdAt", "DESC"]],
    });

    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("Error departmentRequests:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to fetch department requests",
    });
  }
};

/* ========================= CLOSE REQUEST ========================= */

exports.closeRequest = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);
    const { id } = req.params;
    const { problemDescription, actionTakenComment } = req.body;

    const request = await Request.findByPk(id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    // ✅ active dept must match request.departmentId (except superadmin)
    if (roleLower(staff) !== "superadmin") {
      const activeDeptId = ensureActiveDeptAllowed(staff, req);
      if (Number(request.departmentId) !== Number(activeDeptId)) {
        return res.status(403).json({
          success: false,
          message: "Active department mismatch. Please switch active department to this request's department.",
        });
      }
    }

    const isAssignee = request.assignStaffId === staff.id;
    const isDeptAdmin = hasDeptAccess(staff, request.departmentId) && isAdminLike(staff);

    if (!isAssignee && !isDeptAdmin) {
      return res.status(403).json({ success: false, message: "You are not allowed to close this request." });
    }

    if (!problemDescription || !problemDescription.trim()) {
      return res.status(400).json({ success: false, message: "Problem description is required." });
    }
    if (!actionTakenComment || !actionTakenComment.trim()) {
      return res.status(400).json({ success: false, message: "Action taken comment is required." });
    }

    request.problemDescription = problemDescription.trim();
    request.actionTakenComment = actionTakenComment.trim();
    request.status = "closed";
    request.resolvedAt = new Date();

    request.closedById = staff.id;
    request.lastStatusChangedAt = new Date();

    await request.save();

    const [requester, behalfUser] = await Promise.all([
      Staff.findByPk(request.staffId, { attributes: ["email", "firstname", "middlename", "lastname"] }),
      request.behalfId
        ? Staff.findByPk(request.behalfId, { attributes: ["email", "firstname", "middlename", "lastname"] })
        : Promise.resolve(null),
    ]);

    const closeEmailSubject = buildTicketSubject(request.ticketId, request.subject);
    const closeEmailHtml = renderEmailLayout({
      title: "Request Closed",
      intro: "Your request has been marked as closed.",
      rows: [
        { label: "Ticket ID", value: request.ticketId },
        { label: "Subject", value: request.subject },
        { label: "Problem Description", value: request.problemDescription },
        { label: "Action Taken", value: request.actionTakenComment },
        { label: "Closed By", value: getStaffFullName(staff) },
      ],
    });

    await notifyUsers([requester, behalfUser], closeEmailSubject, closeEmailHtml);

    if (roleLower(staff) === "subadmin") {
      await SubadminActivity.create({
        subadminId: staff.id,
        departmentId: request.departmentId,
        actionTaken: "REQUEST_CLOSE",
        entityType: 'REQUEST',
        entityId: request.id,
      });
    }

    return res.status(200).json({ success: true, message: "Request closed successfully.", data: request });
  } catch (error) {
    console.error("Error closeRequest:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || "Failed to close request" });
  }
};

/* ========================= FORWARD REQUEST ========================= */

exports.forwardRequest = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);
    const { id } = req.params;
    const { forwardToStaffId, forwardComment } = req.body;

    if (!forwardToStaffId) {
      return res.status(400).json({ success: false, message: "forwardToStaffId is required." });
    }
    if (!forwardComment || !forwardComment.trim()) {
      return res.status(400).json({ success: false, message: "Forward comment is required." });
    }

    const request = await Request.findByPk(id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    // ✅ active dept must match request.departmentId (except superadmin)
    if (roleLower(staff) !== "superadmin") {
      const activeDeptId = ensureActiveDeptAllowed(staff, req);
      if (Number(request.departmentId) !== Number(activeDeptId)) {
        return res.status(403).json({
          success: false,
          message: "Active department mismatch. Please switch active department to this request's department.",
        });
      }
    }

    const isSameDept = hasDeptAccess(staff, request.departmentId);
    const isAssignee = request.assignStaffId === staff.id;
    const allowedRoles = isSameDept && (isEngineerLike(staff) || isAdminLike(staff));

    if (!isAssignee && !allowedRoles) {
      return res.status(403).json({ success: false, message: "You are not allowed to forward this request." });
    }

    const targetStaff = await Staff.findByPk(forwardToStaffId);
    if (!targetStaff) {
      return res.status(404).json({ success: false, message: `Target staff not found for id: ${forwardToStaffId}` });
    }

    // can only forward within same department of this request
    if (!hasDeptAccess(targetStaff, request.departmentId)) {
      return res.status(400).json({ success: false, message: "Can only forward within the same department of this request." });
    }

    request.assignStaffId = Number(forwardToStaffId);
    request.forwardToStaffId = Number(forwardToStaffId);
    request.forwardComment = forwardComment.trim();
    request.forwardAt = new Date();

    request.assignedAt = new Date();
    request.assignedById = staff.id;
    request.lastStatusChangedAt = new Date();

    if ((request.status || "").toLowerCase() === "pending") request.status = "in-progress";

    await request.save();

    if (roleLower(staff) === "subadmin") {
      await SubadminActivity.create({
        subadminId: staff.id,
        departmentId: request.departmentId,
        actionTaken: "REQUEST_FORWARD",
        entityType: 'REQUEST',
        entityId: request.id,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Request forwarded to staff id ${forwardToStaffId} successfully.`,
      data: request,
    });
  } catch (error) {
    console.error("Error forwardRequest:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || "Failed to forward request" });
  }
};

/* ========================= HOD1 APPROVE ========================= */
/**
 * HOD1 approval is based on requester dept (common dept between requester & hod1).
 * Active department enforcement:
 * - staff must keep active dept = that requester-common dept (except superadmin)
 */
exports.hod1ApproveRequest = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);
    const { id } = req.params;
    const { comment } = req.body;

    const request = await Request.findByPk(id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    if (request.hod1Approval) {
      return res.status(400).json({ success: false, message: "HOD1 already approved this request." });
    }

    const requester = await Staff.findByPk(request.staffId);
    if (!requester) {
      return res.status(400).json({ success: false, message: `Requester staff not found for id: ${request.staffId}` });
    }

    const requesterDeptIds = deptIdsOf(requester);
    const currentDeptIds = deptIdsOf(staff);

    const isHod1Role = isAdminLike(staff);
    const commonDeptId = requesterDeptIds.find((d) => currentDeptIds.includes(d));

    if (!isHod1Role || !commonDeptId) {
      return res.status(403).json({
        success: false,
        message: "You are not HOD1 for this requester department (admin/subadmin of requester dept required).",
      });
    }

    // ✅ active dept must match HOD1 dept (commonDeptId)
    if (roleLower(staff) !== "superadmin") {
      const activeDeptId = ensureActiveDeptAllowed(staff, req);
      if (Number(activeDeptId) !== Number(commonDeptId)) {
        return res.status(403).json({
          success: false,
          message: "Active department mismatch. Switch active department to requester department for HOD1 approval.",
        });
      }
    }

    request.hod1Approval = true;
    request.hod1Comment = comment || null;
    request.hod1ApprovedAt = new Date();
    request.hod1ApprovedById = staff.id;
    request.status = "hod1-approved";

    request.lastStatusChangedAt = new Date();

    await request.save();

    if (roleLower(staff) === "subadmin") {
      await SubadminActivity.create({
        subadminId: staff.id,
        departmentId: commonDeptId,
        actionTaken: "REQUEST_HOD1_APPROVE",
        entityType: 'REQUEST',
        entityId: request.id,
      });
    }

    // HOD2 candidates = admin/subadmin of target department
    const targetDept = await Department.findByPk(request.departmentId);
    if (targetDept) {
      const hod2Candidates = await Staff.findAll({
        where: {
          departmentIds: { [Op.contains]: [request.departmentId] },
          role: { [Op.in]: ["admin", "subadmin"] },
        },
        attributes: ["id", "email", "firstname", "middlename", "lastname"],
      });

      if (hod2Candidates.length > 0) {
        const requesterName = getStaffFullName(requester);
        const staffName = getStaffFullName(staff);

        const emailPromises = hod2Candidates.map((hod) => {
          const hodName = getStaffFullName(hod);
          const emailSubject = buildTicketSubject(request.ticketId, request.subject);

          const emailHtml = renderEmailLayout({
            title: "HOD2 Approval Required",
            intro: `Dear ${hodName}, this request was approved by HOD1 (${staffName}) and now needs your HOD2 approval and engineer assignment.`,
            rows: [
              { label: "Ticket ID", value: request.ticketId },
              { label: "Department", value: targetDept.department },
              { label: "Category", value: request.departmentCategory || "N/A" },
              { label: "Priority", value: request.priority || "N/A" },
              { label: "Status", value: request.status },
              { label: "Subject", value: request.subject },
              { label: "Description", value: request.description },
              { label: "Location", value: request.location || "N/A" },
              { label: "Raised By", value: requesterName },
            ],
            outro: "Please log in to MET Helpdesk to approve as HOD2 and assign an engineer.",
          });

          return sendEmail(hod.email, emailSubject, emailHtml).catch((err) =>
            console.error(`Failed to send HOD2 mail to ${hod.email}`, err)
          );
        });

        await Promise.all(emailPromises);
      }
    }

    return res.status(200).json({ success: true, message: "HOD1 approval done successfully.", data: request });
  } catch (error) {
    console.error("Error hod1ApproveRequest:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to approve as HOD1",
    });
  }
};

/* ========================= HOD2 APPROVE ========================= */

exports.hod2ApproveRequest = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);
    const { id } = req.params;
    const { comment, assignStaffId } = req.body;

    const request = await Request.findByPk(id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    if (!request.hod1Approval) {
      return res.status(400).json({ success: false, message: "HOD1 approval is required before HOD2 approval." });
    }
    if (request.hod2Approval) {
      return res.status(400).json({ success: false, message: "HOD2 already approved this request." });
    }
    if (!assignStaffId) {
      return res.status(400).json({ success: false, message: "assignStaffId is required (engineer to assign)." });
    }

    // ✅ active dept must match target dept
    if (roleLower(staff) !== "superadmin") {
      const activeDeptId = ensureActiveDeptAllowed(staff, req);
      if (Number(activeDeptId) !== Number(request.departmentId)) {
        return res.status(403).json({
          success: false,
          message: "Active department mismatch. Switch active department to target department for HOD2 approval.",
        });
      }
    }

    const currentDeptIds = deptIdsOf(staff);
    const isHod2Role = isAdminLike(staff);
    const isTargetDeptHod = currentDeptIds.includes(request.departmentId);

    if (!isHod2Role || !isTargetDeptHod) {
      return res.status(403).json({
        success: false,
        message: "You are not HOD2 for this target department (admin/subadmin of target dept required).",
      });
    }

    const assignee = await Staff.findByPk(assignStaffId);
    if (!assignee) return res.status(404).json({ success: false, message: `Engineer staff not found for id: ${assignStaffId}` });

    if (!isEngineerLike(assignee)) {
      return res.status(400).json({ success: false, message: "assignStaffId must be an engineer." });
    }

    if (!hasDeptAccess(assignee, request.departmentId)) {
      return res.status(400).json({
        success: false,
        message: "Engineer must belong to the same target department where request is raised.",
      });
    }

    request.hod2Approval = true;
    request.hod2Comment = comment || null;
    request.hod2ApprovedAt = new Date();
    request.hod2ApprovedById = staff.id;

    request.assignStaffId = assignStaffId;
    request.assignedAt = new Date();
    request.assignedById = staff.id;

    request.status = "in-progress";
    request.lastStatusChangedAt = new Date();

    await request.save();

    if (roleLower(staff) === "subadmin") {
      await SubadminActivity.create({
        subadminId: staff.id,
        departmentId: request.departmentId,
        actionTaken: "REQUEST_HOD2_APPROVE_ASSIGN",
        entityType: 'REQUEST',
        entityId: request.id,
      });
    }

    // mail to engineer (optional)
    try {
      const targetDept = await Department.findByPk(request.departmentId);
      const requester = await Staff.findByPk(request.staffId);

      const requesterName = requester ? getStaffFullName(requester) : "Requester";
      const assigneeName = getStaffFullName(assignee);
      const hod2Name = getStaffFullName(staff);

      const htmlEngineer = renderEmailLayout({
        title: "Request Assigned to You",
        intro: `Dear ${assigneeName}, this request was approved by HOD2 (${hod2Name}) and assigned to you.`,
        rows: [
          { label: "Ticket ID", value: request.ticketId },
          { label: "Department", value: targetDept?.department || "N/A" },
          { label: "Category", value: request.departmentCategory || "N/A" },
          { label: "Priority", value: request.priority || "N/A" },
          { label: "Status", value: request.status },
          { label: "Subject", value: request.subject },
          { label: "Description", value: request.description },
          { label: "Location", value: request.location || "N/A" },
          { label: "Raised By", value: requesterName },
        ],
        outro: "Please log in to MET Helpdesk and process this request.",
      });

      if (assignee.email) {
        sendEmail(assignee.email, buildTicketSubject(request.ticketId, request.subject), htmlEngineer).catch((err) =>
          console.error(`Failed to send engineer mail to ${assignee.email}`, err)
        );
      }
    } catch (e) {
      console.error("Error sending engineer mail after HOD2:", e);
    }

    return res.status(200).json({
      success: true,
      message: "HOD2 approval done and request assigned to engineer.",
      data: request,
    });
  } catch (error) {
    console.error("Error hod2ApproveRequest:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to approve as HOD2",
    });
  }
};

/* ========================= REJECT REQUEST ========================= */

exports.rejectRequest = async (req, res) => {
  try {
    const staff = await getCurrentStaff(req);
    const { id } = req.params;
    const { comment } = req.body;

    if (!comment || !comment.trim()) {
      return res.status(400).json({ success: false, message: "Rejection comment is required." });
    }

    const request = await Request.findByPk(id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    if (["closed", "rejected"].includes(String(request.status || "").toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: `Request is already ${request.status}. You cannot reject it now.`,
      });
    }

    if (!isAdminLike(staff)) {
      return res.status(403).json({ success: false, message: "Only admin / subadmin can reject a request." });
    }

    const requester = await Staff.findByPk(request.staffId);
    if (!requester) {
      return res.status(400).json({ success: false, message: `Requester staff not found for id: ${request.staffId}` });
    }

    const requesterDeptIds = deptIdsOf(requester);
    const staffDeptIds = deptIdsOf(staff);

    const commonDeptId = requesterDeptIds.find((d) => staffDeptIds.includes(d)); // HOD1 dept
    const isHod1ForRequester = Boolean(commonDeptId);
    const isHod2ForTarget = staffDeptIds.includes(request.departmentId); // HOD2 dept

    if (!isHod1ForRequester && !isHod2ForTarget) {
      return res.status(403).json({
        success: false,
        message: "You are not HOD1/HOD2 for this request (admin/subadmin of requester or target dept required).",
      });
    }

    // ✅ active dept enforcement
    if (roleLower(staff) !== "superadmin") {
      const activeDeptId = ensureActiveDeptAllowed(staff, req);

      if (isHod2ForTarget) {
        if (Number(activeDeptId) !== Number(request.departmentId)) {
          return res.status(403).json({
            success: false,
            message: "Active department mismatch. Switch active department to target department for HOD2 rejection.",
          });
        }
      } else if (commonDeptId) {
        if (Number(activeDeptId) !== Number(commonDeptId)) {
          return res.status(403).json({
            success: false,
            message: "Active department mismatch. Switch active department to requester department for HOD1 rejection.",
          });
        }
      }
    }

    const rejectionLevel = isHod2ForTarget ? "HOD2" : "HOD1";

    request.status = "rejected";
    request.rejectedById = staff.id;
    request.rejectedByLevel = rejectionLevel;
    request.rejectionComment = comment.trim();
    request.rejectedAt = new Date();

    await request.save();

    if (roleLower(staff) === "subadmin") {
      const activityDepartmentId =
        rejectionLevel === "HOD2"
          ? request.departmentId
          : commonDeptId || request.departmentId;

      await SubadminActivity.create({
        subadminId: staff.id,
        departmentId: activityDepartmentId,
        actionTaken: rejectionLevel === "HOD2" ? "REQUEST_REJECT_HOD2" : "REQUEST_REJECT_HOD1",
        entityType: 'REQUEST',
        entityId: request.id,
      });
    }

    // mail to requester (optional)
    try {
      const targetDept = await Department.findByPk(request.departmentId);
      const requesterName = getStaffFullName(requester);
      const rejectorName = getStaffFullName(staff);

      const html = renderEmailLayout({
        title: "Request Rejected",
        intro: `Dear ${requesterName}, your request was rejected by ${rejectionLevel} (${rejectorName}).`,
        rows: [
          { label: "Ticket ID", value: request.ticketId },
          { label: "Department", value: targetDept?.department || "N/A" },
          { label: "Subject", value: request.subject },
          { label: "Status", value: request.status },
          { label: "Rejection Reason", value: request.rejectionComment },
        ],
        outro: "If you believe this is incorrect, please contact your HOD or the helpdesk team.",
      });

      if (requester.email) {
        sendEmail(requester.email, buildTicketSubject(request.ticketId, request.subject), html).catch((err) =>
          console.error(`Failed to send rejection mail to ${requester.email}`, err)
        );
      }
    } catch (mailErr) {
      console.error("Error sending rejection mail:", mailErr);
    }

    return res.status(200).json({
      success: true,
      message: `Request rejected successfully by ${rejectionLevel}.`,
      data: request,
    });
  } catch (error) {
    console.error("Error rejectRequest:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to reject request",
    });
  }
};
