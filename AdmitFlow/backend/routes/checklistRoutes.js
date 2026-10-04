'use strict';
const express = require('express');
const controller = require('../controllers/checklistController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.get('/', requireAuth, controller.getChecklist);
router.patch('/:itemKey', requireAuth, controller.updateItem);

module.exports = router;
