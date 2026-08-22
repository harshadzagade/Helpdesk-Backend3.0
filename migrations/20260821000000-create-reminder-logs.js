'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('reminderLog', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        allowNull: false,
        primaryKey: true,
      },
      ticketType: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      ticketId: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      entityId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      reminderType: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      recipientStaffId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      recipientEmail: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      thresholdDays: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'sent',
      },
      errorMessage: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      sentAt: {
        type: Sequelize.DATE,
        allowNull: true,
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

    await queryInterface.addIndex(
      'reminderLog',
      ['ticketType', 'entityId', 'reminderType', 'recipientStaffId', 'thresholdDays'],
      {
        unique: true,
        name: 'reminder_log_unique_delivery',
      }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('reminderLog');
  },
};
