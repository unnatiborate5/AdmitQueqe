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

  function render(d) {
    const firstName = String(d.student.fullName).split(' ')[0];
    const p = d.progress;
    root.innerHTML = `
      <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-4">
        <div>
          <h1 class="page-title mb-1">Welcome, ${UI.esc(firstName)}</h1>
          <p class="text-muted mb-0">Your admission progress after CAP allotment.</p>
        </div>
        <span class="status-pill ${p.completed === p.total ? 'completed' : (d.cap ? 'in_progress' : 'pending')} fs-6">${UI.esc(d.overallStatus)}</span>
      </div>

      ${d.warning ? `<div class="alert alert-warning" role="alert">${UI.esc(d.warning)}</div>` : ''}
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
          <section class="panel mb-4">${renderNext(d.nextStep, p.completed === p.total)}</section>
          <section class="panel mb-4">${renderCap(d.cap)}</section>
          <div class="manual-note"><strong>Original documents are verified in person.</strong> Visit your college for physical verification. The college records the result, and it appears here automatically.</div>
        </div>
      </div>`;
  }

  root.addEventListener('click', (event) => {
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
