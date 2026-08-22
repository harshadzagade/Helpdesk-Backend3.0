const Sequelize = require('sequelize');
const sequelize = require('../config/db');

const ReminderLog = sequelize.define('reminderLog', {
  id: {
    type: Sequelize.INTEGER,
    autoIncrement: true,
    allowNull: false,
    primaryKey: true,
  },
  ticketType: {
    type: Sequelize.STRING,
    allowNull: false,
  },
  ticketId: {
    type: Sequelize.STRING,
    allowNull: true,
  },
  entityId: {
    type: Sequelize.INTEGER,
    allowNull: false,
  },
  reminderType: {
    type: Sequelize.STRING,
    allowNull: false,
  },
  recipientStaffId: {
    type: Sequelize.INTEGER,
    allowNull: false,
  },
  recipientEmail: {
    type: Sequelize.STRING,
    allowNull: false,
  },
  thresholdDays: {
    type: Sequelize.INTEGER,
    allowNull: false,
  },
  status: {
    type: Sequelize.STRING,
    allowNull: false,
    defaultValue: 'sent',
  },
  errorMessage: {
    type: Sequelize.TEXT,
    allowNull: true,
  },
  sentAt: {
    type: Sequelize.DATE,
    allowNull: true,
  },
}, {
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['ticketType', 'entityId', 'reminderType', 'recipientStaffId', 'thresholdDays'],
      name: 'reminder_log_unique_delivery',
    },
  ],
});

module.exports = ReminderLog;
