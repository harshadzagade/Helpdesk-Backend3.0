const express = require('express');
const router = express.Router();

const {
  getReportPreferences,
  saveDefaultReportColumns,
  createReportPreset,
  deleteReportPreset,
  exportReportCsv,
  getReportData,
  previewReportCalculations,
} = require('../controller/reportController');
const { verifyToken, allowRoles } = require('../middleware/authMiddleware');

router.get(
  '/data/:module',
  verifyToken,
  getReportData
);

router.get(
  '/export/:module.csv',
  verifyToken,
  allowRoles('admin', 'subadmin', 'superadmin'),
  exportReportCsv
);

router.get(
  '/preferences/:module',
  verifyToken,
  allowRoles('admin', 'subadmin', 'superadmin'),
  getReportPreferences
);

router.put(
  '/preferences/:module/default',
  verifyToken,
  allowRoles('admin', 'subadmin', 'superadmin'),
  saveDefaultReportColumns
);

router.post(
  '/preferences/:module/presets',
  verifyToken,
  allowRoles('admin', 'subadmin', 'superadmin'),
  createReportPreset
);

router.delete(
  '/preferences/:module/presets/:id',
  verifyToken,
  allowRoles('admin', 'subadmin', 'superadmin'),
  deleteReportPreset
);

router.post(
  '/calculations/preview',
  verifyToken,
  allowRoles('admin', 'subadmin', 'superadmin'),
  previewReportCalculations
);

module.exports = router;
