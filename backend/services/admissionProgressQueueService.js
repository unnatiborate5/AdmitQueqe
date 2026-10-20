'use strict';
/**
 * ===========================================================================
 * PERMANENT ADMISSION-PROGRESS QUEUE SERVICE
 * ===========================================================================
 *
 * Deterministic queue for trusted CAP-matched students progressing through
 * all six admission tasks:
 *   1. cap_details (verified CAP allotment)
 *   2. allotment_acceptance
 *   3. admission_form
 *   4. document_preparation
 *   5. physical_verification
 *   6. fee_payment
 *
 * ---------------------------------------------------------------------------
 * PRIORITY SCORING FORMULA SPECIFICATION
 * ---------------------------------------------------------------------------
 * Normalized Composite Score:
 *   S = 0.60 * U + 0.40 * P
 *
 * Where:
 * 1. Approved-Task Progress (P):
 *    P = approvedCount / 6.0
 *    - approvedCount is the integer count (0 to 6) of tasks with approved status.
 *    - Submitted tasks (submitted, pending_review) and tasks requiring correction
 *      do NOT count as approvals (they yield 0 progress points).
 *    - P in [0.0, 1.0].
 *
 * 2. Deadline Urgency (U):
 *    - Missing Deadline Handling: If a student has no scheduled deadline,
 *      urgency is consistently set to U = 0.0 without inventing arbitrary dates.
 *    - Existing Deadline: Sourced exclusively from existing scheduled appointments
 *      (appointment_date).
 *      delta = ceil((deadlineDate - todayDate) / (1000 * 60 * 60 * 24))
 *      - If delta <= 0 (due today or overdue):
 *          U = 1.0  (maximum urgency)
 *      - If 0 < delta < 14 (within 14-day standard window):
 *          U = (14 - delta) / 14.0
 *      - If delta >= 14:
 *          U = 0.0
 *    - U in [0.0, 1.0].
 *
 * 3. Priority Score (S):
 *    S = round(0.60 * U + 0.40 * P, 4) in [0.0000, 1.0000]
 *
 * 4. Deterministic Ordering & Tie-Breaking:
 *    - Primary:   priorityScore DESC (closer deadlines and more approved tasks first)
 *    - Secondary: entered_at ASC     (earlier queue-entry time first: FIFO tie-breaker)
 *    - Tertiary:  student_id ASC     (deterministic fallback)
 *
 * 5. Completion Rule:
 *    - Students are removed from the active queue ONLY after all six tasks are approved.
 *    - When approvedCount === 6, status becomes 'completed'.
 *    - Permanent admission tokens (AF-xxx), task records, uploads, and history
 *      are permanently preserved.
 *
 * 6. System Isolation:
 *    - Completely isolated from daily physical-verification desk tokens (queue_tokens,
 *      Rxxx/Pxxx), verification counters, and C++ queue engine / fairness streak.
 * ===========================================================================
 */

const admissionTokenService = require('./admissionTokenService');

function getQueueService() {
  return require('./queueService');
}

let restoreHookRegistered = false;
function ensureRestoreHook() {
  if (restoreHookRegistered) return;
  restoreHookRegistered = true;
  try {
    getQueueService().onRestore(async (send) => {
      try {
        await syncAllToEngine(send);
      } catch (_) {
        // Non-blocking safe restore
      }
    });
  } catch (_) {}
}

const TOTAL_TASKS = 6;
const WEIGHT_URGENCY = 0.60;
const WEIGHT_PROGRESS = 0.40;
const DEADLINE_HORIZON_DAYS = 14;

const TASK_KEYS = [
  'cap_details',
  'allotment_acceptance',
  'admission_form',
  'document_preparation',
  'physical_verification',
  'fee_payment',
];

const getDb = (dbInstance) => dbInstance || require('../config/db');

/**
 * Checks whether a student is a trusted CAP-matched student.
 * Unmatched students are strictly excluded from queue entry.
 */
function isTrustedCapMatched(studentId, dbInstance) {
  const db = getDb(dbInstance);
  if (!studentId) return false;
  const row = db.prepare(`
    SELECT 1 FROM cap_details WHERE student_id = ?
    UNION
    SELECT 1 FROM cap_allotment_records WHERE linked_student_id = ? AND status = 'verified'
  `).get(studentId, studentId);
  return Boolean(row);
}

