
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
    ticketReminderPopup,
    getReminderStatus,
    getReminderLogs,
    runReminderCheck,
    sendReminderTestEmail,
    rephraseText,
    updateReminderStatus,
} = require("../controller/dashboardController");

router.get("/superadmin", verifyToken, superadminSummary);
router.get("/admin", verifyToken, activeDepartment, adminSummary);
router.get("/engineer", verifyToken, engineerSummary);
router.get("/engineer/tickets", verifyToken, engineerAssignedTickets);
router.get("/user", verifyToken, userSummary);
router.get("/ticket-reminders", verifyToken, ticketReminderPopup);
router.get("/reminders/status", verifyToken, getReminderStatus);
router.get("/reminders/logs", verifyToken, getReminderLogs);
router.put("/reminders/status", verifyToken, updateReminderStatus);
router.post("/reminders/run", verifyToken, runReminderCheck);
router.post("/reminders/test-email", verifyToken, sendReminderTestEmail);
router.post("/rephrase-text", verifyToken, rephraseText);

module.exports = router;
