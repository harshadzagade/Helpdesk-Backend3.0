// routes/departmentRoute.js
const express = require('express');
const {
  createDepartment,
  getDepartments,
  getDepartmentById,
  updateDepartment,
  deleteDepartment
} = require('../controller/departmentController');

const { verifyToken, allowRoles } = require('../middleware/authMiddleware');

const router = express.Router();

// 🔒 Only superadmin can create
router.post('/createdepartment', verifyToken, allowRoles('superadmin'), createDepartment);

// Others (tune as you like)
router.get('/', verifyToken, getDepartments);
router.get('/:id', verifyToken, getDepartmentById);
router.put('/:id', verifyToken, allowRoles('superadmin'), updateDepartment);
router.delete('/:id', verifyToken, allowRoles('superadmin'), deleteDepartment);

module.exports = router;
