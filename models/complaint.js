const Sequelize = require('sequelize');
const sequelize = require('../config/db');

const Complaint = sequelize.define('complaint', {
  id: {
    type: Sequelize.INTEGER,
    autoIncrement: true,
    allowNull: false,
    primaryKey: true
  },
  ticketId: {
    type: Sequelize.STRING,
    allowNull: true,
    unique: true,
  },
  staffId: {
    type: Sequelize.INTEGER,
    allowNull: false
  },
  behalf: {
    type: Sequelize.BOOLEAN,
    defaultValue: false,
    allowNull: false
  },
  behalfId: {
    type: Sequelize.INTEGER,
    allowNull: true
  },
  status: {
    type: Sequelize.STRING,
    defaultValue: 'pending',
    allowNull: false
  },
  departmentId: {
    type: Sequelize.INTEGER,
    allowNull: false
  },
  departmentCategory: {
    type: Sequelize.STRING,
    allowNull: false
  },
  priority: {
    type: Sequelize.STRING,
    allowNull: false
  },
  subject: {
    type: Sequelize.STRING,
    allowNull: false
  },
  description: {
    type: Sequelize.TEXT,
    allowNull: false
  },
  attachments: {
    type: Sequelize.ARRAY(Sequelize.STRING),
    allowNull: true,
  },
  location: {
    type: Sequelize.STRING,
    allowNull: true
  },
  isRepeated: {
    type: Sequelize.BOOLEAN,
    defaultValue: false,
    allowNull: false
  },

  // Assigned staff
  assignStaffId: {
    type: Sequelize.INTEGER,
    allowNull: true
  },

  // ✅ New audit fields
  assignedAt: {
    type: Sequelize.DATE,
    allowNull: true
  },
  assignedById: {
    type: Sequelize.INTEGER,
    allowNull: true
  },
  closedById: {
    type: Sequelize.INTEGER,
    allowNull: true
  },
  lastStatusChangedAt: {
    type: Sequelize.DATE,
    allowNull: true
  },

  problemDescription: {
    type: Sequelize.TEXT,
    allowNull: true
  },

  // Staff action taken comment
  actionTakenComment: {
    type: Sequelize.TEXT,
    allowNull: true
  },

  // Forwarded to another staff
  forwardToStaffId: {
    type: Sequelize.INTEGER,
    allowNull: true
  },

  // Comment while forwarding
  forwardComment: {
    type: Sequelize.TEXT,
    allowNull: true
  },

  forwardAt: {
    type: Sequelize.DATE,
    allowNull: true
  },

  resolvedAt: {
    type: Sequelize.DATE,
    allowNull: true
  },


});

module.exports = Complaint;
