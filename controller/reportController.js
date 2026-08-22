const ReportPreference = require('../models/reportPreference');
const Complaint = require('../models/complaint');
const Request = require('../models/request');
const Staff = require('../models/staff');
const Department = require('../models/department');
const Institute = require('../models/institute');
const { Op } = require('sequelize');
const { stripHtml, durationMinutes, durationLabel } = require('../utils/reportFormatting');

const allowedModules = new Set(['complaint', 'request']);

const normalizeModule = (value) => String(value || '').toLowerCase();

const ensureAllowedModule = (module) => {
  if (!allowedModules.has(module)) {
    const error = new Error('Invalid report module.');
    error.statusCode = 400;
    throw error;
  }
};

const sanitizeColumnIds = (columns) => {
  if (!Array.isArray(columns)) return [];
  return columns
    .map((column) => String(column || '').trim())
    .filter(Boolean);
};

const sanitizeFilters = (filters) => {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return {};

  return {
    scope: filters.scope || 'all',
    statusFilter: filters.statusFilter || 'all',
    priorityFilter: filters.priorityFilter || 'all',
    departmentFilter: filters.departmentFilter || 'all',
    engineerFilter: filters.engineerFilter || 'all',
    fromDate: filters.fromDate || '',
    toDate: filters.toDate || '',
  };
};

const roleLower = (staff) => String(staff?.role || '').toLowerCase();

const staffDeptIds = (staff) =>
  Array.isArray(staff?.departmentIds) ? staff.departmentIds.map(Number).filter(Number.isInteger) : [];

const fullNameOf = (staff) =>
  `${staff?.firstname || ''} ${staff?.middlename || ''} ${staff?.lastname || ''}`
    .replace(/\s+/g, ' ')
    .trim() || staff?.email || '';

const toInt = (value) => {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
};

const buildDateWhere = (fromDate, toDate) => {
  const createdAt = {};

  if (fromDate) {
    const from = new Date(fromDate);
    if (!Number.isNaN(from.getTime())) createdAt[Op.gte] = from;
  }

  if (toDate) {
    const to = new Date(toDate);
    if (!Number.isNaN(to.getTime())) {
      to.setHours(23, 59, 59, 999);
      createdAt[Op.lte] = to;
    }
  }

  return Object.keys(createdAt).length ? { createdAt } : {};
};

const buildAccessWhere = (staff, scope) => {
  const role = roleLower(staff);
  if (role === 'superadmin') return {};
  if (scope === 'my') return { staffId: staff.id };

  const deptIds = staffDeptIds(staff);
  const ownScope = [
    { staffId: staff.id },
    { assignStaffId: staff.id },
    { behalfId: staff.id },
  ];

  if (deptIds.length) ownScope.push({ departmentId: { [Op.in]: deptIds } });

  if (scope === 'incoming' && deptIds.length) return { departmentId: { [Op.in]: deptIds } };
  if (scope === 'department' && deptIds.length) return { departmentId: { [Op.in]: deptIds } };

  return { [Op.or]: ownScope };
};

const buildReportWhere = (staff, query) => {
  const where = {
    ...buildAccessWhere(staff, query.scope || 'all'),
    ...buildDateWhere(query.fromDate, query.toDate),
  };

  if (query.status && query.status !== 'all') where.status = query.status;
  if (query.priority && query.priority !== 'all') where.priority = query.priority;

  const departmentId = toInt(query.departmentId);
  if (departmentId !== null) where.departmentId = departmentId;

  const engineerId = toInt(query.engineerId);
  if (engineerId !== null) where.assignStaffId = engineerId;

  return where;
};

