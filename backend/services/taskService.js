'use strict';
/**
 * Detail views and save logic for the five checklist tasks.
 * (CAP details have their own service: capService.)
 */
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const checklistService = require('./checklistService');
const documentService = require('./documentService');
const verificationService = require('./verificationService');
const feeService = require('./feeService');
const appointmentService = require('./appointmentService');
const workflow = require('./taskWorkflowService');
const uploadService = require('./uploadService');
const {
  assertValid, validateStatusRecord, validateDocuments, validateFee,
} = require('../utils/validators');

const DATE_LABELS = { allotment_acceptance: 'Acceptance', admission_form: 'Submission' };
const FORBIDDEN_WORKFLOW = ['approved', 'correction_required', 'pending_review', 'not_started', 'submitted'];

function itemFor(studentId, key) {
  return checklistService.getChecklist(studentId).find((i) => i.key === key);
}

function requireKnownTask(key) {
  if (!checklistService.getDefinition(key)) throw new ApiError(404, 'Unknown task.');
}

function rejectStudentApprove(body) {
  const raw = body && typeof body === 'object' ? String(body.status || body.workflowStatus || '').trim() : '';
  if (raw === 'approved') {
    throw new ApiError(403, 'Students cannot approve tasks. An admission officer must review this.', null, 'STUDENT_CANNOT_APPROVE');
  }
}

function wantsSubmit(body) {
  return body && typeof body.action === 'string' && body.action.trim() === 'submit';
}

function nextStudentStatus(current, reportedStatus, submit) {
  if (submit) return 'pending_review';
  if (current === 'pending_review') return 'pending_review';
  if (current === 'correction_required') return 'correction_required';
  if (reportedStatus === 'pending') return 'not_started';
  return 'submitted';
}

function applyStudentWorkflow(studentId, key, reportedStatus, body) {
  const current = workflow.get(studentId, key).status;
  const submit = wantsSubmit(body);
  workflow.studentMove(studentId, key, nextStudentStatus(current, reportedStatus, submit));
}

/** Everything the task window needs to render. */
function getTask(studentId, key) {
  requireKnownTask(key);
  const task = itemFor(studentId, key);
  const files = uploadService.list(studentId, key);
  let details;

  switch (key) {
    case 'allotment_acceptance':
    case 'admission_form': {
      const rec = checklistService.getRecord(studentId, key);
      details = {
        eventDate: rec.eventDate,
        note: rec.note,
        files,
        requiredSlot: key === 'allotment_acceptance' ? 'receipt' : 'form',
      };
      break;
    }
    case 'document_preparation': {
      const s = documentService.getSummary(studentId);
      const bySlot = new Map(files.map((f) => [f.slot, f]));
      details = {
        documents: documentService.getDocuments(studentId).map((d) => ({ ...d, file: bySlot.get(d.key) || null })),
        preparedRequired: s.preparedRequired,
        requiredTotal: s.requiredTotal,
        files,
      };
      break;
    }
    case 'physical_verification': {
      const v = verificationService.get(studentId);
      const s = documentService.getSummary(studentId);
      details = {
        verifiedBy: v.verifiedBy,
        verifiedAt: v.verifiedAt,
        remarks: v.remarks,
        collegeVerification: v,
        documentsPrepared: s.preparedRequired,
        documentsRequired: s.requiredTotal,
        appointment: appointmentService.getStudentView(studentId),
        files,
        steps: [
          'Prepare your original documents and photocopies (see Document Preparation).',
          'Submit a verification request here so the admission cell knows you are ready.',
          'Visit your college on the date and time announced in its admission notice.',
          'College staff will check your original documents in person. Uploads never replace that check.',
          'An admission officer records the in-person outcome and then approves this task.',
        ],
      };
      break;
    }
    case 'fee_payment': {
      details = {
        ...feeService.get(studentId),
        paymentModes: feeService.PAYMENT_MODES,
        instructions: [
          ...feeService.INSTRUCTIONS,
          'Uploading a receipt does not approve payment. An admission officer must review it.',
        ],
        files,
        requiredSlot: 'receipt',
      };
      break;
    }
    default:
      throw new ApiError(404, 'Unknown task.');
  }
  return { task, details };
}

function requireEvidence(studentId, key, slot, message) {
  if (!uploadService.hasSlot(studentId, key, slot)) {
    throw new ApiError(400, 'Please correct the highlighted fields.', { file: message });
  }
}

