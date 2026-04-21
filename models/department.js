const Sequelize = require('sequelize');
const sequelize = require('../config/db');

const Department = sequelize.define('department', {
  id: {
    type: Sequelize.INTEGER,
    autoIncrement: true,
    allowNull: false,
    primaryKey: true
  },
  department: {
    type: Sequelize.STRING,
    allowNull: false
  },
  type: {
    type: Sequelize.STRING,
    allowNull: false
  },
  category: {
    type: Sequelize.ARRAY(Sequelize.STRING),
    allowNull: false,
    defaultValue: ['N/A']
  }
}, {
  timestamps: true
});

module.exports = Department;