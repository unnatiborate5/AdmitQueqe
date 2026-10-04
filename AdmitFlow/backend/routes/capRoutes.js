'use strict';
const express = require('express');
const controller = require('../controllers/capController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.get('/', requireAuth, controller.getCapDetails);
router.put('/', requireAuth, controller.saveCapDetails);

module.exports = router;
