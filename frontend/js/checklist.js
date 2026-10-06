/* Admission checklist: cards that open the same task windows as the dashboard. */
(async function () {
  const loading = document.getElementById('loading');
  const root = document.getElementById('checklist-content');
  let items = [];
  let progress = null;

  const student = await Auth.requireLogin('checklist.html');
  if (!student) { loading.classList.add('d-none'); return; }

  function actionLabel(item) {
    if (item.key === 'physical_verification') return 'View status';
    if (item.key === 'document_preparation') return 'Open document checklist';
    if (item.key === 'fee_payment') return 'Update payment status';
    return 'Update status';
  }

  function renderItem(item) {
    const manual = item.key === 'physical_verification'
      ? `<div class="manual-note mb-3">Verification of original documents happens in person at the college. Only the college can change this status.</div>`
      : '';
    return `
      <article class="check-item ${UI.esc(item.status)}" id="item-${UI.esc(item.key)}">
        <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-1">
          <h2 class="h5 mb-0">${UI.esc(item.title)}</h2>
          ${UI.statusPill(item.status, item.statusLabel)}
        </div>
        <p class="text-muted mb-2">${UI.esc(item.description)}</p>
        ${item.summary ? `<p class="task-summary mb-3">${UI.esc(item.summary)}</p>` : ''}
        ${manual}
        <p class="guidance mb-3">${UI.esc(item.guidance)}</p>
        <button type="button" class="btn btn-sm ${item.editable ? 'btn-primary' : 'btn-outline-primary'}" data-open-task="${UI.esc(item.key)}">${UI.esc(actionLabel(item))}</button>
        ${item.updatedAt ? `<span class="text-muted small ms-2">Last updated ${UI.esc(UI.formatDate(item.updatedAt))}</span>` : ''}
      </article>`;
  }

  function render() {
    const statuses = ['completed', ...items.map((i) => i.status)]; // CAP details are already done
    root.innerHTML = `
      <section class="panel mb-4" aria-label="Progress">
        <div class="d-flex flex-wrap justify-content-between align-items-baseline gap-2 mb-3">
          <h2 class="panel-title mb-0">${progress.completed} of ${progress.total} tasks complete</h2>
          <a href="dashboard.html" class="small">View dashboard</a>
        </div>
        ${UI.segmentedBar(statuses)}
      </section>
      ${items.map(renderItem).join('')}`;
  }

  root.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-open-task]');
    if (!trigger) return;
    Tasks.open(trigger.dataset.openTask, {
      studentName: student.fullName,
      onSaved: (message) => { refresh(message); },
    });
  });

  async function refresh(message) {
    try {
      const res = await Api.get('/api/checklist');
      items = res.data.items;
      progress = res.data.progress;
      render();
      root.classList.remove('d-none');
      if (message) UI.showAlert('success', message); else UI.clearAlert();
    } catch (err) {
      if (err.status === 401) { window.location.replace('login.html?next=checklist.html'); return; }
      if (err.code === 'CAP_DETAILS_REQUIRED') {
        UI.showAlert('warning', err.message);
        root.innerHTML = '<button type="button" class="btn btn-primary" data-open-task="cap_details">Enter CAP details</button>';
        root.classList.remove('d-none');
      } else {
        UI.showAlert('danger', err.message);
      }
    } finally {
      loading.classList.add('d-none');
    }
  }

  refresh();
})();
