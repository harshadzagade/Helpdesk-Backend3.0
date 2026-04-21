const jwt = require('jsonwebtoken');
const Staff = require('../models/staff');

// ✅ verify token + hydrate user from DB (departmentIds guaranteed)
exports.verifyToken = async (req, res, next) => {
  try {
    const header = req.headers['authorization'];
    if (!header) return res.status(403).json({ message: 'No token provided' });

    const token = header.startsWith('Bearer ') ? header.split(' ')[1] : null;
    if (!token) return res.status(403).json({ message: 'No token provided' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.id) return res.status(401).json({ message: 'Invalid token' });

    // ✅ Pull latest user from DB
    const staff = await Staff.findByPk(decoded.id, {
      attributes: ['id', 'email', 'role', 'departmentIds', 'instituteId']
    });

    if (!staff) return res.status(401).json({ message: 'Invalid token' });

    // ✅ Always consistent req.user
    req.user = {
      id: staff.id,
      email: staff.email,
      role: staff.role,
      instituteId: staff.instituteId,
      departmentIds: Array.isArray(staff.departmentIds) ? staff.departmentIds : [],
    };

    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token', error: err.message });
  }
};

// Role-based access control
exports.allowRoles = (...roles) => {
  return (req, res, next) => {
    const userRole = String(req.user?.role || '').toLowerCase();
    const allowed = roles.map(r => String(r).toLowerCase());
    if (!allowed.includes(userRole)) {
      return res.status(403).json({ message: 'Access denied: insufficient permissions' });
    }
    next();
  };
};
