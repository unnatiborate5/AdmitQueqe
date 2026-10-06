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

// ---------------------------------------------------------------------------
// Task forms (acceptance, admission form, documents, fee)
// ---------------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECEIPT_RE = /^[A-Za-z0-9][A-Za-z0-9\-_/ ]{2,39}$/;
const MAX_FEE = 10000000;

/** Returns an error message, or null when `value` is a real YYYY-MM-DD date that is not in the future. */
function dateProblem(value) {
  if (!DATE_RE.test(value)) return 'Enter a valid date.';
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return 'Enter a valid date.';
  if (d.getUTCFullYear() < 2000) return 'Enter a valid date.';
  // allow one day of slack so students in time zones ahead of the server are not rejected
  if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) return 'The date cannot be in the future.';
  return null;
}

/** Parses an amount with at most 2 decimals. Returns { value } (null when blank) or { error }. */
function parseMoney(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: null };
  const text = String(raw).trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { error: 'Enter a valid amount (numbers only, up to 2 decimals).' };
  const value = Number(text);
  if (value > MAX_FEE) return { error: 'Amount is too large.' };
  return { value };
}

const cents = (n) => Math.round(n * 100);

/** Status + optional date + note, used by Allotment Acceptance and Admission Form. */
function validateStatusRecord(body, statuses, dateLabel) {
  const b = asObject(body);
  const errors = {};
  const status = clean(b.status);
  const eventDate = clean(b.eventDate);
  const note = typeof b.note === 'string' ? b.note.trim() : '';

  if (!statuses.includes(status)) errors.status = 'Select a status.';
  if (eventDate) {
    const problem = dateProblem(eventDate);
    if (problem) errors.eventDate = problem;
  } else if (status === 'completed') {
    errors.eventDate = `${dateLabel} date is required.`;
  }
  if (note.length > 300) errors.note = 'Notes can be at most 300 characters.';

  return {
    errors,
    values: { status, eventDate: status === 'pending' ? null : (eventDate || null), note: note || null },
  };
}

function validateDocuments(body, documentKeys) {
  const b = asObject(body);
  const errors = {};
  const list = b.preparedDocs;
  let prepared = [];
  if (!Array.isArray(list) || list.some((k) => typeof k !== 'string')) {
    errors.preparedDocs = 'Send the list of prepared documents.';
  } else {
    prepared = Array.from(new Set(list));
    if (prepared.some((k) => !documentKeys.includes(k))) errors.preparedDocs = 'Unknown document in the list.';
  }
  return { errors, values: { prepared } };
}

function validateFee(body, statuses, paymentModes) {
  const b = asObject(body);
  const errors = {};
  const status = clean(b.status);
  if (!statuses.includes(status)) errors.status = 'Select a payment status.';

  const total = parseMoney(b.totalFee);
  if (total.error) errors.totalFee = total.error;

  const values = { status, totalFee: total.value || null, amountPaid: null, paymentMode: null, receiptNumber: null, paidOn: null };
  if (errors.status || status === 'pending') return { errors, values };

  const paid = parseMoney(b.amountPaid);
  const paymentMode = clean(b.paymentMode);
  const receiptNumber = clean(b.receiptNumber);
  const paidOn = clean(b.paidOn);

  if (paid.error) errors.amountPaid = paid.error;
  else if (paid.value === null || paid.value <= 0) errors.amountPaid = 'Enter the amount you have paid.';
  else if (total.value !== null && !errors.totalFee) {
    if (status === 'in_progress' && cents(paid.value) >= cents(total.value)) {
      errors.amountPaid = 'This covers the full fee. Choose "Paid" instead, or lower the amount.';
    } else if (status === 'completed' && cents(paid.value) < cents(total.value)) {
      errors.amountPaid = 'This is less than the total fee. Choose "Partially Paid" instead.';
    }
  }

  if (!paymentMode) errors.paymentMode = 'Select how you paid.';
  else if (!paymentModes.includes(paymentMode)) errors.paymentMode = 'Select a valid payment mode.';

  if (!receiptNumber) errors.receiptNumber = 'Receipt or transaction number is required.';
  else if (!RECEIPT_RE.test(receiptNumber)) errors.receiptNumber = 'Use 3-40 letters, numbers, spaces, - _ or /.';

  if (!paidOn) errors.paidOn = 'Payment date is required.';
  else { const problem = dateProblem(paidOn); if (problem) errors.paidOn = problem; }

  Object.assign(values, { amountPaid: paid.value, paymentMode, receiptNumber, paidOn });
  return { errors, values };
}

module.exports = {
  assertValid, validateRegistration, validateLogin, validateCapDetails,
  validateStatusRecord, validateDocuments, validateFee,
};
