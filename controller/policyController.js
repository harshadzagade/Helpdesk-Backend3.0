// controller/policyController.js
const Policy = require('../models/policies');
const path = require('path');
const fs = require('fs');
const { Op, ARRAY, INTEGER } = require('sequelize');
const sequelize = require('../config/db');

let policyDepartmentColumnReady = false;

const ensurePolicyDepartmentColumn = async () => {
  if (policyDepartmentColumnReady) return;
  const queryInterface = sequelize.getQueryInterface();
  const table = await queryInterface.describeTable('policy');
  if (!table.departmentIds) {
    await queryInterface.addColumn('policy', 'departmentIds', {
      type: ARRAY(INTEGER),
      allowNull: false,
      defaultValue: [],
    });
  }
  policyDepartmentColumnReady = true;
};

const canManagePolicies = (user) =>
  String(user?.role || '').toLowerCase() === 'superadmin' || Boolean(user?.canManagePolicies);

const canViewPolicy = (user, policy) =>
  String(user?.role || '').toLowerCase() === 'superadmin' ||
  (
    Array.isArray(policy?.assignRole) &&
    policy.assignRole.includes(String(user?.role || '').toLowerCase()) &&
    (
      !Array.isArray(policy?.departmentIds) ||
      policy.departmentIds.length === 0 ||
      policy.departmentIds.some((id) => (user?.departmentIds || []).map(Number).includes(Number(id)))
    )
  );

const parseJsonArray = (value, fieldName) => {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      throw new Error(`${fieldName} valid JSON array hona chahiye`);
    }
  }
  throw new Error(`${fieldName} ek array hona chahiye`);
};

const parseDepartmentIds = (value) =>
  parseJsonArray(value, 'departmentIds')
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id));

const isPdfUpload = (file) => {
  if (!file) return true;
  const fileName = String(file.name || '').toLowerCase();
  const mimeType = String(file.mimetype || '').toLowerCase();
  return mimeType === 'application/pdf' || fileName.endsWith('.pdf');
};

const saveAttachment = async (file) => {
  // uploads/policies ke andar file save karenge
  const uploadDir = path.join(__dirname, '..', 'uploads', 'policies');

  // folder exist na ho to bana do
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const safeName = file.name.replace(/\s+/g, '_'); // spaces hatao
  const fileName = `${Date.now()}-${safeName}`;
  const uploadPath = path.join(uploadDir, fileName);

  // express-fileupload ka mv use karte hain
  await file.mv(uploadPath);

  // DB me yahi relative path store karenge
  return `/uploads/policies/${fileName}`;
};

// =======================
// CREATE
// POST /api/policies/createpolicy
// =======================
exports.createPolicy = async (req, res) => {
  try {
    await ensurePolicyDepartmentColumn();
    if (!canManagePolicies(req.user)) {
      return res.status(403).json({ message: 'You are not allowed to upload policies' });
    }

    let { policyName, assignRole, departmentIds } = req.body;

    if (!policyName || !assignRole) {
      return res
        .status(400)
        .json({ message: 'policyName aur assignRole required hai' });
    }

    try {
      assignRole = parseJsonArray(assignRole, 'assignRole').map((role) => String(role).toLowerCase().trim()).filter(Boolean);
      departmentIds = parseDepartmentIds(departmentIds);
    } catch (e) {
      return res.status(400).json({ message: e.message });
    }

    // File handle
    let attachmentPath = null;
    if (req.files && req.files.attachment) {
      if (!isPdfUpload(req.files.attachment)) {
        return res.status(400).json({ message: 'Only PDF files are allowed for policies' });
      }
      attachmentPath = await saveAttachment(req.files.attachment);
    }

    const policy = await Policy.create({
      policyName,
      assignRole,
      departmentIds,
      attachment: attachmentPath,
    });

    return res
      .status(201)
      .json({ message: 'Policy created successfully', data: policy });
  } catch (err) {
    console.error('Error creating policy:', err);
    return res
      .status(500)
      .json({ message: 'Internal server error', error: err.message });
  }
};

