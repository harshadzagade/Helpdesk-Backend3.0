// models/request.js
const Sequelize = require('sequelize');
const sequelize = require('../config/db');

const Request = sequelize.define('request', {
  id: {
    type: Sequelize.INTEGER,
    autoIncrement: true,
    allowNull: false,
    primaryKey: true,
  },

  ticketId: {
    type: Sequelize.STRING,
    allowNull: true,
    unique: true,
  },

  // Request raise karne wala staff
  staffId: {
    type: Sequelize.INTEGER,
    allowNull: false,
  },

  // On behalf flow (same as complaint)
  behalf: {
    type: Sequelize.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },

  behalfId: {
    type: Sequelize.INTEGER,
    allowNull: true,
  },

  status: {
    type: Sequelize.STRING,
    defaultValue: 'pending', // pending -> hod1-approved -> hod2-approved -> in-progress -> closed
    allowNull: false,
  },

  // Target department jisko request ja rahi hai (e.g. ABC)
  departmentId: {
    type: Sequelize.INTEGER,
    allowNull: false,
  },

  departmentCategory: {
    type: Sequelize.STRING,
    allowNull: false,
  },

  priority: {
    type: Sequelize.STRING,
    allowNull: false,
  },

  subject: {
    type: Sequelize.STRING,
    allowNull: false,
  },

  description: {
    type: Sequelize.TEXT,
    allowNull: false,
  },

  attachments: {
    type: Sequelize.ARRAY(Sequelize.STRING),
    allowNull: true,
  },

  location: {
    type: Sequelize.STRING,
    allowNull: true,
  },

  isRepeated: {
    type: Sequelize.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },

  // Assigned engineer (after HOD2 approval)
  assignStaffId: {
    type: Sequelize.INTEGER,
    allowNull: true,
  },

  // ✅ New audit fields
  assignedAt: {
    type: Sequelize.DATE,
    allowNull: true,
  },
  assignedById: {
    type: Sequelize.INTEGER,
    allowNull: true,
  },
  closedById: {
    type: Sequelize.INTEGER,
    allowNull: true,
  },
  lastStatusChangedAt: {
    type: Sequelize.DATE,
    allowNull: true,
  },

  problemDescription: {
    type: Sequelize.TEXT,
    allowNull: true,
  },

  actionTakenComment: {
    type: Sequelize.TEXT,
    allowNull: true,
  },

  forwardToStaffId: {
    type: Sequelize.INTEGER,
    allowNull: true,
  },

  forwardComment: {
    type: Sequelize.TEXT,
    allowNull: true,
  },

  forwardAt: {
    type: Sequelize.DATE,
    allowNull: true,
  },

  resolvedAt: {
    type: Sequelize.DATE,
    allowNull: true,
  },

  // 🔹 HOD1 (Requester department ka HOD)
  hod1Approval: {
    type: Sequelize.BOOLEAN,
    defaultValue: false,
  },
  hod1Comment: {
    type: Sequelize.TEXT,
    allowNull: true,
  },
  hod1ApprovedAt: {
    type: Sequelize.DATE,
    allowNull: true,
  },
  // kisne HOD1 approval diya (admin/subadmin ka staffId)
  hod1ApprovedById: {
    type: Sequelize.INTEGER,
    allowNull: true,
  },

  // 🔹 HOD2 (Target department ka HOD) – assign engineer yahi karega
  hod2Approval: {
    type: Sequelize.BOOLEAN,
    defaultValue: false,
  },
  hod2Comment: {
    type: Sequelize.TEXT,
    allowNull: true,
  },
  hod2ApprovedAt: {
    type: Sequelize.DATE,
    allowNull: true,
  },
  // kisne HOD2 approval + assign kiya (admin/subadmin ka staffId)
  hod2ApprovedById: {
    type: Sequelize.INTEGER,
    allowNull: true,
  },
  rejectedById: {
    type: Sequelize.INTEGER,
    allowNull: true,
  },
  rejectedByLevel: {
    type: Sequelize.STRING, // 'HOD1' / 'HOD2'
    allowNull: true,
  },
  rejectionComment: {
    type: Sequelize.TEXT,
    allowNull: true,
  },
  rejectedAt: {
    type: Sequelize.DATE,
    allowNull: true,
  },
});

module.exports = Request;
