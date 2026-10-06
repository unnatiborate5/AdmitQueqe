'use strict';
const capService = require('./capService');
const checklistService = require('./checklistService');
const applicationService = require('./applicationService');
const appointmentService = require('./appointmentService');

/** CAP details count as the first task; the 5 checklist items follow. */
function buildTasks(studentId) {
  const cap = capService.get(studentId);
  const capTask = {
    key: 'cap_details',
    title: 'CAP Details',
    description: 'Enter your CAP application and allotment details.',
    guidance: 'Fill in the CAP Details form using your CAP allotment letter.',
    required: true,
    status: cap ? 'completed' : 'pending',
    statusLabel: cap ? 'Submitted' : 'Not Entered',
    statusSource: 'student',
    editable: true,
    summary: cap ? `${cap.capRound}, ${cap.allotmentStatus}` : null,
    link: 'cap-details.html',
  };
  const checklist = checklistService.getChecklist(studentId).map((item) => ({ ...item, link: 'checklist.html' }));
  return { cap, tasks: [capTask, ...checklist] };
}

function computeProgress(tasks) {
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const pending = tasks.filter((t) => t.status === 'pending').length;
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
  const { cap, tasks } = buildTasks(student.id);
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

  return {
    student: { fullName: student.fullName, email: student.email },
    cap,
    progress,
    tasks,
    application,
    appointment: cap ? appointmentService.getStudentView(student.id) : null,
    nextStep: tasks.find((t) => t.status !== 'completed') || null,
    overallStatus,
    warning: cancelled
      ? 'Your CAP status is marked as "Seat Cancelled". Update your CAP details if this is incorrect.'
      : null,
  };
}

module.exports = { getProgress, getSummary };
