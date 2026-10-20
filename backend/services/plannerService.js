'use strict';
/**
 * Admin planner (Phase 5: SORTING and MATRICES). All ordering and matrix work is done by the C++ engine:
 *   unscheduled / arrivals  -> merge sort over several keys (priority level, appointment time, token, waiting time)
 *   load                    -> SPARSE matrix (days x half-hour slots)
 *   documents               -> DENSE matrix (documents x CAP rounds)
 */
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const time = require('../utils/time');
const queueService = require('./queueService');
const capService = require('./capService');
const documentService = require('./documentService');

const SLOT_MINUTES = 30;
const SLOTS_PER_DAY = 48;
const OFFICE_FIRST_SLOT = 18;   // 09:00
const OFFICE_END_SLOT = 34;     // 17:00 (exclusive)
const MAX_DAYS = 31;

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const slotLabel = (slot) => `${String(Math.floor((slot * SLOT_MINUTES) / 60)).padStart(2, '0')}:${String((slot * SLOT_MINUTES) % 60).padStart(2, '0')}`;
const safeName = (n) => String(n).replace(/[~:]/g, '-').replace(/\s+/g, '~');

async function runSort(mode, rows) {
  return queueService.withEngine(async ({ send }) => {
    const r = await send(`SORT ${mode} ${rows.length} ${rows.map((x) => `${x.id}:${x.level}:${x.minutes}:${x.token}:${x.waitKey}:${safeName(x.name)}`).join(' ')}`);
    if (!r.ok) throw new Error(`Sort failed: ${r.message}`);
    return r;
  });
}

const priorityOf = (round, vstatus) => queueService.priorityFor(round, vstatus);

/** Students who still need a verification appointment, ranked: who should be booked first. */
async function unscheduled() {
  const rows = db.prepare(
    `SELECT s.id, s.full_name, c.application_id, c.cap_round, c.created_at, CAST(strftime('%s', c.created_at) AS INTEGER) AS since, COALESCE(v.status, 'pending') AS vstatus
       FROM students s JOIN cap_details c ON c.student_id = s.id
       LEFT JOIN verification_records v ON v.student_id = s.id LEFT JOIN application_reviews r ON r.student_id = s.id
      WHERE COALESCE(r.status, 'pending') <> 'rejected' AND COALESCE(v.status, 'pending') <> 'completed'
        AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.student_id = s.id AND a.status = 'scheduled')
      ORDER BY s.id LIMIT 1000`
  ).all();
  const work = rows.map((r) => ({ ...r, level: priorityOf(r.cap_round, r.vstatus).level, minutes: 0, token: 0, waitKey: r.since, name: r.full_name }));
  const sorted = await runSort('unscheduled', work);
  const byId = new Map(work.map((w) => [w.id, w]));
  return {
    sortedBy: 'priority level, then longest waiting, then name',
    algorithm: { name: sorted.algorithm, comparisons: sorted.comparisons, items: sorted.size },
    items: sorted.order.map((id, i) => {
      const w = byId.get(id);
      const p = priorityOf(w.cap_round, w.vstatus);
      return { rank: i + 1, id, name: w.full_name, applicationId: w.application_id, capRound: w.cap_round, level: p.level, priorityReason: p.reason, waitingSince: w.created_at };
    }),
  };
}

const ARRIVAL_MODES = { time: 'arrivals_time', priority: 'arrivals_priority', token: 'arrivals_token' };

/** Today's appointments in the order the admin chooses: by time, by priority or by queue token. */
async function arrivals(sortKey) {
  const key = Object.prototype.hasOwnProperty.call(ARRIVAL_MODES, sortKey) ? sortKey : 'time';
  const today = time.today();
  const rows = db.prepare(
    `SELECT s.id, s.full_name, c.application_id, c.cap_round, a.appointment_time, a.venue, a.status AS appt_status, COALESCE(v.status, 'pending') AS vstatus,
            (SELECT t.token_code FROM queue_tokens t WHERE t.student_id = s.id AND t.queue_date = ? ORDER BY t.id DESC LIMIT 1) AS token_code,
            (SELECT t.token_number FROM queue_tokens t WHERE t.student_id = s.id AND t.queue_date = ? ORDER BY t.id DESC LIMIT 1) AS token_number,
            (SELECT t.status FROM queue_tokens t WHERE t.student_id = s.id AND t.queue_date = ? ORDER BY t.id DESC LIMIT 1) AS token_status
       FROM appointments a JOIN students s ON s.id = a.student_id JOIN cap_details c ON c.student_id = s.id
       LEFT JOIN verification_records v ON v.student_id = s.id
      WHERE a.appointment_date = ? AND a.status IN ('scheduled', 'completed', 'missed') ORDER BY s.id LIMIT 1000`
  ).all(today, today, today, today);
  const work = rows.map((r) => ({ ...r, level: priorityOf(r.cap_round, r.vstatus).level, minutes: minutesOf(r.appointment_time), token: r.token_number || 0, waitKey: 0, name: r.full_name }));
  const sorted = await runSort(ARRIVAL_MODES[key], work);
  const byId = new Map(work.map((w) => [w.id, w]));
  const label = { time: 'appointment time, then priority, then name', priority: 'priority level, then appointment time, then name', token: 'queue token (checked-in students first), then appointment time' }[key];
  return {
    date: today, sort: key, sortedBy: label,
    algorithm: { name: sorted.algorithm, comparisons: sorted.comparisons, items: sorted.size },
    items: sorted.order.map((id, i) => {
      const w = byId.get(id);
      const p = priorityOf(w.cap_round, w.vstatus);
      return { position: i + 1, id, name: w.full_name, applicationId: w.application_id, appointmentTime: w.appointment_time, venue: w.venue, appointmentStatus: w.appt_status, level: p.level, priorityReason: p.reason, token: w.token_code, tokenStatus: w.token_status };
    }),
  };
}

