'use strict';
const db = require('../config/db');
const activityService = require('./activityService');
const appointmentService = require('./appointmentService');
const adminAuthService = require('./adminAuthService');
const queueService = require('./queueService');

/**
 * All numbers come straight from the database.
 *   totalStudents        every registered student
 *   applications         students who entered CAP details (an "application" exists)
 *   notStarted           registered, but no CAP details yet           (applications + notStarted = totalStudents)
 *   pending/approved/rejected/correctionRequested   split of `applications` by the admin's decision
 *   verificationPending  applications whose physical verification is not completed and that are not rejected
 */
function getStats() {
  const row = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM students) AS total_students,
       COUNT(c.id) AS applications,
       COALESCE(SUM(COALESCE(r.status, 'pending') = 'pending'), 0) AS pending,
       COALESCE(SUM(r.status = 'approved'), 0) AS approved,
       COALESCE(SUM(r.status = 'rejected'), 0) AS rejected,
       COALESCE(SUM(r.status = 'correction_requested'), 0) AS corrections,
       COALESCE(SUM(COALESCE(v.status, 'pending') <> 'completed' AND COALESCE(r.status, 'pending') <> 'rejected'), 0) AS verification_pending,
       COALESCE(SUM(COALESCE(v.status, 'pending') <> 'completed' AND COALESCE(r.status, 'pending') <> 'rejected'
                    AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.student_id = c.student_id AND a.status = 'scheduled')), 0) AS verification_unscheduled
     FROM cap_details c
     LEFT JOIN application_reviews r ON r.student_id = c.student_id
     LEFT JOIN verification_records v ON v.student_id = c.student_id`
  ).get();
  return {
    totalStudents: row.total_students,
    applications: row.applications,
    notStarted: row.total_students - row.applications,
    pending: row.pending,
    approved: row.approved,
    rejected: row.rejected,
    correctionRequested: row.corrections,
    verificationPending: row.verification_pending,
    verificationUnscheduled: row.verification_unscheduled,
  };
}

function getDashboard(admin) {
  return {
    stats: getStats(),
    upcomingAppointments: appointmentService.upcoming(5),
    queue: queueService.getTodayCounts(),
    recentActivity: adminAuthService.can(admin.role, 'activity:view') ? activityService.recent(8) : null,
  };
}

module.exports = { getStats, getDashboard };