/**
 * Enrolls a trusted CAP-matched student into the admission progress queue.
 * Strictly prevents duplicates and rejects unmatched students.
 *
 * @param {number} studentId
 * @param {import('better-sqlite3').Database} [dbInstance]
 * @returns {object|null} The queue record or null if not eligible
 */
function enrollStudent(studentId, dbInstance) {
  const db = getDb(dbInstance);
  if (!studentId) return null;

  // Unmatched students are excluded
  if (!isTrustedCapMatched(studentId, db)) {
    return null;
  }

  // Ensure permanent admission token is allocated
  let token = admissionTokenService.getAdmissionToken(studentId, db);
  if (!token) {
    token = admissionTokenService.allocateAdmissionToken(studentId, db);
  }
  if (!token) return null;

  const performEnroll = () => {
    const existing = db.prepare('SELECT * FROM admission_progress_queue WHERE student_id = ?').get(studentId);
    if (existing) {
      return existing;
    }

    db.prepare(`
      INSERT INTO admission_progress_queue (student_id, admission_token, entered_at, status)
      VALUES (?, ?, datetime('now'), 'active')
      ON CONFLICT(student_id) DO NOTHING
    `).run(studentId, token);

    const created = db.prepare('SELECT * FROM admission_progress_queue WHERE student_id = ?').get(studentId);
    if (created) {
      recomputeCompletion(studentId, db);
    }
    return created;
  };

  const enrolled = db.inTransaction ? performEnroll() : db.transaction(performEnroll)();
  if (enrolled) {
    syncStudentToEngine(studentId, db).catch(() => {});
  }
  return enrolled;
}

/**
 * Synchronizes all active records from SQLite into the C++ Max-Heap.
 */
async function syncAllToEngine(send, dbInstance) {
  const db = getDb(dbInstance);
  const rows = db.prepare(`
    SELECT q.student_id, q.admission_token, q.entered_at
      FROM admission_progress_queue q
     WHERE q.status = 'active'
     ORDER BY q.student_id ASC
  `).all();

  await send('PROGRESS_CLEAR');
  if (!rows.length) return;

  const items = [];
  for (const r of rows) {
    const counts = getStudentTaskCounts(r.student_id, db);
    const deadlineInfo = getStudentDeadline(r.student_id, db);
    const urgency = calculateUrgency(deadlineInfo.deadline);
    const priorityScore = calculatePriorityScore(urgency, counts.approvedCount);
    const safeEnteredAt = String(r.entered_at || '').replace(/\s+/g, '~');
    items.push(`${r.student_id}|${r.admission_token}|${priorityScore.toFixed(4)}|${safeEnteredAt}`);
  }

  const BATCH_SIZE = 100;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    const reply = await send(`PROGRESS_LOAD ${chunk.length} ${chunk.join(' ')}`);
    if (!reply.ok) {
      throw new Error(`PROGRESS_LOAD failed: ${reply.message || reply.error}`);
    }
  }
}

/**
 * Synchronizes a single student's status with the C++ Max-Heap.
 */
async function syncStudentToEngine(studentId, dbInstance) {
  if (!studentId) return;
  const db = getDb(dbInstance);
  ensureRestoreHook();
  try {
    const row = db.prepare('SELECT student_id, admission_token, entered_at, status FROM admission_progress_queue WHERE student_id = ?').get(studentId);
    if (!row || row.status === 'completed') {
      await getQueueService().withEngine(async ({ send }) => {
        await send(`PROGRESS_REMOVE ${studentId}`);
      });
      return;
    }

    const counts = getStudentTaskCounts(studentId, db);
    const deadlineInfo = getStudentDeadline(studentId, db);
    const urgency = calculateUrgency(deadlineInfo.deadline);
    const priorityScore = calculatePriorityScore(urgency, counts.approvedCount);
    const safeEnteredAt = String(row.entered_at || '').replace(/\s+/g, '~');

    await getQueueService().withEngine(async ({ send }) => {
      await send(`PROGRESS_UPSERT ${studentId} ${row.admission_token} ${priorityScore.toFixed(4)} ${safeEnteredAt}`);
    });
  } catch (_) {
    // Non-blocking safe update
  }
}

