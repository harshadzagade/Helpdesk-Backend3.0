const express = require('express');
const dotenv = require('dotenv').config();
const db = require('./config/db');
const cors = require('cors');
const seedSuperAdmin = require('./config/seedSuperAdmin');
const fileUpload = require('express-fileupload');
const path = require('path');

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



db.authenticate()
  .then(() => console.log('Database connected...'))
  .catch(err => console.log('Error: ' + err));

const app = express();

// ✅ CORS FIRST — before routes
app.use(cors({
  origin: 'http://localhost:5173',   // your Vite dev URL
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

const PORT = 5000;
//server start
const startServer = async () => {
  try {
    await db.sync({ force: false });
    console.log("Database connected");
    await seedSuperAdmin();

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}...`);
    });
  } catch (error) {
    console.error("Error connecting to database:", error);
  }
}
startServer();