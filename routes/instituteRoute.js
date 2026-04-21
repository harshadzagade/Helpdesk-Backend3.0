// routes/instituteRoute.js
const express = require('express');
const {
  createInstitute,
  getInstitutes,
  getInstituteById,
  updateInstitute,
  deleteInstitute
} = require('../controller/InstituteController');
const { verifyToken, allowRoles } = require('../middleware/authMiddleware');

const router = express.Router();

// 🔒 Only Superadmin can create institutes
router.post('/createinstitute', verifyToken, allowRoles('superadmin'), createInstitute);

// others as usual
router.get('/', verifyToken, getInstitutes);
router.get('/:id', verifyToken, getInstituteById);
router.put('/:id', verifyToken, allowRoles('superadmin'), updateInstitute);
router.delete('/:id', verifyToken, allowRoles('superadmin'), deleteInstitute);

module.exports = router;
