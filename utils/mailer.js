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

const BRAND_NAME = 'MET Helpdesk';
const BRAND_COLOR = '#E31E24';
const BRAND_DARK = '#7A1218';
const SURFACE = '#FFF7F7';
const BORDER = '#F3C7CA';
const TEXT = '#1F2937';
const MUTED = '#6B7280';

const buildTicketSubject = (ticketId, subject) => `[${ticketId}] ${subject}`;

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const renderRows = (rows = []) => {
  const safeRows = rows.filter((row) => row && row.label && row.value !== undefined && row.value !== null && row.value !== '');
  if (!safeRows.length) return '';

  return `
    <table style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">
      ${safeRows
        .map(
          (row, index) => `
        <tr style="background:${index % 2 === 0 ? '#FFFDFD' : SURFACE};">
          <td style="padding:12px 14px;border-bottom:1px solid ${BORDER};font-weight:700;color:${BRAND_DARK};width:34%;">${escapeHtml(row.label)}</td>
          <td style="padding:12px 14px;border-bottom:1px solid ${BORDER};color:${TEXT};">${escapeHtml(row.value)}</td>
        </tr>`
        )
        .join('')}
    </table>
  `;
};

const renderEmailLayout = ({
  title,
  intro,
  rows = [],
  outro,
  badge = BRAND_NAME,
}) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:linear-gradient(180deg,#fff5f5 0%,#fffafb 100%);font-family:Segoe UI,Arial,sans-serif;color:${TEXT};">
  <div style="max-width:680px;margin:0 auto;padding:28px 16px;">
    <div style="background:${BRAND_COLOR};border-radius:22px 22px 0 0;padding:22px 24px;color:#ffffff;text-align:center;">
      <div style="font-size:20px;letter-spacing:0.04em;text-transform:uppercase;opacity:0.98;font-weight:800;">${escapeHtml(badge)}</div>
    </div>
    <div style="background:#ffffff;border:1px solid ${BORDER};border-top:none;border-radius:0 0 22px 22px;padding:28px 24px;box-shadow:0 18px 45px rgba(122,18,24,0.08);">
      <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;color:${BRAND_DARK};">${escapeHtml(title)}</h1>
      ${intro ? `<p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:${TEXT};">${intro}</p>` : ''}
      ${renderRows(rows)}
      ${outro ? `<p style="margin:18px 0 0;font-size:14px;line-height:1.7;color:${MUTED};">${outro}</p>` : ''}
      <p style="margin:24px 0 0;font-size:14px;line-height:1.7;color:${TEXT};">Regards,<br><strong>${BRAND_NAME}</strong></p>
    </div>
  </div>
</body>
</html>`;

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
  BRAND_COLOR,
  buildTicketSubject,
  emailEnabled,
  renderEmailLayout,
  sendMail,
};
