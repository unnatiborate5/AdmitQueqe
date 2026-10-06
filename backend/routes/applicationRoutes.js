'use strict';
const express = require('express');
const controller = require('../controllers/applicationController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.post('/resubmit', requireAuth, controller.resubmit);

module.exports = router;
