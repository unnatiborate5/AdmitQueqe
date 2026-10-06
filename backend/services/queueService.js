'use strict';
/**
 * Queue & token management (Phase 4).
 *
 * Division of labour:
 *   C++ engine  (cpp_engine/)   decides ORDER: token numbers, which student is called next, positions,
 *                               duplicate detection, counter rules. Lives in memory, started as a child process.
 *   This file                   decides ELIGIBILITY and PRIORITY from existing admission data, keeps the
 *                               DATABASE as the durable record, and rebuilds the engine from it when needed.
 *   SQLite                      the source of truth for persistence. Every engine change is saved here.
 *
 * All operations run one at a time (a promise chain), so engine and database never interleave.
 */
const path = require('path');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const time = require('../utils/time');
const activityService = require('./activityService');
const applicationService = require('./applicationService');
const EngineClient = require('./queueEngineClient');
const { ensureEngineBinary } = require('../scripts/buildEngine');

const BURST = Math.max(1, parseInt(process.env.QUEUE_PRIORITY_BURST, 10) || 3);
const LATE_ROUNDS = ['Round 3', 'Special Round'];
const MAX_COUNTERS = 10;
const SYSTEM = { id: null, fullName: 'System', role: 'system' };

const STATUS_LABELS = {
  waiting: 'Waiting', called: 'Called to counter', serving: 'Being served',
  completed: 'Completed', no_show: 'No-show', cancelled: 'Cancelled', expired: 'Expired (end of day)',
};
const ACTIVE = ['waiting', 'called', 'serving'];

/** The priority policy, in words. Shown on the admin queue page so staff can explain it to students. */
const POLICY = {
  burst: BURST,
  levels: [
    { level: 1, lane: 'priority', title: 'Returning student', rule: 'Physical verification was already started (status "In progress"): the student is coming back to finish it.' },
    { level: 2, lane: 'priority', title: 'Late CAP round', rule: `CAP round is ${LATE_ROUNDS.join(' or ')}: less time is left to complete admission.` },
    { level: 3, lane: 'regular', title: 'Regular', rule: 'Everyone else.' },
  ],
  fairness: [
    'Within the same level, students are called strictly in the order they checked in.',
    `After ${BURST} priority students in a row, the next student called is the oldest regular student (if one is waiting), so the regular lane never starves.`,
    'Several counters share the same queue; whichever counter is free calls the next student.',
  ],
};

// ------------------------------------------------------------------------------------------------
// engine process management
// ------------------------------------------------------------------------------------------------
let client = null;
let restoredDate = null;        // the day the engine currently holds; null = must be rebuilt from the database
let chain = Promise.resolve();

const exclusive = (fn) => {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
};

function dropEngine() {
  restoredDate = null;
  if (client) client.stop();
  client = null;
}

const ENGINE_ERRORS = {
  DUPLICATE_TOKEN: [409, 'ALREADY_QUEUED'], UNKNOWN_COUNTER: [404, 'COUNTER_NOT_FOUND'], COUNTER_CLOSED: [409, 'COUNTER_CLOSED'],
  COUNTER_BUSY: [409, 'COUNTER_BUSY'], QUEUE_EMPTY: [409, 'QUEUE_EMPTY'], NOT_FOUND: [404, 'TOKEN_NOT_FOUND'], BAD_STATE: [409, 'BAD_STATE'],
};

/** Sends a command; known refusals become ApiErrors (the engine is unchanged), anything else is a real fault. */
async function engine(line) {
  const reply = await client.send(line);
  if (reply.ok) return reply;
  const known = ENGINE_ERRORS[reply.error];
  if (known) throw new ApiError(known[0], reply.message, null, known[1]);
  throw new Error(`Engine error ${reply.error}: ${reply.message}`);
}

function expireStale(today) {
  const stale = db.prepare(`SELECT t.*, s.full_name AS student_name FROM queue_tokens t JOIN students s ON s.id = t.student_id
                             WHERE t.status IN ('waiting','called','serving') AND t.queue_date <> ?`).all(today);
  if (!stale.length) return false;
  db.transaction(() => {
    db.prepare(`UPDATE queue_tokens SET status = 'expired', finished_at = datetime('now'), finish_reason = 'Not served by the end of the day'
                 WHERE status IN ('waiting','called','serving') AND queue_date <> ?`).run(today);
    activityService.log(SYSTEM, { action: 'queue.expire', summary: `Closed ${stale.length} unfinished token(s) from an earlier day`, details: { tokens: stale.map((t) => `${t.queue_date} ${t.token_code}`) } });
  })();
  return true;
}

