/* Admin Admission-Progress Queue page:
 * Displays active students ranked by 60% deadline urgency + 40% approved-task progress.
 * Manages official CAP round deadlines with clear separation of seat-acceptance,
 * institute-reporting, and admission cutoff dates. */
(async function () {
  const esc = UI.esc;
  const loading = document.getElementById('loading');
  const root = document.getElementById('content');
  const admin = await Admin.requireAdmin('progress-queue.html', 'queue:view');
  if (!admin) { loading.classList.add('d-none'); return; }

  const canManageCap = Admin.can(admin, 'cap:manage');
  let activeTab = 'active'; // 'active' | 'completed' | 'deadlines'
  let queueData = null;
  let deadlinesData = [];
  let searchTerm = '';

  const API_QUEUE = '/api/admin/progress-queue';
  const API_DEADLINES = '/api/admin/cap/round-deadlines';

  async function loadData() {
    try {
      const [qRes, dRes] = await Promise.all([
        Api.get(`${API_QUEUE}?status=all`),
        Api.get(API_DEADLINES),
      ]);
      queueData = qRes.data || { items: [] };
      deadlinesData = dRes.data || [];
      render();
    } catch (err) {
      if (err.status === 401) { window.location.replace('login.html?expired=1'); return; }
      UI.showAlert('danger', err.message || 'Failed to load progress queue.');
    } finally {
      loading.classList.add('d-none');
      root.classList.remove('d-none');
    }
  }

  function getDaysDiff(deadline) {
    if (!deadline) return null;
    const today = new Date().toISOString().slice(0, 10);
    const msPerDay = 86400000;
    const dTime = new Date(`${deadline}T00:00:00Z`).getTime();
    const cTime = new Date(`${today}T00:00:00Z`).getTime();
    return Math.ceil((dTime - cTime) / msPerDay);
  }

  function formatDeadlineCell(item) {
    if (!item.deadline) {
      return `<div class="d-flex flex-column align-items-start">
        <span class="badge bg-secondary mb-1">Unavailable</span>
        <span class="text-muted small">Official schedule pending</span>
      </div>`;
    }
    const days = getDaysDiff(item.deadline);
    let badge = '';
    if (days !== null) {
      if (days < 0) {
        badge = `<span class="badge bg-danger ms-1">Overdue by ${Math.abs(days)}d</span>`;
      } else if (days === 0) {
        badge = '<span class="badge bg-danger ms-1">Due today</span>';
      } else if (days <= 3) {
        badge = `<span class="badge bg-warning text-dark ms-1">${days}d left</span>`;
      } else {
        badge = `<span class="badge bg-light text-dark border ms-1">${days}d left</span>`;
      }
    }
    return `<div>
      <span class="fw-semibold text-nowrap">${esc(UI.formatDay(item.deadline))}</span>
      ${badge}
      <div class="cell-sub text-muted">Reporting to Institute</div>
    </div>`;
  }

  function formatProgressCell(approvedCount) {
    const pct = Math.round((approvedCount / 6) * 100);
    return `<div style="min-width: 90px;">
      <div class="d-flex justify-content-between align-items-center small mb-1">
        <span class="fw-bold">${approvedCount} / 6</span>
        <span class="text-muted">${pct}%</span>
      </div>
      <div class="progress" style="height: 6px;">
        <div class="progress-bar bg-success" style="width: ${pct}%;"></div>
      </div>
    </div>`;
  }

  function renderQueueTable(items, isActive) {
    if (!items.length) {
      return `<div class="empty-state py-5">
        <p class="mb-1 fw-semibold">No students in this view</p>
        <p class="text-muted small">All trusted CAP-matched students automatically appear here when linked.</p>
      </div>`;
    }

    return `<div class="table-responsive">
      <table class="table admin-table align-middle mb-0">
        <thead>
          <tr>
            <th style="width: 80px;">${isActive ? 'Position' : 'Status'}</th>
            <th style="width: 100px;">Priority Score</th>
            <th style="width: 110px;">Token</th>
            <th>Student</th>
            <th style="width: 120px;">CAP Round</th>
            <th>Institute Reporting Deadline</th>
            <th style="width: 100px;">Submitted</th>
            <th style="width: 120px;">Approved</th>
          </tr>
        </thead>
        <tbody>
          ${items.map((item, idx) => {
            const studentId = (item.student && item.student.id) || item.studentId || item.id;
            const studentName = (item.student && item.student.fullName) || item.fullName || 'Student';
            const appId = (item.student && item.student.applicationId) || item.applicationId || '-';
            const email = (item.student && item.student.email) || item.email || '';
            const pos = (item.position !== undefined && item.position !== null && !Number.isNaN(Number(item.position)))
              ? Number(item.position)
              : (isActive ? (idx + 1) : null);
            const posBadge = isActive
              ? `<span class="pos-badge ${pos === 1 ? 'next' : ''}">#${pos}</span>`
              : '<span class="status-pill completed">Completed</span>';
            const studentUrl = `student.html?id=${encodeURIComponent(studentId)}`;

            return `
            <tr class="row-link" data-href="${studentUrl}" title="Open student profile">
              <td>
                ${posBadge}
              </td>
              <td>
                <span class="badge bg-primary fs-6 px-2 py-1" title="Priority Score: 60% urgency + 40% progress">
                  ${typeof item.priorityScore === 'number' ? item.priorityScore.toFixed(4) : (Number(item.priorityScore) || 0).toFixed(4)}
                </span>
              </td>
              <td>
                <span class="code-chip">${esc(item.token)}</span>
              </td>
              <td>
                <a href="${studentUrl}" class="fw-semibold text-decoration-none" title="Open student profile">
                  ${esc(studentName)}
                </a>
                <div class="cell-sub">
                  ${esc(appId)} &middot; ${esc(email)}
                </div>
              </td>
              <td>
                <span class="badge bg-light text-dark border">
                  ${esc(item.capRound || 'Unassigned')}
                </span>
              </td>
              <td>
                ${formatDeadlineCell(item)}
              </td>
              <td>
                <span class="badge bg-light text-dark border">
                  ${item.submittedCount} / 6
                </span>
              </td>
              <td>
                ${formatProgressCell(item.approvedCount)}
              </td>
            </tr>
          `;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  }

  function renderDeadlinesSection() {
    return `<div class="p-3">
      <div class="alert alert-light border mb-4">
        <h3 class="h6 fw-bold mb-1">CAP Round Official Deadlines Configuration</h3>
        <p class="small text-muted mb-0">
          Official deadlines are configured separately per round. The <strong>Institute Reporting Deadline</strong>
          drives queue urgency for the six-task admission workflow. Seat-acceptance (CAP portal) and overall admission cutoff dates
          are tracked separately and are not interchangeable. Dates are never invented; unannounced schedules are marked as unavailable.
        </p>
      </div>

      <div class="table-responsive">
        <table class="table admin-table align-middle">
          <thead>
            <tr>
              <th>CAP Round</th>
              <th>Seat Acceptance Deadline <div class="cell-sub text-muted">CAP Portal</div></th>
              <th class="table-primary text-primary fw-bold">
                Institute Reporting Deadline
                <span class="badge bg-primary text-white ms-1">Drives Queue</span>
              </th>
              <th>Admission Cutoff Date <div class="cell-sub text-muted">System-wide</div></th>
              <th>Status</th>
              <th>Official Notes</th>
              ${canManageCap ? '<th class="text-end">Action</th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${deadlinesData.map((d) => `
              <tr>
                <td class="fw-bold">${esc(d.capRound)}</td>
                <td>
                  ${d.seatAcceptanceDeadline
                    ? `<span class="fw-semibold">${esc(UI.formatDay(d.seatAcceptanceDeadline))}</span>`
                    : '<span class="text-muted small">Not Configured</span>'}
                </td>
                <td class="table-primary">
                  ${d.instituteReportingDeadline
                    ? `<span class="fw-bold text-primary">${esc(UI.formatDay(d.instituteReportingDeadline))}</span>`
                    : '<span class="badge bg-secondary">Unavailable (Not Announced)</span>'}
                </td>
                <td>
                  ${d.admissionCutoffDeadline
                    ? `<span>${esc(UI.formatDay(d.admissionCutoffDeadline))}</span>`
                    : '<span class="text-muted small">Not Configured</span>'}
                </td>
                <td>
                  ${d.isVerified
                    ? '<span class="status-pill completed">Verified</span>'
                    : '<span class="status-pill in_progress">Pending Notification</span>'}
                </td>
                <td class="small text-muted" style="max-width: 250px;">
                  ${esc(d.notes || '-')}
                </td>
                ${canManageCap ? `
                  <td class="text-end">
                    <button type="button" class="btn btn-outline-primary btn-sm" data-act="edit-deadline" data-round="${esc(d.capRound)}">
                      Configure
                    </button>
                  </td>` : ''}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  function openDeadlineModal(roundName) {
    const item = deadlinesData.find((d) => d.capRound === roundName) || { capRound: roundName };
    const m = Modal.open({ title: `Configure Official Deadlines: ${roundName}`, size: 'lg' });

    m.body.innerHTML = `
      <form id="deadline-form" novalidate>
        <div class="alert alert-info py-2 small mb-3">
          <strong>Important:</strong> Keep seat-acceptance, institute-reporting, and cutoff dates distinct.
          The <strong>Institute Reporting Deadline</strong> specifically drives admission queue urgency.
        </div>

        <div class="mb-3">
          <label class="form-label fw-semibold" for="dl-seat">Seat Acceptance Deadline (CAP Portal)</label>
          <input type="date" class="form-control" id="dl-seat" name="seatAcceptance" value="${esc(item.seatAcceptanceDeadline || '')}">
          <div class="form-text">Last date for candidate to accept seat online on the CAP portal.</div>
        </div>

        <div class="mb-3 p-3 bg-light rounded border border-primary">
          <label class="form-label fw-bold text-primary" for="dl-report">
            Institute Reporting & Confirmation Deadline (Relevant to 6-Task Workflow)
          </label>
          <input type="date" class="form-control fw-semibold" id="dl-report" name="instituteReporting" value="${esc(item.instituteReportingDeadline || '')}">
          <div class="form-text text-primary">
            Drives student queue urgency score. Leave empty if official dates have not been announced yet by the CET Cell.
          </div>
        </div>

        <div class="mb-3">
          <label class="form-label fw-semibold" for="dl-cutoff">Overall Admission Cutoff Date</label>
          <input type="date" class="form-control" id="dl-cutoff" name="admissionCutoff" value="${esc(item.admissionCutoffDeadline || '')}">
          <div class="form-text">System-wide final cutoff date after which no admission confirmation can be made.</div>
        </div>

        <div class="mb-3">
          <label class="form-label fw-semibold" for="dl-notes">Official CET Cell Notes / Reference</label>
          <textarea class="form-control" id="dl-notes" name="notes" rows="2" placeholder="e.g. Schedule as per CET Cell notification dated...">${esc(item.notes || '')}</textarea>
        </div>
      </form>
    `;

    m.footer.innerHTML = `
      <button type="button" class="btn btn-outline-secondary" data-act="cancel">Cancel</button>
      <button type="submit" class="btn btn-primary" form="deadline-form">Save Official Deadlines</button>
    `;

    m.footer.querySelector('[data-act=cancel]').addEventListener('click', () => m.close());
    const form = m.body.querySelector('form');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = m.footer.querySelector('[type=submit]');
      UI.setLoading(btn, true, 'Saving');
      m.setBusy(true);

      try {
        const payload = {
          seatAcceptanceDeadline: form.elements.seatAcceptance.value || null,
          instituteReportingDeadline: form.elements.instituteReporting.value || null,
          admissionCutoffDeadline: form.elements.admissionCutoff.value || null,
          notes: form.elements.notes.value.trim() || null,
          isVerified: Boolean(form.elements.instituteReporting.value),
        };

        await Api.put(`${API_DEADLINES}/${encodeURIComponent(roundName)}`, payload);
        m.setBusy(false);
        m.close();
        UI.showAlert('success', `Official deadlines for ${roundName} saved. Queue positions updated.`);
        await loadData();
      } catch (err) {
        m.setBusy(false);
        UI.setLoading(btn, false);
        UI.showAlertIn(m.alertArea, 'danger', err.message || 'Failed to save deadlines.');
      }
    });

    Modal.focusFirst(m);
  }

  function render() {
    const allItems = queueData.items || [];
    const activeItems = allItems.filter((i) => i.status === 'active');
    const completedItems = allItems.filter((i) => i.status === 'completed');

    let displayActive = activeItems;
    let displayCompleted = completedItems;

    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const match = (i) => (
        i.token.toLowerCase().includes(q) ||
        i.student.fullName.toLowerCase().includes(q) ||
        (i.student.applicationId && i.student.applicationId.toLowerCase().includes(q)) ||
        (i.capRound && i.capRound.toLowerCase().includes(q))
      );
      displayActive = displayActive.filter(match);
      displayCompleted = displayCompleted.filter(match);
    }

    // Stats
    const totalActive = activeItems.length;
    const totalCompleted = completedItems.length;

    root.innerHTML = `
      <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
        <div>
          <h1 class="page-title mb-1">Permanent Admission-Progress Queue</h1>
          <p class="text-muted mb-0">
            Tracks every trusted CAP-matched student through all 6 admission tasks. Ranked deterministically by
            <strong>60% official institute reporting deadline urgency + 40% approved-task progress</strong> with FIFO tie-breaking.
          </p>
        </div>
        <div class="d-flex gap-2">
          <button type="button" class="btn btn-outline-primary btn-sm" id="btn-refresh">
            Refresh Queue
          </button>
        </div>
      </div>

      <div class="row g-3 mb-4">
        <div class="col-sm-6">
          <div class="stat-card">
            <div class="num text-primary">${totalActive}</div>
            <div class="lbl">Active in Queue</div>
          </div>
        </div>
        <div class="col-sm-6">
          <div class="stat-card">
            <div class="num text-success">${totalCompleted}</div>
            <div class="lbl">Completed Admissions (6/6)</div>
          </div>
        </div>
      </div>

      <section class="panel mb-3">
        <div class="d-flex flex-wrap justify-content-between align-items-center gap-3">
          <div class="pill-tabs" role="tablist">
            <button type="button" class="pill-tab ${activeTab === 'active' ? 'active' : ''}" data-tab="active">
              Active Queue <span class="badge bg-secondary ms-1">${activeItems.length}</span>
            </button>
            <button type="button" class="pill-tab ${activeTab === 'completed' ? 'active' : ''}" data-tab="completed">
              Completed <span class="badge bg-secondary ms-1">${completedItems.length}</span>
            </button>
            <button type="button" class="pill-tab ${activeTab === 'deadlines' ? 'active' : ''}" data-tab="deadlines">
              CAP Round Deadlines <span class="badge bg-primary ms-1">${deadlinesData.length}</span>
            </button>
          </div>

          ${activeTab !== 'deadlines' ? `
            <div class="search" style="min-width: 280px;">
              <input type="search" class="form-control form-control-sm" id="queue-search"
                placeholder="Search token (AF-xxx), name, or ID" value="${esc(searchTerm)}">
            </div>
          ` : ''}
        </div>
      </section>

      <section class="panel table-panel mb-4" id="main-panel">
        ${activeTab === 'active' ? renderQueueTable(displayActive, true) : ''}
        ${activeTab === 'completed' ? renderQueueTable(displayCompleted, false) : ''}
        ${activeTab === 'deadlines' ? renderDeadlinesSection() : ''}
      </section>
    `;

    // Event listeners
    document.getElementById('btn-refresh').addEventListener('click', loadData);

    root.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = btn.getAttribute('data-tab');
        render();
      });
    });

    // Make student rows clickable to open profile
    root.querySelectorAll('tr.row-link').forEach((tr) => {
      tr.addEventListener('click', (event) => {
        if (event.target.closest('a, button, input, select, textarea, label')) return;
        if (tr.dataset.href) {
          window.location.href = tr.dataset.href;
        }
      });
    });

    const searchInput = document.getElementById('queue-search');
    if (searchInput) {
      searchInput.addEventListener('input', Admin.debounce(() => {
        searchTerm = searchInput.value.trim();
        render();
      }, 250));
    }

    root.querySelectorAll('[data-act="edit-deadline"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const roundName = btn.getAttribute('data-round');
        openDeadlineModal(roundName);
      });
    });
  }

  // Initial load
  loadData();
})();
