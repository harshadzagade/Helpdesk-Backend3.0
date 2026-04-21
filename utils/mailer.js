const nodemailer = require('nodemailer');

const emailEnabled = String(process.env.ENABLE_EMAIL || 'false').toLowerCase() === 'true';

const hasMailConfig = Boolean(process.env.MAIL_USER && process.env.MAIL_PASS);

const transporter = hasMailConfig
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.MAIL_USER,
        pass: String(process.env.MAIL_PASS || '').replace(/\s+/g, ''),
      },
    })
  : null;

const buildTicketSubject = (ticketId, subject) => `[${ticketId}] ${subject}`;

const sendMail = async (options) => {
  if (!emailEnabled) {
    return { skipped: true, reason: 'email_disabled' };
  }

  if (!transporter) {
    throw new Error('Mail transporter is not configured');
  }

  const mailOptions = {
    from: process.env.MAIL_FROM || process.env.MAIL_USER,
    ...options,
  };

  return transporter.sendMail(mailOptions);
};

module.exports = {
  buildTicketSubject,
  emailEnabled,
  sendMail,
};