/** Appointment load for the next N days as a SPARSE matrix, plus a suggested least-loaded office-hours slot per day. */
async function load({ from, days } = {}) {
  const start = from || time.today();
  if (!time.isRealDate(start)) throw new ApiError(400, 'Please correct the highlighted fields.', { from: 'Enter a valid date.' });
  const n = days === undefined || days === '' ? 14 : Number(days);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) throw new ApiError(400, 'Please correct the highlighted fields.', { days: `Choose 1 to ${MAX_DAYS} days.` });
  const dates = Array.from({ length: n }, (_, i) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const rows = db.prepare("SELECT appointment_date AS d, appointment_time AS t FROM appointments WHERE status = 'scheduled' AND appointment_date >= ? AND appointment_date <= ?").all(dates[0], dates[n - 1]);
  const dayIndex = new Map(dates.map((d, i) => [d, i]));
  const pairs = rows.map((r) => `${dayIndex.get(r.d)}:${Math.floor(minutesOf(r.t) / SLOT_MINUTES)}`);

  const r = await queueService.withEngine(async ({ send }) => {
    const reply = await send(`APPT_LOAD ${n} ${SLOTS_PER_DAY} ${OFFICE_FIRST_SLOT} ${OFFICE_END_SLOT} ${pairs.length}${pairs.length ? ` ${pairs.join(' ')}` : ''}`);
    if (!reply.ok) throw new Error(`Load report failed: ${reply.message}`);
    return reply;
  });
  const cell = ([d, c, count]) => ({ date: dates[d], time: slotLabel(c), count });
  return {
    from: dates[0], days: n, slotMinutes: SLOT_MINUTES, officeHours: { from: slotLabel(OFFICE_FIRST_SLOT), to: slotLabel(OFFICE_END_SLOT) },
    matrix: { representation: 'sparse (triplet list)', rows: r.rows, cols: r.cols, totalCells: r.rows * r.cols, storedCells: r.nonZeros, density: Number(r.density.toFixed(4)), lookupComparisons: r.lookupComparisons },
    bookings: r.bookings,
    cells: r.cells.map(cell),
    dayTotals: dates.map((d, i) => ({ date: d, count: r.rowSums[i] })),
    slotTotals: r.colSums.map((count, c) => ({ time: slotLabel(c), count })).filter((s) => s.count > 0),
    busiest: r.busiest.map(cell),
    suggestions: dates.map((d, i) => ({ date: d, time: slotLabel(r.bestSlots[i][0]), count: r.bestSlots[i][1] })),
  };
}

/** Which documents are ready, per CAP round, as a DENSE matrix (documents x rounds). */
async function documents() {
  const docs = documentService.DOCUMENTS;
  const rounds = capService.CAP_ROUNDS;
  const totals = rounds.map((rd) => db.prepare('SELECT COUNT(*) AS n FROM cap_details WHERE cap_round = ?').get(rd).n);
  const cells = db.prepare(
    `SELECT d.doc_key, c.cap_round, COUNT(*) AS n FROM document_status d JOIN cap_details c ON c.student_id = d.student_id WHERE d.prepared = 1 GROUP BY d.doc_key, c.cap_round`
  ).all().map((r) => `${documentService.KEYS.indexOf(r.doc_key)}:${rounds.indexOf(r.cap_round)}:${r.n}`).filter((s) => !s.includes('-1'));

  const r = await queueService.withEngine(async ({ send }) => {
    const reply = await send(`DOC_READINESS ${docs.length} ${rounds.length} ${totals.join(' ')} ${cells.length}${cells.length ? ` ${cells.join(' ')}` : ''}`);
    if (!reply.ok) throw new Error(`Readiness report failed: ${reply.message}`);
    return reply;
  });
  const at = (arr, d, k) => arr[d * rounds.length + k];
  return {
    matrix: { representation: 'dense (rows x columns array)', rows: docs.length, cols: rounds.length },
    rounds: rounds.map((name, k) => ({ name, students: totals[k] })),
    documents: docs.map((d, i) => ({
      key: d.key, title: d.title, required: d.required,
      ready: rounds.map((_, k) => at(r.counts, i, k)), percent: rounds.map((_, k) => at(r.percent, i, k)), totalReady: r.docTotals[i],
    })),
    weakest: rounds.map((name, k) => (r.weakestDoc[k] < 0 ? { round: name, document: null } : { round: name, document: docs[r.weakestDoc[k]].title, percent: at(r.percent, r.weakestDoc[k], k) })),
  };
}

module.exports = { unscheduled, arrivals, load, documents, SLOT_MINUTES };
