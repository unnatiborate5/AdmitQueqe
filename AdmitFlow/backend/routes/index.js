'use strict';
const express = require('express');

const router = express.Router();
router.get('/health', (req, res) => res.json({ success: true, message: 'AdmitFlow API is running.' }));
router.use('/auth', require('./authRoutes'));
router.use('/cap-details', require('./capRoutes'));
router.use('/checklist', require('./checklistRoutes'));
router.use('/dashboard', require('./dashboardRoutes'));

module.exports = router;
