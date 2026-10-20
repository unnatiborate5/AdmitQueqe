'use strict';
/**
 * Global admin search (Phase 5: SEARCHING).
 *
 * The C++ engine holds a SearchIndex (cpp_engine/include/search_index.hpp):
 *   application ID -> binary search on a merge-sorted array (prefix = a contiguous range)
 *   token code     -> binary search on today's tokens sorted by number
 *   student name   -> linear search (a fragment of text has no order to exploit)
 * This service loads the index from SQLite, rebuilds it only when the underlying data changed, runs the right
 * searches for what the admin typed, and returns students with the algorithm and step counts used.
 */
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const time = require('../utils/time');
const queueService = require('./queueService');

const MAX_RESULTS = 15;
const BATCH = 150;
let indexFingerprint = null;     // what the engine's index currently reflects; null = must be (re)built

// A new engine process starts with an empty index.
queueService.onRestore(async () => { indexFingerprint = null; });

function fingerprint(today) {
  const r = db.prepare(
    `SELECT (SELECT COUNT(*) FROM students) AS s, (SELECT COUNT(*) FROM cap_details) AS c,
            (SELECT COALESCE(MAX(updated_at), '') FROM cap_details) AS cu,
            (SELECT COUNT(*) FROM queue_tokens WHERE queue_date = ?) AS t, (SELECT COALESCE(MAX(id), 0) FROM queue_tokens WHERE queue_date = ?) AS tm`
  ).get(today, today);
  return `${today}|${r.s}|${r.c}|${r.cu}|${r.t}|${r.tm}`;
}

const safeName = (n) => String(n).replace(/[~:]/g, '-').replace(/\s+/g, '~');

async function ensureIndex(send) {
  const today = time.today();
  const fp = fingerprint(today);
  if (fp === indexFingerprint) return false;
  const students = db.prepare(
    `SELECT s.id, s.full_name, COALESCE(c.application_id, '_NONE_' || s.id) AS app FROM students s LEFT JOIN cap_details c ON c.student_id = s.id ORDER BY s.id`
  ).all();
  const tokens = db.prepare('SELECT token_number, token_code, student_id FROM queue_tokens WHERE queue_date = ? ORDER BY token_number').all(today);

  await send('INDEX_CLEAR');
  for (let i = 0; i < students.length; i += BATCH) {
    const part = students.slice(i, i + BATCH);
    const r = await send(`INDEX_ADD ${part.length} ${part.map((s) => `${s.id}:${s.app}:${safeName(s.full_name)}`).join(' ')}`);
    if (!r.ok) throw new Error(`Index load failed: ${r.message}`);
  }
  for (let i = 0; i < tokens.length; i += BATCH) {
    const part = tokens.slice(i, i + BATCH);
    const r = await send(`INDEX_TOKENS ${part.length} ${part.map((t) => `${t.token_number}:${t.token_code[0]}:${t.student_id}`).join(' ')}`);
    if (!r.ok) throw new Error(`Index load failed: ${r.message}`);
  }
  const built = await send('INDEX_BUILD');
  if (!built.ok) throw new Error('Index build failed');
  indexFingerprint = fp;
  return true;
}

const TOKEN_RE = /^[PR]\d{1,6}$/i;
const APP_RE = /^[A-Za-z0-9-]{3,20}$/;
const TEXT_RE = /^[\p{L}\p{N}\s.'’-]+$/u;

async function search(rawQuery) {
  const q = String(rawQuery || '').trim().replace(/\s+/g, ' ');
  if (q.length < 2) throw new ApiError(400, 'Type at least 2 characters to search.', { q: 'Too short.' });
  if (q.length > 60) throw new ApiError(400, 'Search text can be at most 60 characters.', { q: 'Too long.' });
  if (!TEXT_RE.test(q)) throw new ApiError(400, 'Search text can only contain letters, numbers, spaces and . \' -', { q: 'Invalid characters.' });

  return queueService.withEngine(async ({ send }) => {
    const rebuilt = await ensureIndex(send);
    const plan = [];
    if (TOKEN_RE.test(q)) plan.push({ field: 'Token', cmd: `SEARCH_TOKEN ${q}` });
    if (APP_RE.test(q)) plan.push({ field: 'Application ID', cmd: `SEARCH_APP ${q}` });
    if (/[\p{L}]/u.test(q)) plan.push({ field: 'Name', cmd: `SEARCH_NAME ${q.replace(/\s/g, '~')}` });

    const matches = new Map();      // studentId -> ['Token', 'Name', ...]
    const algorithms = [];
    for (const step of plan) {
      const r = await send(step.cmd);
      if (!r.ok) throw new Error(`Search failed: ${r.message}`);
      algorithms.push({ field: step.field, algorithm: r.algorithm, comparisons: r.comparisons, searched: r.size, matches: r.matches.length });
      for (const id of r.matches) matches.set(id, [...(matches.get(id) || []), step.field]);
    }

    // rank: token matches, then application-ID matches, then name matches; each group keeps the engine's order
    const rank = (fields) => (fields.includes('Token') ? 0 : fields.includes('Application ID') ? 1 : 2);
    const ordered = [...matches.entries()].sort((a, b) => rank(a[1]) - rank(b[1]));   // Array.sort is stable
    const ids = ordered.slice(0, MAX_RESULTS).map(([id]) => id);

    let results = [];
    if (ids.length) {
      const rows = db.prepare(
        `SELECT s.id, s.full_name, s.email, s.admission_token, c.application_id, c.cap_round, COALESCE(r.status, CASE WHEN c.id IS NULL THEN 'not_started' ELSE 'pending' END) AS review,
                (SELECT t.token_code FROM queue_tokens t WHERE t.student_id = s.id AND t.queue_date = ? ORDER BY t.id DESC LIMIT 1) AS token,
                (SELECT t.status FROM queue_tokens t WHERE t.student_id = s.id AND t.queue_date = ? ORDER BY t.id DESC LIMIT 1) AS token_status
           FROM students s LEFT JOIN cap_details c ON c.student_id = s.id LEFT JOIN application_reviews r ON r.student_id = s.id
          WHERE s.id IN (${ids.map(() => '?').join(',')})`
      ).all(time.today(), time.today(), ...ids);
      const byId = new Map(rows.map((r) => [r.id, r]));
      results = ids.filter((id) => byId.has(id)).map((id) => {
        const r = byId.get(id);
        return { id, name: r.full_name, email: r.email, applicationId: r.application_id, admissionToken: r.admission_token || null, capRound: r.cap_round, reviewStatus: r.review, token: r.token, tokenStatus: r.token_status, matchedBy: matches.get(id) };
      });
    }
    return { query: q, results, total: matches.size, truncated: matches.size > MAX_RESULTS, algorithms, indexRebuilt: rebuilt };
  });
}

module.exports = { search };
