const Sequelize = require('sequelize');
const sequelize = require('../config/db');

const ReportPreference = sequelize.define('reportPreference', {
  id: {
    type: Sequelize.INTEGER,
    autoIncrement: true,
    allowNull: false,
    primaryKey: true,
  },
  staffId: {
    type: Sequelize.INTEGER,
    allowNull: false,
  },
  module: {
    type: Sequelize.STRING,
    allowNull: false,
  },
  preferenceKey: {
    type: Sequelize.STRING,
    allowNull: false,
    defaultValue: 'default',
  },
  name: {
    type: Sequelize.STRING,
    allowNull: true,
  },
  columns: {
    type: Sequelize.JSONB,
    allowNull: false,
    defaultValue: [],
  },
  filters: {
    type: Sequelize.JSONB,
    allowNull: false,
    defaultValue: {},
  },
}, {
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['staffId', 'module', 'preferenceKey'],
    },
  ],
});

module.exports = ReportPreference;
