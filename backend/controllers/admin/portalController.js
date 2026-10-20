'use strict';
const asyncHandler = require('../../utils/asyncHandler');
const v = require('../../utils/adminValidators');
const adminDashboardService = require('../../services/adminDashboardService');
const adminStudentService = require('../../services/adminStudentService');
const applicationService = require('../../services/applicationService');
const verificationAdminService = require('../../services/verificationAdminService');
const activityService = require('../../services/activityService');
const undoService = require('../../services/undoService');
const taskService = require('../../services/taskService');
const verificationService = require('../../services/verificationService');
const uploadService = require('../../services/uploadService');

const dashboard = asyncHandler(async (req, res) => {
  res.json({ success: true, data: adminDashboardService.getDashboard(req.admin) });
});

const listStudents = asyncHandler(async (req, res) => {
  res.json({ success: true, data: adminStudentService.list(req.query) });
});

const studentDetail = asyncHandler(async (req, res) => {
  res.json({ success: true, data: adminStudentService.getDetail(v.parseId(req.params.id, 'Student')) });
});

const reviewApplication = asyncHandler(async (req, res) => {
  const id = v.parseId(req.params.id, 'Student');
  const { errors, values } = v.validateReview(req.body);
  v.assertValid(errors);
  const before = applicationService.getReview(id);          // what an undo will restore
  const result = applicationService.review(req.admin, id, values);
  const student = applicationService.requireStudent(id);
  await undoService.record(req.admin, {
    kind: 'review', studentId: id,
    summary: `${applicationService.LABELS[result.status]}: application of ${student.fullName} (was ${applicationService.LABELS[before.status]})`,
    before: { status: before.status, remarks: before.remarks, reviewedBy: before.reviewedBy, reviewedAt: before.reviewedAt },
    after: { status: result.status },
  });
  res.json({
    success: true,
    message: `Application marked "${result.label}".`,
    data: adminStudentService.getDetail(id),
  });
});

const addNote = asyncHandler(async (req, res) => {
  const id = v.parseId(req.params.id, 'Student');
  const { errors, values } = v.validateNote(req.body);
  v.assertValid(errors);
  applicationService.addNote(req.admin, id, values.remarks);
  res.status(201).json({ success: true, message: 'Internal note saved.', data: adminStudentService.getDetail(id) });
});

const recordVerification = asyncHandler(async (req, res) => {
  const id = v.parseId(req.params.id, 'Student');
  const { errors, values } = v.validateVerification(req.body);
  v.assertValid(errors);
  verificationAdminService.record(req.admin, id, values);
  res.json({ success: true, message: 'Verification outcome saved.', data: adminStudentService.getDetail(id) });
});

const reviewTask = asyncHandler(async (req, res) => {
  const id = v.parseId(req.params.id, 'Student');
  if (req.params.taskKey === 'physical_verification' && req.body && req.body.action === 'approve'
      && verificationService.get(id).status !== 'completed') {
    throw new (require('../../utils/ApiError'))(409, 'Record the in-person original-document verification before approving this task.', null, 'IN_PERSON_VERIFICATION_REQUIRED');
  }
  taskService.reviewTask(req.admin, id, req.params.taskKey, req.body || {});
  res.json({ success: true, message: 'Task review saved.', data: adminStudentService.getDetail(id) });
});

const downloadTaskFile = asyncHandler(async (req, res) => {
  const id = v.parseId(req.params.id, 'Student');
  uploadService.sendFile(res, uploadService.getForAdmin(req.params.fileId, id));
});

const activity = asyncHandler(async (req, res) => {
  res.json({ success: true, data: activityService.list(req.query) });
});

module.exports = { dashboard, listStudents, studentDetail, reviewApplication, addNote, recordVerification, reviewTask, downloadTaskFile, activity };
