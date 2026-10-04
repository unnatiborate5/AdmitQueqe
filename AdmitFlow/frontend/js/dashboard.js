/* Student dashboard: CAP summary, progress tracker, task list. */
(async function () {
  const loading = document.getElementById('loading');
  const root = document.getElementById('dashboard-content');

  const student = await Auth.requireLogin('dashboard.html');
  if (!student) { loading.classList.add('d-none'); return; }

  function actionLabel(task) {
    if (task.key === 'cap_details') return task.status === 'completed' ? 'Edit details' : 'Enter CAP details';
    return 'Update status';
  }

  function renderTasks(tasks) {
    return `<ol class="task-list">${tasks.map((t, i) => `
      <li class="task-item">
        <span class="task-marker ${UI.esc(t.status)}" aria-hidden="true">${t.status === 'completed' ? '&#10003;' : i + 1}</span>
        <div class="task-body">
          <div class="d-flex flex-wrap justify-content-between align-items-center gap-2">
            <span class="task-title">${UI.esc(t.title)}</span>
            ${UI.statusPill(t.status, t.statusLabel)}
          </div>
          <p class="task-desc">${UI.esc(t.description)}</p>
          <a class="btn btn-sm btn-outline-primary" href="${UI.esc(t.link)}">${actionLabel(t)}</a>
        </div>
      </li>`).join('')}</ol>`;
  }

  function renderCap(cap) {
    if (!cap) {
      return `<h2 class="panel-title">CAP allotment</h2>
        <p class="text-muted mb-3">You have not entered your CAP details yet.</p>
        <a class="btn btn-primary btn-sm" href="cap-details.html">Enter CAP details</a>`;
    }
    return `<div class="d-flex justify-content-between align-items-start mb-2">
        <h2 class="panel-title mb-0">CAP allotment</h2>
        <a href="cap-details.html" class="small">Edit</a>
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
      <a class="btn btn-primary btn-sm" href="${UI.esc(next.link)}">${actionLabel(next)}</a>`;
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
          <a class="btn btn-primary btn-sm" href="cap-details.html">Enter CAP details</a></div>` : ''}

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
          <div class="manual-note"><strong>Original documents are verified in person.</strong> Visit your college for physical verification, then record the result in your checklist.</div>
        </div>
      </div>`;
  }

  try {
    const res = await Api.get('/api/dashboard');
    render(res.data);
    root.classList.remove('d-none');
  } catch (err) {
    if (err.status === 401) { window.location.replace('login.html?next=dashboard.html'); return; }
    UI.showAlert('danger', err.message);
  } finally {
    loading.classList.add('d-none');
  }
})();
