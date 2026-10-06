'use strict';
const ApiError = require('./ApiError');
const time = require('./time');

const asObject = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});
const oneLine = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
/** Multi-line text: keeps line breaks but trims and normalises them. */
const multiLine = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim() : '');
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const REVIEW_ACTIONS = {
  approve: { status: 'approved', remarksRequired: false },
  reject: { status: 'rejected', remarksRequired: true },
  request_corrections: { status: 'correction_requested', remarksRequired: true },
  reopen: { status: 'pending', remarksRequired: true },
};
const REVIEW_STATUSES = ['pending', 'approved', 'rejected', 'correction_requested'];
const VERIFICATION_STATUSES = ['pending', 'in_progress', 'completed'];
const APPOINTMENT_END_STATUSES = ['completed', 'missed', 'cancelled'];

function assertValid(errors) {
  if (Object.keys(errors).length) throw new ApiError(400, 'Please correct the highlighted fields.', errors);
}

function parseId(raw, label = 'ID') {
  if (!/^\d{1,9}$/.test(String(raw))) throw new ApiError(404, `${label} not found.`);
  return Number(raw);
}

function validateReview(body) {
  const b = asObject(body);
  const errors = {};
  const action = oneLine(b.action);
  const rule = REVIEW_ACTIONS[action];
  const remarks = multiLine(b.remarks);
  const expectedStatus = oneLine(b.expectedStatus);

  if (!rule) errors.action = 'Choose approve, reject, request corrections or reopen.';
  if (remarks.length > 1000) errors.remarks = 'Remarks can be at most 1000 characters.';
  else if (rule && rule.remarksRequired && remarks.length < 5) {
    errors.remarks = 'Remarks (at least 5 characters) are required for this action. The student will see them.';
  }
  if (expectedStatus && !REVIEW_STATUSES.includes(expectedStatus)) errors.expectedStatus = 'Unknown status.';
  return { errors, values: { action, targetStatus: rule && rule.status, remarks: remarks || null, expectedStatus: expectedStatus || null } };
}

function validateNote(body) {
  const b = asObject(body);
  const errors = {};
  const remarks = multiLine(b.remarks);
  if (remarks.length < 3) errors.remarks = 'Enter the note (at least 3 characters).';
  else if (remarks.length > 1000) errors.remarks = 'Notes can be at most 1000 characters.';
  return { errors, values: { remarks } };
}

function validateVerification(body) {
  const b = asObject(body);
  const errors = {};
  const status = oneLine(b.status);
  const remarks = multiLine(b.remarks);
  if (!VERIFICATION_STATUSES.includes(status)) errors.status = 'Select a verification status.';
  if (remarks.length > 300) errors.remarks = 'Remarks can be at most 300 characters.';
  else if (status === 'pending' && remarks.length < 3) errors.remarks = 'Give a reason when resetting the verification.';
  return { errors, values: { status, remarks: remarks || null } };
}

/** Shared by "schedule" and "reschedule". */
function validateAppointment(body, { requireReason = false, requireStudent = false } = {}) {
  const b = asObject(body);
  const errors = {};
  const date = oneLine(b.date);
  const startTime = oneLine(b.time);
  const venue = oneLine(b.venue);
  const instructions = multiLine(b.instructions);
  const reason = multiLine(b.reason);
  const studentId = requireStudent ? Number(b.studentId) : null;

  if (requireStudent && (!Number.isInteger(studentId) || studentId < 1)) errors.studentId = 'Choose a student.';

  if (!date) errors.date = 'Date is required.';
  else if (!time.isRealDate(date)) errors.date = 'Enter a valid date.';
  else if (date < time.today()) errors.date = 'The appointment date cannot be in the past.';
  else if (date > time.addDays(365)) errors.date = 'Choose a date within the next year.';

  if (!startTime) errors.time = 'Time is required.';
  else if (!TIME_RE.test(startTime)) errors.time = 'Enter a valid time (HH:MM).';
  else if (!errors.date && date === time.today() && startTime <= time.nowTime()) errors.time = 'That time has already passed today.';

  if (!venue) errors.venue = 'Venue is required.';
  else if (venue.length < 3 || venue.length > 150) errors.venue = 'Venue must be 3-150 characters.';

  if (instructions.length > 300) errors.instructions = 'Instructions can be at most 300 characters.';
  if (requireReason) {
    if (reason.length < 3) errors.reason = 'Give a reason for rescheduling. The student will see it.';
    else if (reason.length > 300) errors.reason = 'Reason can be at most 300 characters.';
  }
  return { errors, values: { studentId, date, time: startTime, venue, instructions: instructions || null, reason: reason || null } };
}

function validateAppointmentStatus(body) {
  const b = asObject(body);
  const errors = {};
  const status = oneLine(b.status);
  const note = multiLine(b.note);
  if (!APPOINTMENT_END_STATUSES.includes(status)) errors.status = 'Choose completed, missed or cancelled.';
  if (note.length > 300) errors.note = 'Note can be at most 300 characters.';
  else if (status === 'cancelled' && note.length < 3) errors.note = 'Give a reason for cancelling. The student will see it.';
  return { errors, values: { status, note: note || null } };
}

/** Page/size/filter parsing shared by list endpoints. Unknown values are ignored, never trusted. */
function parsePaging(query, { defaultSize = 20, maxSize = 50 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(query.pageSize, 10) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
const pick = (value, allowed) => (typeof value === 'string' && allowed.includes(value) ? value : null);
/** Escapes % and _ so a search like "100%" is matched literally by LIKE ... ESCAPE '\'. */
const likeTerm = (raw) => `%${String(raw || '').trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

module.exports = {
  REVIEW_ACTIONS, REVIEW_STATUSES, VERIFICATION_STATUSES, APPOINTMENT_END_STATUSES,
  assertValid, parseId, validateReview, validateNote, validateVerification, validateAppointment,
  validateAppointmentStatus, parsePaging, pick, likeTerm,
};
