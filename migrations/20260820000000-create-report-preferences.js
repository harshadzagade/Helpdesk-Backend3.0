'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('reportPreference', {
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
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    await queryInterface.addIndex('reportPreference', ['staffId', 'module', 'preferenceKey'], {
      unique: true,
      name: 'report_preference_staff_module_key_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('reportPreference');
  },
};
