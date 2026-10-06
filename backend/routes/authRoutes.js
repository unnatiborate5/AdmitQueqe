'use strict';
const express = require('express');
const controller = require('../controllers/authController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.post('/register', controller.register);
router.post('/login', controller.login);
router.post('/logout', controller.logout);
router.get('/me', requireAuth, controller.me);

module.exports = router;
