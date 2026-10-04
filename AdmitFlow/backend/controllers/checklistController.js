'use strict';
const capService = require('../services/capService');
const checklistService = require('../services/checklistService');
const dashboardService = require('../services/dashboardService');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

/** The checklist is only available once CAP details have been entered. */
function requireCapDetails(studentId) {
  if (!capService.get(studentId)) {
    throw new ApiError(409, 'Please enter your CAP details before using the checklist.', null, 'CAP_DETAILS_REQUIRED');
  }
}

const getChecklist = asyncHandler(async (req, res) => {
  requireCapDetails(req.student.id);
  res.json({
    success: true,
    data: {
      items: checklistService.getChecklist(req.student.id),
      progress: dashboardService.getProgress(req.student.id),
    },
  });
});

const updateItem = asyncHandler(async (req, res) => {
  requireCapDetails(req.student.id);
  const status = req.body && typeof req.body.status === 'string' ? req.body.status : '';
  const item = checklistService.updateItem(req.student.id, req.params.itemKey, status);
  res.json({
    success: true,
    message: `"${item.title}" updated to "${item.statusLabel}".`,
    data: { item, progress: dashboardService.getProgress(req.student.id) },
  });
});

module.exports = { getChecklist, updateItem };
