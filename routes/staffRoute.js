// routes/staffRoute.js
const express = require('express');
const {
  createStaff,
  getStaff,
  getStaffById,
  updateStaff,
  deleteStaff,

  // archive
  getArchivedStaff,
  getArchivedStaffById,
  recoverStaff,
  permanentDeleteStaff,

  // ✅ NEW: admin scoped role change
  updateStaffRoleScoped,
} = require('../controller/staffController');

const { verifyToken, allowRoles } = require('../middleware/authMiddleware');
const activeDepartment = require('../middleware/activeDepartment');

const router = express.Router();

// ====================== ACTIVE STAFF ======================
router.post('/createstaff', verifyToken, allowRoles('superadmin'), createStaff);
router.get('/', verifyToken, getStaff);

// ✅ Admin + Superadmin can change role (admin only for own dept)
router.patch('/role/:id', verifyToken, activeDepartment, allowRoles('admin', 'superadmin'), updateStaffRoleScoped);

// ====================== ARCHIVE STAFF ======================
router.get('/archiveStaff', verifyToken, allowRoles('superadmin'), getArchivedStaff);
router.get('/archived/:id', verifyToken, allowRoles('superadmin'), getArchivedStaffById);
router.post('/recover/:id', verifyToken, allowRoles('superadmin'), recoverStaff);
router.delete('/permanent/:id', verifyToken, allowRoles('superadmin'), permanentDeleteStaff);

// ====================== SINGLE STAFF (KEEP LAST) ======================
router.get('/:id', verifyToken, getStaffById);
router.put('/:id', verifyToken, allowRoles('superadmin'), updateStaff);
router.delete('/:id', verifyToken, allowRoles('superadmin'), deleteStaff);

module.exports = router;
