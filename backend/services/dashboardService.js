'use strict';
const capService = require('./capService');
const capRecordService = require('./capRecordService');
const checklistService = require('./checklistService');
const applicationService = require('./applicationService');
const appointmentService = require('./appointmentService');

/** CAP details count as the first task; the 5 checklist items follow. */
function buildTasks(studentId) {
  const cap = capService.get(studentId);
  const verification = capRecordService.studentState(studentId);
  const waiting = verification.status === 'pending';
  const capTask = {
    key: 'cap_details',
    title: 'CAP Details',
    description: 'Submit your CAP application ID. Your allotment details are filled in once the admission cell verifies it.',
    guidance: 'Enter only your CAP application ID. Never enter your CAP portal password: AdmitFlow does not connect to the official CAP portal and will never ask for it.',
    required: true,
    status: cap ? 'completed' : (waiting ? 'in_progress' : 'pending'),
    statusLabel: cap ? 'Verified' : (waiting ? 'Verification Pending' : 'Not Submitted'),
    statusSource: 'college',
    editable: !cap,
    summary: cap ? `${cap.capRound}, ${cap.allotmentStatus}` : (waiting ? `Application ID ${verification.applicationId} is waiting for verification` : null),
    link: 'cap-details.html',
  };
  const checklist = checklistService.getChecklist(studentId).map((item) => ({ ...item, link: 'checklist.html' }));
  return { cap, verification, tasks: [capTask, ...checklist] };
}

function isTaskComplete(task) {
  return task.status === 'completed' || task.status === 'approved';
}

function computeProgress(tasks) {
  const total = tasks.length;
  const completed = tasks.filter(isTaskComplete).length;
  const inProgress = tasks.filter((t) => ['in_progress', 'submitted', 'pending_review', 'correction_required'].includes(t.status)).length;
  const pending = tasks.filter((t) => t.status === 'pending' || t.status === 'not_started').length;
  return {
    total,
    completed,
    inProgress,
    pending,
    remaining: total - completed,
    percent: Math.round((completed / total) * 100),
  };
}

function getProgress(studentId) {
  return computeProgress(buildTasks(studentId).tasks);
}

function getSummary(student) {
  const { cap, verification, tasks } = buildTasks(student.id);
  const progress = computeProgress(tasks);
  const cancelled = cap && cap.allotmentStatus === capService.CANCELLED_STATUS;

  // The college's decision (set in the admin portal) takes priority over the student's own progress.
  const application = cap ? applicationService.getStudentView(student.id) : null;

  let overallStatus = 'In Progress';
  if (!cap) overallStatus = 'Getting Started';
  else if (cancelled) overallStatus = 'Seat Cancelled';
  else if (application.status === 'rejected') overallStatus = 'Application Rejected';
  else if (application.status === 'correction_requested') overallStatus = 'Corrections Requested';
  else if (application.status === 'approved') overallStatus = 'Admission Approved';
  else if (progress.completed === progress.total) overallStatus = 'Admission Process Complete';

  let admissionToken = student.admissionToken || (cap && cap.admissionToken) || null;
  if (!admissionToken && cap) {
    const admissionTokenService = require('./admissionTokenService');
    const db = require('../config/db');
    admissionToken = admissionTokenService.allocateAdmissionToken(student.id, db);
  }

  return {
    student: {
      id: student.id,
      fullName: student.fullName,
      applicationId: student.applicationId || (cap && cap.applicationId) || (verification && verification.applicationId) || null,
      admissionToken,
      email: student.email,
    },
    admissionToken,
    cap,
    capVerification: verification,
    progress,
    tasks,
    application,
    appointment: cap ? appointmentService.getStudentView(student.id) : null,
    nextStep: tasks.find((t) => !isTaskComplete(t)) || null,
    overallStatus,
    warning: cancelled
      ? 'Your CAP status is marked as "Seat Cancelled". Update your CAP details if this is incorrect.'
      : null,
  };
}

module.exports = { getProgress, getSummary };
