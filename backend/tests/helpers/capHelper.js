'use strict';
// Test helper: gives a student VERIFIED CAP details through the real flow (staff add a record, a different admin verifies it,
// the student claims the application ID). Students can no longer type their own allotment details.
// Require this AFTER setting process.env.DB_PATH.
const db = require('../../config/db');
const capRecordService = require('../../services/capRecordService');

let actors = null;
function ensureActors() {
  if (actors) return actors;
  const add = (name, email, role) => {
    const id = Number(db.prepare('INSERT INTO admins (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(name, email, 'not-a-real-hash', role).lastInsertRowid);
    return { id, fullName: name, role };
  };
  actors = { entry: add('CAP Fixture Entry', 'cap-fixture-entry@test.local', 'admission_officer'), verifier: add('CAP Fixture Verifier', 'cap-fixture-verifier@test.local', 'super_admin') };
  return actors;
}

function linkVerified(studentId, { applicationId, name, college = 'College of Engineering Pune', branch = 'Computer Engineering', round = 'Round 1', status = 'Allotted' }) {
  const a = ensureActors();
  const student = db.prepare('SELECT id, full_name AS fullName FROM students WHERE id = ?').get(studentId);
  const rec = capRecordService.create(a.entry, { applicationId, candidateName: name || student.fullName, allottedCollege: college, courseBranch: branch, capRound: round, allotmentStatus: status });
  capRecordService.verify(a.verifier, rec.id, {});
  const result = capRecordService.claim(student, applicationId);
  if (result.status !== 'linked') throw new Error(`fixture could not link ${applicationId}: ${result.status}`);
  return rec;
}

module.exports = { ensureActors, linkVerified };
