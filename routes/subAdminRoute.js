const express = require('express');
const router = express.Router();
const {
    getSubadminActivities
} = require('../controller/subadminActivity');
const { verifyToken } = require('../middleware/authMiddleware');
const activeDepartment = require('../middleware/activeDepartment');


router.get('/', verifyToken, activeDepartment, getSubadminActivities);

module.exports = router;