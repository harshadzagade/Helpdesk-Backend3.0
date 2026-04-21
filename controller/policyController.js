// controller/policyController.js
const Policy = require('../models/policies');
const path = require('path');
const fs = require('fs');
const { Op } = require('sequelize');

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
    let { policyName, assignRole } = req.body;

    if (!policyName || !assignRole) {
      return res
        .status(400)
        .json({ message: 'policyName aur assignRole required hai' });
    }

    // frontend se JSON string aa sakti hai: '["admin","user"]'
    if (typeof assignRole === 'string') {
      try {
        assignRole = JSON.parse(assignRole);
      } catch (e) {
        return res
          .status(400)
          .json({ message: 'assignRole valid JSON array hona chahiye' });
      }
    }

    if (!Array.isArray(assignRole)) {
      return res
        .status(400)
        .json({ message: 'assignRole ek array hona chahiye' });
    }

    // File handle
    let attachmentPath = null;
    if (req.files && req.files.attachment) {
      attachmentPath = await saveAttachment(req.files.attachment);
    }

    const policy = await Policy.create({
      policyName,
      assignRole,
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
    // authMiddleware me jo user set kiya hoga
    const userRole = req.user.role; // make sure authMiddleware me role aa raha ho

    let policies;

    // superadmin ko sab dikhana hai
    if (userRole === 'superadmin') {
      policies = await Policy.findAll({
        order: [['id', 'DESC']],
      });
    } else {
      // baaki sab ko sirf wohi policies jisme unka role assignRole array me hai
      policies = await Policy.findAll({
        where: {
          assignRole: {
            [Op.contains]: [userRole], // PostgreSQL ARRAY field ke liye
          },
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
    const { id } = req.params;

    const policy = await Policy.findByPk(id);

    if (!policy) {
      return res.status(404).json({ message: 'Policy not found' });
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
    const { id } = req.params;
    let { policyName, assignRole } = req.body;

    const policy = await Policy.findByPk(id);

    if (!policy) {
      return res.status(404).json({ message: 'Policy not found' });
    }

    // assignRole agar bheja hai to parse + validate
    if (assignRole !== undefined) {
      if (typeof assignRole === 'string') {
        try {
          assignRole = JSON.parse(assignRole);
        } catch (e) {
          return res
            .status(400)
            .json({ message: 'assignRole valid JSON array hona chahiye' });
        }
      }

      if (!Array.isArray(assignRole)) {
        return res
          .status(400)
          .json({ message: 'assignRole ek array hona chahiye' });
      }

      policy.assignRole = assignRole;
    }

    if (policyName !== undefined) {
      policy.policyName = policyName;
    }

    // agar new file aaye to replace
    if (req.files && req.files.attachment) {
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
