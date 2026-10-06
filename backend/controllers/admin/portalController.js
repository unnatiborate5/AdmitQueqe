'use strict';
const asyncHandler = require('../../utils/asyncHandler');
const v = require('../../utils/adminValidators');
const adminDashboardService = require('../../services/adminDashboardService');
const adminStudentService = require('../../services/adminStudentService');
const applicationService = require('../../services/applicationService');
const verificationAdminService = require('../../services/verificationAdminService');
const activityService = require('../../services/activityService');

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
  const result = applicationService.review(req.admin, id, values);
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

const activity = asyncHandler(async (req, res) => {
  res.json({ success: true, data: activityService.list(req.query) });
});

module.exports = { dashboard, listStudents, studentDetail, reviewApplication, addNote, recordVerification, activity };
