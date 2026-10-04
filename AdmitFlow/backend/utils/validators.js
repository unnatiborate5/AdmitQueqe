'use strict';
const ApiError = require('./ApiError');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_RE = /^\p{L}[\p{L} .'-]{1,99}$/u;
const PHONE_RE = /^[6-9]\d{9}$/;
const APP_ID_RE = /^[A-Z0-9][A-Z0-9-]{4,19}$/;

const asObject = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {});
const clean = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

function normalizePhone(raw) {
  let d = String(raw === undefined || raw === null ? '' : raw).replace(/[\s()-]/g, '');
  if (d.startsWith('+91')) d = d.slice(3);
  else if (/^91\d{10}$/.test(d)) d = d.slice(2);
  else if (/^0\d{10}$/.test(d)) d = d.slice(1);
  return d;
}

/** Throws a 400 ApiError when `errors` is not empty. */
function assertValid(errors) {
  if (Object.keys(errors).length > 0) {
    throw new ApiError(400, 'Please correct the highlighted fields.', errors);
  }
}

function validateRegistration(body) {
  const b = asObject(body);
  const errors = {};
  const fullName = clean(b.fullName);
  const email = clean(b.email).toLowerCase();
  const phone = normalizePhone(b.phone);
  const password = typeof b.password === 'string' ? b.password : '';
  const confirmPassword = typeof b.confirmPassword === 'string' ? b.confirmPassword : '';

  if (!fullName) errors.fullName = 'Full name is required.';
  else if (!NAME_RE.test(fullName)) errors.fullName = "Enter a valid name (2-100 letters; spaces, . ' - allowed).";

  if (!email) errors.email = 'Email is required.';
  else if (email.length > 254 || !EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';

  if (!phone) errors.phone = 'Mobile number is required.';
  else if (!PHONE_RE.test(phone)) errors.phone = 'Enter a valid 10-digit Indian mobile number.';

  if (!password) errors.password = 'Password is required.';
  else if (password.length < 8) errors.password = 'Password must be at least 8 characters.';
  else if (password.length > 128) errors.password = 'Password must be at most 128 characters.';
  else if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    errors.password = 'Password must contain at least one letter and one number.';
  }

  if (!confirmPassword) errors.confirmPassword = 'Please confirm your password.';
  else if (confirmPassword !== password) errors.confirmPassword = 'Passwords do not match.';

  return { errors, values: { fullName, email, phone, password } };
}

function validateLogin(body) {
  const b = asObject(body);
  const errors = {};
  const email = clean(b.email).toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  if (!email) errors.email = 'Email is required.';
  else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
  if (!password) errors.password = 'Password is required.';
  return { errors, values: { email, password } };
}

function validateCapDetails(body, options) {
  const b = asObject(body);
  const errors = {};
  const applicationId = clean(b.applicationId).toUpperCase();
  const studentName = clean(b.studentName);
  const allottedCollege = clean(b.allottedCollege);
  const courseBranch = clean(b.courseBranch);
  const capRound = clean(b.capRound);
  const allotmentStatus = clean(b.allotmentStatus);

  if (!applicationId) errors.applicationId = 'Application ID is required.';
  else if (!APP_ID_RE.test(applicationId)) {
    errors.applicationId = 'Application ID must be 5-20 characters (letters, numbers, hyphen).';
  }

  if (!studentName) errors.studentName = 'Student name is required.';
  else if (!NAME_RE.test(studentName)) errors.studentName = 'Enter a valid name as printed on your allotment letter.';

  if (!allottedCollege) errors.allottedCollege = 'Allotted college is required.';
  else if (allottedCollege.length < 3 || allottedCollege.length > 150) {
    errors.allottedCollege = 'College name must be 3-150 characters.';
  }

  if (!courseBranch) errors.courseBranch = 'Course / branch is required.';
  else if (courseBranch.length < 2 || courseBranch.length > 100) {
    errors.courseBranch = 'Course / branch must be 2-100 characters.';
  }

  if (!capRound) errors.capRound = 'CAP round is required.';
  else if (!options.capRounds.includes(capRound)) errors.capRound = 'Select a valid CAP round.';

  if (!allotmentStatus) errors.allotmentStatus = 'Allotment status is required.';
  else if (!options.allotmentStatuses.includes(allotmentStatus)) {
    errors.allotmentStatus = 'Select a valid allotment status.';
  }

  return {
    errors,
    values: { applicationId, studentName, allottedCollege, courseBranch, capRound, allotmentStatus },
  };
}

module.exports = { assertValid, validateRegistration, validateLogin, validateCapDetails };
