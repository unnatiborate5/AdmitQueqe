'use strict';
/**
 * Physical document verification appointments. The appointment only says WHEN and WHERE the student
 * must come; the verification itself is done by hand at the college (see verificationAdminService).
 */
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const time = require('../utils/time');
const activityService = require('./activityService');
const applicationService = require('./applicationService');
const { parsePaging, pick, likeTerm } = require('../utils/adminValidators');

const STATUSES = ['scheduled', 'completed', 'missed', 'cancelled'];
const LABELS = { scheduled: 'Scheduled', completed: 'Completed', missed: 'Missed', cancelled: 'Cancelled' };

const toDto = (a) => ({
  id: a.id,
  studentId: a.student_id,
  date: a.appointment_date,
  time: a.appointment_time,
  venue: a.venue,
  instructions: a.instructions,
  status: a.status,
  statusLabel: LABELS[a.status],
  note: a.status_note,
  rescheduleCount: a.reschedule_count,
  createdBy: a.created_by_name,
  updatedBy: a.updated_by_name,
  createdAt: a.created_at,
  updatedAt: a.updated_at,
});

const isUnique = (err) => /UNIQUE constraint failed/i.test(String(err && err.message));
const DUPLICATE = () => new ApiError(
  409, 'This student already has a scheduled appointment. Reschedule it instead of creating a second one.', null, 'ALREADY_SCHEDULED'
);

function getActive(studentId) {
  const row = db.prepare("SELECT * FROM appointments WHERE student_id = ? AND status = 'scheduled'").get(studentId);
  return row ? toDto(row) : null;
}

function listForStudent(studentId) {
  return db.prepare('SELECT * FROM appointments WHERE student_id = ? ORDER BY id DESC').all(studentId).map(toDto);
}

/** What the student sees: their latest appointment (the scheduled one, otherwise the most recent). No admin names. */
function getStudentView(studentId) {
  const row = db.prepare(
    `SELECT * FROM appointments WHERE student_id = ?
     ORDER BY CASE status WHEN 'scheduled' THEN 0 ELSE 1 END, id DESC LIMIT 1`
  ).get(studentId);
  if (!row) return null;
  const a = toDto(row);
  return {
    date: a.date, time: a.time, venue: a.venue, instructions: a.instructions,
    status: a.status, statusLabel: a.statusLabel, note: a.note,
    rescheduled: a.rescheduleCount > 0, updatedAt: a.updatedAt,
  };
}

function requireAppointment(id) {
  const row = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  if (!row) throw new ApiError(404, 'Appointment not found.');
  return row;
}

function studentOf(studentId) {
  return db.prepare('SELECT id, full_name AS fullName FROM students WHERE id = ?').get(studentId);
}

const slot = (a) => `${a.appointment_date} ${a.appointment_time}`;

