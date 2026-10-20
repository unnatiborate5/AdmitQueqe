'use strict';
const express = require('express');
const controller = require('../controllers/taskController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.post('/:taskKey/uploads', requireAuth, controller.uploadFile);
router.get('/uploads/:fileId', requireAuth, controller.downloadFile);
router.get('/:taskKey', requireAuth, controller.getTask);
router.put('/:taskKey', requireAuth, controller.saveTask);

module.exports = router;
