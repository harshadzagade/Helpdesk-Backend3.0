// controllers/staffController.js

const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');

const Staff = require('../models/staff');
const ArchiveStaff = require('../models/archiveStaff');
const { emailEnabled, renderEmailLayout, sendMail } = require('../utils/mailer');

const ALLOWED_ROLES = ['superadmin', 'admin', 'subadmin', 'engineer', 'user'];

// ------------------------- helpers -------------------------
const normalizeArray = (v) =>
  Array.isArray(v)
    ? v
    : (typeof v === 'string'
      ? v.split(',').map(s => s.trim()).filter(Boolean)
      : undefined);

const normalizeIntArray = (v) => {
  const arr = normalizeArray(v);
  if (!arr) return [];
  return arr
    .map(x => Number(String(x).trim()))
    .filter(n => Number.isInteger(n));
};

const toIntOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

const toBool = (value) => value === true || value === 'true' || value === 1 || value === '1';

const scrub = (s) => {
  if (!s) return s;
  const { password, ...safe } = s.get ? s.get({ plain: true }) : s;
  return safe;
};

const isSuperadmin = (user) => String(user?.role || '').toLowerCase() === 'superadmin';
const canManageExtensions = (user) => isSuperadmin(user) || Boolean(user?.canManageExtensions);
const getAppUrl = () => String(process.env.APP_URL || 'https://hello.met.edu').replace(/\/+$/, '');

const sendWelcomeMail = async (staff, temporaryPassword) => {
  const loginUrl = getAppUrl();
  return transporter.sendMail({
    to: staff.email,
    subject: 'Welcome to MET Helpdesk',
    html: renderEmailLayout({
      title: `Welcome, ${staff.firstname}`,
      intro: 'Your MET Helpdesk account has been created successfully. Use the temporary password below for your first sign-in.',
      rows: [
        { label: 'Portal URL', value: loginUrl },
        { label: 'Email', value: staff.email },
        { label: 'Temporary Password', value: temporaryPassword },
        { label: 'Role', value: staff.role },
      ],
      outro: 'On your first sign-in, the portal will ask you to create your own new password.',
    }),
    text: `Welcome ${staff.firstname}
Portal URL: ${loginUrl}
Email: ${staff.email}
Temporary Password: ${temporaryPassword}
Role: ${staff.role}

On your first sign-in, the portal will ask you to create your own new password.

Regards,
MET Helpdesk`
  });
};

// ------------------------- mail (PEHLE JAISA: hardcoded) -------------------------
if (!emailEnabled) {
  console.log('Email delivery disabled; staff notification emails will be skipped.');
}

const transporter = {
  verify: () => {},
  sendMail,
};

// optional debug
transporter.verify((err) => {
  if (err) console.error('❌ Mail transporter error:', err.message);
  else console.log('✅ Mail transporter ready');
});

// ------------------------- validations -------------------------
/** One departmentId -> only one admin */
const validateAdminDepartments = async (proposedDeptIds, excludeId = null) => {
  if (!proposedDeptIds || proposedDeptIds.length === 0) return true;

  for (const deptId of proposedDeptIds) {
    const existingAdmin = await Staff.findOne({
      where: {
        role: 'admin',
        departmentIds: { [Op.contains]: [deptId] },
        ...(excludeId && { id: { [Op.ne]: excludeId } })
      }
    });

    if (existingAdmin) {
      throw new Error(`DepartmentId "${deptId}" already assigned to another admin`);
    }
  }
  return true;
};

