const express = require('express');
const router = express.Router();

const {
  createComplaint,
  getAllComplaints,
  getComplaintById,
  incommingComplaints,
  myComplaints,
  departmentComplaints,
  assignComplaintToSelf,
  assignComplaintToStaff, // ✅ NEW
  closeComplaint,
  forwardComplaint,
} = require('../controller/complaintController');

const { verifyToken, allowRoles } = require('../middleware/authMiddleware');
const activeDepartment = require('../middleware/activeDepartment');

// Create complaint
router.post('/send-complaint', verifyToken, createComplaint);

// Get all complaints
router.get('/', verifyToken, getAllComplaints);

// Incoming complaints (activeDepartment middleware se deptId)
router.get('/incomming', verifyToken, activeDepartment, incommingComplaints);

// My complaints
router.get('/my-complaints', verifyToken, myComplaints);

// Department complaints
router.get(
  '/department-complaints',
  verifyToken,
  activeDepartment,
  departmentComplaints
);

// ✅ Self assign (engineer/subadmin/admin as per controller)
router.patch('/:id/assign-self', verifyToken, assignComplaintToSelf);

router.patch(
  '/:id/assign',
  verifyToken,
  allowRoles('admin', 'subadmin'),
  assignComplaintToStaff
);

// ✅ Forward complaint (ONLY assignee as per controller)
// body: { forwardToStaffId, forwardComment }
router.patch('/:id/forward', verifyToken, forwardComplaint);

// Close complaint
router.patch('/:id/close', verifyToken, closeComplaint);

// ALWAYS LAST
router.get('/:id', verifyToken, getComplaintById);

module.exports = router;
