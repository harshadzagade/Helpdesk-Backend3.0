const express = require('express');
const dotenv = require('dotenv').config();
const db = require('./config/db');
const cors = require('cors');
const seedSuperAdmin = require('./config/seedSuperAdmin');
const fileUpload = require('express-fileupload');
const path = require('path');
const http = require('http');
const { QueryTypes } = require('sequelize');
const { startReminderScheduler } = require('./utils/reminderJob');
const { initializeRealtime } = require('./utils/realtime');

// Routes Imports
const authRoute = require('./routes/authRoute');
const instituteRoute = require('./routes/instituteRoute');
const departmentRoute = require('./routes/departmentRoute');
const staffRoute = require('./routes/staffRoute');
const ArchiveStaffRoute = require('./routes/archiveStaff');
const ComplaintRoute = require('./routes/complaintRoute');
const requestRoutes = require('./routes/requestRoutes');
const policyRoutes = require('./routes/policyRoutes');
const SubadminActivityRoute = require('./routes/subAdminRoute');
const dashboardRoutes = require("./routes/dashboardRoutes");
const reportRoutes = require('./routes/reportRoutes');



db.authenticate()
  .then(() => console.log('Database connected...'))
  .catch(err => console.log('Error: ' + err));

const app = express();
const server = http.createServer(app);
const allowedOrigins = [
  'http://localhost:5173',
  'http://hello.met.edu',
  'http://hello.met.edu:5173',
  'https://hello.met.edu',
  'https://hello.met.edu:5173',
  ...String(process.env.FRONTEND_URL || process.env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
];

// ✅ CORS FIRST — before routes
app.use(cors({
  origin: [...new Set(allowedOrigins)],
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','x-department-id'],
  credentials: false                  // keep false if using JWT in headers
}));

//middleware
app.use(express.json());

// ✅ FILE UPLOAD (express-fileupload)
app.use(fileUpload({
  createParentPath: true,   // folder auto banane ke liye
}));

// ✅ Static for uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

//routes
app.use('/api/auth', authRoute);
app.use('/api/institutes', instituteRoute); 
app.use('/api/departments', departmentRoute);
app.use('/api/staff', staffRoute);
app.use('/api/staffArchive', ArchiveStaffRoute);
app.use('/api/complaints', ComplaintRoute);
app.use('/api/requests', requestRoutes);
app.use('/api/policies', policyRoutes);
app.use('/api/subadmin-activities', SubadminActivityRoute);
app.use("/api/dashboard", dashboardRoutes);
app.use('/api/reports', reportRoutes);

const PORT = 5000;

const ensureUniqueTicketIndexes = async () => {
  const duplicateChecks = [
    { tableName: 'complaint', label: 'complaint' },
    { tableName: '"request"', label: 'request' },
  ];

  for (const { tableName, label } of duplicateChecks) {
    const duplicates = await db.query(
      `SELECT "ticketId", COUNT(*)::int AS count
       FROM ${tableName}
       WHERE "ticketId" IS NOT NULL
       GROUP BY "ticketId"
       HAVING COUNT(*) > 1`,
      { type: QueryTypes.SELECT }
    );

    if (duplicates.length > 0) {
      const duplicateList = duplicates.map((row) => row.ticketId).join(', ');
      throw new Error(`Duplicate ${label} ticketId values already exist: ${duplicateList}`);
    }
  }

  await db.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS complaint_ticket_id_unique_idx ON complaint ("ticketId") WHERE "ticketId" IS NOT NULL'
  );
  await db.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS request_ticket_id_unique_idx ON "request" ("ticketId") WHERE "ticketId" IS NOT NULL'
  );
};

//server start
const startServer = async () => {
  try {
    await db.sync({ force: false });
    await ensureUniqueTicketIndexes();
    console.log("Database connected");
    await seedSuperAdmin();

    initializeRealtime(server);

    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}...`);
      startReminderScheduler();
    });
  } catch (error) {
    console.error("Error connecting to database:", error);
  }
}
startServer();
