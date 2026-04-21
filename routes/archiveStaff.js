const express = require('express');
const {
  recoverStaff, permanentDeleteStaff, getArchivedStaff, getArchivedStaffById
} = require('../controller/staffController');
const { verifyToken, allowRoles } = require('../middleware/authMiddleware');

const router = express.Router();
router.get('/archiveStaff', verifyToken, allowRoles('superadmin'), getArchivedStaff);
router.post('/recover/:id', verifyToken, allowRoles('superadmin'), recoverStaff);
router.delete('/permanent/:id', verifyToken, allowRoles('superadmin'), permanentDeleteStaff);
router.get('/archived/:id', verifyToken, allowRoles('superadmin'), getArchivedStaffById);

module.exports = router;