/**
 * Evaluates the 6 admission tasks for a student.
 * Tracks submittedCount and approvedCount separately.
 * Submissions do NOT count as approvals.
 */
function getStudentTaskCounts(studentId, dbInstance) {
  const db = getDb(dbInstance);
  const tasks = [];

  // Task 1: cap_details
  const capRow = db.prepare(`
    SELECT 1 FROM cap_details WHERE student_id = ?
    UNION
    SELECT 1 FROM cap_allotment_records WHERE linked_student_id = ? AND status = 'verified'
  `).get(studentId, studentId);

  const claimRow = db.prepare(`
    SELECT 1 FROM cap_claims WHERE student_id = ? AND status = 'pending'
  `).get(studentId);

  const capApproved = Boolean(capRow);
  const capSubmitted = !capApproved && Boolean(claimRow);

  tasks.push({
    key: 'cap_details',
    isApproved: capApproved,
    isSubmitted: capSubmitted,
    status: capApproved ? 'approved' : (capSubmitted ? 'pending_review' : 'not_started'),
  });

  // Tasks 2–6: review records from task_reviews
  const reviews = new Map(
    db.prepare('SELECT task_key, status FROM task_reviews WHERE student_id = ?').all(studentId)
      .map((r) => [r.task_key, r.status])
  );

  // Check verification_records for physical_verification outcome
  const verificationRecord = db.prepare('SELECT status FROM verification_records WHERE student_id = ?').get(studentId);
  const isPhysicalVerifiedInPerson = verificationRecord && verificationRecord.status === 'completed';

  const otherKeys = ['allotment_acceptance', 'admission_form', 'document_preparation', 'physical_verification', 'fee_payment'];
  for (const key of otherKeys) {
    const rawStatus = reviews.get(key) || 'not_started';
    let isApproved = rawStatus === 'approved';
    if (key === 'physical_verification' && isPhysicalVerifiedInPerson && rawStatus !== 'correction_required') {
      isApproved = true;
    }
    const isSubmitted = !isApproved && (rawStatus === 'submitted' || rawStatus === 'pending_review');

    tasks.push({
      key,
      isApproved,
      isSubmitted,
      status: isApproved ? 'approved' : rawStatus,
    });
  }

  const approvedCount = tasks.filter((t) => t.isApproved).length;
  const submittedCount = tasks.filter((t) => t.isSubmitted).length;

  return {
    totalTasks: TOTAL_TASKS,
    approvedCount,
    submittedCount,
    tasks,
  };
}

/**
 * Retrieves the relevant official CAP round deadline for a student's six-task admission workflow.
 * Selects only the official institute reporting deadline for the student's actual CAP round.
 * Never derives dates from round numbers, invents deadlines, or substitutes appointment dates.
 */
function getStudentDeadline(studentId, dbInstance) {
  const db = getDb(dbInstance);
  const capRoundDeadlineService = require('./capRoundDeadlineService');
  return capRoundDeadlineService.getRelevantDeadlineForStudent(studentId, db);
}

/**
 * Calculates deadline urgency score U in [0.0, 1.0].
 * Closer deadlines yield higher urgency.
 * If the official deadline is unavailable or missing, returns null (marked unavailable).
 *
 * @param {string|null} deadline - 'YYYY-MM-DD'
 * @param {Date|string} [asOfDate] - base date for calculation
 * @returns {number|null} Urgency in [0.0, 1.0] or null if unavailable
 */
