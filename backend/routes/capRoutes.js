'use strict';
const express = require('express');
const controller = require('../controllers/capController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.get('/', requireAuth, controller.getCapDetails);
router.put('/', requireAuth, controller.submitApplicationId);
router.delete('/', requireAuth, controller.withdraw);
router.post('/simulate-login', requireAuth, controller.simulateCapLogin);
router.post('/demo-login', requireAuth, controller.simulateCapLogin);

module.exports = router;
