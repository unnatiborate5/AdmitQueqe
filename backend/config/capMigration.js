'use strict';
/**
 * One-time, idempotent migration run at start-up.
 *
 * Before CAP verification existed, students typed their own allotment details into cap_details. Those rows are
 * UNVERIFIED. This moves each of them into the verification queue instead of trusting them:
 *   - a CAP record with status "pending verification" (source: legacy_student_entry) keeps exactly what the student typed,
 *   - the student gets a pending claim for that application ID (so they see "verification pending"),
 *   - the unverified cap_details row is removed (it is re-created automatically when an admin verifies the record).
 * Nothing is lost, and nothing unverified keeps feeding the rest of the system. Rows that are already linked to a
 * verified record are left alone, so running this again changes nothing.
 */
function migrateLegacyCapDetails(db) {
  const legacy = db.prepare(
    `SELECT c.* FROM cap_details c
      WHERE NOT EXISTS (SELECT 1 FROM cap_allotment_records r WHERE r.linked_student_id = c.student_id AND r.status = 'verified')`
  ).all();
  if (!legacy.length) return 0;

  db.transaction(() => {
    for (const c of legacy) {
      let rec = db.prepare('SELECT id FROM cap_allotment_records WHERE application_id = ?').get(c.application_id);
      if (!rec) {
        const id = Number(db.prepare(
          `INSERT INTO cap_allotment_records (application_id, candidate_name, allotted_college, course_branch, cap_round, allotment_status, source, source_note, entered_by_name)
           VALUES (?, ?, ?, ?, ?, ?, 'legacy_student_entry', 'Typed by the student before verification existed. Check against the CAP allotment list.', 'Student (self-entered)')`
        ).run(c.application_id, c.student_name, c.allotted_college, c.course_branch, c.cap_round, c.allotment_status).lastInsertRowid);
        db.prepare("INSERT INTO cap_record_history (record_id, event, actor_type, actor_name, remarks) VALUES (?, 'migrated', 'system', 'System', ?)")
          .run(id, 'Moved from the old student-entered CAP form. Pending verification.');
        rec = { id };
      }
      db.prepare("UPDATE cap_claims SET status = 'withdrawn', resolved_at = datetime('now') WHERE student_id = ? AND status = 'pending'").run(c.student_id);
      db.prepare("INSERT INTO cap_claims (student_id, application_id, reason) VALUES (?, ?, 'not_verified')").run(c.student_id, c.application_id);
      db.prepare('DELETE FROM cap_details WHERE student_id = ?').run(c.student_id);
    }
  })();
  console.log(`CAP verification: moved ${legacy.length} self-entered CAP detail(s) to the verification queue (nothing was deleted).`);
  return legacy.length;
};

module.exports = function runMigrations(db) {
  // Idempotent migration for students.application_id column
  const cols = db.prepare("PRAGMA table_info(students)").all();
  const hasAppId = cols.some((c) => c.name === 'application_id');
  if (!hasAppId) {
    db.exec("ALTER TABLE students ADD COLUMN application_id TEXT;");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_students_app_id ON students(application_id);");

  // Backfill application_id for existing students from cap_details or cap_allotment_records
  db.exec(`
    UPDATE students
       SET application_id = (SELECT application_id FROM cap_details WHERE cap_details.student_id = students.id)
     WHERE application_id IS NULL AND EXISTS (SELECT 1 FROM cap_details WHERE cap_details.student_id = students.id);
    UPDATE students
       SET application_id = (SELECT application_id FROM cap_allotment_records WHERE cap_allotment_records.linked_student_id = students.id)
     WHERE application_id IS NULL AND EXISTS (SELECT 1 FROM cap_allotment_records WHERE cap_allotment_records.linked_student_id = students.id);
  `);

  migrateTaskWorkflow(db);
  return migrateLegacyCapDetails(db);
};

/** Map old student-self-set checklist statuses onto the officer-review workflow. Never auto-approves. */
function migrateTaskWorkflow(db) {
  db.exec(`
    INSERT OR IGNORE INTO task_reviews (student_id, task_key, status)
    SELECT student_id, item_key,
           CASE status
             WHEN 'completed' THEN 'pending_review'
             WHEN 'in_progress' THEN 'submitted'
             ELSE 'not_started'
           END
      FROM checklist_items
     WHERE item_key IN ('allotment_acceptance', 'admission_form', 'fee_payment')
  `);
}