function calculateUrgency(deadline, asOfDate = new Date()) {
  if (!deadline || typeof deadline !== 'string') {
    return null;
  }

  const deadlineClean = deadline.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadlineClean)) {
    return null;
  }

  let asOfStr;
  if (asOfDate instanceof Date) {
    asOfStr = asOfDate.toISOString().slice(0, 10);
  } else if (typeof asOfDate === 'string') {
    asOfStr = asOfDate.trim().slice(0, 10);
  } else {
    asOfStr = new Date().toISOString().slice(0, 10);
  }

  const msPerDay = 24 * 60 * 60 * 1000;
  const dTime = new Date(`${deadlineClean}T00:00:00Z`).getTime();
  const cTime = new Date(`${asOfStr}T00:00:00Z`).getTime();

  if (Number.isNaN(dTime) || Number.isNaN(cTime)) {
    return null;
  }

  const deltaDays = Math.ceil((dTime - cTime) / msPerDay);

  if (deltaDays <= 0) {
    // Due today or overdue: maximum urgency
    return 1.0;
  }
  if (deltaDays >= DEADLINE_HORIZON_DAYS) {
    // Beyond standard 14-day window: no immediate urgency
    return 0.0;
  }

  const urgency = (DEADLINE_HORIZON_DAYS - deltaDays) / DEADLINE_HORIZON_DAYS;
  return Number(urgency.toFixed(4));
}

/**
 * Computes deterministic normalized priority score:
 *   S = 0.60 * urgency + 0.40 * (approvedCount / 6.0)
 *
 * If urgency is unavailable (null), it contributes 0.0 to the urgency component
 * consistently without inventing arbitrary dates:
 *   S = 0.60 * 0.0 + 0.40 * (approvedCount / 6.0)
 *
 * @param {number|null} urgency - [0.0, 1.0] or null
 * @param {number} approvedCount - [0, 6]
 * @returns {number} Score in [0.0, 1.0]
 */
function calculatePriorityScore(urgency, approvedCount) {
  const normUrgency = (urgency === null || urgency === undefined || Number.isNaN(Number(urgency)))
    ? 0.0
    : Math.max(0.0, Math.min(1.0, Number(urgency)));
  const normApproved = Math.max(0, Math.min(TOTAL_TASKS, Number(approvedCount) || 0));
  const progress = normApproved / TOTAL_TASKS;

  const score = (WEIGHT_URGENCY * normUrgency) + (WEIGHT_PROGRESS * progress);
  return Number(score.toFixed(4));
}

/**
 * Recomputes completion status for a student.
 * Students are removed from the active queue ONLY after all 6 tasks are approved.
 */
function recomputeCompletion(studentId, dbInstance) {
  const db = getDb(dbInstance);
  const counts = getStudentTaskCounts(studentId, db);

  if (counts.approvedCount >= TOTAL_TASKS) {
    db.prepare(`
      UPDATE admission_progress_queue
         SET status = 'completed',
             completed_at = COALESCE(completed_at, datetime('now')),
             updated_at = datetime('now')
       WHERE student_id = ? AND status = 'active'
    `).run(studentId);
  } else {
    db.prepare(`
      UPDATE admission_progress_queue
         SET status = 'active',
             completed_at = NULL,
             updated_at = datetime('now')
       WHERE student_id = ? AND status = 'completed'
    `).run(studentId);
  }
}

/**
 * Retrieves the admission progress queue with dynamic positions,
 * priority scores, urgency, and submitted/approved task counts.
 *
 * @param {object} [options]
 * @param {string} [options.status] - 'active' (default), 'completed', or 'all'
 * @param {string} [options.search] - search term
 * @param {Date|string} [options.asOfDate] - base date for urgency calculation
 * @param {import('better-sqlite3').Database} [dbInstance]
 */
