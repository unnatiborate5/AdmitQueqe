'use strict';
const capService = require('../services/capService');
const capRecordService = require('../services/capRecordService');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const db = require('../config/db');

const state = (studentId) => {
  const capDetails = capService.get(studentId);
  const verification = capRecordService.studentState(studentId);
  const student = db.prepare('SELECT admission_token FROM students WHERE id = ?').get(studentId);
  let admissionToken = (capDetails && capDetails.admissionToken) || (student ? student.admission_token : null) || null;
  let details = capDetails;
  if (!details) {
    const rec = db.prepare('SELECT * FROM cap_allotment_records WHERE linked_student_id = ?').get(studentId);
    if (rec) {
      if (!admissionToken && rec.status === 'verified') {
        const admissionTokenService = require('../services/admissionTokenService');
        admissionToken = admissionTokenService.allocateAdmissionToken(studentId, db);
      }
      details = {
        applicationId: rec.application_id,
        studentName: rec.candidate_name,
        allottedCollege: rec.allotted_college,
        courseBranch: rec.course_branch,
        capRound: rec.cap_round,
        allotmentStatus: rec.allotment_status,
        admissionToken,
        updatedAt: rec.updated_at,
        verified: rec.status === 'verified',
        status: rec.status,
      };
    }
  } else if (details && !details.admissionToken && admissionToken) {
    details.admissionToken = admissionToken;
  }
  return { capDetails: details, verification, admissionToken };
};

const getCapDetails = asyncHandler(async (req, res) => {
  res.json({ success: true, data: state(req.student.id) });
});

/**
 * The ONLY thing a student can submit is their application ID. College, branch, CAP round, allotment status (and any
 * other field, including anything resembling a password) are refused outright; they come from verified records.
 * Rejected field names are listed, but their values are never echoed or stored.
 */
const submitApplicationId = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const extra = Object.keys(body).filter((k) => k !== 'applicationId');
  if (extra.length) {
    const errors = {};
    extra.slice(0, 10).forEach((k) => { errors[String(k).slice(0, 40)] = 'This cannot be edited. It comes from verified CAP records.'; });
    throw new ApiError(400, 'Only the application ID can be submitted. College, branch, CAP round and allotment status come from verified CAP records and cannot be edited.', errors, 'READ_ONLY_FIELDS');
  }
  const result = capRecordService.claim(req.student, body.applicationId);
  res.json({
    success: true,
    message: result.status === 'linked' ? 'Your CAP details were found and linked.' : 'Verification pending. The admission cell will verify your application ID.',
    data: { result: result.status, ...state(req.student.id) },
  });
});

const withdraw = asyncHandler(async (req, res) => {
  capRecordService.withdrawClaim(req.student);
  res.json({ success: true, message: 'The pending verification was withdrawn.', data: state(req.student.id) });
});

const simulateCapLogin = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const result = capRecordService.simulateCapLogin(req.student, body.applicationId, body.demoPassword || body.password);
  res.json({
    success: true,
    message: 'Demo CAP credentials verified successfully. Your allotment details have been linked.',
    data: result,
  });
});

module.exports = { getCapDetails, submitApplicationId, withdraw, simulateCapLogin };
