const Sequelize = require('sequelize');
const sequelize = require('../config/db');

const Institute = sequelize.define('institute', {
    id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        allowNull: false,
        primaryKey: true
    },
    institute: {
        type: Sequelize.STRING,
        allowNull: false
    }
});

module.exports = Institute;