function getQueue(options = {}, dbInstance) {
  const db = getDb(dbInstance);
  const filterStatus = options.status || 'active';
  const asOfDate = options.asOfDate || new Date();

  const rows = db.prepare(`
    SELECT q.id AS queue_id,
           q.student_id,
           q.admission_token,
           q.entered_at,
           q.status AS queue_status,
           q.completed_at,
           s.full_name,
           s.email,
           s.phone,
           c.application_id
      FROM admission_progress_queue q
      JOIN students s ON s.id = q.student_id
      LEFT JOIN cap_details c ON c.student_id = s.id
     ORDER BY q.entered_at ASC, q.student_id ASC
  `).all();

  // Evaluate each student and sync completion
  const evaluated = [];
  for (const r of rows) {
    const counts = getStudentTaskCounts(r.student_id, db);
    const deadlineInfo = getStudentDeadline(r.student_id, db);
    const urgency = calculateUrgency(deadlineInfo.deadline, asOfDate);
    const priorityScore = calculatePriorityScore(urgency, counts.approvedCount);

    let currentStatus = r.queue_status;
    if (counts.approvedCount >= TOTAL_TASKS && currentStatus === 'active') {
      recomputeCompletion(r.student_id, db);
      currentStatus = 'completed';
    } else if (counts.approvedCount < TOTAL_TASKS && currentStatus === 'completed') {
      recomputeCompletion(r.student_id, db);
      currentStatus = 'active';
    }

    evaluated.push({
      queueId: r.queue_id,
      studentId: r.student_id,
      token: r.admission_token,
      student: {
        id: r.student_id,
        fullName: r.full_name,
        email: r.email,
        phone: r.phone,
        applicationId: r.application_id || null,
      },
      capRound: deadlineInfo.capRound,
      deadline: deadlineInfo.deadline,
      deadlineType: deadlineInfo.deadlineType,
      deadlineLabel: deadlineInfo.deadlineLabel,
      urgencyAvailable: Boolean(deadlineInfo.isAvailable && urgency !== null),
      urgency,
      seatAcceptanceDeadline: deadlineInfo.seatAcceptanceDeadline,
      admissionCutoffDeadline: deadlineInfo.admissionCutoffDeadline,
      submittedCount: counts.submittedCount,
      approvedCount: counts.approvedCount,
      priorityScore,
      enteredAt: r.entered_at,
      status: currentStatus,
      completedAt: r.completed_at || null,
    });
  }

  // Active candidates to be ranked
  const activeCandidates = evaluated.filter((item) => item.status === 'active');
  const activeMap = new Map(activeCandidates.map((item) => [item.studentId, item]));

  // Completed queue: completedAt DESC, entered_at ASC, student.id ASC
  const completedStudents = evaluated
    .filter((item) => item.status === 'completed')
    .sort((a, b) => {
      const compA = a.completedAt || '';
      const compB = b.completedAt || '';
      if (compA !== compB) {
        return compB < compA ? -1 : 1;
      }
      return a.enteredAt < b.enteredAt ? -1 : 1;
    })
    .map((item) => ({
      position: null,
      ...item,
    }));

  const formulaInfo = {
    description: 'Deterministic 60% deadline urgency + 40% approved-task progress (C++ Max-Heap)',
    weights: { urgency: WEIGHT_URGENCY, progress: WEIGHT_PROGRESS },
    totalTasks: TOTAL_TASKS,
    urgencyHorizonDays: DEADLINE_HORIZON_DAYS,
    relevantDeadlineType: 'institute_reporting',
    relevantDeadlineLabel: 'Institute Reporting Deadline',
    tieBreaker: 'FIFO (earlier entered_at)',
    engine: 'cpp_admission_progress_max_heap',
  };

  const buildResult = (activeRanked) => {
    let filtered;
    if (filterStatus === 'active') {
      filtered = activeRanked;
    } else if (filterStatus === 'completed') {
      filtered = completedStudents;
    } else {
      filtered = [...activeRanked, ...completedStudents];
    }

    if (options.search && typeof options.search === 'string' && options.search.trim()) {
      const term = options.search.trim().toLowerCase();
      filtered = filtered.filter((item) =>
        item.token.toLowerCase().includes(term) ||
        item.student.fullName.toLowerCase().includes(term) ||
        item.student.email.toLowerCase().includes(term) ||
        (item.student.applicationId && item.student.applicationId.toLowerCase().includes(term))
      );
    }

    return {
      items: filtered,
      total: filtered.length,
      formula: formulaInfo,
    };
  };

  // Synchronous baseline (for immediate sync property access)
  const syncRanked = activeCandidates
    .slice()
    .sort((a, b) => {
      if (b.priorityScore !== a.priorityScore) {
        return b.priorityScore - a.priorityScore;
      }
      if (a.enteredAt !== b.enteredAt) {
        return a.enteredAt < b.enteredAt ? -1 : 1;
      }
      return a.student.id - b.student.id;
    })
    .map((item, idx) => ({
      ...item,
      position: idx + 1,
    }));
  const syncResult = buildResult(syncRanked);

  // Asynchronous query: ordering determined by C++ Max-Heap via PROGRESS_RANK
  const enginePromise = (async () => {
    ensureRestoreHook();
    try {
      const reply = await getQueueService().withEngine(async ({ send }) => {
        // Sync active students to engine
        await send('PROGRESS_CLEAR');
        if (activeCandidates.length > 0) {
          const payload = activeCandidates.map((c) => {
            const safeEntered = String(c.enteredAt || '').replace(/\s+/g, '~');
            return `${c.studentId}|${c.token}|${c.priorityScore.toFixed(4)}|${safeEntered}`;
          });
          const BATCH = 100;
          for (let i = 0; i < payload.length; i += BATCH) {
            const chunk = payload.slice(i, i + BATCH);
            const loadRes = await send(`PROGRESS_LOAD ${chunk.length} ${chunk.join(' ')}`);
            if (!loadRes.ok) throw new Error(loadRes.message || 'PROGRESS_LOAD failed');
          }
        }
        return await send('PROGRESS_RANK');
      });

      if (reply && reply.ok && Array.isArray(reply.ranked)) {
        const seen = new Set();
        const heapRanked = [];
        for (let i = 0; i < reply.ranked.length; i++) {
          const r = reply.ranked[i];
          const st = activeMap.get(r.studentId);
          if (st) {
            heapRanked.push({
              ...st,
              position: i + 1, // Position assigned strictly from C++ max-heap order
            });
            seen.add(r.studentId);
          }
        }
        for (const item of activeCandidates) {
          if (!seen.has(item.studentId)) {
            heapRanked.push({
              ...item,
              position: heapRanked.length + 1,
            });
          }
        }
        return buildResult(heapRanked);
      }
    } catch (_) {
      // Graceful fallback to syncResult if engine is temporarily unreachable
    }
    return syncResult;
  })();

  // Attach synchronous properties to the returned promise so both synchronous
  // access (.items, .total, .formula) and `await getQueue(...)` work seamlessly!
  Object.assign(enginePromise, syncResult);
  return enginePromise;
}

