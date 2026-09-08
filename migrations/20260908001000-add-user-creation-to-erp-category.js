'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "department"
      SET "category" = array_append("category", 'User Creation'),
          "updatedAt" = NOW()
      WHERE LOWER("department") = 'erp'
        AND NOT ('User Creation' = ANY("category"));
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "department"
      SET "category" = array_remove("category", 'User Creation'),
          "updatedAt" = NOW()
      WHERE LOWER("department") = 'erp';
    `);
  },
};
