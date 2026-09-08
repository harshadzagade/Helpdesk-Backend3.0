'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('policy');
    if (!table.departmentIds) {
      await queryInterface.addColumn('policy', 'departmentIds', {
        type: Sequelize.ARRAY(Sequelize.INTEGER),
        allowNull: false,
        defaultValue: [],
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('policy');
    if (table.departmentIds) {
      await queryInterface.removeColumn('policy', 'departmentIds');
    }
  },
};
