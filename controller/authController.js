const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Staff = require('../models/staff');
const { renderEmailLayout, sendMail } = require('../utils/mailer');

const makeOtp = () => String(Math.floor(100000 + Math.random() * 900000)); // 6-digit OTP
const AUTH_TOKEN_EXPIRES_IN = '8h';

// Helper to construct full name
const getFullName = (staff) => {
  return `${staff.firstname} ${staff.middlename || ''} ${staff.lastname}`.trim();
};

// Register Staff (only Superadmin can do this)
exports.register = async (req, res) => {
  try {
    const {
      firstname, middlename, lastname,
      email, password, role,
      instituteId, departmentIds, // ✅ new fields
      employeeType,               // ✅ departmentType ki jagah
      phoneNumber, contactExtension, isNew
    } = req.body;

    // Basic validation
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    if (!firstname || !lastname || !role || !employeeType) {
      return res.status(400).json({ message: 'firstname, lastname, role, employeeType are required' });
    }

    // ✅ instituteId must be integer
    const instId = Number(instituteId);
    if (!Number.isInteger(instId)) {
      return res.status(400).json({ message: 'Valid instituteId (integer) is required' });
    }

    // ✅ departmentIds must be array of integers
    let deptIds = departmentIds;
    if (typeof deptIds === 'string') {
      deptIds = deptIds.split(',').map(x => Number(x.trim())).filter(Number.isInteger);
    }
    if (!Array.isArray(deptIds) || deptIds.length === 0) {
      return res.status(400).json({ message: 'departmentIds must be a non-empty array of integers' });
    }

    const existing = await Staff.findOne({ where: { email: email.trim().toLowerCase() } });
    if (existing) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const staff = await Staff.create({
      firstname: String(firstname).trim(),
      middlename: String(middlename ?? '').trim(),
      lastname: String(lastname).trim(),
      email: String(email).trim().toLowerCase(),
      password: hashedPassword,
      role: String(role).toLowerCase().trim(),

      instituteId: instId,
      departmentIds: deptIds,

      employeeType: String(employeeType).trim(),
      phoneNumber: phoneNumber ?? null,
      contactExtension: contactExtension ?? null,
      isNew: isNew !== undefined ? Boolean(isNew) : true
    });

    res.status(201).json({ message: 'Staff registered successfully', staff });
  } catch (error) {
    console.error('Error in register:', error);
    res.status(500).json({ message: 'Error creating staff', error: error.message });
  }
};

// Login
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Basic validation
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const staff = await Staff.findOne({ where: { email } });
    if (!staff) {
      return res.status(404).json({ message: 'User not found' });
    }

    const isMatch = await bcrypt.compare(password, staff.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Check if isNew is true
    if (staff.isNew) {
      return res.status(401).json({ 
        message: 'Please set your initial password first using the setInitialPassword endpoint.' 
      });
    }

    const fullName = getFullName(staff);

    const token = jwt.sign(
      { id: staff.id, email: staff.email, name: fullName, role: staff.role },
      process.env.JWT_SECRET,
      { expiresIn: AUTH_TOKEN_EXPIRES_IN }
    );

    res.status(200).json({
      message: 'Login successful',
      token,
      id: staff.id, // Added: Include staff ID for frontend use
      role: staff.role,
      name: fullName,
      email: staff.email,
      departmentIds: staff.departmentIds,
      canManageExtensions: Boolean(staff.canManageExtensions),
      canManagePolicies: Boolean(staff.canManagePolicies),
      expiresIn: AUTH_TOKEN_EXPIRES_IN,
    });
  } catch (error) {
    console.error('Error in login:', error);
    res.status(500).json({ message: 'Login error', error: error.message });
  }
};

