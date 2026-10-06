/* Admin queue page: counters, waiting lanes, check-in, token actions, lookup. Refreshes itself every 10 seconds. */
(async function () {
  const esc = UI.esc;
  const loading = document.getElementById('loading');
  const root = document.getElementById('content');
  const admin = await Admin.requireAdmin('queue.html', 'queue:view');
  if (!admin) { loading.classList.add('d-none'); return; }

  const canOperate = Admin.can(admin, 'queue:operate');
  const canConfigure = Admin.can(admin, 'queue:configure');
  const API = '/api/admin/queue';
  let data = null;
  let built = false;
  let busy = false;
  let lookupHtml = '';
  let eligibleTerm = '';
  let eligibleHtml = '';

  const when = (ts) => (ts ? UI.formatDate(ts) : '-');
  const studentLink = (t) => `<a href="student.html?id=${t.student.id}" class="fw-semibold text-decoration-none">${esc(t.student.name)}</a>`;
  const level = (t) => (t.level < 3 ? `<span class="priority-tag" title="${esc(t.priorityReason)}">Priority ${t.level}</span>` : '<span class="text-muted small">Regular</span>');

  // ---------------- rendering ----------------
  function counterCard(c) {
    const t = c.token;
    let body;
    if (t) {
      body = `<div class="d-flex justify-content-between align-items-start"><span class="big-code">${esc(t.code)}</span>${Admin.tokenPill(t.status)}</div>
        <div>${studentLink(t)}<div class="cell-sub">${esc(t.applicationId)} &middot; ${level(t)}</div></div>`;
    } else {
      body = `<div class="text-muted">${c.isOpen ? 'Free. Ready to call the next student.' : 'Closed.'}</div>`;
    }
    const buttons = [];
    if (canOperate) {
      if (!t && c.isOpen) buttons.push(`<button class="btn btn-primary btn-sm" data-act="call" data-counter="${c.id}">Call next</button>`);
      if (t && t.status === 'called') {
        buttons.push(`<button class="btn btn-primary btn-sm" data-act="start" data-token="${t.id}">Student arrived: start</button>`);
        buttons.push(`<button class="btn btn-outline-danger btn-sm" data-act="noshow" data-token="${t.id}">No-show</button>`);
      }
      if (t && t.status === 'serving') {
        buttons.push(`<button class="btn btn-primary btn-sm" data-act="complete" data-token="${t.id}">Complete</button>`);
        buttons.push(`<a class="btn btn-outline-primary btn-sm" href="student.html?id=${t.student.id}">Record outcome</a>`);
      }
      if (!(t && t.status === 'serving')) buttons.push(`<button class="btn btn-outline-secondary btn-sm" data-act="toggle" data-counter="${c.id}" data-open="${c.isOpen ? 0 : 1}">${c.isOpen ? 'Close counter' : 'Open counter'}</button>`);
    }
    return `<div class="col-md-6 col-xl-4"><div class="counter-card ${c.isOpen ? '' : 'closed'} ${t ? 'busy' : ''}">
      <div class="d-flex justify-content-between align-items-center"><strong>${esc(c.name)}</strong>
        <span class="status-pill ${c.isOpen ? 'completed' : 'not_started'}">${c.isOpen ? 'Open' : 'Closed'}</span></div>
      ${body}${buttons.length ? `<div class="action-bar mt-auto pt-1">${buttons.join('')}</div>` : ''}</div></div>`;
  }

  function laneTable(title, tokens, empty) {
    return `<section class="panel table-panel h-100"><div class="lane-title"><span>${esc(title)}</span><span class="text-muted fw-semibold">${tokens.length} waiting</span></div>
      ${tokens.length ? `<div class="table-responsive"><table class="table admin-table align-middle"><thead><tr><th>Call order</th><th>Token</th><th>Student</th><th>Waiting since</th>${canOperate ? '<th></th>' : ''}</tr></thead><tbody>
        ${tokens.map((t) => `<tr><td><span class="pos-badge ${t.position === 1 ? 'next' : ''}" title="${t.ahead} ahead">${t.position}</span></td>
          <td><span class="code-chip">${esc(t.code)}</span></td>
          <td>${studentLink(t)}<div class="cell-sub">${esc(t.applicationId)}${t.level < 3 ? ` &middot; ${esc(t.priorityReason)}` : ''}</div></td>
          <td class="small text-nowrap">${esc(when(t.createdAt))}</td>
          ${canOperate ? `<td class="text-end"><button class="btn btn-outline-danger btn-sm" data-act="cancel" data-token="${t.id}">Remove</button></td>` : ''}</tr>`).join('')}
      </tbody></table></div>` : `<div class="empty-state py-4">${esc(empty)}</div>`}</section>`;
  }

  function finishedTable(list) {
    if (!list.length) return '<div class="empty-state py-4">No finished tokens yet today.</div>';
    return `<div class="table-responsive"><table class="table admin-table align-middle"><thead><tr><th>Token</th><th>Student</th><th>Result</th><th>Counter</th><th>Issued</th><th>Finished</th></tr></thead><tbody>
      ${list.map((t) => `<tr><td><span class="code-chip">${esc(t.code)}</span></td><td>${studentLink(t)}</td>
        <td>${Admin.tokenPill(t.status)}${t.finishReason ? `<div class="cell-sub">${esc(t.finishReason)}</div>` : ''}</td>
        <td>${esc(t.counter ? t.counter.name : '-')}</td><td class="small">${esc(when(t.createdAt))}</td><td class="small">${esc(when(t.finishedAt))}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function policyPanel(p) {
    return `<section class="panel"><h2 class="panel-title">How the queue decides who is next</h2>
      <div class="table-responsive"><table class="table admin-table"><thead><tr><th>Level</th><th>Lane</th><th>Who</th></tr></thead><tbody>
        ${p.levels.map((l) => `<tr><td><strong>${l.level}</strong> ${esc(l.title)}</td><td>${l.lane === 'priority' ? 'Priority (heap)' : 'Regular (FIFO)'}</td><td>${esc(l.rule)}</td></tr>`).join('')}</tbody></table></div>
      <ul class="small mb-0">${p.fairness.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></section>`;
  }

  function stat(label, value, cls) {
    return `<div class="col-6 col-md"><div class="stat-card ${cls || ''}"><div class="num">${value}</div><div class="lbl">${esc(label)}</div></div></div>`;
  }

  function build() {
    root.innerHTML = `
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <div><h1 class="page-title mb-1">Verification queue</h1>
          <p class="text-muted mb-0" id="q-sub"></p></div>
        <div class="d-flex gap-2">
          ${canConfigure ? '<button type="button" class="btn btn-outline-primary" data-act="add-counter">Add counter</button>' : ''}
          <button type="button" class="btn btn-outline-primary" data-act="refresh">Refresh</button></div>
      </div>
      <div class="row g-3 mb-4" id="q-stats"></div>
      <h2 class="h5 fw-bold mb-2">Counters</h2>
      <div class="row g-3 mb-4" id="q-counters"></div>
      <div class="row g-4 mb-4">
        ${canOperate ? `<div class="col-lg-6"><section class="panel h-100"><h2 class="panel-title">Check in a student</h2>
          <p class="small text-muted">Students with a verification appointment today. Issuing a token puts them in the queue.</p>
          <input type="search" class="form-control mb-2" id="q-eligible-search" placeholder="Search name, email or application ID" maxlength="60" autocomplete="off">
          <div id="q-eligible"></div></section></div>` : ''}
        <div class="${canOperate ? 'col-lg-6' : 'col-12'}"><section class="panel h-100"><h2 class="panel-title">Find a token</h2>
          <form id="q-lookup-form" class="d-flex gap-2 mb-2"><input class="form-control" id="q-lookup" placeholder="Token code (R012) or application ID" maxlength="30" autocomplete="off"><button class="btn btn-primary" type="submit">Find</button></form>
          <div id="q-lookup-out"></div></section></div>
      </div>
      <h2 class="h5 fw-bold mb-2">Waiting (in the order they will be called)</h2>
      <div class="row g-3 mb-4" id="q-lanes"></div>
      <h2 class="h5 fw-bold mb-2">Finished today</h2>
      <section class="panel table-panel mb-4" id="q-finished"></section>
      <div id="q-policy"></div>`;
    built = true;
    const search = document.getElementById('q-eligible-search');
    if (search) {
      search.addEventListener('input', Admin.debounce(() => { eligibleTerm = search.value.trim(); loadEligible(); }, 250));
    }
    document.getElementById('q-lookup-form').addEventListener('submit', onLookup);
  }

  function render() {
    if (!built) build();
    const s = data.stats;
    document.getElementById('q-sub').textContent = `${UI.formatDay(data.date)} - updates automatically every 10 seconds`;
    document.getElementById('q-stats').innerHTML = [
      stat('Waiting', s.waiting, 'pending'), stat('Priority lane', s.priorityWaiting), stat('At counters', s.called + s.serving, 'verification'),
      stat('Served', s.completed, 'approved'), stat('No-show / cancelled', `${s.noShow} / ${s.cancelled}`, 'rejected'),
    ].join('');
    document.getElementById('q-counters').innerHTML = data.counters.map(counterCard).join('');
    const pri = data.waiting.filter((t) => t.lane === 'priority');
    const reg = data.waiting.filter((t) => t.lane === 'regular');
    document.getElementById('q-lanes').innerHTML =
      `<div class="col-lg-6">${laneTable('Priority lane', pri, 'No priority students waiting.')}</div><div class="col-lg-6">${laneTable('Regular lane (first come, first served)', reg, 'No regular students waiting.')}</div>`;
    document.getElementById('q-finished').innerHTML = finishedTable(data.finished);
    document.getElementById('q-policy').innerHTML = policyPanel(data.policy);
    document.getElementById('q-lookup-out').innerHTML = lookupHtml;
  }

  async function loadEligible() {
    const box = document.getElementById('q-eligible');
    if (!box) return;
    try {
      const list = (await Api.get(`${API}/eligible?search=${encodeURIComponent(eligibleTerm)}`)).data.students;
      eligibleHtml = list.length ? list.map((s) => `<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 py-2 border-top">
          <div><a class="fw-semibold text-decoration-none" href="student.html?id=${s.id}">${esc(s.name)}</a>
            <div class="cell-sub">${esc(s.applicationId)} &middot; appointment ${esc(UI.formatClock(s.appointmentTime))} &middot; ${s.level < 3 ? `<span class="priority-tag">Priority ${s.level}</span> ${esc(s.priorityReason)}` : 'Regular'}</div></div>
          <button class="btn btn-primary btn-sm" data-act="check-in" data-student="${s.id}">Issue token</button></div>`).join('')
        : '<div class="text-muted small">Nobody left to check in. Students need a scheduled appointment today and no active token.</div>';
      box.innerHTML = eligibleHtml;
    } catch (err) { Admin.handleError(err); }
  }

  async function load(initial) {
    if (busy || (Modal.isOpen() && !initial)) return;
    busy = true;
    try {
      data = (await Api.get(API)).data;
      render();
      if (canOperate) loadEligible();
      root.classList.remove('d-none');
    } catch (err) {
      if (err.status === 503) UI.showAlert('danger', err.message); else Admin.handleError(err);
    } finally { busy = false; loading.classList.add('d-none'); }
  }

  // ---------------- actions ----------------
  async function run(request, okMessage) {
    UI.clearAlert();
    try {
      const res = await request();
      UI.showAlert('success', okMessage ? okMessage(res) : res.message);
    } catch (err) { Admin.handleError(err); }
    busy = false;
    await load(true);
  }

  function noteDialog({ title, intro, label, confirm, danger, request, message }) {
    const m = Modal.open({ title });
    m.body.innerHTML = `<form id="q-note-form" novalidate><p>${intro}</p><div class="mb-1"><label class="form-label fw-semibold" for="q-note">${esc(label)}</label>
      <textarea class="form-control" id="q-note" name="note" rows="2" maxlength="200"></textarea><div class="invalid-feedback"></div></div></form>`;
    m.footer.innerHTML = `<button type="button" class="btn btn-outline-secondary" data-x="cancel">Cancel</button><button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" form="q-note-form">${esc(confirm)}</button>`;
    m.footer.querySelector('[data-x=cancel]').addEventListener('click', () => m.close());
    m.body.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const note = m.body.querySelector('#q-note').value;
      m.close();
      await run(() => request(note), message);
    });
    Modal.focusFirst(m);
  }

  function tokenOf(id) {
    return [...data.waiting, ...data.counters.map((c) => c.token).filter(Boolean)].find((t) => t.id === Number(id));
  }

  function addCounterDialog() {
    const m = Modal.open({ title: 'Add a counter' });
    m.body.innerHTML = '<form id="q-counter-form" novalidate><div class="mb-1"><label class="form-label fw-semibold" for="q-cname">Counter name</label><input class="form-control" id="q-cname" name="name" maxlength="40" placeholder="e.g. Counter 3" required><div class="invalid-feedback"></div></div></form>';
    m.footer.innerHTML = '<button type="button" class="btn btn-outline-secondary" data-x="cancel">Cancel</button><button type="submit" class="btn btn-primary" form="q-counter-form">Add counter</button>';
    m.footer.querySelector('[data-x=cancel]').addEventListener('click', () => m.close());
    const form = m.body.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      UI.clearFieldErrors(form);
      try { const res = await Api.post(`${API}/counters`, { name: form.elements.name.value }); m.close(); UI.showAlert('success', res.message); await load(true); }
      catch (err) { UI.setFieldErrors(form, err.errors); UI.showAlertIn(m.alertArea, 'danger', err.message); }
    });
    Modal.focusFirst(m);
  }

  async function onLookup(e) {
    e.preventDefault();
    const v = document.getElementById('q-lookup').value.trim();
    const out = document.getElementById('q-lookup-out');
    if (!v) return;
    const param = /^[A-Za-z]\d{3,6}$/.test(v) && /^[PRpr]/.test(v) ? 'token' : 'applicationId';
    try {
      const { token: t, source } = (await Api.get(`${API}/lookup?${param}=${encodeURIComponent(v)}`)).data;
      lookupHtml = `<div class="lookup-result"><div class="d-flex justify-content-between align-items-start"><span class="big-code code-chip fs-4">${esc(t.code)}</span>${Admin.tokenPill(t.status)}</div>
        <div>${studentLink(t)} <span class="text-muted small">${esc(t.applicationId)}</span></div>
        <div class="small mt-1">${t.position ? `Position <strong>${t.position}</strong> (${t.ahead} ahead)` : ''}${t.counter ? ` &middot; ${esc(t.counter.name)}` : ''} &middot; ${level(t)}</div>
        ${t.finishReason ? `<div class="small text-muted">${esc(t.finishReason)}</div>` : ''}<div class="cell-sub mt-1">Found via ${source === 'engine' ? 'the live queue (hash-map lookup)' : "today's records"}.</div></div>`;
    } catch (err) {
      lookupHtml = `<div class="alert alert-warning mb-0">${esc(err.message)}</div>`;
      if (err.status === 401) { Admin.handleError(err); return; }
    }
    out.innerHTML = lookupHtml;
  }

  root.addEventListener('click', (event) => {
    const b = event.target.closest('[data-act]');
    if (!b || !data) return;
    const act = b.dataset.act;
    if (act === 'refresh') { load(true); return; }
    if (act === 'add-counter') { addCounterDialog(); return; }
    if (act === 'check-in') { b.disabled = true; run(() => Api.post(`${API}/check-in`, { studentId: Number(b.dataset.student) }), (r) => `Token ${r.data.token.code} issued${r.data.token.position ? `. Queue position ${r.data.token.position}` : ''}.`); return; }
    if (act === 'call') { b.disabled = true; run(() => Api.post(`${API}/counters/${b.dataset.counter}/call-next`, {})); return; }
    if (act === 'toggle') { b.disabled = true; run(() => Api.patch(`${API}/counters/${b.dataset.counter}`, { isOpen: b.dataset.open === '1' }), (r) => `${r.message}${r.data.returned.length ? ` ${r.data.returned.join(', ')} went back to the queue.` : ''}`); return; }
    if (act === 'start') { b.disabled = true; run(() => Api.post(`${API}/tokens/${b.dataset.token}/start`, {})); return; }
    if (act === 'complete') { b.disabled = true; run(() => Api.post(`${API}/tokens/${b.dataset.token}/complete`, {})); return; }
    const t = tokenOf(b.dataset.token);
    if (!t) return;
    if (act === 'noshow') {
      noteDialog({ title: `No-show: ${t.code}`, intro: `${esc(t.student.name)} was called to ${esc(t.counter ? t.counter.name : 'the counter')} but did not arrive. The counter becomes free. They can get a new token at the back of the queue.`, label: 'Note (optional)', confirm: 'Mark as no-show', danger: true, request: (note) => Api.post(`${API}/tokens/${t.id}/no-show`, { note }) });
    }
    if (act === 'cancel') {
      noteDialog({ title: `Remove ${t.code} from the queue`, intro: `${esc(t.student.name)} will leave the queue and the token is cancelled.`, label: 'Reason (optional)', confirm: 'Remove from queue', danger: true, request: (note) => Api.post(`${API}/tokens/${t.id}/cancel`, { note }) });
    }
  });

  load(true);
  setInterval(() => { if (!document.hidden) load(false); }, 10000);
})();