// ============================================================
// 1) CREATE (Superadmin only)
// ============================================================
exports.createStaff = async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'superadmin') {
      return res.status(403).json({ message: 'Only superadmin can create staff' });
    }

    const body = req.body || {};
    const {
      firstname,
      middlename,
      lastname,
      email,
      password, // optional
      role,
      instituteId,
      departmentIds,
      employeeType,
      phoneNumber,
      contactExtension,
      isNew
    } = body;

    const finalPassword = password || 'MetHelpdesk';
    const finalIsNew = isNew !== undefined ? Boolean(isNew) : true;

    const instId = toIntOrNull(instituteId);
    const deptIds = normalizeIntArray(departmentIds) ?? [];

    if (!firstname || !lastname || !email || !role || instId === null || deptIds.length === 0 || !employeeType) {
      return res.status(400).json({
        message: 'Missing required fields (firstname, lastname, email, role, instituteId, departmentIds, employeeType)'
      });
    }

    const roleLower = String(role).toLowerCase().trim();
    if (!ALLOWED_ROLES.includes(roleLower)) {
      return res.status(400).json({ message: `Invalid role. Allowed: ${ALLOWED_ROLES.join(', ')}` });
    }

    const exists = await Staff.findOne({ where: { email: String(email).trim().toLowerCase() } });
    if (exists) return res.status(409).json({ message: 'Email already in use' });

    if (roleLower === 'admin') {
      try {
        await validateAdminDepartments(deptIds);
      } catch (err) {
        return res.status(400).json({ message: err.message });
      }
    }

    const hashed = await bcrypt.hash(finalPassword, 10);

    const created = await Staff.create({
      firstname: String(firstname).trim(),
      middlename: String(middlename ?? '').trim(),
      lastname: String(lastname).trim(),
      email: String(email).trim().toLowerCase(),
      password: hashed,
      role: roleLower,
      instituteId: instId,
      departmentIds: deptIds,
      employeeType: String(employeeType).trim(),
      phoneNumber: phoneNumber ?? null,
      contactExtension: contactExtension ?? null,
      canManageExtensions: toBool(body.canManageExtensions),
      canManagePolicies: toBool(body.canManagePolicies),
      isNew: finalIsNew
    });

    // ✅ Welcome mail (PEHLE JAISA: always try)
    try {
      await sendWelcomeMail(created, finalPassword);
      console.log('✅ Welcome mail sent to:', created.email);
    } catch (mailErr) {
      console.error('❌ Welcome mail failed:', mailErr.message);
    }

    return res.status(201).json({ message: 'Staff created', data: scrub(created) });
  } catch (err) {
    return res.status(500).json({ message: 'Create failed', error: err.message });
  }
};

// ============================================================
// 2) LIST (search & pagination) - Active staff
// ============================================================
exports.getStaff = async (req, res) => {
  try {
    const { q = '', role, instituteId, page = 1, limit = 20 } = req.query;

    const where = {};

    if (q) {
      where[Op.or] = [
        { firstname: { [Op.iLike]: `%${q}%` } },
        { lastname: { [Op.iLike]: `%${q}%` } },
        { email: { [Op.iLike]: `%${q}%` } }
      ];
    }

    if (role) where.role = String(role).toLowerCase();

    const instId = toIntOrNull(instituteId);
    if (instId !== null) where.instituteId = instId;

    const offset = (Number(page) - 1) * Number(limit);

    const { rows, count } = await Staff.findAndCountAll({
      where,
      attributes: { exclude: ['password'] },
      offset,
      limit: Number(limit),
      order: [['id', 'DESC']]
    });

    return res.json({
      data: rows,
      pagination: {
        total: count,
        page: Number(page),
        pages: Math.ceil(count / Number(limit)),
        limit: Number(limit)
      }
    });
  } catch (err) {
    return res.status(500).json({ message: 'Fetch failed', error: err.message });
  }
};

// ============================================================
// 3) READ by id - Active staff
// ============================================================
exports.getStaffById = async (req, res) => {
  try {
    const item = await Staff.findByPk(req.params.id, { attributes: { exclude: ['password'] } });
    if (!item) return res.status(404).json({ message: 'Staff not found' });
    return res.json({ data: item });
  } catch (err) {
    return res.status(500).json({ message: 'server Fetch failed', error: err.message });
  }
};

