/* Admission checklist: view and update item status. */
(async function () {
  const loading = document.getElementById('loading');
  const root = document.getElementById('checklist-content');
  const ACTIVE_BTN = { pending: 'btn-secondary', in_progress: 'btn-warning', completed: 'btn-success' };
  let items = [];
  let progress = null;

  const student = await Auth.requireLogin('checklist.html');
  if (!student) { loading.classList.add('d-none'); return; }

  function renderItem(item) {
    const manual = item.key === 'physical_verification'
      ? `<div class="manual-note mb-3">Verification of original documents happens in person at the college. AdmitFlow does not verify anything. Update this after your visit.</div>`
      : '';
    const buttons = item.statusOptions.map((o) => `
      <button type="button" class="btn btn-sm ${o.value === item.status ? ACTIVE_BTN[o.value] : 'btn-outline-secondary'}"
              data-key="${UI.esc(item.key)}" data-status="${UI.esc(o.value)}"
              aria-pressed="${o.value === item.status}">${UI.esc(o.label)}</button>`).join('');
    return `
      <article class="check-item ${UI.esc(item.status)}" id="item-${UI.esc(item.key)}">
        <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-1">
          <h2 class="h5 mb-0">${UI.esc(item.title)}</h2>
          ${UI.statusPill(item.status, item.statusLabel)}
        </div>
        <p class="text-muted mb-3">${UI.esc(item.description)}</p>
        ${manual}
        <p class="guidance mb-3">${UI.esc(item.guidance)}</p>
        <div class="btn-group flex-wrap" role="group" aria-label="Status for ${UI.esc(item.title)}">${buttons}</div>
        ${item.updatedAt ? `<div class="text-muted small mt-2">Last updated ${UI.esc(UI.formatDate(item.updatedAt))}</div>` : ''}
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

  root.addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-key]');
    if (!btn || btn.getAttribute('aria-pressed') === 'true') return;
    UI.clearAlert();
    const group = btn.parentElement;
    group.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const res = await Api.patch(`/api/checklist/${encodeURIComponent(btn.dataset.key)}`, { status: btn.dataset.status });
      items = items.map((i) => (i.key === res.data.item.key ? res.data.item : i));
      progress = res.data.progress;
      render();
      UI.showAlert('success', res.message);
    } catch (err) {
      if (err.status === 401) { window.location.replace('login.html?next=checklist.html'); return; }
      group.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      UI.showAlert('danger', err.message);
    }
  });

  try {
    const res = await Api.get('/api/checklist');
    items = res.data.items;
    progress = res.data.progress;
    render();
    root.classList.remove('d-none');
  } catch (err) {
    if (err.status === 401) { window.location.replace('login.html?next=checklist.html'); return; }
    if (err.code === 'CAP_DETAILS_REQUIRED') {
      UI.showAlert('warning', err.message);
      root.innerHTML = '<a class="btn btn-primary" href="cap-details.html">Enter CAP details</a>';
      root.classList.remove('d-none');
    } else {
      UI.showAlert('danger', err.message);
    }
  } finally {
    loading.classList.add('d-none');
  }
})();
