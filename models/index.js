// // models/index.js (final working version)

// const fs = require('fs');
// const path = require('path');
// const sequelize = require('../config/db');
// const Sequelize = require('sequelize');

// const db = {};

// fs.readdirSync(__dirname)
//   .filter(file => file !== 'index.js' && file.endsWith('.js'))
//   .forEach(file => {
//     const model = require(path.join(__dirname, file))(sequelize, Sequelize.DataTypes);
//     db[model.name] = model; // ← "Staff", "Complaint" aayega automatically
//   });

// // Sab models load hone ke baad associations call karo
// Object.keys(db).forEach(modelName => {
//   if (db[modelName].associate) {
//     db[modelName].associate(db);
//   }
// });

// db.sequelize = sequelize;
// db.Sequelize = Sequelize;

// module.exports = db;

const fs = require('fs');
const path = require('path');
const sequelize = require('../config/db');
const Sequelize = require('sequelize');

const db = {};

fs.readdirSync(__dirname)
  .filter(file => file !== 'index.js' && file.endsWith('.js'))
  .forEach(file => {
    const model = require(path.join(__dirname, file));
    db[model.name] = model;
  });

db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;