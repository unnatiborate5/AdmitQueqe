/* Admin CAP records: add / import / correct / verify / revoke / unlink records and resolve student claims. */
(async function () {
  const esc = UI.esc;
  const admin = await Admin.requireAdmin('cap-records.html', 'cap:view');
  if (!admin) return;
  const $ = (id) => document.getElementById(id);
  const canManage = Admin.can(admin, 'cap:manage');
  const canVerify = Admin.can(admin, 'cap:verify');
  const API = '/api/admin/cap';
  const TABS = [['verified', 'Allotment records'], ['revoked', 'Revoked'], ['claims', 'Student claims']];
  const params = new URLSearchParams(window.location.search);
  const state = { tab: TABS.some((t) => t[0] === params.get('tab')) ? params.get('tab') : 'verified', page: 1 };
  let list = null; let claims = null; let options = { capRounds: [], allotmentStatuses: [] };

  const pill = (status, label) => UI.statusPill({ pending_verification: 'in_progress', verified: 'completed', revoked: 'rejected' }[status] || status, label);
  const reasonClass = { not_found: 'not_started', not_verified: 'in_progress', revoked: 'rejected', name_mismatch: 'correction_requested', already_linked: 'rejected' };

  // ---------------- generic dialog ----------------
  const fieldHtml = (id, label, control, hint) => `<div class="mb-3"><label class="form-label fw-semibold" for="${id}">${esc(label)}</label>${control}<div class="invalid-feedback"></div>${hint ? `<div class="form-text">${esc(hint)}</div>` : ''}</div>`;
  const textInput = (id, name, value, attrs) => `<input class="form-control" id="${id}" name="${name}" value="${esc(value || '')}" ${attrs || ''}>`;
  const textArea = (id, name, rows, attrs) => `<textarea class="form-control" id="${id}" name="${name}" rows="${rows || 2}" ${attrs || ''}></textarea>`;
  const selectHtml = (id, name, values, selected) => `<select class="form-select" id="${id}" name="${name}"><option value="">Select</option>${values.map((v) => `<option${v === selected ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`;

  function formDialog({ title, size, bodyHtml, submit, danger, request, after }) {
    const m = Modal.open({ title, size });
    m.body.innerHTML = `<form id="cap-dialog-form" novalidate>${bodyHtml}</form>`;
    m.footer.innerHTML = `<button type="button" class="btn btn-outline-secondary" data-x="cancel">Cancel</button><button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" form="cap-dialog-form">${esc(submit)}</button>`;
    m.footer.querySelector('[data-x=cancel]').addEventListener('click', () => m.close());
    const form = m.body.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      UI.clearFieldErrors(form); m.alertArea.innerHTML = '';
      const btn = m.footer.querySelector('[type=submit]');
      UI.setLoading(btn, true, 'Saving'); m.setBusy(true);
      try {
        const res = await request(Object.fromEntries(new FormData(form).entries()));
        m.setBusy(false);
        if (after) { after(res, m); } else { m.close(); UI.showAlert('success', res.message); refresh(); }
      } catch (err) {
        m.setBusy(false); UI.setLoading(btn, false);
        if (err.status === 401) { window.location.replace('login.html?expired=1'); return; }
        UI.setFieldErrors(form, err.errors);
        UI.showAlertIn(m.alertArea, 'danger', err.message);
      }
    });
    Modal.focusFirst(m);
    return m;
  }

  // ---------------- record add / correct ----------------
  function recordDialog(rec) {
    const editing = Boolean(rec);
    const locked = editing && rec.linkedStudent;
    formDialog({
      title: editing ? `Correct record ${rec.applicationId}` : 'Add a CAP record', size: 'lg', submit: editing ? 'Save correction' : 'Add record',
      bodyHtml: `${editing ? `<p class="small text-muted">${rec.status === 'revoked' ? 'Correcting a revoked record restores it to active status.' : 'A correction updates the allotment details and linked student, and is recorded in the history with your remarks.'}</p>` : '<p class="small text-muted">The record is immediately trusted and ready for student linking.</p>'}
        <div class="row"><div class="col-md-6">${fieldHtml('r-app', 'Application ID', textInput('r-app', 'applicationId', rec && rec.applicationId, `maxlength="20" autocomplete="off" ${locked ? 'readonly' : ''}`), locked ? 'Locked while linked to a student. Unlink first to change it.' : '5-20 letters, numbers or hyphens.')}</div>
        <div class="col-md-6">${fieldHtml('r-name', 'Candidate name', textInput('r-name', 'candidateName', rec && rec.candidateName, 'maxlength="100"'), 'As printed on the CAP list.')}</div></div>
        ${fieldHtml('r-college', 'Allotted college', textInput('r-college', 'allottedCollege', rec && rec.allottedCollege, 'maxlength="150"'))}
        ${fieldHtml('r-branch', 'Course / branch', textInput('r-branch', 'courseBranch', rec && rec.courseBranch, 'maxlength="100"'))}
        <div class="row"><div class="col-md-6">${fieldHtml('r-round', 'CAP round', selectHtml('r-round', 'capRound', options.capRounds, rec && rec.capRound))}</div>
        <div class="col-md-6">${fieldHtml('r-status', 'Allotment status', selectHtml('r-status', 'allotmentStatus', options.allotmentStatuses, rec && rec.allotmentStatus))}</div></div>
        ${fieldHtml('r-note', 'Source note (optional)', textInput('r-note', 'sourceNote', rec && rec.sourceNote, 'maxlength="200" placeholder="e.g. CET Cell list, Round 1, downloaded 12 Aug"'))}
        ${editing ? fieldHtml('r-remarks', 'Reason for the correction', textArea('r-remarks', 'remarks', 2, 'maxlength="300" required'), 'Required. Saved in the audit history.') : ''}`,
      request: (v) => (editing ? Api.put(`${API}/records/${rec.id}`, v) : Api.post(`${API}/records`, v)),
    });
  }

  // ---------------- CSV import ----------------
  function importDialog() {
    formDialog({
      title: 'Import CAP records from CSV', size: 'lg', submit: 'Import',
      bodyHtml: `<p class="small text-muted">Paste rows with these columns (a header row is optional, up to 500 rows):<br><code>application_id, candidate_name, allotted_college, course_branch, cap_round, allotment_status[, demo_password]</code><br>
        Imported records are immediately trusted and ready for student linking. Existing application IDs are never overwritten: they are reported and skipped.</p>
        ${fieldHtml('i-csv', 'CSV text', textArea('i-csv', 'csv', 9, 'required spellcheck="false"'))}
        ${fieldHtml('i-note', 'Source note (optional)', textInput('i-note', 'sourceNote', '', 'maxlength="200" placeholder="e.g. CET Cell list, Round 1"'))}
        <div id="import-result"></div>`,
      request: (v) => Api.post(`${API}/records/import`, v),
      after: (res, m) => {
        const r = res.data;
        const accepted = r.accepted !== undefined ? r.accepted : r.created;
        const dups = r.duplicates !== undefined ? r.duplicates : (r.skipped || []).filter((s) => s.isDuplicate).length;
        const rejs = r.rejected !== undefined ? r.rejected : (r.skipped || []).filter((s) => !s.isDuplicate).length;
        m.body.querySelector('#import-result').innerHTML = `<div class="alert alert-${accepted ? 'success' : 'warning'} mb-2">
            <strong>Import summary:</strong> ${accepted} accepted, ${dups} duplicate, ${rejs} rejected (of ${r.total} total rows).
          </div>
          ${r.skipped.length ? `<div class="table-responsive" style="max-height:14rem"><table class="table admin-table"><thead><tr><th>Line</th><th>Application ID</th><th>Status</th><th>Why it was skipped</th></tr></thead><tbody>${r.skipped.map((s) => `<tr><td>${s.line}</td><td>${esc(s.applicationId)}</td><td><span class="badge ${s.isDuplicate ? 'bg-secondary' : 'bg-danger'}">${s.isDuplicate ? 'Duplicate' : 'Rejected'}</span></td><td>${esc(s.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
        m.footer.innerHTML = '<button type="button" class="btn btn-primary" data-x="done">Done</button>';
        m.footer.querySelector('[data-x=done]').addEventListener('click', () => { m.close(); refresh(); });
      },
    });
  }

  const simple = (rec, { title, intro, label, required, submit, danger, path, message }) => formDialog({
    title, submit, danger,
    bodyHtml: `<p>${intro}</p>${fieldHtml('s-remarks', label, textArea('s-remarks', 'remarks', 2, `maxlength="300" ${required ? 'required' : ''}`), required ? 'Required. Saved in the audit history.' : 'Optional. Saved in the audit history.')}`,
    request: (v) => Api.post(`${API}/records/${rec.id}/${path}`, v),
  });

  async function historyDialog(rec) {
    const m = Modal.open({ title: `History of ${rec.applicationId}`, size: 'lg' });
    m.body.innerHTML = '<div class="spinner-wrap py-3">Loading</div>';
    m.footer.innerHTML = '<button type="button" class="btn btn-outline-secondary" data-x="close">Close</button>';
    m.footer.querySelector('[data-x=close]').addEventListener('click', () => m.close());
    try {
      const { record, history } = (await Api.get(`${API}/records/${rec.id}`)).data;
      const detail = (h) => {
        const d = h.details || {};
        if (d.changes) return Object.entries(d.changes).map(([k, c]) => `${k}: "${c.from}" \u2192 "${c.to}"`).join('; ');
        if (d.studentName) return `Student: ${d.studentName}${d.adminApproved ? ' (approved by an admin)' : ''}`;
        if (d.fields) return `${d.fields.candidateName}, ${d.fields.allottedCollege}, ${d.fields.capRound}`;
        return '';
      };
      m.body.innerHTML = `<p class="small text-muted mb-2">${esc(record.sourceLabel)}${record.sourceNote ? ` &middot; ${esc(record.sourceNote)}` : ''}. Entered by ${esc(record.enteredBy)}.</p>
        <ul class="timeline">${history.map((h) => `<li class="${h.event === 'edited' ? 'note' : (h.actorType === 'student' ? 'student' : '')}">
          <div class="fw-semibold text-capitalize">${esc(h.event)}</div>${detail(h) ? `<div class="small">${esc(detail(h))}</div>` : ''}${h.remarks ? `<div class="pre-line">${esc(h.remarks)}</div>` : ''}
          <div class="when">${esc(h.actorName)}${h.actorType !== 'admin' ? ` (${esc(h.actorType)})` : ''} &middot; ${esc(UI.formatDate(h.createdAt))}</div></li>`).join('')}</ul>`;
    } catch (err) { m.body.innerHTML = ''; UI.showAlertIn(m.alertArea, 'danger', err.message); }
  }

  // ---------------- rendering ----------------
  function renderTabs() {
    const counts = list ? list.counts : {};
    $('cap-tabs').innerHTML = TABS.map(([key, label]) => {
      const n = key === 'claims' ? (list ? list.pendingClaims : 0) : (counts[key] || 0);
      return `<button type="button" role="tab" aria-selected="${state.tab === key}" class="${state.tab === key ? 'active' : ''}" data-tab="${key}">${label}<span class="count">${n}</span></button>`;
    }).join('');
    $('cap-filters').classList.toggle('d-none', state.tab === 'claims');
  }

  function recordRows() {
    const head = '<thead><tr><th>Application ID</th><th>Candidate and allotment</th><th>Source</th><th>Status</th><th>Linked student</th><th class="text-end">Actions</th></tr></thead>';
    if (!list.items.length) return `${head}<tbody><tr><td colspan="6"><div class="empty-state">No records here.</div></td></tr></tbody>`;
    return `${head}<tbody>${list.items.map((r) => {
      const acts = [];
      if (canManage) acts.push(`<button class="btn btn-outline-primary btn-sm" data-act="edit" data-id="${r.id}">Correct</button>`);
      if (canManage && r.linkedStudent) acts.push(`<button class="btn btn-outline-danger btn-sm" data-act="unlink" data-id="${r.id}">Unlink</button>`);
      if (canVerify && r.status !== 'revoked' && !r.linkedStudent) acts.push(`<button class="btn btn-outline-danger btn-sm" data-act="revoke" data-id="${r.id}">Revoke</button>`);
      acts.push(`<button class="btn btn-outline-secondary btn-sm" data-act="history" data-id="${r.id}">History</button>`);
      return `<tr><td><span class="code-chip">${esc(r.applicationId)}</span></td>
        <td><div class="fw-semibold">${esc(r.candidateName)}</div><div class="cell-sub">${esc(r.allottedCollege)}, ${esc(r.courseBranch)} &middot; ${esc(r.capRound)} &middot; ${esc(r.allotmentStatus)}</div></td>
        <td class="small">${esc(r.sourceLabel)}${r.sourceNote ? `<div class="cell-sub">${esc(r.sourceNote)}</div>` : ''}<div class="cell-sub">Entered by ${esc(r.enteredBy)}</div></td>
        <td>${pill(r.status, r.statusLabel)}${r.verifiedBy ? `<div class="cell-sub">${esc(r.verifiedBy)}, ${esc(UI.formatDate(r.verifiedAt))}</div>` : ''}</td>
        <td>${r.linkedStudent ? `<a class="text-decoration-none fw-semibold" href="student.html?id=${r.linkedStudent.id}">${esc(r.linkedStudent.name)}</a>${r.linkedStudent.admissionToken ? ` <span class="badge bg-primary ms-1">${esc(r.linkedStudent.admissionToken)}</span>` : ''}` : '<span class="text-muted">-</span>'}</td>
        <td class="text-end"><div class="d-inline-flex flex-wrap gap-1 justify-content-end">${acts.join('')}</div></td></tr>`;
    }).join('')}</tbody>`;
  }

  function claimRows() {
    const head = '<thead><tr><th>Student</th><th>Submitted ID</th><th>Why it is waiting</th><th>Submitted</th><th class="text-end">Actions</th></tr></thead>';
    if (!claims.items.length) return `${head}<tbody><tr><td colspan="5"><div class="empty-state">No students are waiting for verification.</div></td></tr></tbody>`;
    return `${head}<tbody>${claims.items.map((c) => `<tr>
      <td><a class="fw-semibold text-decoration-none" href="student.html?id=${c.student.id}">${esc(c.student.name)}</a>${c.student.admissionToken ? ` <span class="badge bg-primary ms-1">${esc(c.student.admissionToken)}</span>` : ''}<div class="cell-sub">${esc(c.student.email)}</div></td>
      <td><span class="code-chip">${esc(c.applicationId)}</span>${c.record ? `<div class="cell-sub">Record: ${esc(c.record.candidateName)} (${esc(c.record.statusLabel.toLowerCase())})</div>` : ''}</td>
      <td>${UI.statusPill(reasonClass[c.reason] || 'pending', c.reasonLabel)}</td><td class="small">${esc(UI.formatDate(c.submittedAt))}</td>
      <td class="text-end">${canManage ? `<div class="d-inline-flex gap-1">${c.canApprove ? `<button class="btn btn-primary btn-sm" data-act="approve" data-id="${c.id}">Link student</button>` : ''}<button class="btn btn-outline-danger btn-sm" data-act="reject" data-id="${c.id}">Reject</button></div>` : ''}</td></tr>`).join('')}</tbody>`;
  }

  async function refresh() {
    try {
      renderTabs();
      if (state.tab === 'claims') {
        claims = (await Api.get(`${API}/claims`)).data;
        list = list || (await Api.get(`${API}/records?pageSize=1`)).data;
        $('cap-table').innerHTML = claimRows(); $('pager').innerHTML = '';
      } else {
        list = (await Api.get(`${API}/records${Admin.qs({ status: state.tab, search: $('f-search').value.trim(), linked: $('f-linked').value, page: state.page })}`)).data;
        options = list.options;
        $('cap-table').innerHTML = recordRows();
        Admin.renderPager($('pager'), list, (p) => { state.page = p; refresh(); });
      }
      renderTabs();
      document.title = 'CAP records - AdmitFlow Admin';
    } catch (err) { Admin.handleError(err); }
  }

  // ---------------- events ----------------
  if (canManage) $('cap-actions').innerHTML = '<button type="button" class="btn btn-outline-primary" data-top="import">Import CSV</button><button type="button" class="btn btn-primary" data-top="add">Add record</button>';
  document.addEventListener('click', (e) => {
    const top = e.target.closest('[data-top]');
    if (top) { (top.dataset.top === 'add' ? recordDialog : importDialog)(); return; }
    const tab = e.target.closest('[data-tab]');
    if (tab) { state.tab = tab.dataset.tab; state.page = 1; refresh(); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    if (['approve', 'reject'].includes(b.dataset.act)) {
      const c = claims.items.find((x) => x.id === id);
      if (b.dataset.act === 'approve') {
        formDialog({ title: `Link ${c.student.name} to ${c.applicationId}`, submit: 'Link student',
          bodyHtml: `<p>The record is verified (${esc(c.record.candidateName)}). ${c.reason === 'name_mismatch' ? '<strong>The name does not match the student\'s registered name</strong>, so remarks are required.' : ''}</p>${fieldHtml('c-remarks', 'Remarks', textArea('c-remarks', 'remarks', 2, 'maxlength="300"'), c.reason === 'name_mismatch' ? 'Required: say how you confirmed this is the same person.' : 'Optional.')}`,
          request: (v) => Api.post(`${API}/claims/${id}/approve`, v) });
      } else {
        formDialog({ title: `Reject the claim of ${c.student.name}`, submit: 'Reject claim', danger: true,
          bodyHtml: `<p>The student will see your reason and can submit a corrected application ID.</p>${fieldHtml('c-note', 'Reason', textArea('c-note', 'note', 2, 'maxlength="300" required'), 'Required.')}`,
          request: (v) => Api.post(`${API}/claims/${id}/reject`, v) });
      }
      return;
    }
    const rec = list.items.find((x) => x.id === id);
    if (!rec) return;
    switch (b.dataset.act) {
      case 'edit': recordDialog(rec); break;
      case 'history': historyDialog(rec); break;
      case 'verify': simple(rec, { title: `Verify ${rec.applicationId}`, intro: `Confirm that <strong>${esc(rec.candidateName)}</strong>, ${esc(rec.allottedCollege)}, ${esc(rec.courseBranch)}, ${esc(rec.capRound)} matches the CAP allotment list. Students waiting on this ID are linked automatically.`, label: 'Remarks (optional)', required: false, submit: 'Verify record', path: 'verify' }); break;
      case 'revoke': simple(rec, { title: `Revoke ${rec.applicationId}`, intro: 'A revoked record can no longer be linked to students. Correct it later to restore it.', label: 'Reason', required: true, submit: 'Revoke record', danger: true, path: 'revoke' }); break;
      case 'unlink': simple(rec, { title: `Unlink ${rec.linkedStudent.name}`, intro: `This removes the CAP details of <strong>${esc(rec.linkedStudent.name)}</strong> and takes them out of the verification queue. Use it when the wrong account was linked.`, label: 'Reason', required: true, submit: 'Unlink student', danger: true, path: 'unlink' }); break;
      default: break;
    }
  });
  $('f-search').addEventListener('input', Admin.debounce(() => { state.page = 1; refresh(); }, 300));
  $('f-linked').addEventListener('change', () => { state.page = 1; refresh(); });
  refresh();
})();
