'use strict';
const express = require('express');
const controller = require('../controllers/taskController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.get('/:taskKey', requireAuth, controller.getTask);
router.put('/:taskKey', requireAuth, controller.saveTask);

module.exports = router;