// ============================================================
// 4) UPDATE (Superadmin only) - full update
// ============================================================
exports.updateStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    const item = await Staff.findByPk(id);
    if (!item) return res.status(404).json({ message: 'Staff not found' });

    const proposedRole =
      body.role !== undefined ? String(body.role).toLowerCase().trim() : String(item.role).toLowerCase().trim();

    const proposedInstituteId =
      body.instituteId !== undefined ? toIntOrNull(body.instituteId) : item.instituteId;

    const proposedDeptIds =
      body.departmentIds !== undefined ? (normalizeIntArray(body.departmentIds) ?? []) : item.departmentIds;

    if (body.role !== undefined && proposedRole) {
      if (!ALLOWED_ROLES.includes(proposedRole)) {
        return res.status(400).json({ message: `Invalid role. Allowed: ${ALLOWED_ROLES.join(', ')}` });
      }

      const currentIsSuper = String(item.role).toLowerCase() === 'superadmin';
      const becomesNonSuper = proposedRole !== 'superadmin';
      if (currentIsSuper && becomesNonSuper) {
        const superCount = await Staff.count({ where: { role: 'superadmin' } });
        if (superCount <= 1) {
          return res.status(403).json({ message: 'Cannot downgrade the last superadmin' });
        }
      }

      item.role = proposedRole;
    }

    if (proposedRole === 'admin') {
      try {
        await validateAdminDepartments(proposedDeptIds, id);
      } catch (err) {
        return res.status(400).json({ message: err.message });
      }
    }

    if (body.firstname !== undefined) item.firstname = String(body.firstname).trim();
    if (body.middlename !== undefined) item.middlename = String(body.middlename).trim();
    if (body.lastname !== undefined) item.lastname = String(body.lastname).trim();

    if (body.email !== undefined) {
      const newEmail = String(body.email).trim().toLowerCase();
      if (!newEmail) return res.status(400).json({ message: 'Email cannot be empty' });

      const dupe = await Staff.findOne({ where: { email: newEmail, id: { [Op.ne]: id } } });
      if (dupe) return res.status(409).json({ message: 'Email already in use' });

      item.email = newEmail;
    }

    if (body.password !== undefined && String(body.password).trim()) {
      item.password = await bcrypt.hash(String(body.password), 10);
    }

    if (proposedInstituteId === null) {
      return res.status(400).json({ message: 'Invalid instituteId' });
    }
    item.instituteId = proposedInstituteId;

    if (!proposedDeptIds || proposedDeptIds.length === 0) {
      return res.status(400).json({ message: 'departmentIds cannot be empty' });
    }
    item.departmentIds = proposedDeptIds;

    if (body.employeeType !== undefined) item.employeeType = String(body.employeeType).trim();

    if (body.phoneNumber !== undefined) {
      item.phoneNumber = body.phoneNumber === null || body.phoneNumber === '' ? null : body.phoneNumber;
    }

    if (body.contactExtension !== undefined) {
      item.contactExtension = body.contactExtension === '' ? null : String(body.contactExtension);
    }

    if (body.canManageExtensions !== undefined) {
      item.canManageExtensions = toBool(body.canManageExtensions);
    }

    if (body.canManagePolicies !== undefined) {
      item.canManagePolicies = toBool(body.canManagePolicies);
    }

    if (body.isNew !== undefined) item.isNew = Boolean(body.isNew);

    await item.save();

    return res.json({ message: 'Staff updated', data: scrub(item) });
  } catch (err) {
    return res.status(500).json({ message: 'Update failed', error: err.message });
  }
};

exports.updateStaffPermissions = async (req, res) => {
  try {
    if (!isSuperadmin(req.user)) {
      return res.status(403).json({ message: 'Only superadmin can update staff permissions' });
    }

    const { id } = req.params;
    const target = await Staff.findByPk(id);
    if (!target) return res.status(404).json({ message: 'Staff not found' });

    if (req.body.canManageExtensions === undefined &&
        req.body.canUpdateExtensions === undefined &&
        req.body.canManagePolicies === undefined &&
        req.body.canUploadPolicies === undefined) {
      return res.status(400).json({
        message: 'Provide canManageExtensions/canUpdateExtensions and/or canManagePolicies/canUploadPolicies',
      });
    }

    const canManageExtensionsValue =
      req.body.canManageExtensions !== undefined
        ? toBool(req.body.canManageExtensions)
        : req.body.canUpdateExtensions !== undefined
          ? toBool(req.body.canUpdateExtensions)
          : target.canManageExtensions;

    const canManagePoliciesValue =
      req.body.canManagePolicies !== undefined
        ? toBool(req.body.canManagePolicies)
        : req.body.canUploadPolicies !== undefined
          ? toBool(req.body.canUploadPolicies)
          : target.canManagePolicies;

    target.canManageExtensions = canManageExtensionsValue;
    target.canManagePolicies = canManagePoliciesValue;
    await target.save();

    return res.json({
      message: 'Staff permissions updated successfully',
      data: scrub(target),
    });
  } catch (err) {
    return res.status(500).json({ message: 'Permission update failed', error: err.message });
  }
};

