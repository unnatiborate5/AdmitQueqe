/* Admin student page: inspect one application, review it, record the verification outcome,
 * manage the appointment and read the status history. */
(async function () {
  const esc = UI.esc;
  const loading = document.getElementById('loading');
  const root = document.getElementById('content');

  const admin = await Admin.requireAdmin('students.html', 'students:view');
  if (!admin) { loading.classList.add('d-none'); return; }

  const id = new URLSearchParams(window.location.search).get('id');
  const canReview = Admin.can(admin, 'applications:review');
  const canAppt = Admin.can(admin, 'appointments:manage');
  const canVerify = Admin.can(admin, 'verification:record');
  let data = null;

  const money = (n) => (n === null || n === undefined ? '-' : `\u20B9${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
  const dd = (label, value) => `<dt>${esc(label)}</dt><dd>${value === null || value === undefined || value === '' ? '<span class="text-muted">-</span>' : esc(value)}</dd>`;

  // ---------------- panels ----------------
  function panelActions(d) {
    if (!d.hasApplication) return '';
    const status = d.review.status;
    const hasAppt = Boolean(d.appointment);
    const verified = d.verification.status === 'completed';
    const btns = [];
    if (canReview) {
      btns.push('<button type="button" class="btn btn-primary" data-act="review">Review application</button>');
      btns.push('<button type="button" class="btn btn-outline-primary" data-act="note">Add internal note</button>');
    }
    if (canVerify && status !== 'rejected') btns.push('<button type="button" class="btn btn-outline-primary" data-act="verify">Record verification outcome</button>');
    if (canAppt && status !== 'rejected' && !verified && !hasAppt) btns.push('<button type="button" class="btn btn-outline-primary" data-act="schedule">Schedule appointment</button>');
    return `<section class="panel mb-4" aria-label="Actions">
      <h2 class="panel-title mb-3">Actions</h2>
      ${btns.length ? `<div class="action-bar">${btns.join('')}</div>` : '<div class="readonly-note">Your role (' + esc(admin.roleLabel) + ') can view applications but not change them.</div>'}
    </section>`;
  }

  function panelReview(d) {
    const r = d.review;
    return `<section class="panel mb-4" aria-label="College review">
      <div class="d-flex justify-content-between align-items-center mb-2"><h2 class="panel-title mb-0">College review</h2>${Admin.reviewPill(r.status)}</div>
      ${r.status === 'not_started' ? '<p class="text-muted mb-0">The student has not entered CAP details, so there is no application to review yet.</p>' : `
        ${r.remarks && r.status !== 'pending' ? `<p class="pre-line mb-2">${esc(r.remarks)}</p>` : ''}
        <p class="text-muted small mb-0">${r.reviewedAt ? `Last decision by ${esc(r.reviewedBy)} on ${esc(UI.formatDate(r.reviewedAt))}.` : 'No decision recorded yet.'} Remarks on a decision are shown to the student.</p>`}
    </section>`;
  }

  function panelVerification(d) {
    if (!d.hasApplication) return '';
    const v = d.verification;
    const a = d.appointment;
    return `<section class="panel mb-4" aria-label="Physical verification">
      <div class="d-flex justify-content-between align-items-center mb-2"><h2 class="panel-title mb-0">Physical verification</h2>${Admin.verifPill(v.status)}</div>
      <p class="small text-muted">Documents are checked in person at the college. Here you only record the appointment and the outcome.</p>
      ${v.status === 'completed' ? `<dl class="cap-summary mb-2">${dd('Verified by', v.verifiedBy)}${dd('Verified on', v.verifiedAt ? UI.formatDay(v.verifiedAt) : '')}</dl>` : ''}
      ${v.remarks ? `<p class="pre-line small mb-2"><strong>Remarks:</strong> ${esc(v.remarks)}</p>` : ''}
      <h3 class="h6 fw-bold mt-3">Appointment</h3>
      ${a ? `<div class="mb-2"><span class="fw-semibold">${esc(Admin.slot(a.date, a.time))}</span> ${Admin.apptPill(a.status)}</div>
          <div>${esc(a.venue)}</div>
          ${a.instructions ? `<div class="small text-muted pre-line">${esc(a.instructions)}</div>` : ''}
          ${a.note ? `<div class="small mt-1"><strong>Last reason:</strong> ${esc(a.note)}</div>` : ''}
          ${canAppt ? `<div class="action-bar mt-3">
            <button class="btn btn-outline-primary btn-sm" data-act="reschedule">Reschedule</button>
            <button class="btn btn-outline-primary btn-sm" data-act="appt-completed">Mark completed</button>
            <button class="btn btn-outline-primary btn-sm" data-act="appt-missed">Mark missed</button>
            <button class="btn btn-outline-danger btn-sm" data-act="appt-cancelled">Cancel</button></div>` : ''}`
    : '<p class="text-muted mb-0">No active appointment.</p>'}
      ${d.appointments.filter((x) => x.status !== 'scheduled').length ? `<h3 class="h6 fw-bold mt-3">Earlier appointments</h3>
        <ul class="review-history">${d.appointments.filter((x) => x.status !== 'scheduled').map((x) => `<li>${esc(Admin.slot(x.date, x.time))} ${Admin.apptPill(x.status)}${x.note ? `<div class="text-muted">${esc(x.note)}</div>` : ''}</li>`).join('')}</ul>` : ''}
    </section>`;
  }

  function panelQueue(d) {
    if (!d.hasApplication || !d.queue) return '';
    const q = d.queue;
    const canOperate = Admin.can(admin, 'queue:operate');
    return `<section class="panel mb-4" aria-label="Queue token">
      <h2 class="panel-title mb-2">Today's queue token</h2>
      ${q.tokens.length ? `<ul class="review-history">${q.tokens.map((t) => `<li class="d-flex flex-wrap justify-content-between gap-2"><span><span class="code-chip">${esc(t.code)}</span> ${t.counter ? `<span class="text-muted">&middot; ${esc(t.counter.name)}</span>` : ''}${t.finishReason ? `<span class="d-block text-muted small">${esc(t.finishReason)}</span>` : ''}</span>${Admin.tokenPill(t.status)}</li>`).join('')}</ul>`
    : '<p class="text-muted small mb-2">No token issued today.</p>'}
      ${canOperate && q.canCheckIn ? '<button type="button" class="btn btn-primary btn-sm mt-2" data-act="check-in">Check in and issue token</button>'
    : (q.checkInProblem && !q.tokens.some((t) => ['waiting', 'called', 'serving'].includes(t.status)) ? `<p class="small text-muted mt-2 mb-0">${esc(q.checkInProblem)}</p>` : '')}
      <a class="small d-inline-block mt-2" href="queue.html">Open the queue</a>
    </section>`;
  }

  function panelHistory(d) {
    return `<section class="panel mb-4" aria-label="Status history">
      <h2 class="panel-title mb-3">Status history</h2>
      ${d.history.length ? `<ul class="timeline">${d.history.map((h) => `<li class="${h.type === 'remark' ? 'note' : (h.actorType === 'student' ? 'student' : '')}">
        <div class="fw-semibold">${h.type === 'remark' ? 'Internal note' : `${esc(h.fromLabel || 'New')} \u2192 ${esc(h.toLabel)}`}</div>
        ${h.remarks ? `<div class="pre-line">${esc(h.remarks)}</div>` : ''}
        <div class="when">${h.actorType === 'student' ? 'Student' : ''} ${esc(h.actorName)} &middot; ${esc(UI.formatDate(h.createdAt))}</div></li>`).join('')}</ul>`
    : '<p class="text-muted mb-0">No decisions or notes yet.</p>'}
    </section>`;
  }

  function panelCap(d) {
    const c = d.cap;
    return `<section class="panel mb-4" aria-label="CAP details">
      <h2 class="panel-title mb-2">CAP application</h2>
      ${c ? `<dl class="detail-grid mb-0">${dd('Application ID', c.applicationId)}${dd('Name on allotment letter', c.studentName)}${dd('Allotted college', c.allottedCollege)}${dd('Course / branch', c.courseBranch)}${dd('CAP round', c.capRound)}${dd('Allotment status', c.allotmentStatus)}${dd('Last updated', UI.formatDate(c.updatedAt))}</dl>`
    : '<p class="text-muted mb-0">The student has not entered CAP details yet.</p>'}
    </section>`;
  }

  function panelTasks(d) {
    if (!d.hasApplication) return '';
    const rec = d.records;
    const f = d.fee;
    return `<section class="panel mb-4" aria-label="Admission progress">
      <div class="d-flex justify-content-between align-items-baseline mb-2"><h2 class="panel-title mb-0">Admission progress</h2><span class="fw-bold">${d.progress.completed} of ${d.progress.total} tasks complete</span></div>
      ${UI.segmentedBar(d.tasks.map((t) => t.status))}
      <ul class="review-history mt-2">${d.tasks.map((t) => `<li class="d-flex flex-wrap justify-content-between gap-2"><span><span class="fw-semibold">${esc(t.title)}</span>${t.summary ? `<span class="d-block text-muted">${esc(t.summary)}</span>` : ''}</span>${UI.statusPill(t.status, t.statusLabel)}</li>`).join('')}</ul>
      ${(rec.allotmentAcceptance.note || rec.admissionForm.note) ? `<div class="small mt-2">${rec.allotmentAcceptance.note ? `<div><strong>Acceptance note:</strong> ${esc(rec.allotmentAcceptance.note)}</div>` : ''}${rec.admissionForm.note ? `<div><strong>Admission form note:</strong> ${esc(rec.admissionForm.note)}</div>` : ''}</div>` : ''}
    </section>
    <section class="panel mb-4" aria-label="Documents">
      <h2 class="panel-title mb-2">Documents the student reports as prepared</h2>
      <p class="small text-muted">Self-reported by the student. Authenticity is checked by staff in person, not here.</p>
      ${d.documents.map((x) => `<div class="doc-check ${x.prepared ? 'on' : ''}"><span class="tick" aria-hidden="true">${x.prepared ? '&#10003;' : '&#9675;'}</span><span><span class="visually-hidden">${x.prepared ? 'Prepared: ' : 'Not prepared: '}</span>${esc(x.title)}${x.required ? '' : ' <span class="text-muted">(if applicable)</span>'}</span></div>`).join('')}
    </section>
    <section class="panel mb-4" aria-label="Fee">
      <h2 class="panel-title mb-2">Fee payment (as reported by the student)</h2>
      <dl class="detail-grid mb-0">${dd('Total fee', money(f.totalFee))}${dd('Amount paid', money(f.amountPaid))}${dd('Payment mode', f.paymentMode)}${dd('Receipt / transaction no.', f.receiptNumber)}${dd('Paid on', f.paidOn ? UI.formatDay(f.paidOn) : '')}</dl>
    </section>`;
  }

  function render(d) {
    data = d;
    const s = d.student;
    document.title = `${s.fullName} - AdmitFlow Admin`;
    root.innerHTML = `
      <a href="students.html" class="small text-decoration-none">&larr; All students</a>
      <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mt-2 mb-4">
        <div><h1 class="page-title mb-1">${esc(s.fullName)}</h1>
          <p class="text-muted mb-0">${esc(s.email)} &middot; ${esc(s.phone)} &middot; registered ${esc(UI.formatDate(s.registeredAt))}</p></div>
        <div>${Admin.reviewPill(d.review.status)}</div>
      </div>
      ${d.review.status === 'approved' && d.verification.status !== 'completed' ? '<div class="alert alert-warning">This application is approved but physical verification has not been recorded as completed.</div>' : ''}
      <div class="row g-4">
        <div class="col-lg-7">${panelCap(d)}${panelTasks(d)}</div>
        <div class="col-lg-5">${panelActions(d)}${panelReview(d)}${panelVerification(d)}${panelQueue(d)}${panelHistory(d)}</div>
      </div>`;
  }

  function done(message) {
    return (res) => {
      // appointment endpoints wrap the refreshed detail as data.student; the others return it as data
      render(res.data.review ? res.data : res.data.student);
      UI.showAlert('success', message);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  }

  // ---------------- dialogs ----------------
  const ACTIONS = {
    approve: { title: 'Approve application', desc: 'Accept this application. Remarks are optional.' },
    request_corrections: { title: 'Request corrections', desc: 'Ask the student to fix something. They see your remarks and can mark it done.' },
    reject: { title: 'Reject application', desc: 'Reject this application. Remarks are required and shown to the student.' },
    reopen: { title: 'Reopen for review', desc: 'Move it back to Pending Review. A reason is required.' },
  };

  function openReview() {
    const current = data.review.status;
    const choices = Object.keys(ACTIONS).filter((a) => {
      if (a === 'reopen') return current !== 'pending';
      return { approve: 'approved', request_corrections: 'correction_requested', reject: 'rejected' }[a] !== current;
    });
    const m = Modal.open({ title: 'Review application', size: 'lg' });
    m.body.innerHTML = `<form id="review-form" novalidate>
      <p class="mb-3">Current status: ${Admin.reviewPill(current)}</p>
      <fieldset class="mb-3"><legend class="doc-legend">Decision</legend>
        ${choices.map((a, i) => `<label class="review-choice"><input type="radio" name="action" value="${a}" ${i === 0 ? 'checked' : ''}><span><span class="t">${esc(ACTIONS[a].title)}</span><span class="d">${esc(ACTIONS[a].desc)}</span></span></label>`).join('')}
      </fieldset>
      <div id="verify-warning" class="alert alert-warning d-none">Physical verification is not recorded as completed yet. You can still approve, but check that this is intended.</div>
      <div class="mb-1"><label class="form-label fw-semibold" for="remarks">Remarks <span id="remarks-req" class="text-muted fw-normal">(optional)</span></label>
        <textarea class="form-control" id="remarks" name="remarks" rows="3" maxlength="1000"></textarea><div class="invalid-feedback"></div>
        <div class="form-text">The student will see these remarks on their dashboard.</div></div>
    </form>`;
    m.footer.innerHTML = '<button type="button" class="btn btn-outline-secondary" data-act="cancel">Cancel</button><button type="submit" class="btn btn-primary" form="review-form">Save decision</button>';
    m.footer.querySelector('[data-act=cancel]').addEventListener('click', () => m.close());
    const form = m.body.querySelector('form');
    const sync = () => {
      const a = form.elements.action.value;
      m.body.querySelector('#remarks-req').textContent = a === 'approve' ? '(optional)' : '(required)';
      m.body.querySelector('#verify-warning').classList.toggle('d-none', !(a === 'approve' && data.verification.status !== 'completed'));
    };
    form.addEventListener('change', sync);
    sync();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      UI.clearFieldErrors(form);
      m.alertArea.innerHTML = '';
      const btn = m.footer.querySelector('[type=submit]');
      UI.setLoading(btn, true, 'Saving');
      m.setBusy(true);
      try {
        const res = await Api.post(`/api/admin/students/${data.student.id}/review`, {
          action: form.elements.action.value, remarks: form.elements.remarks.value, expectedStatus: current,
        });
        m.setBusy(false); m.close();
        done(res.message)(res);
      } catch (err) {
        m.setBusy(false); UI.setLoading(btn, false);
        if (err.status === 401) { window.location.replace('login.html?expired=1'); return; }
        UI.setFieldErrors(form, err.errors);
        UI.showAlertIn(m.alertArea, 'danger', err.message);
        if (err.code === 'STALE_STATUS') { m.footer.querySelector('[type=submit]').disabled = true; setTimeout(() => { m.close(); load(); }, 1800); }
      }
    });
    Modal.focusFirst(m);
  }

  function simpleDialog({ title, bodyHtml, submitLabel, formId, request, successMessage }) {
    const m = Modal.open({ title });
    m.body.innerHTML = `<form id="${formId}" novalidate>${bodyHtml}</form>`;
    m.footer.innerHTML = `<button type="button" class="btn btn-outline-secondary" data-act="cancel">Cancel</button><button type="submit" class="btn btn-primary" form="${formId}">${esc(submitLabel)}</button>`;
    m.footer.querySelector('[data-act=cancel]').addEventListener('click', () => m.close());
    const form = m.body.querySelector('form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      UI.clearFieldErrors(form);
      m.alertArea.innerHTML = '';
      const btn = m.footer.querySelector('[type=submit]');
      UI.setLoading(btn, true, 'Saving');
      m.setBusy(true);
      try {
        const res = await request(Object.fromEntries(new FormData(form).entries()));
        m.setBusy(false); m.close();
        done(successMessage)(res);
      } catch (err) {
        m.setBusy(false); UI.setLoading(btn, false);
        if (err.status === 401) { window.location.replace('login.html?expired=1'); return; }
        UI.setFieldErrors(form, err.errors);
        UI.showAlertIn(m.alertArea, 'danger', err.message);
      }
    });
    Modal.focusFirst(m);
  }

  const openNote = () => simpleDialog({
    title: 'Add internal note', formId: 'note-form', submitLabel: 'Save note', successMessage: 'Internal note saved.',
    bodyHtml: `<div class="mb-1"><label class="form-label fw-semibold" for="n-remarks">Note</label>
      <textarea class="form-control" id="n-remarks" name="remarks" rows="3" maxlength="1000" required></textarea><div class="invalid-feedback"></div>
      <div class="form-text">Visible to college staff only. The student does not see internal notes.</div></div>`,
    request: (v) => Api.post(`/api/admin/students/${data.student.id}/notes`, v),
  });

  function openVerify() {
    const v = data.verification;
    const opt = (val, label) => `<option value="${val}" ${v.status === val ? 'selected' : ''}>${label}</option>`;
    simpleDialog({
      title: 'Record verification outcome', formId: 'verify-form', submitLabel: 'Save outcome', successMessage: 'Verification outcome saved. The student can see it.',
      bodyHtml: `<p class="manual-note small">Record what happened at the in-person check. AdmitFlow does not verify documents online.</p>
        <div class="mb-3"><label class="form-label fw-semibold" for="v-status">Outcome</label>
          <select class="form-select" id="v-status" name="status">${opt('pending', 'Not verified (reset)')}${opt('in_progress', 'Verification in progress')}${opt('completed', 'Verified at college')}</select><div class="invalid-feedback"></div>
          <div class="form-text">Choosing "Verified" also closes the student's scheduled appointment as completed.</div></div>
        <div class="mb-1"><label class="form-label fw-semibold" for="v-remarks">Remarks (optional; required when resetting)</label>
          <textarea class="form-control" id="v-remarks" name="remarks" rows="2" maxlength="300">${esc(v.remarks || '')}</textarea><div class="invalid-feedback"></div></div>`,
      request: (b) => Api.put(`/api/admin/students/${data.student.id}/verification`, b),
    });
  }

  // ---------------- events ----------------
  root.addEventListener('click', (event) => {
    const b = event.target.closest('[data-act]');
    if (!b || !data) return;
    const name = data.student.fullName;
    switch (b.dataset.act) {
      case 'review': openReview(); break;
      case 'note': openNote(); break;
      case 'verify': openVerify(); break;
      case 'check-in': {
        b.disabled = true;
        Api.post('/api/admin/queue/check-in', { studentId: data.student.id })
          .then((res) => { UI.showAlert('success', `${res.message} ${res.data.token.position ? `Queue position ${res.data.token.position}.` : ''}`); return load(); })
          .catch((err) => { b.disabled = false; Admin.handleError(err); });
        break;
      }
      case 'schedule': ApptDialogs.openSchedule({ student: { id: data.student.id, name }, onDone: done('Appointment scheduled. The student can see it on their dashboard.') }); break;
      case 'reschedule': ApptDialogs.openReschedule({ appointment: data.appointment, studentName: name, onDone: done('Appointment rescheduled. The student can see the new slot.') }); break;
      default:
        if (b.dataset.act.startsWith('appt-')) {
          const status = b.dataset.act.slice(5);
          ApptDialogs.openStatus({ appointment: data.appointment, status, studentName: name, onDone: done(`Appointment marked ${status}.`) });
        }
    }
  });

  async function load() {
    try {
      render((await Api.get(`/api/admin/students/${encodeURIComponent(id)}`)).data);
      root.classList.remove('d-none');
    } catch (err) {
      if (err.status === 404) {
        root.innerHTML = '<div class="panel"><h1 class="page-title">Student not found</h1><p class="text-muted">This student does not exist.</p><a class="btn btn-primary" href="students.html">Back to students</a></div>';
        root.classList.remove('d-none');
      } else Admin.handleError(err);
    } finally { loading.classList.add('d-none'); }
  }
  if (!id) { window.location.replace('students.html'); return; }
  load();
})();
