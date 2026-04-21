// routes/requestRoutes.js
const express = require('express');
const router = express.Router();
const {
  createRequest,
  getAllRequests,
  getRequestById,
  incomingRequests,
  myRequests,
  departmentRequests,
  closeRequest,
  forwardRequest,
  hod1ApproveRequest,
  hod2ApproveRequest,
  rejectRequest
} = require('../controller/requestController');
const { verifyToken } = require('../middleware/authMiddleware');
const activeDepartment = require('../middleware/activeDepartment');

// Create request
router.post('/send-request', verifyToken, createRequest);

// List routes
router.get('/', verifyToken, getAllRequests);

// ✅ Active dept required
router.get('/incoming', verifyToken, activeDepartment, incomingRequests);

router.get('/my-requests', verifyToken, myRequests);

// ✅ Active dept required
router.get('/department-requests', verifyToken, activeDepartment, departmentRequests);

// HOD approvals (✅ Active dept required)
router.patch('/:id/hod1-approve', verifyToken, activeDepartment, hod1ApproveRequest);
router.patch('/:id/hod2-approve', verifyToken, activeDepartment, hod2ApproveRequest);

// Forward & Close (✅ Active dept required)
router.patch('/:id/forward', verifyToken, activeDepartment, forwardRequest);
router.patch('/:id/close', verifyToken, activeDepartment, closeRequest);

// Reject (✅ Active dept required)  — NOTE: keep this BEFORE "/:id" GET
router.patch('/:id/reject', verifyToken, activeDepartment, rejectRequest);

// ALWAYS LAST
router.get('/:id', verifyToken, getRequestById);

module.exports = router;