// =======================
// READ ALL
// GET /api/policies/
// =======================
// GET /api/policies
exports.getAllPolicies = async (req, res) => {
  try {
    await ensurePolicyDepartmentColumn();
    // authMiddleware me jo user set kiya hoga
    const userRole = req.user.role; // make sure authMiddleware me role aa raha ho

    let policies;

    // superadmin ko sab dikhana hai
    if (userRole === 'superadmin') {
      policies = await Policy.findAll({
        order: [['id', 'DESC']],
      });
    } else {
      const userDepartmentIds = Array.isArray(req.user.departmentIds)
        ? req.user.departmentIds.map(Number)
        : [];

      // role match + department scope: empty departmentIds means visible to all departments
      policies = await Policy.findAll({
        where: {
          [Op.and]: [
            { assignRole: { [Op.contains]: [userRole] } },
            {
              [Op.or]: [
                { departmentIds: { [Op.eq]: [] } },
                { departmentIds: { [Op.overlap]: userDepartmentIds } },
              ],
            },
          ],
        },
        order: [['id', 'DESC']],
      });
    }

    return res.status(200).json({
      message: 'Policies fetched successfully',
      data: policies,
    });
  } catch (err) {
    console.error('Error fetching policies:', err);
    return res.status(500).json({
      message: 'Internal server error',
      error: err.message,
    });
  }
};


// =======================
// READ ONE
// GET /api/policies/:id
// =======================
exports.getPolicyById = async (req, res) => {
  try {
    await ensurePolicyDepartmentColumn();
    const { id } = req.params;

    const policy = await Policy.findByPk(id);

    if (!policy) {
      return res.status(404).json({ message: 'Policy not found' });
    }

    if (!canViewPolicy(req.user, policy)) {
      return res.status(403).json({ message: 'You are not allowed to view this policy' });
    }

    return res
      .status(200)
      .json({ message: 'Policy fetched successfully', data: policy });
  } catch (err) {
    console.error('Error fetching policy:', err);
    return res
      .status(500)
      .json({ message: 'Internal server error', error: err.message });
  }
};

// =======================
// UPDATE
// PUT /api/policies/updatepolicy/:id
// =======================
exports.updatePolicy = async (req, res) => {
  try {
    await ensurePolicyDepartmentColumn();
    if (!canManagePolicies(req.user)) {
      return res.status(403).json({ message: 'You are not allowed to update policies' });
    }

    const { id } = req.params;
    let { policyName, assignRole, departmentIds } = req.body;

    const policy = await Policy.findByPk(id);

    if (!policy) {
      return res.status(404).json({ message: 'Policy not found' });
    }

    if (assignRole !== undefined) {
      try {
        policy.assignRole = parseJsonArray(assignRole, 'assignRole').map((role) => String(role).toLowerCase().trim()).filter(Boolean);
      } catch (e) {
        return res.status(400).json({ message: e.message });
      }
    }

    if (departmentIds !== undefined) {
      try {
        policy.departmentIds = parseDepartmentIds(departmentIds);
      } catch (e) {
        return res.status(400).json({ message: e.message });
      }
    }

    if (policyName !== undefined) {
      policy.policyName = policyName;
    }

    // agar new file aaye to replace
    if (req.files && req.files.attachment) {
      if (!isPdfUpload(req.files.attachment)) {
        return res.status(400).json({ message: 'Only PDF files are allowed for policies' });
      }
      const attachmentPath = await saveAttachment(req.files.attachment);

      // (optional) purane file ko delete kar sakte ho:
      // if (policy.attachment) {
      //   const oldPath = path.join(__dirname, '..', policy.attachment);
      //   if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      // }

      policy.attachment = attachmentPath;
    }

    await policy.save();

    return res
      .status(200)
      .json({ message: 'Policy updated successfully', data: policy });
  } catch (err) {
    console.error('Error updating policy:', err);
    return res
      .status(500)
      .json({ message: 'Internal server error', error: err.message });
  }
};

// =======================
// DELETE
// DELETE /api/policies/deletepolicy/:id
// =======================
exports.deletePolicy = async (req, res) => {
  try {
    await ensurePolicyDepartmentColumn();
    if (!canManagePolicies(req.user)) {
      return res.status(403).json({ message: 'You are not allowed to delete policies' });
    }

    const { id } = req.params;

    const policy = await Policy.findByPk(id);

    if (!policy) {
      return res.status(404).json({ message: 'Policy not found' });
    }

    // (optional) file delete karna ho to:
    // if (policy.attachment) {
    //   const filePath = path.join(__dirname, '..', policy.attachment);
    //   if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    // }

    await policy.destroy();

    return res.status(200).json({ message: 'Policy deleted successfully' });
  } catch (err) {
    console.error('Error deleting policy:', err);
    return res
      .status(500)
      .json({ message: 'Internal server error', error: err.message });
  }
};
