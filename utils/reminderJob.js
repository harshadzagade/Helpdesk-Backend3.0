const { Op } = require('sequelize');
const Complaint = require('../models/complaint');
const Request = require('../models/request');
const Staff = require('../models/staff');
const Department = require('../models/department');
const ReminderLog = require('../models/reminderLog');
const ReminderSetting = require('../models/reminderSetting');
const { buildTicketSubject, renderEmailLayout, sendMail } = require('./mailer');
const { emitTicketReminderRefresh } = require('./realtime');

const DAY_MS = 24 * 60 * 60 * 1000;
let jobRunning = false;
let lastRunAt = null;
let lastRunSummary = null;
let nextRunAt = null;
let lastScheduledRunDate = null;

const sanitizeThresholdDays = (value) => {
  const source = Array.isArray(value) ? value : String(value || '1,2').split(',');
  const configured = source
    .map((value) => Number(String(value).trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  return configured.length ? [...new Set(configured)].sort((a, b) => a - b) : [1, 2];
};

const isValidRunTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));

const getDefaultReminderSettings = () => ({
  enabled: String(process.env.REMINDER_JOB_ENABLED || 'true').toLowerCase() === 'true',
  runTime: isValidRunTime(process.env.REMINDER_RUN_TIME) ? process.env.REMINDER_RUN_TIME : '11:00',
  thresholdDays: sanitizeThresholdDays(process.env.REMINDER_THRESHOLD_DAYS || '1,2'),
});

const getReminderSettings = async () => {
  const defaults = getDefaultReminderSettings();
  const [settings] = await ReminderSetting.findOrCreate({
    where: { id: 1 },
    defaults,
  });

  return {
    enabled: Boolean(settings.enabled),
    runTime: isValidRunTime(settings.runTime) ? settings.runTime : defaults.runTime,
    thresholdDays: sanitizeThresholdDays(settings.thresholdDays),
  };
};

const updateReminderSettings = async ({ enabled, runTime, thresholdDays }) => {
  const settings = await getReminderSettings();
  const [row] = await ReminderSetting.findOrCreate({
    where: { id: 1 },
    defaults: settings,
  });

  if (enabled !== undefined) row.enabled = Boolean(enabled);
  if (runTime !== undefined) {
    if (!isValidRunTime(runTime)) {
      const error = new Error('runTime must be in HH:mm format.');
      error.statusCode = 400;
      throw error;
    }
    row.runTime = runTime;
  }
  if (thresholdDays !== undefined) row.thresholdDays = sanitizeThresholdDays(thresholdDays);

  await row.save();
  const nextSettings = await getReminderSettings();
  nextRunAt = calculateNextRunAt(nextSettings.runTime, new Date());
  return nextSettings;
};

const normalizeStatus = (status) => String(status || '').toLowerCase().replace(/\s+/g, '-');

const fullNameOf = (staff) =>
  `${staff?.firstname || ''} ${staff?.middlename || ''} ${staff?.lastname || ''}`
    .replace(/\s+/g, ' ')
    .trim() || staff?.email || `Staff ${staff?.id || ''}`.trim();

const deptIdsOf = (staff) => (
  Array.isArray(staff?.departmentIds) ? staff.departmentIds.map(Number).filter(Number.isInteger) : []
);

const ageInDays = (date, now = new Date()) => {
  if (!date) return 0;
  const diff = now.getTime() - new Date(date).getTime();
  if (!Number.isFinite(diff) || diff < 0) return 0;
  return Math.floor(diff / DAY_MS);
};

const getReachedThresholds = (startDate, thresholds, now) => {
  const daysOld = ageInDays(startDate, now);
  return thresholds.filter((days) => daysOld >= days);
};

const formatDateKey = (date) => date.toISOString().slice(0, 10);

const minutesFromTime = (time) => {
  const [hours, minutes] = String(time || '11:00').split(':').map(Number);
  return (hours * 60) + minutes;
};

const calculateNextRunAt = (runTime, now = new Date()) => {
  const [hours, minutes] = String(runTime || '11:00').split(':').map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
};

const shouldRunScheduledJob = (settings, now = new Date()) => {
  if (!settings.enabled || jobRunning) return false;

  const todayKey = formatDateKey(now);
  if (lastScheduledRunDate === todayKey) return false;

  const currentMinutes = (now.getHours() * 60) + now.getMinutes();
  return currentMinutes >= minutesFromTime(settings.runTime);
};

