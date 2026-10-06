/* Student dashboard: CAP summary, progress tracker, task list. */
(async function () {
  const loading = document.getElementById('loading');
  const root = document.getElementById('dashboard-content');

  const student = await Auth.requireLogin('dashboard.html');
  if (!student) { loading.classList.add('d-none'); return; }

  function actionLabel(task) {
    switch (task.key) {
      case 'cap_details': return task.status === 'completed' ? 'Edit details' : 'Enter CAP details';
      case 'document_preparation': return 'Open document checklist';
      case 'physical_verification': return 'View status';
      case 'fee_payment': return 'Update payment status';
      default: return 'Update status';
    }
  }

  const openTask = (key) => Tasks.open(key, {
    studentName: student.fullName,
    onSaved: (message) => { refresh(message); },
  });

  function renderTasks(tasks) {
    return `<ol class="task-list">${tasks.map((t, i) => `
      <li class="task-item">
        <button type="button" class="task-open" data-open-task="${UI.esc(t.key)}" aria-label="${UI.esc(t.title)}: ${UI.esc(t.statusLabel)}. ${UI.esc(actionLabel(t))}">
          <span class="task-marker ${UI.esc(t.status)}" aria-hidden="true">${t.status === 'completed' ? '&#10003;' : i + 1}</span>
          <span class="task-body">
            <span class="task-head">
              <span class="task-title">${UI.esc(t.title)}</span>
              ${UI.statusPill(t.status, t.statusLabel)}
            </span>
            <span class="task-desc">${UI.esc(t.description)}</span>
            ${t.summary ? `<span class="task-summary">${UI.esc(t.summary)}</span>` : ''}
            <span class="task-action">${UI.esc(actionLabel(t))} <span aria-hidden="true">&rsaquo;</span></span>
          </span>
        </button>
      </li>`).join('')}</ol>`;
  }

  function renderCap(cap) {
    if (!cap) {
      return `<h2 class="panel-title">CAP allotment</h2>
        <p class="text-muted mb-3">You have not entered your CAP details yet.</p>
        <button type="button" class="btn btn-primary btn-sm" data-open-task="cap_details">Enter CAP details</button>`;
    }
    return `<div class="d-flex justify-content-between align-items-start mb-2">
        <h2 class="panel-title mb-0">CAP allotment</h2>
        <button type="button" class="btn btn-link btn-sm p-0" data-open-task="cap_details">Edit</button>
      </div>
      <dl class="cap-summary mt-3">
        <dt>Allotted college</dt><dd>${UI.esc(cap.allottedCollege)}</dd>
        <dt>Course / branch</dt><dd>${UI.esc(cap.courseBranch)}</dd>
        <dt>CAP round</dt><dd>${UI.esc(cap.capRound)}</dd>
        <dt>Allotment status</dt><dd>${UI.esc(cap.allotmentStatus)}</dd>
        <dt>Application ID</dt><dd>${UI.esc(cap.applicationId)}</dd>
        <dt>Student name</dt><dd class="mb-0">${UI.esc(cap.studentName)}</dd>
      </dl>`;
  }

  function renderNext(next, allDone) {
    if (!next) {
      return `<h2 class="panel-title">Next step</h2>
        <p class="mb-0 text-muted">${allDone ? 'Every task is complete. Your admission process is done.' : ''}</p>`;
    }
    return `<h2 class="panel-title">Next required step</h2>
      <p class="fw-semibold mb-1">${UI.esc(next.title)}</p>
      <p class="text-muted small">${UI.esc(next.guidance)}</p>
      <button type="button" class="btn btn-primary btn-sm" data-open-task="${UI.esc(next.key)}">${UI.esc(actionLabel(next))}</button>`;
  }

  const REVIEW_NOTE = {
    approved: ['success', 'Your application has been approved'],
    rejected: ['danger', 'Your application was rejected'],
    correction_requested: ['warning', 'The college asked you to make corrections'],
  };

  /** Banner shown only once the college has made a decision. */
  function renderReviewBanner(app) {
    if (!app || !REVIEW_NOTE[app.status]) return '';
    const [kind, title] = REVIEW_NOTE[app.status];
    return `<div class="alert alert-${kind}" role="${kind === 'success' ? 'status' : 'alert'}">
        <div class="fw-bold">${UI.esc(title)}</div>
        ${app.remarks ? `<div class="pre-line mt-1">${UI.esc(app.remarks)}</div>` : ''}
        ${app.canResubmit ? '<button type="button" class="btn btn-primary btn-sm mt-2" data-resubmit>I have made the corrections</button>' : ''}
      </div>`;
  }

  function renderReviewPanel(app) {
    if (!app) return '';
    const note = { pending: 'The college has not reviewed your application yet.', approved: 'The college approved your application.', rejected: 'The college rejected your application.', correction_requested: 'Please fix what the college asked for, then press "I have made the corrections".' }[app.status];
    return `<div class="d-flex justify-content-between align-items-center mb-2">
        <h2 class="panel-title mb-0">College review</h2>${UI.statusPill(app.status, app.label)}</div>
      <p class="text-muted small mb-0">${UI.esc(note)}</p>
      ${app.history.length ? `<ul class="review-history mt-2">${app.history.slice(0, 4).map((h) => `<li><span class="fw-semibold">${UI.esc(h.label)}</span> <span class="text-muted">&middot; ${UI.esc(h.by)}, ${UI.esc(UI.formatDate(h.createdAt))}</span>${h.remarks ? `<div class="pre-line text-muted">${UI.esc(h.remarks)}</div>` : ''}</li>`).join('')}</ul>` : ''}`;
  }

  function renderAppointment(a) {
    if (!a) {
      return `<h2 class="panel-title">Verification appointment</h2>
        <p class="text-muted small mb-0">No appointment yet. When the college schedules your in-person document verification, the date, time and venue will appear here.</p>`;
    }
    return `<div class="d-flex justify-content-between align-items-center mb-2">
        <h2 class="panel-title mb-0">Verification appointment</h2>${UI.statusPill(a.status, a.statusLabel)}</div>
      <dl class="cap-summary mb-0">
        <dt>Date and time</dt><dd>${UI.esc(UI.formatDay(a.date))}, ${UI.esc(UI.formatClock(a.time))}</dd>
        <dt>Venue</dt><dd>${UI.esc(a.venue)}</dd>
        ${a.instructions ? `<dt>Instructions</dt><dd class="pre-line">${UI.esc(a.instructions)}</dd>` : ''}
        ${a.note ? `<dt>${a.status === 'scheduled' ? 'Rescheduled because' : 'Note from the college'}</dt><dd class="pre-line">${UI.esc(a.note)}</dd>` : ''}
      </dl>
      ${a.status === 'missed' ? '<p class="small text-muted mt-2 mb-0">The college marked this appointment as missed. They will contact you to arrange a new date.</p>' : ''}`;
  }

  function openResubmit() {
    const m = Modal.open({ title: 'Corrections done?' });
    m.body.innerHTML = `<form id="resubmit-form" novalidate>
      <p>This puts your application back in the college review queue.</p>
      <div class="mb-1"><label class="form-label fw-semibold" for="rs-note">Note for the college (optional)</label>
        <textarea class="form-control" id="rs-note" name="note" rows="3" maxlength="300"></textarea><div class="invalid-feedback"></div></div></form>`;
    m.footer.innerHTML = '<button type="button" class="btn btn-outline-secondary" data-act="cancel">Cancel</button><button type="submit" class="btn btn-primary" form="resubmit-form">Send for review</button>';
    m.footer.querySelector('[data-act=cancel]').addEventListener('click', () => m.close());
    const form = m.body.querySelector('form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      UI.clearFieldErrors(form);
      const btn = m.footer.querySelector('[type=submit]');
      UI.setLoading(btn, true, 'Sending');
      m.setBusy(true);
      try {
        const res = await Api.post('/api/application/resubmit', { note: form.elements.note.value });
        m.setBusy(false); m.close();
        refresh(res.message);
      } catch (err) {
        m.setBusy(false); UI.setLoading(btn, false);
        UI.setFieldErrors(form, err.errors);
        UI.showAlertIn(m.alertArea, 'danger', err.message);
      }
    });
    Modal.focusFirst(m);
  }

  function overallClass(d) {
    if (d.application && d.application.status === 'approved') return 'approved';
    if (d.application && d.application.status === 'rejected') return 'rejected';
    return isComplete(d) ? 'completed' : (d.cap ? 'in_progress' : 'pending');
  }
  const isComplete = (d) => d.progress.completed === d.progress.total;

  // ---------- Phase 4: verification queue token ----------
  let queueState = null;

  function renderQueue(q) {
    if (!q || (!q.token && !q.appointmentToday)) return '';
    const t = q.token;
    if (!t) {
      return `<h2 class="panel-title">Verification queue</h2>
        <p class="mb-0 small">Your verification appointment is today at ${UI.esc(UI.formatClock(q.appointmentToday.time))}, ${UI.esc(q.appointmentToday.venue)}. When you arrive, the verification desk will check you in and give you a token. Your token and queue position will appear here.</p>`;
    }
    return `<div class="token-card ${UI.esc(t.status)}">
        <div class="small fw-bold text-muted text-uppercase">Your token</div>
        <div class="token-code">${UI.esc(t.code)}</div>
        <div class="my-2">${UI.statusPill(t.status, t.statusLabel)} ${t.priority ? `<span class="priority-tag" title="${UI.esc(t.priorityReason)}">Priority</span>` : ''}</div>
        ${t.status === 'waiting' && t.position ? `<div class="token-position">Position ${t.position} &middot; ${t.ahead} ahead of you</div>` : ''}
        ${t.counter && (t.status === 'called' || t.status === 'serving') ? `<div class="token-position">${UI.esc(t.counter)}</div>` : ''}
        <p class="small ${t.status === 'called' ? 'fw-bold' : 'text-muted'} mt-2 mb-0">${UI.esc(t.message)}</p>
        ${t.priority && t.priorityReason ? `<p class="small text-muted mb-0 mt-1">Priority reason: ${UI.esc(t.priorityReason)}</p>` : ''}
        ${t.active ? '<p class="small text-muted mb-0 mt-2">This updates automatically.</p>' : ''}
      </div>`;
  }

  /** Re-draws only the token card; polls every 10 s while a token is active or today's appointment is waiting for check-in. */
  function paintQueue() {
    const box = document.getElementById('queue-panel');
    if (!box) return;
    const html = renderQueue(queueState);
    box.innerHTML = html;
    box.classList.toggle('d-none', !html);
  }

  async function pollQueue() {
    if (document.hidden || Modal.isOpen()) return;
    const q = queueState;
    if (!q || !(q.appointmentToday || (q.token && q.token.active))) return;
    try {
      queueState = (await Api.get('/api/queue/my-token')).data.queue;
      paintQueue();
    } catch (err) {
      if (err.status === 401) window.location.replace('login.html?next=dashboard.html');
    }
  }
  setInterval(pollQueue, 10000);

  function render(d) {
    queueState = d.queue || null;
    const firstName = String(d.student.fullName).split(' ')[0];
    const p = d.progress;
    root.innerHTML = `
      <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-4">
        <div>
          <h1 class="page-title mb-1">Welcome, ${UI.esc(firstName)}</h1>
          <p class="text-muted mb-0">Your admission progress after CAP allotment.</p>
        </div>
        <span class="status-pill ${overallClass(d)} fs-6">${UI.esc(d.overallStatus)}</span>
      </div>

      ${d.warning ? `<div class="alert alert-warning" role="alert">${UI.esc(d.warning)}</div>` : ''}
      ${renderReviewBanner(d.application)}
      ${!d.cap ? `<div class="alert alert-info d-flex flex-wrap justify-content-between align-items-center gap-2" role="status">
          <span>Start by entering your CAP details so we can set up your checklist.</span>
          <button type="button" class="btn btn-primary btn-sm" data-open-task="cap_details">Enter CAP details</button></div>` : ''}

      <section class="panel mb-4" aria-label="Progress tracker">
        <div class="d-flex flex-wrap justify-content-between align-items-baseline gap-2 mb-3">
          <h2 class="panel-title mb-0">${p.completed} of ${p.total} tasks complete</h2>
          <span class="fw-bold">${p.percent}%</span>
        </div>
        ${UI.segmentedBar(d.tasks.map((t) => t.status))}
        <div class="stat-row mt-4">
          <div class="stat completed"><div class="num">${p.completed}</div><div class="lbl">Completed</div></div>
          <div class="stat in_progress"><div class="num">${p.inProgress}</div><div class="lbl">In progress</div></div>
          <div class="stat"><div class="num">${p.pending}</div><div class="lbl">Pending</div></div>
          <div class="stat"><div class="num">${p.remaining}</div><div class="lbl">Required tasks left</div></div>
        </div>
      </section>

      <div class="row g-4">
        <div class="col-lg-7">
          <section class="panel" aria-label="Admission tasks">
            <h2 class="panel-title mb-3">Admission tasks</h2>
            ${renderTasks(d.tasks)}
          </section>
        </div>
        <div class="col-lg-5">
          <section class="panel mb-4 ${renderQueue(d.queue) ? '' : 'd-none'}" id="queue-panel" aria-label="Verification queue" aria-live="polite">${renderQueue(d.queue)}</section>
          <section class="panel mb-4">${renderNext(d.nextStep, p.completed === p.total)}</section>
          ${d.application ? `<section class="panel mb-4" aria-label="College review">${renderReviewPanel(d.application)}</section>` : ''}
          ${d.cap ? `<section class="panel mb-4" aria-label="Verification appointment">${renderAppointment(d.appointment)}</section>` : ''}
          <section class="panel mb-4">${renderCap(d.cap)}</section>
          <div class="manual-note"><strong>Original documents are verified in person.</strong> Visit your college for physical verification. The college records the result, and it appears here automatically.</div>
        </div>
      </div>`;
  }

  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-resubmit]')) { openResubmit(); return; }
    const trigger = event.target.closest('[data-open-task]');
    if (trigger) openTask(trigger.dataset.openTask);
  });

  /** Loads (or reloads) the dashboard. `message` is shown as a success notice after a save. */
  async function refresh(message) {
    try {
      const res = await Api.get('/api/dashboard');
      render(res.data);
      root.classList.remove('d-none');
      if (message) UI.showAlert('success', message); else UI.clearAlert();
    } catch (err) {
      if (err.status === 401) { window.location.replace('login.html?next=dashboard.html'); return; }
      UI.showAlert('danger', err.message);
    } finally {
      loading.classList.add('d-none');
    }
  }

  refresh();
})();
