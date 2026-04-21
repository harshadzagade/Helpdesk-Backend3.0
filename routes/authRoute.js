const express = require('express');
const router = express.Router();
const { register, login, setInitialPassword, forgotPassword, verifyOtp, resetPassword } = require('../controller/authController');
const { verifyToken, allowRoles } = require('../middleware/authMiddleware');

// Public Routes
router.post('/login', login);

router.post('/set-initial-password', setInitialPassword);

// Protected (Superadmin only)
router.post('/register', verifyToken, allowRoles('superadmin'), register);

router.post('/forgot-password', forgotPassword);

router.post('/verify-otp', verifyOtp);

router.post('/reset-password', resetPassword);

module.exports = router;
