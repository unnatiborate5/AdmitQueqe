'use strict';
/**
 * Undo for recent reversible admin actions (Phase 5: STACK).
 *
 * Reversible actions: an application decision (approve / reject / request corrections / reopen) and an appointment
 * reschedule. Each admin has their own LIFO stack in the C++ engine (cpp_engine/include/undo_stacks.hpp, built on
 * dsa/stack.hpp): the newest action is always undone first, and an admin can only undo their own actions.
 *
 * The details needed to reverse an action are stored in SQLite (admin_undo_actions), so nothing is lost if the
 * engine restarts: the stacks are rebuilt from the 'active' rows. The stack holds at most 20 actions per admin;
 * pushing a 21st discards the oldest.
 */
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const queueService = require('./queueService');
const applicationService = require('./applicationService');
const appointmentService = require('./appointmentService');

const CAPACITY = 20;
const json = (v) => JSON.stringify(v);

const REVERTERS = {
  review: (admin, row, before, after) => applicationService.revertReview(admin, row.student_id, before, after.status),
  reschedule: (admin, row, before, after) => appointmentService.revertReschedule(admin, row.target_id, before, after),
};

// After the engine restarts, rebuild every admin's stack from the database (oldest first, so the newest ends on top).
queueService.onRestore(async (send) => {
  await send('STACK_CLEAR_ALL');
  const admins = db.prepare("SELECT DISTINCT admin_id FROM admin_undo_actions WHERE status = 'active'").all();
  for (const { admin_id: adminId } of admins) {
    const rows = db.prepare("SELECT id, student_id, kind FROM admin_undo_actions WHERE admin_id = ? AND status = 'active' ORDER BY id DESC LIMIT ?").all(adminId, CAPACITY).reverse();
    for (const r of rows) await send(`STACK_PUSH ${adminId} ${r.id} ${r.student_id} ${r.kind}`);
    db.prepare("UPDATE admin_undo_actions SET status = 'expired', resolved_at = datetime('now') WHERE admin_id = ? AND status = 'active' AND id < ?")
      .run(adminId, rows.length ? rows[0].id : 0);
  }
});

/** Called after a reversible action succeeded. Never throws: the action itself already happened. */
async function record(admin, { kind, studentId, targetId = null, summary, before, after }) {
  try {
    const id = Number(db.prepare(
      'INSERT INTO admin_undo_actions (admin_id, kind, student_id, target_id, summary, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(admin.id, kind, studentId, targetId, summary, json(before), json(after)).lastInsertRowid);
    await queueService.withEngine(async ({ send }) => {
      const r = await send(`STACK_PUSH ${admin.id} ${id} ${studentId} ${kind}`);
      if (!r.ok) throw new Error(r.message);
      if (r.dropped) db.prepare("UPDATE admin_undo_actions SET status = 'expired', resolved_at = datetime('now') WHERE id = ?").run(r.dropped);
    });
  } catch (err) {
    // The row is saved, so the stack is rebuilt from it the next time the engine restarts.
    console.error('Could not push the undo entry:', err.message);
  }
}

const dto = (row) => ({ id: row.id, kind: row.kind, summary: row.summary, studentId: row.student_id, studentName: row.student_name, createdAt: row.created_at });
const rowsFor = (ids) => (ids.length
  ? db.prepare(`SELECT a.*, s.full_name AS student_name FROM admin_undo_actions a JOIN students s ON s.id = a.student_id WHERE a.id IN (${ids.map(() => '?').join(',')})`).all(...ids)
  : []);

/** The admin's undo stack, newest first. */
function list(admin) {
  return queueService.withEngine(async ({ send }) => {
    const r = await send(`STACK_LIST ${admin.id}`);
    if (!r.ok) throw new Error(r.message);
    const byId = new Map(rowsFor(r.entries.map((e) => e.actionId)).map((row) => [row.id, row]));
    const items = r.entries.map((e) => byId.get(e.actionId)).filter(Boolean).map(dto);
    return { capacity: CAPACITY, size: items.length, items, next: items[0] || null };
  });
}

/** Undoes the admin's most recent reversible action (LIFO). */
function undoLatest(admin) {
  return queueService.withEngine(async ({ send }) => {
    const peek = await send(`STACK_PEEK ${admin.id}`);
    if (!peek.ok) throw new ApiError(409, 'There is nothing to undo.', null, 'NOTHING_TO_UNDO');
    const row = db.prepare('SELECT * FROM admin_undo_actions WHERE id = ?').get(peek.entry.actionId);
    const settle = async (status) => {
      await send(`STACK_POP ${admin.id}`);
      if (row) db.prepare('UPDATE admin_undo_actions SET status = ?, resolved_at = datetime(\'now\') WHERE id = ?').run(status, row.id);
    };
    if (!row || row.status !== 'active') { await settle('discarded'); throw new ApiError(409, 'That action is no longer available to undo. It was removed from your undo list.', null, 'STALE_UNDO'); }

    try {
      REVERTERS[row.kind](admin, row, JSON.parse(row.before_json), JSON.parse(row.after_json));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'STALE_UNDO') {   // things changed since: this entry can never be undone, so drop it and unblock the stack
        await settle('discarded');
        throw new ApiError(409, `${err.message} It was removed from your undo list.`, null, 'STALE_UNDO');
      }
      throw err;        // anything else leaves the stack untouched
    }
    await settle('undone');
    const rest = await send(`STACK_LIST ${admin.id}`);
    const next = rest.ok && rest.entries.length ? rowsFor([rest.entries[0].actionId])[0] : null;
    return { undone: dto(db.prepare('SELECT a.*, s.full_name AS student_name FROM admin_undo_actions a JOIN students s ON s.id = a.student_id WHERE a.id = ?').get(row.id)), remaining: rest.ok ? rest.size : 0, next: next ? dto(next) : null };
  });
}

module.exports = { CAPACITY, record, list, undoLatest };