function schedule(admin, v) {
  return db.transaction(() => {
    const { student, applicationId } = applicationService.requireApplication(v.studentId);
    if (applicationService.getReview(v.studentId).status === 'rejected') {
      throw new ApiError(409, 'This application is rejected. Reopen it before scheduling a verification appointment.', null, 'APPLICATION_REJECTED');
    }
    const ver = db.prepare('SELECT status FROM verification_records WHERE student_id = ?').get(v.studentId);
    if (ver && ver.status === 'completed') {
      throw new ApiError(409, 'Physical verification is already completed for this student.', null, 'ALREADY_VERIFIED');
    }
    if (getActive(v.studentId)) throw DUPLICATE();

    let id;
    try {
      id = db.prepare(
        `INSERT INTO appointments (student_id, appointment_date, appointment_time, venue, instructions, created_by_name, updated_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(v.studentId, v.date, v.time, v.venue, v.instructions, admin.fullName, admin.fullName).lastInsertRowid;
    } catch (err) {
      if (isUnique(err)) throw DUPLICATE();
      throw err;
    }
    activityService.log(admin, {
      action: 'appointment.schedule',
      student,
      summary: `Scheduled verification for ${student.fullName} (${applicationId}) on ${v.date} at ${v.time}, ${v.venue}`,
      details: { appointmentId: Number(id), date: v.date, time: v.time, venue: v.venue },
    });
    return toDto(requireAppointment(Number(id)));
  })();
}

function reschedule(admin, id, v) {
  return db.transaction(() => {
    const old = requireAppointment(id);
    if (old.status !== 'scheduled') {
      throw new ApiError(409, `Only a scheduled appointment can be rescheduled (this one is ${LABELS[old.status].toLowerCase()}). Schedule a new one instead.`, null, 'NOT_SCHEDULED');
    }
    const unchanged = old.appointment_date === v.date && old.appointment_time === v.time
      && old.venue === v.venue && (old.instructions || null) === (v.instructions || null);
    if (unchanged) throw new ApiError(400, 'Nothing has changed. Pick a new date, time or venue.', { date: 'Same as the current appointment.' });

    db.prepare(
      `UPDATE appointments SET appointment_date = ?, appointment_time = ?, venue = ?, instructions = ?, status_note = ?,
         reschedule_count = reschedule_count + 1, updated_by_name = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(v.date, v.time, v.venue, v.instructions, v.reason, admin.fullName, id);
    const student = studentOf(old.student_id);
    activityService.log(admin, {
      action: 'appointment.reschedule',
      student,
      summary: `Rescheduled verification for ${student.fullName} from ${slot(old)} to ${v.date} ${v.time}`,
      details: { appointmentId: id, from: { date: old.appointment_date, time: old.appointment_time, venue: old.venue }, to: { date: v.date, time: v.time, venue: v.venue }, reason: v.reason },
    });
    return toDto(requireAppointment(id));
  })();
}

function updateStatus(admin, id, { status, note }) {
  return db.transaction(() => {
    const old = requireAppointment(id);
    if (old.status !== 'scheduled') {
      throw new ApiError(409, `This appointment is already ${LABELS[old.status].toLowerCase()} and can no longer be changed.`, null, 'NOT_SCHEDULED');
    }
    if ((status === 'completed' || status === 'missed') && old.appointment_date > time.today()) {
      throw new ApiError(409, `A future appointment cannot be marked ${status}. Wait until the appointment date.`, null, 'TOO_EARLY');
    }
    db.prepare(
      "UPDATE appointments SET status = ?, status_note = ?, updated_by_name = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(status, note, admin.fullName, id);
    const student = studentOf(old.student_id);
    activityService.log(admin, {
      action: `appointment.${status}`,
      student,
      summary: `Marked the ${slot(old)} verification appointment of ${student.fullName} as ${status}`,
      details: { appointmentId: id, from: 'scheduled', to: status, note },
    });
    return toDto(requireAppointment(id));
  })();
}

/** Appointment management page: filterable list plus per-status counts for the tabs. */
function list(query) {
  const { page, pageSize, offset } = parsePaging(query);
  const where = [];
  const args = [];
  const status = pick(query.status, STATUSES);
  if (status) { where.push('a.status = ?'); args.push(status); }
  if (time.isRealDate(String(query.date || ''))) { where.push('a.appointment_date = ?'); args.push(query.date); }
  if (query.when === 'today') { where.push('a.appointment_date = ?'); args.push(time.today()); }
  if (query.when === 'upcoming') { where.push('a.appointment_date >= ?'); args.push(time.today()); }
  if (query.search && String(query.search).trim()) {
    const t = likeTerm(query.search);
    where.push("(s.full_name LIKE ? ESCAPE '\\' OR s.email LIKE ? ESCAPE '\\' OR c.application_id LIKE ? ESCAPE '\\')");
    args.push(t, t, t);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM appointments a JOIN students s ON s.id = a.student_id LEFT JOIN cap_details c ON c.student_id = s.id ${clause}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...args).n;
  const order = status === 'scheduled' || query.when
    ? 'a.appointment_date ASC, a.appointment_time ASC, a.id ASC'
    : 'a.appointment_date DESC, a.appointment_time DESC, a.id DESC';
  const rows = db.prepare(
    `SELECT a.*, s.full_name AS student_name, s.email AS student_email, c.application_id ${from} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...args, pageSize, offset);

  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  db.prepare('SELECT status, COUNT(*) AS n FROM appointments GROUP BY status').all().forEach((r) => { counts[r.status] = r.n; });
  return {
    items: rows.map((r) => ({ ...toDto(r), student: { id: r.student_id, name: r.student_name, email: r.student_email, applicationId: r.application_id } })),
    counts, today: time.today(), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function upcoming(limit = 5) {
  return db.prepare(
    `SELECT a.*, s.full_name AS student_name FROM appointments a JOIN students s ON s.id = a.student_id
      WHERE a.status = 'scheduled' AND a.appointment_date >= ? ORDER BY a.appointment_date, a.appointment_time LIMIT ?`
  ).all(time.today(), limit).map((r) => ({ ...toDto(r), student: { id: r.student_id, name: r.student_name } }));
}

module.exports = { STATUSES, LABELS, getActive, listForStudent, getStudentView, schedule, reschedule, updateStatus, list, upcoming };
