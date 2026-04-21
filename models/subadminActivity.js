const Sequelize = require('sequelize');
const sequelize = require('../config/db');
const Staff = require('./staff');
const Department = require('./department');

const SubadminActivity = sequelize.define(
  'subadminActivity',
  {
    id: {
      type: Sequelize.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    subadminId: {
      type: Sequelize.INTEGER,
      allowNull: false,
    },
    departmentId: {
      type: Sequelize.INTEGER,
      allowNull: false,
    },
    actionTaken: {
      type: Sequelize.STRING,
      allowNull: false,
    },
    entityType: {
      type: Sequelize.ENUM('COMPLAINT', 'REQUEST'),
      allowNull: false,
    },
    entityId: {
      type: Sequelize.INTEGER,
      allowNull: false,
    },
  },
  {
    tableName: 'subadmin_activities',
    timestamps: true,
  }
);

SubadminActivity.belongsTo(Staff, {
  as: 'subadmin',
  foreignKey: 'subadminId',
});

Staff.hasMany(SubadminActivity, {
  as: 'subadminActivities',
  foreignKey: 'subadminId',
});

SubadminActivity.belongsTo(Department, {
  foreignKey: 'departmentId',
});

Department.hasMany(SubadminActivity, {
  foreignKey: 'departmentId',
});

module.exports = SubadminActivity;