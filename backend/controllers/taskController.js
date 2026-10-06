'use strict';
const capService = require('../services/capService');
const taskService = require('../services/taskService');
const dashboardService = require('../services/dashboardService');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

/** Tasks other than CAP details need the CAP record first. */
function requireCapDetails(studentId) {
  if (!capService.get(studentId)) {
    throw new ApiError(409, 'Please enter your CAP details first.', null, 'CAP_DETAILS_REQUIRED');
  }
}

const getTask = asyncHandler(async (req, res) => {
  requireCapDetails(req.student.id);
  res.json({ success: true, data: taskService.getTask(req.student.id, req.params.taskKey) });
});

const saveTask = asyncHandler(async (req, res) => {
  requireCapDetails(req.student.id);
  const result = taskService.saveTask(req.student.id, req.params.taskKey, req.body);
  res.json({
    success: true,
    message: `${result.task.title} saved. Status: ${result.task.statusLabel}.`,
    data: { ...result, progress: dashboardService.getProgress(req.student.id) },
  });
});

module.exports = { getTask, saveTask };
