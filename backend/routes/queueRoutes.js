'use strict';
const express = require('express');
const controller = require('../controllers/queueController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.get('/my-token', requireAuth, controller.myToken);

module.exports = router;