// Set Initial Password (for new users with isNew = true)
exports.setInitialPassword = async (req, res) => {
  try {
    const { email, currentPassword, newPassword } = req.body;
    if (!email || !currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Email, current password, and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters long' });
    }
    const staff = await Staff.findOne({ where: { email } });
    if (!staff) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (!staff.isNew) {
      return res.status(400).json({ message: 'Initial password has already been set. Please login normally.' });
    }
    const isMatch = await bcrypt.compare(currentPassword, staff.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid current password' });
    }
    
    // Generate token FIRST (uses unchanged data)
    const fullName = getFullName(staff);
    const token = jwt.sign(
      { id: staff.id, email: staff.email, name: fullName, role: staff.role },
      process.env.JWT_SECRET,
      { expiresIn: AUTH_TOKEN_EXPIRES_IN }
    );
    
    // THEN update password and save
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    staff.password = hashedNewPassword;
    staff.isNew = false;
    await staff.save();
    
    res.status(200).json({
      message: 'Initial password set successfully. You are now logged in.',
      token,
      id: staff.id,
      role: staff.role,
      name: fullName,
      email: staff.email,
      canManageExtensions: Boolean(staff.canManageExtensions),
      canManagePolicies: Boolean(staff.canManagePolicies),
      expiresIn: AUTH_TOKEN_EXPIRES_IN,
    });
  } catch (error) {
    console.error('Error in setInitialPassword:', error);
    res.status(500).json({ message: 'Error setting initial password', error: error.message });
  }
};

const OTP_TTL_MIN = 10;

// (1) Send OTP for password reset
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const user = await Staff.findOne({ where: { email } });
    // Privacy-safe response: don't confirm if user exists
    if (!user) {
      return res.json({ message: 'If the email exists, an OTP has been sent' });
    }

    const otp = makeOtp();
    user.resetOtpHash = await bcrypt.hash(otp, 10);
    user.resetOtpExpiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);
    await user.save();

    // Send email with OTP
    await sendMail({
      to: email,
      subject: 'MET Helpdesk Password Reset OTP',
      html: renderEmailLayout({
        title: 'Password Reset OTP',
        intro: 'We received a request to reset your password. Use the OTP below to continue securely.',
        rows: [
          { label: 'OTP', value: otp },
          { label: 'Valid For', value: `${OTP_TTL_MIN} minutes` },
        ],
        outro: "If you didn't request this, you can safely ignore this email.",
      }),
      text: `Your OTP is ${otp}. It expires in ${OTP_TTL_MIN} minutes. If you didn't request this, ignore this email.`
    });

    if (process.env.NODE_ENV !== 'production') {
      console.log('[DEV] OTP sent to', email, '=>', otp);
    }

    return res.json({ message: 'If the email exists, an OTP has been sent' });
  } catch (error) {
    console.error('Error in forgotPassword:', error);
    return res.status(500).json({ message: 'Failed to start reset', error: error.message });
  }
};

// (2) Verify OTP (for UI confirmation)
exports.verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    const user = await Staff.findOne({ where: { email } });
    // Privacy-safe: treat missing user or fields as invalid OTP
    if (!user || !user.resetOtpHash || !user.resetOtpExpiresAt) {
      return res.status(400).json({ message: 'Invalid or expired OTP' });
    }

    // Check expiry
    if (new Date(user.resetOtpExpiresAt).getTime() < Date.now()) {
      user.resetOtpHash = null;
      user.resetOtpExpiresAt = null;
      await user.save();
      return res.status(400).json({ message: 'OTP expired. Please request a new one.' });
    }

    const isValid = await bcrypt.compare(String(otp), user.resetOtpHash);
    if (!isValid) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    return res.json({ message: 'OTP verified successfully' });
  } catch (error) {
    console.error('Error in verifyOtp:', error);
    return res.status(500).json({ message: 'Verify failed', error: error.message });
  }
};

// (3) Reset password using OTP
exports.resetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ message: 'Email, OTP, and newPassword are required' });
    }

    // Basic password validation (e.g., min length)
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters long' });
    }

    const user = await Staff.findOne({ where: { email } });
    // Privacy-safe: treat missing user or fields as invalid OTP
    if (!user || !user.resetOtpHash || !user.resetOtpExpiresAt) {
      return res.status(400).json({ message: 'Invalid or expired OTP' });
    }

    // Check expiry
    if (new Date(user.resetOtpExpiresAt).getTime() < Date.now()) {
      user.resetOtpHash = null;
      user.resetOtpExpiresAt = null;
      await user.save();
      return res.status(400).json({ message: 'OTP expired. Please request a new one.' });
    }

    const isValid = await bcrypt.compare(String(otp), user.resetOtpHash);
    if (!isValid) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    // Update password and clear OTP fields
    user.password = await bcrypt.hash(newPassword, 10);
    user.resetOtpHash = null;
    user.resetOtpExpiresAt = null;
    await user.save();

    return res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error('Error in resetPassword:', error);
    return res.status(500).json({ message: 'Reset failed', error: error.message });
  }
};
