'use strict';
const capService = require('../services/capService');
const taskService = require('../services/taskService');
const dashboardService = require('../services/dashboardService');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const multipart = require('../utils/multipart');
const uploadService = require('../services/uploadService');

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
    message: result.task.key === 'physical_verification'
      ? 'Verification request submitted successfully for officer review. Original documents must still be checked in person.'
      : 'Submitted successfully for officer review.',
    data: { ...result, progress: dashboardService.getProgress(req.student.id) },
  });
});

const uploadFile = asyncHandler(async (req, res) => {
  requireCapDetails(req.student.id);
  const { fields, file } = await multipart.readRequest(req);
  const uploaded = uploadService.save(req.student.id, req.params.taskKey, {
    slot: fields.slot,
    filename: file && file.filename,
    mime: file && file.mime,
    buffer: file && file.buffer,
  });
  res.status(201).json({ success: true, message: 'Evidence uploaded.', data: { file: uploaded } });
});

const downloadFile = asyncHandler(async (req, res) => {
  uploadService.sendFile(res, uploadService.getOwned(req.params.fileId, req.student.id));
});

module.exports = { getTask, saveTask, uploadFile, downloadFile };
