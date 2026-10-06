'use strict';
const capService = require('../services/capService');
const checklistService = require('../services/checklistService');
const dashboardService = require('../services/dashboardService');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const getChecklist = asyncHandler(async (req, res) => {
  if (!capService.get(req.student.id)) {
    throw new ApiError(409, 'Please enter your CAP details before using the checklist.', null, 'CAP_DETAILS_REQUIRED');
  }
  res.json({
    success: true,
    data: {
      items: checklistService.getChecklist(req.student.id),
      progress: dashboardService.getProgress(req.student.id),
    },
  });
});

module.exports = { getChecklist };
