'use strict';
const asyncHandler = require('../../utils/asyncHandler');
const v = require('../../utils/adminValidators');
const ApiError = require('../../utils/ApiError');
const progressQueueService = require('../../services/admissionProgressQueueService');

const list = asyncHandler(async (req, res) => {
  const data = await progressQueueService.getQueue(req.query);
  res.json({ success: true, data });
});

const getStudent = asyncHandler(async (req, res) => {
  const studentId = v.parseId(req.params.id, 'Student');
  const data = await progressQueueService.getStudentQueueStatus(studentId);
  if (!data) {
    throw new ApiError(404, 'Student is not in the admission progress queue.');
  }
  res.json({ success: true, data });
});

module.exports = {
  list,
  getStudent,
};
