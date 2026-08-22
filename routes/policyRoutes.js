// routes/policyRoutes.js
const express = require('express');
const router = express.Router();
const {createPolicy, getAllPolicies, getPolicyById, updatePolicy, deletePolicy} = require('../controller/policyController');
const { verifyToken } = require('../middleware/authMiddleware');

router.post('/createpolicy', verifyToken, createPolicy);       // Create
router.get('/', verifyToken, getAllPolicies);      // Read all
router.get('/:id',verifyToken, getPolicyById);   // Read one
router.put('/updatepolicy/:id', verifyToken, updatePolicy);    // Update
router.delete('/deletepolicy/:id', verifyToken, deletePolicy); // Delete

module.exports = router;