/** Rebuilds the engine's memory from the database. */
async function restore(today) {
  const counters = db.prepare('SELECT id, is_open FROM verification_counters ORDER BY id').all();
  const tokens = db.prepare(`SELECT * FROM queue_tokens WHERE queue_date = ? AND status IN ('waiting','called','serving') ORDER BY token_number`).all(today);
  const lastSeq = db.prepare('SELECT COALESCE(MAX(token_number), 0) AS n FROM queue_tokens WHERE queue_date = ?').get(today).n;
  const meta = db.prepare("SELECT value FROM queue_meta WHERE key = 'priority_streak'").get();
  const [metaDate, metaStreak] = meta ? meta.value.split('|') : [null, '0'];

  await engine(`RESET ${BURST}`);
  for (const c of counters) await engine(`COUNTER ${c.id} ${c.is_open ? 1 : 0}`);
  for (const t of tokens) {
    const reply = await client.send(`LOAD ${t.token_number} ${t.priority_level} ${t.status} ${t.counter_id || 0} ${t.student_id} ${t.application_id}`);
    if (!reply.ok) {   // inconsistent row: retire it rather than refuse to start
      db.prepare("UPDATE queue_tokens SET status = 'cancelled', finished_at = datetime('now'), finish_reason = ? WHERE id = ?")
        .run(`Removed while restoring the queue (${reply.error})`, t.id);
    }
  }
  await engine(`SEQ ${lastSeq}`);
  await engine(`STREAK ${metaDate === today ? Number(metaStreak) || 0 : 0}`);
  restoredDate = today;
}

async function ensureReady() {
  const today = time.today();
  if (!client || !client.alive) {
    client = new EngineClient(process.env.QUEUE_ENGINE_PATH || ensureEngineBinary(), BURST).start();
    restoredDate = null;
  }
  if (expireStale(today)) restoredDate = null;
  seedCounters();
  if (restoredDate !== today) await restore(today);
}

function seedCounters() {
  if (db.prepare('SELECT COUNT(*) AS n FROM verification_counters').get().n === 0) {
    const ins = db.prepare('INSERT INTO verification_counters (name) VALUES (?)');
    ins.run('Counter 1');
    ins.run('Counter 2');
  }
}

/** Runs `fn` exclusively with a ready engine. A real fault (not a business refusal) rebuilds the engine from the database. */
function operate(fn) {
  return exclusive(async () => {
    try {
      await ensureReady();
      await reconcile();
      return await fn();
    } catch (err) {
      if (!(err instanceof ApiError)) {
        dropEngine();
        if (/ENGINE_DOWN|ENOENT|spawn|compile|Could not compile|No C\+\+ compiler/i.test(String(err.message))) {
          throw new ApiError(503, `The queue engine is unavailable: ${String(err.message).split('\n')[0]}`, null, 'ENGINE_UNAVAILABLE');
        }
      }
      throw err;
    }
  });
}

// ------------------------------------------------------------------------------------------------
// data helpers
// ------------------------------------------------------------------------------------------------
const TOKEN_SELECT = `SELECT t.*, s.full_name AS student_name, k.name AS counter_name FROM queue_tokens t
                        JOIN students s ON s.id = t.student_id LEFT JOIN verification_counters k ON k.id = t.counter_id`;

const tokenRow = (id) => db.prepare(`${TOKEN_SELECT} WHERE t.id = ?`).get(id);
const tokenRowByCode = (code, date) => db.prepare(`${TOKEN_SELECT} WHERE t.token_code = ? AND t.queue_date = ?`).get(code, date);

function toDto(r, live) {
  const waiting = r.status === 'waiting' && live;
  return {
    id: r.id, code: r.token_code, number: r.token_number, date: r.queue_date, lane: r.lane, level: r.priority_level, priorityReason: r.priority_reason,
    status: r.status, statusLabel: STATUS_LABELS[r.status],
    counter: r.counter_id ? { id: r.counter_id, name: r.counter_name } : null,
    student: { id: r.student_id, name: r.student_name }, applicationId: r.application_id, appointmentId: r.appointment_id,
    position: waiting ? live.position : null, ahead: waiting ? live.ahead : null,
    issuedBy: r.issued_by_name, createdAt: r.created_at, calledAt: r.called_at, servingAt: r.serving_at, finishedAt: r.finished_at, finishReason: r.finish_reason,
  };
}