exports.updateStaffContactExtension = async (req, res) => {
  try {
    if (!canManageExtensions(req.user)) {
      return res.status(403).json({ message: 'You are not allowed to update employee extension numbers' });
    }

    const { id } = req.params;
    const { contactExtension } = req.body;

    if (contactExtension === undefined) {
      return res.status(400).json({ message: 'contactExtension is required' });
    }

    const target = await Staff.findByPk(id);
    if (!target) return res.status(404).json({ message: 'Staff not found' });

    target.contactExtension = contactExtension === '' || contactExtension === null
      ? null
      : String(contactExtension).trim();
    await target.save();

    return res.json({
      message: 'Contact extension updated successfully',
      data: scrub(target),
    });
  } catch (err) {
    return res.status(500).json({ message: 'Extension update failed', error: err.message });
  }
};

// ============================================================
// 5) ADMIN FEATURE: Role change only for own dept users
//    (Admin + Superadmin allowed)
//    - Admin can only assign: user/engineer/subadmin
//    - Admin cannot modify admin/superadmin
//    - Admin must share at least 1 deptId with target user
// ============================================================
exports.updateStaffRoleScoped = async (req, res) => {
  try {
    const actor = req.user;
    if (!actor || !actor.role) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const { role } = req.body;

    const newRole = String(role || '').toLowerCase().trim();
    if (!ALLOWED_ROLES.includes(newRole)) {
      return res.status(400).json({ message: `Invalid role. Allowed: ${ALLOWED_ROLES.join(', ')}` });
    }

    const target = await Staff.findByPk(id);
    if (!target) return res.status(404).json({ message: 'Staff not found' });

    const actorRole = String(actor.role).toLowerCase();
    const targetRole = String(target.role).toLowerCase();

    // superadmin: allow (with last superadmin protection)
    if (actorRole === 'superadmin') {
      if (targetRole === 'superadmin' && newRole !== 'superadmin') {
        const superCount = await Staff.count({ where: { role: 'superadmin' } });
        if (superCount <= 1) {
          return res.status(403).json({ message: 'Cannot downgrade the last superadmin' });
        }
      }
      target.role = newRole;
      await target.save();
      return res.json({ message: 'Role updated', data: scrub(target) });
    }

    // admin: scoped
    if (actorRole !== 'admin') {
      return res.status(403).json({ message: 'Only admin/superadmin can change roles' });
    }

    // admin cannot touch admin/superadmin
    if (targetRole === 'admin' || targetRole === 'superadmin') {
      return res.status(403).json({ message: 'Admin cannot change admin/superadmin roles' });
    }

    // admin can set only these roles
    const ADMIN_ASSIGNABLE = ['user', 'engineer', 'subadmin'];
    if (!ADMIN_ASSIGNABLE.includes(newRole)) {
      return res.status(403).json({ message: 'Admin can assign only: user, engineer, subadmin' });
    }

    // dept scope check (needs req.user.departmentIds)
    const actorDeptIds = normalizeIntArray(actor.departmentIds);
    const targetDeptIds = normalizeIntArray(target.departmentIds);

    if (!actorDeptIds.length) {
      return res.status(403).json({ message: 'Admin has no department access assigned' });
    }

    const sameDept = targetDeptIds.some(d => actorDeptIds.includes(d));
    if (!sameDept) {
      return res.status(403).json({ message: 'You can change role only for your department staff' });
    }

    target.role = newRole;
    await target.save();

    return res.json({ message: 'Role updated', data: scrub(target) });
  } catch (err) {
    return res.status(500).json({ message: 'Role update failed', error: err.message });
  }
};

// ============================================================
// 6) DELETE (Superadmin only) - archive then delete
// ============================================================
exports.deleteStaff = async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'superadmin') {
      return res.status(403).json({ message: 'Only superadmin can delete staff' });
    }

    const { id } = req.params;

    const fullItem = await Staff.findByPk(id);
    if (!fullItem) return res.status(404).json({ message: 'Staff not found' });

    if (String(fullItem.role).toLowerCase() === 'superadmin') {
      return res.status(403).json({ message: 'Superadmin cannot be deleted' });
    }

    await ArchiveStaff.create({
      firstname: fullItem.firstname,
      middlename: fullItem.middlename,
      lastname: fullItem.lastname,
      email: fullItem.email,
      password: fullItem.password,
      role: fullItem.role,
      instituteId: fullItem.instituteId,
      departmentIds: fullItem.departmentIds,
      employeeType: fullItem.employeeType,
      phoneNumber: fullItem.phoneNumber,
      contactExtension: fullItem.contactExtension,
      canManageExtensions: fullItem.canManageExtensions,
      canManagePolicies: fullItem.canManagePolicies,
      isNew: fullItem.isNew
    });

    await fullItem.destroy();

    return res.json({ message: 'Staff deleted and archived successfully' });
  } catch (err) {
    return res.status(500).json({ message: 'Delete failed', error: err.message });
  }
};