const getStaffMaps = async () => {
  const [staff, departments, institutes] = await Promise.all([
    Staff.findAll({ attributes: { exclude: ['password'] } }),
    Department.findAll(),
    Institute.findAll(),
  ]);

  const staffById = {};
  const deptById = {};
  const instituteById = {};

  staff.forEach((item) => {
    staffById[String(item.id)] = item.get ? item.get({ plain: true }) : item;
  });
  departments.forEach((item) => {
    const row = item.get ? item.get({ plain: true }) : item;
    deptById[String(row.id)] = row.department || row.name || '';
  });
  institutes.forEach((item) => {
    const row = item.get ? item.get({ plain: true }) : item;
    instituteById[String(row.id)] = row.institute || row.name || '';
  });

  return { staffById, deptById, instituteById };
};

const decorateRow = (row, module, maps) => {
  const data = row.get ? row.get({ plain: true }) : row;
  const requester = maps.staffById[String(data.staffId)];
  const requesterDeptIds = staffDeptIds(requester);
  const requesterDepartmentNames = requesterDeptIds.map((deptId) => maps.deptById[String(deptId)]).filter(Boolean).join(', ');
  const targetDepartmentName = maps.deptById[String(data.departmentId)] || '';
  const assignedMinutes = durationMinutes(data.createdAt, data.assignedAt || data.forwardAt);
  const closeMinutes = durationMinutes(data.createdAt, data.resolvedAt);
  const approvalMinutes = durationMinutes(data.hod1ApprovedAt, data.hod2ApprovedAt);
  const approvalAssignMinutes = durationMinutes(data.hod2ApprovedAt, data.assignedAt);

  return {
    ...data,
    reportFields: {
      ticketType: module === 'request' ? 'Request' : 'Complaint',
      raisedByName: fullNameOf(requester),
      raisedByRole: requester?.role || '',
      raisedByInstitute: maps.instituteById[String(requester?.instituteId)] || '',
      raisedByDepartment: requesterDepartmentNames,
      targetDepartment: targetDepartmentName,
      hod1Department: requesterDepartmentNames,
      hod2Department: targetDepartmentName,
      engineerName: fullNameOf(maps.staffById[String(data.assignStaffId)]),
      assignedByName: fullNameOf(maps.staffById[String(data.assignedById)]),
      assignedByRole: maps.staffById[String(data.assignedById)]?.role || '',
      closedByName: fullNameOf(maps.staffById[String(data.closedById)]),
      hod1ApprovedByName: fullNameOf(maps.staffById[String(data.hod1ApprovedById)]),
      hod1ApprovedByRole: maps.staffById[String(data.hod1ApprovedById)]?.role || '',
      hod2ApprovedByName: fullNameOf(maps.staffById[String(data.hod2ApprovedById)]),
      hod2ApprovedByRole: maps.staffById[String(data.hod2ApprovedById)]?.role || '',
      description: stripHtml(data.description),
      problemDescription: stripHtml(data.problemDescription),
      actionTakenComment: stripHtml(data.actionTakenComment),
      hod1Comment: stripHtml(data.hod1Comment),
      hod2Comment: stripHtml(data.hod2Comment),
      rejectionComment: stripHtml(data.rejectionComment),
      timeToAssignMinutes: assignedMinutes,
      totalTimeToCloseMinutes: closeMinutes,
      timeBetweenApprovalsMinutes: approvalMinutes,
      timeToAssignAfterApprovalMinutes: approvalAssignMinutes,
      timeToAssign: durationLabel(assignedMinutes),
      totalTimeToClose: durationLabel(closeMinutes),
      timeBetweenApprovals: durationLabel(approvalMinutes),
      timeToAssignAfterApproval: durationLabel(approvalAssignMinutes),
    },
  };
};

