const e = require('cors');
const sequelize = require('../config/db');
const Sequelize = require('sequelize');

const Policy = sequelize.define('policy', {
    id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        allowNull: false,
        primaryKey: true
    },
    policyName: {
        type: Sequelize.STRING,
        allowNull: false
    },
    assignRole: {
       type: Sequelize.ARRAY(Sequelize.STRING),
          allowNull: false,
    },
    attachment:{
        type: Sequelize.STRING,
        allowNull: true
    }
});

module.exports = Policy;