const getDepartmentAdmins = async (departmentIds) => {
  const ids = [...new Set((departmentIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return [];

  return Staff.findAll({
    where: {
      role: { [Op.in]: ['admin', 'subadmin'] },
      departmentIds: { [Op.overlap]: ids },
    },
    attributes: ['id', 'email', 'firstname', 'middlename', 'lastname', 'role', 'departmentIds'],
  });
};

const createLogKey = ({ ticketType, entityId, reminderType, recipientStaffId, thresholdDays }) => ({
  ticketType,
  entityId,
  reminderType,
  recipientStaffId,
  thresholdDays,
});

const reminderExists = async (key) => {
  const existing = await ReminderLog.findOne({ where: key });
  return Boolean(existing);
};

const writeReminderLog = async ({ ticketType, ticketId, entityId, reminderType, recipient, thresholdDays, status, errorMessage }) => {
  await ReminderLog.findOrCreate({
    where: createLogKey({
      ticketType,
      entityId,
      reminderType,
      recipientStaffId: recipient.id,
      thresholdDays,
    }),
    defaults: {
      ticketId,
      recipientEmail: recipient.email,
      sentAt: new Date(),
      status,
      errorMessage: errorMessage || null,
    },
  });
};

const sendReminder = async ({ ticketType, ticket, reminderType, recipient, thresholdDays, title, intro, rows }) => {
  const key = createLogKey({
    ticketType,
    entityId: ticket.id,
    reminderType,
    recipientStaffId: recipient.id,
    thresholdDays,
  });

  if (await reminderExists(key)) {
    return { skipped: true, reason: 'already_logged' };
  }

  const ticketId = ticket.ticketId || `${ticketType}-${ticket.id}`;
  try {
    const mailResult = await sendMail({
      to: recipient.email,
      subject: buildTicketSubject(ticketId, `${thresholdDays}-day reminder: ${ticket.subject || 'Pending action'}`),
      html: renderEmailLayout({
        title,
        intro,
        rows: [
          { label: 'Ticket ID', value: ticketId },
          { label: 'Ticket Type', value: ticketType },
          { label: 'Subject', value: ticket.subject || 'N/A' },
          { label: 'Status', value: ticket.status || 'N/A' },
          { label: 'Reminder Age', value: `${thresholdDays} day${thresholdDays > 1 ? 's' : ''}` },
          ...rows,
        ],
        outro: 'Please log in to MET Helpdesk and take the pending action.',
      }),
    });

    if (mailResult?.skipped) {
      return { skipped: true, reason: mailResult.reason };
    }

    await writeReminderLog({
      ticketType,
      ticketId,
      entityId: ticket.id,
      reminderType,
      recipient,
      thresholdDays,
      status: 'sent',
    });
    return { sent: true };
  } catch (error) {
    await writeReminderLog({
      ticketType,
      ticketId,
      entityId: ticket.id,
      reminderType,
      recipient,
      thresholdDays,
      status: 'failed',
      errorMessage: error.message,
    });
    return { failed: true, error: error.message };
  }
};

const sendToRecipients = async (recipients, payload) => {
  const results = [];
  const uniqueRecipients = [];
  const seen = new Set();

  recipients.forEach((recipient) => {
    const email = String(recipient?.email || '').trim().toLowerCase();
    if (!recipient?.id || !email || seen.has(email)) return;
    seen.add(email);
    uniqueRecipients.push(recipient);
  });

  for (const recipient of uniqueRecipients) {
    for (const thresholdDays of payload.thresholds) {
      results.push(await sendReminder({ ...payload, recipient, thresholdDays }));
    }
  }

  return results;
};

const processHod1RequestReminders = async (thresholds, now) => {
  const requests = await Request.findAll({
    where: {
      hod1Approval: false,
      status: { [Op.notIn]: ['closed', 'rejected'] },
    },
  });
  const results = [];

  for (const request of requests) {
    const reachedThresholds = getReachedThresholds(request.createdAt, thresholds, now);
    if (!reachedThresholds.length) continue;

    const requester = await Staff.findByPk(request.staffId);
    const requesterDeptIds = deptIdsOf(requester);
    const recipients = await getDepartmentAdmins(requesterDeptIds);
    const deptNames = await Department.findAll({ where: { id: { [Op.in]: requesterDeptIds } } });

    results.push(...await sendToRecipients(recipients, {
      ticketType: 'request',
      ticket: request,
      reminderType: 'HOD1_PENDING',
      thresholds: reachedThresholds,
      title: 'HOD1 Approval Reminder',
      intro: `This request is waiting for HOD1 approval from the requester department.`,
      rows: [
        { label: 'Requester', value: fullNameOf(requester) },
        { label: 'Requester Department', value: deptNames.map((dept) => dept.department).join(', ') || 'N/A' },
      ],
    }));
  }

  return results;
};

const processHod2RequestReminders = async (thresholds, now) => {
  const requests = await Request.findAll({
    where: {
      hod1Approval: true,
      hod2Approval: false,
      status: { [Op.notIn]: ['closed', 'rejected'] },
    },
  });
  const results = [];

  for (const request of requests) {
    const reachedThresholds = getReachedThresholds(request.hod1ApprovedAt, thresholds, now);
    if (!reachedThresholds.length) continue;

    const recipients = await getDepartmentAdmins([request.departmentId]);
    const targetDept = await Department.findByPk(request.departmentId);

    results.push(...await sendToRecipients(recipients, {
      ticketType: 'request',
      ticket: request,
      reminderType: 'HOD2_PENDING',
      thresholds: reachedThresholds,
      title: 'HOD2 Approval Reminder',
      intro: `This request is waiting for HOD2 approval from the target department.`,
      rows: [
        { label: 'Target Department', value: targetDept?.department || `ID: ${request.departmentId}` },
      ],
    }));
  }

  return results;
};

const processEngineerReminders = async ({ model, ticketType, thresholds, now }) => {
  const rows = await model.findAll({
    where: {
      assignStaffId: { [Op.ne]: null },
      resolvedAt: null,
      status: { [Op.notIn]: ['closed', 'rejected'] },
    },
  });
  const results = [];

  for (const ticket of rows) {
    const status = normalizeStatus(ticket.status);
    if (status === 'pending') continue;

    const startDate = ticket.forwardAt || ticket.assignedAt;
    const reachedThresholds = getReachedThresholds(startDate, thresholds, now);
    if (!reachedThresholds.length) continue;

    const recipient = await Staff.findByPk(ticket.assignStaffId);
    if (!recipient) continue;

    results.push(...await sendToRecipients([recipient], {
      ticketType,
      ticket,
      reminderType: 'ENGINEER_PENDING',
      thresholds: reachedThresholds,
      title: `${ticketType === 'request' ? 'Request' : 'Complaint'} Action Reminder`,
      intro: `This ${ticketType} is assigned and still waiting for resolution.`,
      rows: [
        { label: 'Assigned To', value: fullNameOf(recipient) },
        { label: 'Assigned At', value: startDate ? new Date(startDate).toLocaleString('en-IN') : 'N/A' },
      ],
    }));
  }

  return results;
};

const runReminderJob = async () => {
  if (jobRunning) {
    return { skipped: true, reason: 'job_already_running' };
  }

  jobRunning = true;
  const settings = await getReminderSettings();
  const thresholds = settings.thresholdDays;
  const now = new Date();

  try {
    const results = [
      ...await processHod1RequestReminders(thresholds, now),
      ...await processHod2RequestReminders(thresholds, now),
      ...await processEngineerReminders({ model: Request, ticketType: 'request', thresholds, now }),
      ...await processEngineerReminders({ model: Complaint, ticketType: 'complaint', thresholds, now }),
    ];

    const summary = results.reduce((acc, result) => {
      if (result.sent) acc.sent += 1;
      else if (result.failed) acc.failed += 1;
      else if (result.skipped) acc.skipped += 1;
      return acc;
    }, { sent: 0, failed: 0, skipped: 0 });

    console.log('Reminder job completed:', summary);
    lastRunAt = new Date();
    lastRunSummary = summary;
    emitTicketReminderRefresh({
      roles: ['admin', 'subadmin', 'engineer', 'user'],
      reason: 'reminder-job-run',
    });
    return summary;
  } finally {
    jobRunning = false;
  }
};

const startReminderScheduler = () => {
  const timer = setInterval(async () => {
    try {
      const settings = await getReminderSettings();
      nextRunAt = calculateNextRunAt(settings.runTime, new Date());
      if (!shouldRunScheduledJob(settings)) return;

      lastScheduledRunDate = formatDateKey(new Date());
      await runReminderJob();
      nextRunAt = calculateNextRunAt(settings.runTime, new Date());
    } catch (error) {
      console.error('Reminder scheduler failed:', error);
    }
  }, 60 * 1000);

  getReminderSettings()
    .then((settings) => {
      nextRunAt = calculateNextRunAt(settings.runTime, new Date());
      console.log(`Reminder job scheduled daily at ${settings.runTime}.`);
    })
    .catch((error) => console.error('Reminder scheduler setup failed:', error));

  return timer;
};

const getReminderSchedulerStatus = async () => {
  const settings = await getReminderSettings();
  nextRunAt = settings.enabled ? calculateNextRunAt(settings.runTime, new Date()) : null;

  return {
    enabled: settings.enabled,
    running: jobRunning,
    runTime: settings.runTime,
    thresholdDays: settings.thresholdDays,
    lastRunAt,
    lastRunSummary,
    nextRunAt: settings.enabled ? nextRunAt : null,
  };
};

module.exports = {
  getReminderSchedulerStatus,
  runReminderJob,
  startReminderScheduler,
  updateReminderSettings,
};
