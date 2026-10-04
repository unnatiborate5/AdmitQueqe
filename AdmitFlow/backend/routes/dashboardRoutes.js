'use strict';
const express = require('express');
const controller = require('../controllers/dashboardController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.get('/', requireAuth, controller.getDashboard);

module.exports = router;
