
const express = require("express");
const router = express.Router();

const { verifyToken } = require("../middleware/authMiddleware");
const activeDepartment = require("../middleware/activeDepartment");

const {
    superadminSummary,
    adminSummary,
    engineerSummary,
    engineerAssignedTickets,
    userSummary,
} = require("../controller/dashboardController");

router.get("/superadmin", verifyToken, superadminSummary);
router.get("/admin", verifyToken, activeDepartment, adminSummary);
router.get("/engineer", verifyToken, engineerSummary);
router.get("/engineer/tickets", verifyToken, engineerAssignedTickets);
router.get("/user", verifyToken, userSummary);

module.exports = router;