/**
 * Returns queue information for a specific student.
 */
function getStudentQueueStatus(studentId, dbInstance) {
  const db = getDb(dbInstance);
  if (!studentId) return null;

  const row = db.prepare('SELECT * FROM admission_progress_queue WHERE student_id = ?').get(studentId);
  if (!row) return null;

  const counts = getStudentTaskCounts(studentId, db);
  const deadlineInfo = getStudentDeadline(studentId, db);
  const urgency = calculateUrgency(deadlineInfo.deadline);
  const priorityScore = calculatePriorityScore(urgency, counts.approvedCount);

  const fallback = {
    position: null,
    token: row.admission_token,
    capRound: deadlineInfo.capRound,
    deadline: deadlineInfo.deadline,
    deadlineType: deadlineInfo.deadlineType,
    deadlineLabel: deadlineInfo.deadlineLabel,
    urgencyAvailable: Boolean(deadlineInfo.isAvailable && urgency !== null),
    urgency,
    seatAcceptanceDeadline: deadlineInfo.seatAcceptanceDeadline,
    admissionCutoffDeadline: deadlineInfo.admissionCutoffDeadline,
    submittedCount: counts.submittedCount,
    approvedCount: counts.approvedCount,
    priorityScore,
    enteredAt: row.entered_at,
    status: row.status,
    completedAt: row.completed_at,
  };

  const syncActiveQueue = getQueue({ status: 'active' }, db);
  const syncActiveItem = syncActiveQueue.items ? syncActiveQueue.items.find((item) => item.student.id === studentId) : null;
  if (syncActiveItem) {
    Object.assign(fallback, syncActiveItem);
  }

  const asyncPromise = (async () => {
    const activeQueue = await getQueue({ status: 'active' }, db);
    const activeItem = activeQueue.items.find((item) => item.student.id === studentId);
    if (activeItem) {
      return activeItem;
    }

    const completedQueue = await getQueue({ status: 'completed' }, db);
    const completedItem = completedQueue.items.find((item) => item.student.id === studentId);
    if (completedItem) {
      return completedItem;
    }

    return fallback;
  })();

  Object.assign(asyncPromise, fallback);
  return asyncPromise;
}

