'use strict';
/**
 * Records the OUTCOME of the in-person document check. The check itself is manual:
 * nothing here (or anywhere in AdmitFlow) verifies document authenticity online.
 * Writes the same verification_records row that students see read-only.
 */
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const time = require('../utils/time');
const activityService = require('./activityService');
const applicationService = require('./applicationService');
const verificationService = require('./verificationService');
const taskWorkflowService = require('./taskWorkflowService');

const LABELS = { pending: 'Not Verified', in_progress: 'Verification In Progress', completed: 'Verified at College' };

function record(admin, studentId, { status, remarks }) {
  return db.transaction(() => {
    const { student, applicationId } = applicationService.requireApplication(studentId);
    if (applicationService.getReview(studentId).status === 'rejected') {
      throw new ApiError(409, 'This application is rejected. Reopen it before recording verification.', null, 'APPLICATION_REJECTED');
    }
    const before = verificationService.get(studentId);
    if (before.status === status && (before.remarks || null) === (remarks || null)) {
      throw new ApiError(409, `Verification is already "${LABELS[status]}".`, null, 'NO_CHANGE');
    }
    const verifiedBy = status === 'completed' ? admin.fullName : null;
    const verifiedAt = status === 'completed' ? time.today() : null;
    db.prepare(
      `INSERT INTO verification_records (student_id, status, verified_by, verified_at, remarks)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(student_id) DO UPDATE SET status = excluded.status, verified_by = excluded.verified_by,
         verified_at = excluded.verified_at, remarks = excluded.remarks, updated_at = datetime('now')`
    ).run(studentId, status, verifiedBy, verifiedAt, remarks);

    activityService.log(admin, {
      action: 'verification.record',
      student,
      summary: `Recorded physical verification as "${LABELS[status]}" for ${student.fullName} (${applicationId})`,
      details: { from: before.status, to: status, remarks },
    });

    // Keep the two records consistent: a student who has just been verified no longer has a pending visit.
    if (status === 'completed') {
      const appt = db.prepare("SELECT id, appointment_date, appointment_time FROM appointments WHERE student_id = ? AND status = 'scheduled'").get(studentId);
      if (appt) {
        db.prepare(
          "UPDATE appointments SET status = 'completed', status_note = 'Closed automatically when verification was recorded.', updated_by_name = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(admin.fullName, appt.id);
        activityService.log(admin, {
          action: 'appointment.completed',
          student,
          summary: `Appointment ${appt.appointment_date} ${appt.appointment_time} of ${student.fullName} closed as completed (verification recorded)`,
          details: { appointmentId: appt.id, automatic: true },
        });
      }
      // A completed in-person check can approve Task 5, but only after the student has requested review.
      if (taskWorkflowService.get(studentId, 'physical_verification').status === 'pending_review') {
        taskWorkflowService.officerReview(admin, studentId, 'physical_verification', { action: 'approve' });
      }
    }
    return verificationService.get(studentId);
  })();
}

module.exports = { LABELS, record };
