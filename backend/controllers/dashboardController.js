'use strict';
const dashboardService = require('../services/dashboardService');
const queueService = require('../services/queueService');
const asyncHandler = require('../utils/asyncHandler');

const getDashboard = asyncHandler(async (req, res) => {
  const data = dashboardService.getSummary(req.student);
  // The queue is an add-on: if the engine is unavailable the dashboard must still load.
  try { data.queue = await queueService.getStudentView(req.student.id); } catch (err) { data.queue = null; }
  res.json({ success: true, data });
});

module.exports = { getDashboard };
