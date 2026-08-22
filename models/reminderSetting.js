const Sequelize = require('sequelize');
const sequelize = require('../config/db');

const ReminderSetting = sequelize.define('reminderSetting', {
  id: {
    type: Sequelize.INTEGER,
    autoIncrement: true,
    allowNull: false,
    primaryKey: true,
  },
  enabled: {
    type: Sequelize.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  runTime: {
    type: Sequelize.STRING,
    allowNull: false,
    defaultValue: '11:00',
  },
  thresholdDays: {
    type: Sequelize.ARRAY(Sequelize.INTEGER),
    allowNull: false,
    defaultValue: [1, 2],
  },
}, {
  timestamps: true,
});

module.exports = ReminderSetting;
