'use strict';
const dashboardService = require('../services/dashboardService');
const asyncHandler = require('../utils/asyncHandler');

const getDashboard = asyncHandler(async (req, res) => {
  res.json({ success: true, data: dashboardService.getSummary(req.student) });
});

module.exports = { getDashboard };
