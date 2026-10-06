'use strict';
const db = require('../config/db');
const { parsePaging, likeTerm } = require('../utils/adminValidators');

/**
 * Records one administrative action. Call it inside the same db.transaction() as the change itself,
 * so an action and its audit entry are saved together or not at all.
 */
function log(admin, { action, student, summary, details }) {
  db.prepare(
    `INSERT INTO admin_activity_log (admin_id, admin_name, admin_role, action, student_id, student_name, summary, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    admin.id, admin.fullName, admin.role, action,
    student ? student.id : null, student ? student.fullName : null,
    summary, details ? JSON.stringify(details) : null
  );
}

const toDto = (r) => ({
  id: r.id,
  action: r.action,
  summary: r.summary,
  details: r.details ? JSON.parse(r.details) : null,
  admin: { id: r.admin_id, name: r.admin_name, role: r.admin_role },
  student: r.student_name ? { id: r.student_id, name: r.student_name } : null,
  createdAt: r.created_at,
});

const GROUPS = ['auth', 'application', 'appointment', 'verification', 'queue'];

function list(query) {
  const { page, pageSize, offset } = parsePaging(query, { defaultSize: 25, maxSize: 100 });
  const where = [];
  const args = [];
  const adminId = parseInt(query.adminId, 10);
  if (adminId > 0) { where.push('admin_id = ?'); args.push(adminId); }
  const studentId = parseInt(query.studentId, 10);
  if (studentId > 0) { where.push('student_id = ?'); args.push(studentId); }
  if (GROUPS.includes(query.group)) { where.push("action LIKE ? ESCAPE '\\'"); args.push(`${query.group}.%`); }
  if (query.search && String(query.search).trim()) {
    where.push("(summary LIKE ? ESCAPE '\\' OR admin_name LIKE ? ESCAPE '\\' OR student_name LIKE ? ESCAPE '\\')");
    const t = likeTerm(query.search);
    args.push(t, t, t);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM admin_activity_log ${clause}`).get(...args).n;
  const rows = db.prepare(`SELECT * FROM admin_activity_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, offset);
  const admins = db.prepare('SELECT id, full_name FROM admins ORDER BY full_name COLLATE NOCASE').all()
    .map((a) => ({ id: a.id, name: a.full_name }));
  return { items: rows.map(toDto), admins, groups: GROUPS, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

function recent(limit = 8) {
  return db.prepare('SELECT * FROM admin_activity_log ORDER BY id DESC LIMIT ?').all(limit).map(toDto);
}

module.exports = { log, list, recent };
