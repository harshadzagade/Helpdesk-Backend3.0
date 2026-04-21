const { Op, QueryTypes } = require('sequelize');
const sequelize = require('../config/db');

const buildTicketId = async ({ model, prefix, regex, lockKey, transaction }) => {
  const year = new Date().getFullYear();
  const fullPrefix = `${prefix}${year}`;

  await sequelize.query('SELECT pg_advisory_xact_lock(:lockKey)', {
    replacements: { lockKey },
    transaction,
    type: QueryTypes.SELECT,
  });

  const lastRecord = await model.findOne({
    where: {
      ticketId: {
        [Op.like]: `${fullPrefix}%`,
      },
    },
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    transaction,
  });

  let sequence = 1;

  if (lastRecord?.ticketId) {
    const match = String(lastRecord.ticketId).match(regex);
    if (match) {
      const lastYear = Number(match[1]);
      const lastSequence = Number(match[2]);

      if (lastYear === year && Number.isFinite(lastSequence)) {
        sequence = lastSequence + 1;
      }
    }
  }

  return `${fullPrefix}${String(sequence).padStart(3, '0')}`;
};

module.exports = {
  buildTicketId,
};
