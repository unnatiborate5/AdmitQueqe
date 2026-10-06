'use strict';
const queueService = require('../services/queueService');
const asyncHandler = require('../utils/asyncHandler');

/** Student: my token and queue position (polled by the dashboard while a token is active). */
const myToken = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { queue: await queueService.getStudentView(req.student.id) } });
});

module.exports = { myToken };