const reportExportColumns = [
  ['ticketType', 'Ticket Type'],
  ['ticketId', 'Ticket ID'],
  ['raisedByName', 'Raised By'],
  ['raisedByInstitute', 'Raised By Institute'],
  ['raisedByDepartment', 'Raised By Department'],
  ['subject', 'Subject'],
  ['status', 'Status'],
  ['priority', 'Priority'],
  ['targetDepartment', 'Target Department'],
  ['departmentCategory', 'Category'],
  ['location', 'Location'],
  ['engineerName', 'Engineer'],
  ['description', 'Description'],
  ['createdAt', 'Logged Time'],
  ['assignedAt', 'Assigned Time'],
  ['resolvedAt', 'Closed Time'],
  ['assignedByName', 'Assigned By'],
  ['assignedByRole', 'Assigned By Role'],
  ['closedByName', 'Closed By'],
  ['problemDescription', 'Problem Description'],
  ['actionTakenComment', 'Action Taken'],
  ['timeToAssign', 'Time Taken to Assign'],
  ['totalTimeToClose', 'Total Time to Close'],
  ['hod1Department', 'HOD1 Department'],
  ['hod1Approval', 'HOD1 Status'],
  ['hod1ApprovedAt', 'HOD1 Time'],
  ['hod1ApprovedByName', 'HOD1 Approved By'],
  ['hod1ApprovedByRole', 'HOD1 Approved By Role'],
  ['hod1Comment', 'HOD1 Comment'],
  ['hod2Department', 'HOD2 Department'],
  ['hod2Approval', 'HOD2 Status'],
  ['hod2ApprovedAt', 'HOD2 Time'],
  ['hod2ApprovedByName', 'HOD2 Approved By'],
  ['hod2ApprovedByRole', 'HOD2 Approved By Role'],
  ['hod2Comment', 'HOD2 Comment'],
  ['timeBetweenApprovals', 'Time Between First and Second Approval'],
  ['timeToAssignAfterApproval', 'Time Taken to Assign After Approval'],
  ['rejectedByLevel', 'Rejection Level'],
  ['rejectionComment', 'Rejection Comment'],
  ['rejectedAt', 'Rejected At'],
];

const csvEscape = (value) => {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const getExportValue = (row, key) => {
  if (row.reportFields && row.reportFields[key] !== undefined) return row.reportFields[key];
  if (key === 'hod1Approval') return row.hod1Approval ? 'Approved' : 'Pending';
  if (key === 'hod2Approval') return row.hod2Approval ? 'Approved' : 'Pending';
  return row[key] || '';
};

const getDecoratedReportRows = async (req, module) => {
  const model = module === 'request' ? Request : Complaint;
  const staff = await Staff.findByPk(req.user.id);
  if (!staff) {
    const error = new Error('Staff not found.');
    error.statusCode = 404;
    throw error;
  }

  const page = Math.max(toInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(toInt(req.query.limit) || 10000, 1), 10000);
  const offset = (page - 1) * limit;
  const where = buildReportWhere(staff, req.query);

  const { rows, count } = await model.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    offset,
    limit,
  });

  const maps = await getStaffMaps();
  const data = rows.map((row) => decorateRow(row, module, maps));

  return {
    data,
    count,
    pagination: {
      total: count,
      page,
      pages: Math.ceil(count / limit),
      limit,
    },
  };
};

exports.getReportPreferences = async (req, res) => {
  try {
    const module = normalizeModule(req.params.module);
    ensureAllowedModule(module);

    const preferences = await ReportPreference.findAll({
      where: {
        staffId: req.user.id,
        module,
      },
      order: [['preferenceKey', 'ASC'], ['name', 'ASC']],
    });

    const defaultPreference = preferences.find((preference) => preference.preferenceKey === 'default') || null;
    const presets = preferences.filter((preference) => preference.preferenceKey !== 'default');

    return res.status(200).json({
      success: true,
      data: {
        default: defaultPreference,
        presets,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to load report preferences.',
    });
  }
};

exports.getReportData = async (req, res) => {
  try {
    const module = normalizeModule(req.params.module);
    ensureAllowedModule(module);

    const { data, count, pagination } = await getDecoratedReportRows(req, module);

    return res.status(200).json({
      success: true,
      count,
      data,
      pagination,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to load report data.',
    });
  }
};

exports.exportReportCsv = async (req, res) => {
  try {
    const module = normalizeModule(req.params.module);
    ensureAllowedModule(module);

    const { data } = await getDecoratedReportRows(req, module);
    const selectedColumns = sanitizeColumnIds(String(req.query.columns || '').split(','));
    const availableColumns = module === 'request'
      ? reportExportColumns
      : reportExportColumns.filter(([key]) => !key.startsWith('hod') && !['timeBetweenApprovals', 'timeToAssignAfterApproval', 'rejectedByLevel', 'rejectionComment', 'rejectedAt'].includes(key));
    const selectedSet = new Set(selectedColumns);
    const columns = selectedColumns.length
      ? availableColumns.filter(([key]) => selectedSet.has(key))
      : availableColumns;

    const header = columns.map(([, label]) => csvEscape(label)).join(',');
    const body = data.map((row) => (
      columns.map(([key]) => csvEscape(getExportValue(row, key))).join(',')
    ));
    const csv = [header, ...body].join('\n');

    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${module}-report-${today}.csv"`);
    return res.status(200).send(csv);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to export report CSV.',
    });
  }
};