const counterRow = (id) => db.prepare('SELECT * FROM verification_counters WHERE id = ?').get(id);
const counterDto = (c, token) => ({ id: c.id, name: c.name, isOpen: Boolean(c.is_open), token: token || null });

function setStreak(today, streak) {
  db.prepare("INSERT INTO queue_meta (key, value) VALUES ('priority_streak', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`${today}|${streak}`);
}

// ------------------------------------------------------------------------------------------------
// eligibility and priority (all from existing admission data)
// ------------------------------------------------------------------------------------------------
function priorityFor(capRound, verificationStatus) {
  if (verificationStatus === 'in_progress') return { level: 1, reason: POLICY.levels[0].title };
  if (LATE_ROUNDS.includes(capRound)) return { level: 2, reason: `${POLICY.levels[1].title} (${capRound})` };
  return { level: 3, reason: POLICY.levels[2].title };
}

/** Why this student cannot get a token right now, or null when check-in is allowed. DB only. */
function checkInProblem(studentId, today = time.today()) {
  const student = db.prepare('SELECT id, full_name FROM students WHERE id = ?').get(studentId);
  if (!student) return { status: 404, code: 'STUDENT_NOT_FOUND', message: 'Student not found.' };
  const cap = db.prepare('SELECT application_id, cap_round FROM cap_details WHERE student_id = ?').get(studentId);
  if (!cap) return { status: 409, code: 'NO_APPLICATION', message: 'This student has not entered CAP details yet.' };
  if (applicationService.getReview(studentId).status === 'rejected') return { status: 409, code: 'APPLICATION_REJECTED', message: 'This application is rejected, so the student cannot join the verification queue.' };
  const ver = db.prepare('SELECT status FROM verification_records WHERE student_id = ?').get(studentId);
  const verStatus = ver ? ver.status : 'pending';
  if (verStatus === 'completed') return { status: 409, code: 'ALREADY_VERIFIED', message: 'Physical verification is already completed for this student.' };
  const appt = db.prepare("SELECT * FROM appointments WHERE student_id = ? AND status = 'scheduled'").get(studentId);
  if (!appt) return { status: 409, code: 'NO_APPOINTMENT', message: 'This student has no scheduled verification appointment. Schedule one first.' };
  if (appt.appointment_date !== today) return { status: 409, code: 'NOT_TODAY', message: `The appointment is on ${appt.appointment_date}. Check-in is only possible on the day of the appointment.` };
  const active = db.prepare(`SELECT token_code FROM queue_tokens WHERE student_id = ? AND status IN ('waiting','called','serving')`).get(studentId);
  if (active) return { status: 409, code: 'ALREADY_QUEUED', message: `This student already has an active token (${active.token_code}).`, existing: active.token_code };
  const served = db.prepare(`SELECT token_code FROM queue_tokens WHERE appointment_id = ? AND status = 'completed'`).get(appt.id);
  if (served) return { status: 409, code: 'ALREADY_SERVED', message: `This appointment was already served with token ${served.token_code}. Record the verification outcome, or schedule a new appointment.` };
  return { ok: true, student, cap, appt, verStatus };
}

/** For a WAITING token: why it is no longer valid, or null. */
function staleReason(t) {
  if (applicationService.getReview(t.student_id).status === 'rejected') return 'Application was rejected';
  const ver = db.prepare('SELECT status FROM verification_records WHERE student_id = ?').get(t.student_id);
  if (ver && ver.status === 'completed') return 'Physical verification was already completed';
  const appt = t.appointment_id ? db.prepare('SELECT status, appointment_date FROM appointments WHERE id = ?').get(t.appointment_id) : null;
  if (!appt || appt.status !== 'scheduled' || appt.appointment_date !== t.queue_date) return 'The appointment was cancelled or changed';
  return null;
}

/** Waiting students whose situation changed in the admin portal leave the queue automatically. */
async function reconcile() {
  const today = time.today();
  const waiting = db.prepare(`${TOKEN_SELECT} WHERE t.queue_date = ? AND t.status = 'waiting' ORDER BY t.token_number`).all(today);
  for (const t of waiting) {
    const reason = staleReason(t);
    if (reason) await autoCancel(t, reason);
  }
}

async function autoCancel(t, reason) {
  await engine(`CANCEL ${t.token_code}`);
  db.transaction(() => {
    db.prepare("UPDATE queue_tokens SET status = 'cancelled', finished_at = datetime('now'), finish_reason = ? WHERE id = ?").run(reason, t.id);
    activityService.log(SYSTEM, { action: 'queue.auto_cancel', student: { id: t.student_id, fullName: t.student_name }, summary: `Token ${t.token_code} of ${t.student_name} removed from the queue: ${reason}`, details: { token: t.token_code, reason } });
  })();
}

// ------------------------------------------------------------------------------------------------
// operations
// ------------------------------------------------------------------------------------------------
function checkIn(admin, studentId) {
  return operate(async () => {
    const today = time.today();
    const check = checkInProblem(studentId, today);
    if (!check.ok) throw new ApiError(check.status, check.message, null, check.code);
    const { student, cap, appt, verStatus } = check;
    const prio = priorityFor(cap.cap_round, verStatus);

    const reply = await engine(`ENQUEUE ${prio.level} ${student.id} ${cap.application_id}`);   // the engine generates the token
    const t = reply.token;
    let id;
    try {
      id = db.transaction(() => {
        const newId = db.prepare(
          `INSERT INTO queue_tokens (queue_date, token_number, token_code, lane, priority_level, priority_reason, student_id, appointment_id, application_id, issued_by_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(today, t.seq, t.code, t.lane, t.level, prio.reason, student.id, appt.id, cap.application_id, admin.fullName).lastInsertRowid;
        activityService.log(admin, {
          action: 'queue.check_in', student: { id: student.id, fullName: student.full_name },
          summary: `Checked in ${student.full_name} (${cap.application_id}): token ${t.code}, ${t.lane} lane`,
          details: { token: t.code, lane: t.lane, level: t.level, reason: prio.reason, position: t.position },
        });
        return Number(newId);
      })();
    } catch (err) { dropEngine(); throw err; }   // engine and database disagree: rebuild the engine from the database
    return toDto(tokenRow(id), t);
  });
}

function callNext(admin, counterId) {
  return operate(async () => {
    const counter = counterRow(counterId);
    if (!counter) throw new ApiError(404, 'Counter not found.', null, 'COUNTER_NOT_FOUND');
    if (!counter.is_open) throw new ApiError(409, `${counter.name} is closed. Open it first.`, null, 'COUNTER_CLOSED');
    const today = time.today();

    for (let attempts = 0; attempts < 200; attempts += 1) {
      const reply = await engine(`CALL ${counter.id}`);
      const row = tokenRowByCode(reply.token.code, today);
      const stale = row && staleReason(row);
      if (!row || stale) {    // safety net: skip a student who stopped being eligible since the last check
        await engine(`CANCEL ${reply.token.code}`);
        if (row) {
          db.transaction(() => {
            db.prepare("UPDATE queue_tokens SET status = 'cancelled', finished_at = datetime('now'), finish_reason = ? WHERE id = ?").run(stale, row.id);
            activityService.log(SYSTEM, { action: 'queue.auto_cancel', student: { id: row.student_id, fullName: row.student_name }, summary: `Token ${row.token_code} of ${row.student_name} skipped: ${stale}`, details: { token: row.token_code, reason: stale } });
          })();
        }
        continue;
      }
      try {
        db.transaction(() => {
          db.prepare("UPDATE queue_tokens SET status = 'called', counter_id = ?, called_at = datetime('now') WHERE id = ?").run(counter.id, row.id);
          setStreak(today, reply.streak);
          activityService.log(admin, { action: 'queue.call', student: { id: row.student_id, fullName: row.student_name }, summary: `${counter.name} called token ${row.token_code} (${row.student_name})`, details: { token: row.token_code, counter: counter.name } });
        })();
      } catch (err) { dropEngine(); throw err; }
      return toDto(tokenRow(row.id));
    }
    throw new ApiError(409, 'Nobody eligible is waiting.', null, 'QUEUE_EMPTY');
  });
}

/** start / complete / no-show / cancel on one token (by database id). */
function transition(admin, tokenId, kind, note) {
  const CONFIG = {
    start: { cmd: 'START', from: ['called'], to: 'serving', col: 'serving_at', action: 'queue.start', verb: 'started serving' },
    complete: { cmd: 'COMPLETE', from: ['serving'], to: 'completed', col: 'finished_at', action: 'queue.complete', verb: 'completed' },
    no_show: { cmd: 'NOSHOW', from: ['called'], to: 'no_show', col: 'finished_at', action: 'queue.no_show', verb: 'marked as no-show' },
    cancel: { cmd: 'CANCEL', from: ['waiting', 'called'], to: 'cancelled', col: 'finished_at', action: 'queue.cancel', verb: 'cancelled' },
  }[kind];
  return operate(async () => {
    const row = tokenRow(tokenId);
    if (!row) throw new ApiError(404, 'Token not found.', null, 'TOKEN_NOT_FOUND');
    if (!CONFIG.from.includes(row.status)) {
      throw new ApiError(409, `Token ${row.token_code} is ${STATUS_LABELS[row.status].toLowerCase()}; it cannot be ${CONFIG.verb} now.`, null, 'BAD_STATE');
    }
    await engine(`${CONFIG.cmd} ${row.token_code}`);
    try {
      db.transaction(() => {
        db.prepare(`UPDATE queue_tokens SET status = ?, ${CONFIG.col} = datetime('now'), finish_reason = COALESCE(?, finish_reason) WHERE id = ?`).run(CONFIG.to, note || null, row.id);
        activityService.log(admin, {
          action: CONFIG.action, student: { id: row.student_id, fullName: row.student_name },
          summary: `Token ${row.token_code} (${row.student_name}) ${CONFIG.verb}${row.counter_name ? ` at ${row.counter_name}` : ''}`,
          details: { token: row.token_code, from: row.status, to: CONFIG.to, note: note || null },
        });
      })();
    } catch (err) { dropEngine(); throw err; }
    return toDto(tokenRow(row.id));
  });
}

function setCounterOpen(admin, counterId, isOpen) {
  return operate(async () => {
    const counter = counterRow(counterId);
    if (!counter) throw new ApiError(404, 'Counter not found.', null, 'COUNTER_NOT_FOUND');
    if (Boolean(counter.is_open) === isOpen) throw new ApiError(409, `${counter.name} is already ${isOpen ? 'open' : 'closed'}.`, null, 'NO_CHANGE');
    const reply = await engine(`COUNTER ${counter.id} ${isOpen ? 1 : 0}`);
    try {
      db.transaction(() => {
        db.prepare('UPDATE verification_counters SET is_open = ? WHERE id = ?').run(isOpen ? 1 : 0, counter.id);
        for (const r of reply.returned) {   // a student called to this counter goes back to their place in line
          const row = tokenRowByCode(r.code, time.today());
          db.prepare("UPDATE queue_tokens SET status = 'waiting', counter_id = NULL, called_at = NULL WHERE id = ?").run(row.id);
        }
        activityService.log(admin, {
          action: isOpen ? 'queue.counter_open' : 'queue.counter_close',
          summary: `${counter.name} ${isOpen ? 'opened' : 'closed'}${reply.returned.length ? `; ${reply.returned.map((r) => r.code).join(', ')} returned to the queue` : ''}`,
          details: { counter: counter.name, returned: reply.returned.map((r) => r.code) },
        });
      })();
    } catch (err) { dropEngine(); throw err; }
    return { counter: counterDto(counterRow(counter.id)), returned: reply.returned.map((r) => r.code) };
  });
}

function addCounter(admin, name) {
  return operate(async () => {
    const clean = String(name || '').trim().replace(/\s+/g, ' ');
    if (clean.length < 2 || clean.length > 40) throw new ApiError(400, 'Please correct the highlighted fields.', { name: 'Counter name must be 2-40 characters.' });
    if (db.prepare('SELECT COUNT(*) AS n FROM verification_counters').get().n >= MAX_COUNTERS) throw new ApiError(409, `At most ${MAX_COUNTERS} counters are supported.`, null, 'TOO_MANY_COUNTERS');
    if (db.prepare('SELECT 1 FROM verification_counters WHERE name = ? COLLATE NOCASE').get(clean)) throw new ApiError(409, 'A counter with this name already exists.', { name: 'Already exists.' }, 'DUPLICATE_COUNTER');
    const id = Number(db.prepare('INSERT INTO verification_counters (name) VALUES (?)').run(clean).lastInsertRowid);
    activityService.log(admin, { action: 'queue.counter_add', summary: `Added ${clean}`, details: { counter: clean } });
    await engine(`COUNTER ${id} 1`);
    return counterDto(counterRow(id));
  });
}

// ------------------------------------------------------------------------------------------------
// views
// ------------------------------------------------------------------------------------------------
function getState() {
  return operate(async () => {
    const today = time.today();
    const snap = await engine('SNAPSHOT');
    const rows = db.prepare(`${TOKEN_SELECT} WHERE t.queue_date = ? ORDER BY t.token_number`).all(today);
    const liveByCode = new Map(snap.waiting.map((w) => [w.code, w]));
    const tokens = rows.map((r) => toDto(r, liveByCode.get(r.token_code)));
    const byCode = new Map(tokens.map((t) => [t.code, t]));
    const counterTokens = new Map(snap.counters.filter((c) => c.token).map((c) => [c.id, byCode.get(c.token.code)]));
    const count = (s) => tokens.filter((t) => t.status === s).length;
    return {
      date: today, policy: POLICY, streak: snap.streak,
      counters: db.prepare('SELECT * FROM verification_counters ORDER BY id').all().map((c) => counterDto(c, counterTokens.get(c.id))),
      waiting: snap.waiting.map((w) => byCode.get(w.code)),
      finished: tokens.filter((t) => !ACTIVE.includes(t.status)).sort((a, b) => b.number - a.number),
      stats: { waiting: snap.waiting.length, priorityWaiting: snap.priorityWaiting, regularWaiting: snap.regularWaiting, called: snap.called, serving: snap.serving, completed: count('completed'), noShow: count('no_show'), cancelled: count('cancelled') + count('expired'), issued: tokens.length },
    };
  });
}

function lookup(query) {
  return operate(async () => {
    const today = time.today();
    const code = String(query.token || '').trim().toUpperCase();
    const appId = String(query.applicationId || '').trim().toUpperCase();
    if (code && !/^[PR]\d{3,6}$/.test(code)) throw new ApiError(400, 'Token codes look like P003 or R012.', { token: 'Invalid token code.' });
    if (!code && !/^[A-Z0-9-]{5,20}$/.test(appId)) throw new ApiError(400, 'Enter a token code (e.g. R012) or an application ID.', { token: 'Required.' });

    // 1. active tokens: O(1) hash-map lookup inside the engine
    const r = await client.send(code ? `FIND_TOKEN ${code}` : `FIND_APP ${appId}`);
    if (r.ok) {
      const row = tokenRowByCode(r.token.code, today);
      return { source: 'engine', token: toDto(row, r.token) };
    }
    // 2. finished tokens: only the database remembers them
    const row = code ? tokenRowByCode(code, today)
      : db.prepare(`${TOKEN_SELECT} WHERE t.application_id = ? AND t.queue_date = ? ORDER BY t.id DESC LIMIT 1`).get(appId, today);
    if (!row) throw new ApiError(404, 'No token found for today.', null, 'TOKEN_NOT_FOUND');
    return { source: 'database', token: toDto(row) };
  });
}

/** Students who can be checked in right now (appointment today, no active token ...). DB only. */
function listEligible(search) {
  const today = time.today();
  const term = `%${String(search || '').trim().slice(0, 60).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = db.prepare(
    `SELECT s.id, s.full_name, c.application_id, c.cap_round, a.appointment_time, a.venue, COALESCE(v.status, 'pending') AS vstatus
       FROM appointments a JOIN students s ON s.id = a.student_id JOIN cap_details c ON c.student_id = s.id
       LEFT JOIN verification_records v ON v.student_id = s.id LEFT JOIN application_reviews r ON r.student_id = s.id
      WHERE a.status = 'scheduled' AND a.appointment_date = ? AND COALESCE(r.status, 'pending') <> 'rejected' AND COALESCE(v.status, 'pending') <> 'completed'
        AND NOT EXISTS (SELECT 1 FROM queue_tokens q WHERE q.student_id = s.id AND q.status IN ('waiting','called','serving'))
        AND NOT EXISTS (SELECT 1 FROM queue_tokens q WHERE q.appointment_id = a.id AND q.status = 'completed')
        AND (s.full_name LIKE ? ESCAPE '\\' OR s.email LIKE ? ESCAPE '\\' OR c.application_id LIKE ? ESCAPE '\\')
      ORDER BY a.appointment_time, s.full_name COLLATE NOCASE LIMIT 20`
  ).all(today, term, term, term);
  return rows.map((r) => {
    const p = priorityFor(r.cap_round, r.vstatus);
    return { id: r.id, name: r.full_name, applicationId: r.application_id, capRound: r.cap_round, appointmentTime: r.appointment_time, venue: r.venue, level: p.level, lane: p.level === 3 ? 'regular' : 'priority', priorityReason: p.reason };
  });
}

const STUDENT_MESSAGES = {
  waiting: (t) => (t.position === 1 ? 'You are next. Please stay near the verification area.' : `You are number ${t.position} in the queue. ${t.ahead} student${t.ahead === 1 ? '' : 's'} will be called before you.`),
  called: (t) => `Please go to ${t.counter} now.`,
  serving: (t) => `You are being served at ${t.counter}.`,
  completed: () => 'Your turn is finished. The college will record the verification result on your dashboard.',
  no_show: () => 'You were called but did not reach the counter. Please ask the verification desk for a new token.',
  cancelled: () => 'Your token was cancelled. Please ask the verification desk if you still need to be verified.',
  expired: () => 'Your token from an earlier day expired. Please ask the verification desk.',
};

function studentToken(row, live) {
  const t = {
    code: row.token_code, status: row.status, statusLabel: STATUS_LABELS[row.status], lane: row.lane, priority: row.priority_level < 3,
    priorityReason: row.priority_level < 3 ? row.priority_reason : null, counter: row.counter_name || null,
    position: row.status === 'waiting' && live ? live.position : null, ahead: row.status === 'waiting' && live ? live.ahead : null,
    issuedAt: row.created_at, calledAt: row.called_at, finishedAt: row.finished_at, active: ACTIVE.includes(row.status),
  };
  t.message = STUDENT_MESSAGES[row.status](t);
  return t;
}

/** What the student sees. Uses the engine only when a live queue position is needed. */
async function getStudentView(studentId) {
  const today = time.today();
  const latest = () => db.prepare(`${TOKEN_SELECT} WHERE t.student_id = ? AND t.queue_date = ? ORDER BY (t.status IN ('waiting','called','serving')) DESC, t.id DESC LIMIT 1`).get(studentId, today);
  const appt = db.prepare("SELECT appointment_time, venue FROM appointments WHERE student_id = ? AND status = 'scheduled' AND appointment_date = ?").get(studentId, today);
  const hint = { appointmentToday: appt ? { time: appt.appointment_time, venue: appt.venue } : null };

  let row = latest();
  if (row && row.status === 'waiting') {
    return operate(async () => {      // also drops the token if the student stopped being eligible
      row = latest();
      if (!row || row.status !== 'waiting') return { token: row ? studentToken(row) : null, ...hint };
      const r = await engine(`FIND_TOKEN ${row.token_code}`);
      return { token: studentToken(row, r.token), ...hint };
    });
  }
  return { token: row ? studentToken(row) : null, ...hint };
}

function tokensForStudentToday(studentId) {
  return db.prepare(`${TOKEN_SELECT} WHERE t.student_id = ? AND t.queue_date = ? ORDER BY t.id DESC`).all(studentId, time.today()).map((r) => toDto(r));
}

function getTodayCounts() {
  const counts = Object.fromEntries(['waiting', 'called', 'serving', 'completed', 'no_show'].map((s) => [s, 0]));
  db.prepare('SELECT status, COUNT(*) AS n FROM queue_tokens WHERE queue_date = ? GROUP BY status').all(time.today()).forEach((r) => { if (r.status in counts) counts[r.status] = r.n; });
  return counts;
}

// ------------------------------------------------------------------------------------------------
function shutdown() { dropEngine(); }
const __test = { killEngine: () => { if (client && client.child) client.child.kill('SIGKILL'); }, engineAlive: () => Boolean(client && client.alive), BURST };

module.exports = {
  POLICY, STATUS_LABELS, checkInProblem, priorityFor, checkIn, callNext, transition, setCounterOpen, addCounter,
  getState, lookup, listEligible, getStudentView, tokensForStudentToday, getTodayCounts, shutdown, __test,
};
