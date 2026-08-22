const Sequelize = require('sequelize');
const sequelize = require('../config/db');

const Staff = sequelize.define('staff', {
  id: {
    type: Sequelize.INTEGER,
    autoIncrement: true,
    allowNull: false,
    primaryKey: true
  },
  firstname: {
    type: Sequelize.STRING,
    allowNull: false
  },
  middlename: {
    type: Sequelize.STRING,
    allowNull: false
  },
  lastname: {
    type: Sequelize.STRING,
    allowNull: false
  },
  email: {
    type: Sequelize.STRING,
    allowNull: false,
    unique: true
  },
  password: {
    type: Sequelize.STRING,
    allowNull: false
  },
  role: {
    type: Sequelize.STRING,
    allowNull: false
  },
  instituteId: {
    type: Sequelize.INTEGER,
    allowNull: false
  },
  departmentIds: {
    type: Sequelize.ARRAY(Sequelize.INTEGER),
    allowNull: false,
    defaultValue: []
  },
  employeeType: {
    type: Sequelize.STRING,
    allowNull: false
  },
  phoneNumber: {
    type: Sequelize.BIGINT,
    allowNull: true
  },
  contactExtension: {
    type: Sequelize.STRING,
    allowNull: true
  },
  canManageExtensions: {
    type: Sequelize.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  canManagePolicies: {
    type: Sequelize.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  isNew: {
    type: Sequelize.BOOLEAN,
    allowNull: false
  },
  resetOtpHash: {
    type: Sequelize.STRING,
    allowNull: true,
  },
  resetOtpExpiresAt: {
    type: Sequelize.DATE,
    allowNull: true,
  }
}, {
  timestamps: true
});

module.exports = Staff;