exports.saveDefaultReportColumns = async (req, res) => {
  try {
    const module = normalizeModule(req.params.module);
    ensureAllowedModule(module);

    const columns = sanitizeColumnIds(req.body.columns);
    if (!columns.length) {
      return res.status(400).json({
        success: false,
        message: 'At least one report column is required.',
      });
    }

    const [preference] = await ReportPreference.upsert({
      staffId: req.user.id,
      module,
      preferenceKey: 'default',
      name: 'Default Columns',
      columns,
      filters: {},
    }, {
      returning: true,
    });

    return res.status(200).json({
      success: true,
      data: preference,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to save report columns.',
    });
  }
};

exports.createReportPreset = async (req, res) => {
  try {
    const module = normalizeModule(req.params.module);
    ensureAllowedModule(module);

    const name = String(req.body.name || '').trim();
    const columns = sanitizeColumnIds(req.body.columns);
    const filters = sanitizeFilters(req.body.filters);

    if (!name) {
      return res.status(400).json({ success: false, message: 'Preset name is required.' });
    }

    if (!columns.length) {
      return res.status(400).json({ success: false, message: 'At least one report column is required.' });
    }

    const existing = await ReportPreference.findOne({
      where: {
        staffId: req.user.id,
        module,
        preferenceKey: { [Op.ne]: 'default' },
        name,
      },
    });

    if (existing) {
      existing.columns = columns;
      existing.filters = filters;
      await existing.save();

      return res.status(200).json({
        success: true,
        data: existing,
        message: 'Report preset updated.',
      });
    }

    const preset = await ReportPreference.create({
      staffId: req.user.id,
      module,
      preferenceKey: `preset:${Date.now()}`,
      name,
      columns,
      filters,
    });

    return res.status(201).json({
      success: true,
      data: preset,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to save report preset.',
    });
  }
};

exports.deleteReportPreset = async (req, res) => {
  try {
    const module = normalizeModule(req.params.module);
    ensureAllowedModule(module);

    const deleted = await ReportPreference.destroy({
      where: {
        id: req.params.id,
        staffId: req.user.id,
        module,
      },
    });

    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Report preset not found.' });
    }

    return res.status(200).json({ success: true, message: 'Report preset deleted.' });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to delete report preset.',
    });
  }
};

exports.previewReportCalculations = (req, res) => {
  const { rows = [] } = req.body;
  const data = Array.isArray(rows) ? rows : [];

  return res.status(200).json({
    success: true,
    data: data.map((row) => ({
      id: row.id,
      description: stripHtml(row.description),
      problemDescription: stripHtml(row.problemDescription),
      actionTakenComment: stripHtml(row.actionTakenComment),
      timeToAssignMinutes: durationMinutes(row.createdAt, row.assignedAt || row.forwardAt),
      totalTimeToCloseMinutes: durationMinutes(row.createdAt, row.resolvedAt),
      timeBetweenApprovalsMinutes: durationMinutes(row.hod1ApprovedAt, row.hod2ApprovedAt),
      timeToAssignAfterApprovalMinutes: durationMinutes(row.hod2ApprovedAt, row.assignedAt),
    })),
  });
};