// ============================================================
// 7) LIST ARCHIVED STAFF (Superadmin only via route)
// ============================================================
exports.getArchivedStaff = async (req, res) => {
  try {
    const archivedStaffData = await ArchiveStaff.findAndCountAll({
      attributes: { exclude: ['password'] },
      order: [['id', 'DESC']]
    });
    return res.status(200).json(archivedStaffData);
  } catch (error) {
    return res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// ============================================================
// 8) RECOVER STAFF (Superadmin only)
// ============================================================
exports.recoverStaff = async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'superadmin') {
      return res.status(403).json({ message: 'Only superadmin can recover staff' });
    }

    const { id } = req.params;

    const archivedItem = await ArchiveStaff.findByPk(id);
    if (!archivedItem) return res.status(404).json({ message: 'Archived staff not found' });

    const emailExists = await Staff.findOne({ where: { email: archivedItem.email } });
    if (emailExists) return res.status(409).json({ message: 'Email already in use by active staff' });

    const roleLower = String(archivedItem.role).toLowerCase().trim();
    if (!ALLOWED_ROLES.includes(roleLower)) {
      return res.status(400).json({ message: `Invalid archived role: ${roleLower}` });
    }

    const deptIds = archivedItem.departmentIds || [];
    if (roleLower === 'admin') {
      try {
        await validateAdminDepartments(deptIds);
      } catch (err) {
        return res.status(400).json({ message: err.message });
      }
    }

    const recovered = await Staff.create({
      firstname: archivedItem.firstname,
      middlename: archivedItem.middlename,
      lastname: archivedItem.lastname,
      email: archivedItem.email,
      password: archivedItem.password,
      role: roleLower,
      instituteId: archivedItem.instituteId,
      departmentIds: deptIds,
      employeeType: archivedItem.employeeType,
      phoneNumber: archivedItem.phoneNumber,
      contactExtension: archivedItem.contactExtension,
      canManageExtensions: archivedItem.canManageExtensions,
      canManagePolicies: archivedItem.canManagePolicies,
      isNew: archivedItem.isNew
    });

    await archivedItem.destroy();

    // optional recovery mail
    try {
      await transporter.sendMail({
        to: recovered.email,
        subject: 'Your MET Helpdesk Account Has Been Recovered',
        html: renderEmailLayout({
          title: 'Account Recovery Notice',
          intro: 'Your account has been recovered and is active again.',
          rows: [
            { label: 'Email', value: recovered.email },
            { label: 'Role', value: recovered.role },
          ],
          outro: 'Please log in with your existing credentials.',
        }),
        text: `Account Recovery Notice
Your account has been recovered and is now active again.
Email: ${recovered.email}
Please log in with your existing credentials.
Helpdesk Team`
      });
      console.log('✅ Recovery mail sent to:', recovered.email);
    } catch (mailErr) {
      console.error('❌ Recovery mail failed:', mailErr.message);
    }

    return res.json({ message: 'Staff recovered successfully', data: scrub(recovered) });
  } catch (err) {
    return res.status(500).json({ message: 'Recovery failed', error: err.message });
  }
};

// ============================================================
// 9) PERMANENT DELETE FROM ARCHIVE (Superadmin only)
// ============================================================
exports.permanentDeleteStaff = async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'superadmin') {
      return res.status(403).json({ message: 'Only superadmin can permanently delete staff' });
    }

    const { id } = req.params;

    const archivedItem = await ArchiveStaff.findByPk(id);
    if (!archivedItem) return res.status(404).json({ message: 'Archived staff not found' });

    await archivedItem.destroy();

    return res.json({ message: 'Staff permanently deleted from archive' });
  } catch (err) {
    return res.status(500).json({ message: 'Permanent delete failed', error: err.message });
  }
};

// ============================================================
// 10) READ ARCHIVED by id (Superadmin only)
// ============================================================
exports.getArchivedStaffById = async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'superadmin') {
      return res.status(403).json({ message: 'Only superadmin can view archived staff' });
    }

    const item = await ArchiveStaff.findByPk(req.params.id, { attributes: { exclude: ['password'] } });
    if (!item) return res.status(404).json({ message: 'Archived staff not found' });

    return res.json({ data: item });
  } catch (err) {
    return res.status(500).json({ message: 'Fetch archived failed', error: err.message });
  }
};
