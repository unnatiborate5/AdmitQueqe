'use strict';
const express = require('express');

const router = express.Router();
router.get('/health', (req, res) => res.json({ success: true, message: 'AdmitFlow API is running.' }));
router.use('/auth', require('./authRoutes'));
router.use('/cap-details', require('./capRoutes'));
router.use('/checklist', require('./checklistRoutes'));
router.use('/tasks', require('./taskRoutes'));
router.use('/dashboard', require('./dashboardRoutes'));
router.use('/application', require('./applicationRoutes'));
router.use('/queue', require('./queueRoutes'));
router.use('/admin', require('./adminRoutes'));

module.exports = router;