/**
 * Triggered on task submission, review, approval, or correction.
 * Idempotently auto-enrolls trusted CAP-matched students and updates completion.
 */
function handleTaskUpdate(studentId, dbInstance) {
  const db = getDb(dbInstance);
  if (!studentId) return;

  try {
    const existing = db.prepare('SELECT id FROM admission_progress_queue WHERE student_id = ?').get(studentId);
    if (!existing && isTrustedCapMatched(studentId, db)) {
      enrollStudent(studentId, db);
    } else if (existing) {
      recomputeCompletion(studentId, db);
    }
    syncStudentToEngine(studentId, db).catch(() => {});
  } catch (_) {
    // Non-blocking safe update
  }
}

/**
 * Triggered on appointment scheduling, rescheduling, or status changes.
 */
function handleDeadlineUpdate(studentId, dbInstance) {
  const db = getDb(dbInstance);
  if (!studentId) return;

  try {
    const existing = db.prepare('SELECT id FROM admission_progress_queue WHERE student_id = ?').get(studentId);
    if (!existing && isTrustedCapMatched(studentId, db)) {
      enrollStudent(studentId, db);
    }
    syncStudentToEngine(studentId, db).catch(() => {});
  } catch (_) {
    // Non-blocking safe update
  }
}

/**
 * Safe, idempotent initialization and backfill for existing matched students.
 */
function initQueue(dbInstance) {
  const db = getDb(dbInstance);

  db.exec(`
    CREATE TABLE IF NOT EXISTS admission_progress_queue (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id      INTEGER NOT NULL UNIQUE REFERENCES students(id) ON DELETE CASCADE,
      admission_token TEXT    NOT NULL,
      entered_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
      completed_at    TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_progress_queue_status ON admission_progress_queue(status, entered_at);
  `);

  const candidates = db.prepare(`
    SELECT s.id, s.admission_token, s.created_at
      FROM students s
     WHERE s.admission_token IS NOT NULL
       AND (
         EXISTS (SELECT 1 FROM cap_details c WHERE c.student_id = s.id)
         OR EXISTS (SELECT 1 FROM cap_allotment_records r WHERE r.linked_student_id = s.id AND r.status = 'verified')
       )
     ORDER BY s.id ASC
  `).all();

  let backfilled = 0;
  const insertStmt = db.prepare(`
    INSERT INTO admission_progress_queue (student_id, admission_token, entered_at, status)
    VALUES (?, ?, ?, 'active')
    ON CONFLICT(student_id) DO NOTHING
  `);

  db.transaction(() => {
    for (const c of candidates) {
      const res = insertStmt.run(c.id, c.admission_token, c.created_at || new Date().toISOString());
      if (res.changes > 0) backfilled++;
      recomputeCompletion(c.id, db);
    }
  })();

  return backfilled;
}

function handleRoundDeadlineUpdate(capRound, dbInstance) {
  const db = getDb(dbInstance);
  // Recompute completion for students in this round
  if (!capRound) return;
  try {
    const students = db.prepare(`
      SELECT student_id FROM admission_progress_queue q
      WHERE EXISTS (SELECT 1 FROM cap_details c WHERE c.student_id = q.student_id AND c.cap_round = ?)
         OR EXISTS (SELECT 1 FROM cap_allotment_records r WHERE r.linked_student_id = q.student_id AND r.cap_round = ?)
    `).all(capRound, capRound);
    for (const s of students) {
      recomputeCompletion(s.student_id, db);
      syncStudentToEngine(s.student_id, db).catch(() => {});
    }
  } catch (_) {
    // Non-blocking safe update
  }
}

module.exports = {
  TOTAL_TASKS,
  WEIGHT_URGENCY,
  WEIGHT_PROGRESS,
  DEADLINE_HORIZON_DAYS,
  TASK_KEYS,
  isTrustedCapMatched,
  enrollStudent,
  getStudentTaskCounts,
  getStudentDeadline,
  calculateUrgency,
  calculatePriorityScore,
  recomputeCompletion,
  getQueue,
  getStudentQueueStatus,
  handleTaskUpdate,
  handleDeadlineUpdate,
  handleRoundDeadlineUpdate,
  initQueue,
  syncAllToEngine,
  syncStudentToEngine,
};
