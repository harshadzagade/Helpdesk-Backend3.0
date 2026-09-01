const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const Staff = require('../models/staff');

let io = null;

const roomForUser = (id) => `user:${id}`;
const roomForRole = (role) => `role:${String(role || '').toLowerCase()}`;
const roomForDepartment = (id) => `department:${id}`;

const getAllowedOrigins = () => {
  const configured = String(process.env.FRONTEND_URL || process.env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return [...new Set([
    'http://localhost:5173',
    'http://hello.met.edu',
    'http://hello.met.edu:5173',
    'https://hello.met.edu',
    'https://hello.met.edu:5173',
    ...configured,
  ])];
};

const initializeRealtime = (server) => {
  io = new Server(server, {
    cors: {
      origin: getAllowedOrigins(),
      methods: ['GET', 'POST'],
    },
  });

  io.use(async (socket, next) => {
    try {
      const rawToken = socket.handshake.auth?.token || socket.handshake.headers?.authorization;
      const token = String(rawToken || '').replace(/^Bearer\s+/i, '');

      if (!token) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const staff = await Staff.findByPk(decoded.id, {
        attributes: ['id', 'role', 'departmentIds'],
      });

      if (!staff) return next(new Error('Invalid user'));

      socket.user = {
        id: staff.id,
        role: staff.role,
        departmentIds: Array.isArray(staff.departmentIds) ? staff.departmentIds : [],
      };

      return next();
    } catch (error) {
      return next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.user;
    socket.join(roomForUser(user.id));
    socket.join(roomForRole(user.role));
    user.departmentIds.forEach((departmentId) => socket.join(roomForDepartment(departmentId)));
  });

  return io;
};

const emitTicketReminderRefresh = ({ userIds = [], roles = [], departmentIds = [], reason = 'ticket-updated' } = {}) => {
  if (!io) return;

  const rooms = new Set();
  userIds.filter(Boolean).forEach((id) => rooms.add(roomForUser(id)));
  roles.filter(Boolean).forEach((role) => rooms.add(roomForRole(role)));
  departmentIds.filter(Boolean).forEach((id) => rooms.add(roomForDepartment(id)));

  if (rooms.size === 0) {
    io.emit('ticket-reminders:changed', { reason });
    return;
  }

  rooms.forEach((room) => {
    io.to(room).emit('ticket-reminders:changed', { reason });
  });
};

module.exports = {
  emitTicketReminderRefresh,
  initializeRealtime,
};
