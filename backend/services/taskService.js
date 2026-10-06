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
const {
  assertValid, validateStatusRecord, validateDocuments, validateFee,
} = require('../utils/validators');

const DATE_LABELS = { allotment_acceptance: 'Acceptance', admission_form: 'Submission' };

function itemFor(studentId, key) {
  return checklistService.getChecklist(studentId).find((i) => i.key === key);
}

function requireKnownTask(key) {
  if (!checklistService.getDefinition(key)) throw new ApiError(404, 'Unknown task.');
}

/** Everything the task window needs to render. */
function getTask(studentId, key) {
  requireKnownTask(key);
  const task = itemFor(studentId, key);
  let details;

  switch (key) {
    case 'allotment_acceptance':
    case 'admission_form': {
      const rec = checklistService.getRecord(studentId, key);
      details = { eventDate: rec.eventDate, note: rec.note };
      break;
    }
    case 'document_preparation': {
      const s = documentService.getSummary(studentId);
      details = {
        documents: documentService.getDocuments(studentId),
        preparedRequired: s.preparedRequired,
        requiredTotal: s.requiredTotal,
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
        documentsPrepared: s.preparedRequired,
        documentsRequired: s.requiredTotal,
        appointment: appointmentService.getStudentView(studentId),
        steps: [
          'Prepare your original documents and photocopies (see Document Preparation).',
          'Visit your college on the date and time announced in its admission notice.',
          'College staff will check your original documents in person.',
          'The college records the outcome. It then appears here automatically.',
        ],
      };
      break;
    }
    case 'fee_payment': {
      details = { ...feeService.get(studentId), paymentModes: feeService.PAYMENT_MODES, instructions: feeService.INSTRUCTIONS };
      break;
    }
    default:
      throw new ApiError(404, 'Unknown task.');
  }
  return { task, details };
}

/** Validates and persists a task form. Each save is atomic. */
function saveTask(studentId, key, body) {
  requireKnownTask(key);

  if (key === 'physical_verification') {
    throw new ApiError(
      403,
      'Physical verification can only be recorded by the college after it checks your original documents in person.',
      null,
      'COLLEGE_ONLY'
    );
  }

  if (key === 'allotment_acceptance' || key === 'admission_form') {
    const { errors, values } = validateStatusRecord(body, checklistService.STATUSES, DATE_LABELS[key]);
    assertValid(errors);
    db.transaction(() => {
      checklistService.setStoredStatus(studentId, key, values.status);
      checklistService.saveRecord(studentId, key, values);
    })();
  } else if (key === 'document_preparation') {
    const { errors, values } = validateDocuments(body, documentService.KEYS);
    assertValid(errors);
    documentService.savePrepared(studentId, values.prepared);
  } else if (key === 'fee_payment') {
    const { errors, values } = validateFee(body, checklistService.STATUSES, feeService.PAYMENT_MODES);
    assertValid(errors);
    db.transaction(() => {
      checklistService.setStoredStatus(studentId, key, values.status);
      feeService.save(studentId, values);
    })();
  }

  return getTask(studentId, key);
}

module.exports = { getTask, saveTask };