/** Validates and persists a task form. Each save is atomic. */
function saveTask(studentId, key, body) {
  requireKnownTask(key);
  rejectStudentApprove(body);
  const payload = body && typeof body === 'object' ? body : {};

  if (key === 'physical_verification') {
    const action = typeof payload.action === 'string' ? payload.action.trim() : '';
    const tryingOutcome = FORBIDDEN_WORKFLOW.includes(String(payload.status || '').trim())
      || payload.verifiedBy || payload.verifiedAt
      || ['pending', 'in_progress', 'completed'].includes(String(payload.status || '').trim());
    if (action !== 'submit' && tryingOutcome) {
      throw new ApiError(
        403,
        'Physical verification can only be recorded by the college after it checks your original documents in person.',
        null,
        'COLLEGE_ONLY'
      );
    }
    if (action !== 'submit') {
      throw new ApiError(
        403,
        'Physical verification can only be recorded by the college after it checks your original documents in person.',
        null,
        'COLLEGE_ONLY'
      );
    }
    if (workflow.get(studentId, key).status === 'pending_review') {
      throw new ApiError(409, 'Your verification request is already with the admission officer.', null, 'VERIFICATION_REQUEST_PENDING');
    }
    const note = typeof payload.note === 'string' ? payload.note.trim() : '';
    if (note.length > 300) {
      throw new ApiError(400, 'Please correct the highlighted fields.', { note: 'Notes can be at most 300 characters.' });
    }
    db.transaction(() => {
      checklistService.saveRecord(studentId, key, { eventDate: null, note: note || null });
      workflow.studentMove(studentId, key, 'pending_review');
    })();
    return getTask(studentId, key);
  }

  if (key === 'allotment_acceptance' || key === 'admission_form') {
    const { errors, values } = validateStatusRecord(payload, checklistService.STATUSES, DATE_LABELS[key]);
    assertValid(errors);
    const submit = wantsSubmit(payload);
    if (submit && values.status === 'completed') {
      const slot = key === 'allotment_acceptance' ? 'receipt' : 'form';
      const label = key === 'allotment_acceptance' ? 'acceptance receipt' : 'completed admission form';
      requireEvidence(studentId, key, slot, `Upload the ${label} before submitting for review.`);
    }
    db.transaction(() => {
      checklistService.setStoredStatus(studentId, key, values.status);
      checklistService.saveRecord(studentId, key, values);
      applyStudentWorkflow(studentId, key, values.status, payload);
    })();
  } else if (key === 'document_preparation') {
    const { errors, values } = validateDocuments(payload, documentService.KEYS);
    assertValid(errors);
    if (wantsSubmit(payload)) {
      const required = documentService.getDocuments(studentId).filter((d) => d.required);
      if (values.prepared.length !== required.length || !required.every((d) => values.prepared.includes(d.key))) {
        throw new ApiError(400, 'Please correct the highlighted fields.', { preparedDocs: 'Mark all seven required documents prepared before submitting for review.' });
      }
      for (const doc of required) requireEvidence(studentId, key, doc.key, `Upload the ${doc.title} before submitting for review.`);
    }
    db.transaction(() => {
      documentService.savePrepared(studentId, values.prepared);
      const summary = documentService.getSummary(studentId);
      applyStudentWorkflow(studentId, key, summary.status, payload);
    })();
  } else if (key === 'fee_payment') {
    const { errors, values } = validateFee(payload, checklistService.STATUSES, feeService.PAYMENT_MODES);
    assertValid(errors);
    const submit = wantsSubmit(payload);
    if (submit) {
      if (values.status === 'pending') {
        throw new ApiError(400, 'Please correct the highlighted fields.', { status: 'Enter payment details before submitting for review.' });
      }
      requireEvidence(studentId, key, 'receipt', 'Upload a payment receipt before submitting for review. Uploads do not approve payment.');
    }
    db.transaction(() => {
      checklistService.setStoredStatus(studentId, key, values.status);
      feeService.save(studentId, values);
      applyStudentWorkflow(studentId, key, values.status, payload);
    })();
  }

  return getTask(studentId, key);
}

function reviewTask(admin, studentId, key, body) {
  requireKnownTask(key);
  const result = workflow.officerReview(admin, studentId, key, body || {});
  return { review: result, ...getTask(studentId, key) };
}

module.exports = { getTask, saveTask, reviewTask };
