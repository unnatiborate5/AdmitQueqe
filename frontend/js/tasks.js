/* Task windows: one form / detail view for each of the six admission tasks.
 * Usage: Tasks.open('fee_payment', { studentName, onSaved(message) })  Exposes window.Tasks. */
(function () {
  const esc = UI.esc;
  const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  const STATUS_DATE_LABEL = { allotment_acceptance: 'Accepted on', admission_form: 'Submitted on' };
  const STATUS_DATE_NOUN = { allotment_acceptance: 'Acceptance', admission_form: 'Submission' };

  const TITLES = {
    cap_details: 'CAP Details',
    allotment_acceptance: 'CAP Allotment Acceptance',
    admission_form: 'Admission Form',
    document_preparation: 'Document Preparation',
    physical_verification: 'Physical Document Verification',
    fee_payment: 'Fee / Payment Status',
  };

  // ---------- small building blocks ----------
  const field = (label, control, hint, extraClass) =>
    `<div class="mb-3 ${extraClass || ''}">${label ? `<label class="form-label fw-semibold" for="${control.id}">${esc(label)}</label>` : ''}${control.html}<div class="invalid-feedback"></div>${hint ? `<div class="form-text">${esc(hint)}</div>` : ''}</div>`;

  const input = (id, name, value, attrs) => ({
    id,
    html: `<input class="form-control" id="${id}" name="${name}" value="${esc(value === null || value === undefined ? '' : value)}" ${attrs || ''}>`,
  });

  const select = (id, name, options, selected, placeholder) => ({
    id,
    html: `<select class="form-select" id="${id}" name="${name}">${placeholder ? `<option value="">${esc(placeholder)}</option>` : ''}${options
      .map((o) => {
        const value = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        return `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
      }).join('')}</select>`,
  });

  function setFooter(m, buttons) {
    m.footer.innerHTML = buttons.map((b) =>
      `<button type="${b.type || 'button'}" class="btn ${b.cls}" ${b.form ? `form="${b.form}"` : ''} data-act="${b.act || ''}">${esc(b.label)}</button>`).join('');
    return m.footer;
  }
  const saveCancel = (m) => setFooter(m, [
    { label: 'Cancel', cls: 'btn-outline-secondary', act: 'cancel' },
    { label: 'Save', cls: 'btn-primary', type: 'submit', form: 'task-form', act: 'save' },
  ]);

  function loadingView(m) {
    m.body.innerHTML = '<div class="spinner-wrap py-4"><div class="spinner-border text-primary mb-2" aria-hidden="true"></div><div>Loading</div></div>';
    setFooter(m, [{ label: 'Cancel', cls: 'btn-outline-secondary', act: 'cancel' }]);
    m.footer.querySelector('[data-act=cancel]').addEventListener('click', () => m.close());
  }

  function errorView(m, message) {
    m.body.innerHTML = '';
    UI.showAlertIn(m.alertArea, 'danger', message);
    setFooter(m, [{ label: 'Close', cls: 'btn-outline-secondary', act: 'cancel' }]);
    m.footer.querySelector('[data-act=cancel]').addEventListener('click', () => m.close());
  }

  /** Wires Cancel + Save for a form. `validate(form)` returns client-side errors; `request(form)` returns a promise. */
  function wireForm(m, opts) {
    const form = m.body.querySelector('#task-form');
    const saveBtn = m.footer.querySelector('[data-act=save]');
    m.footer.querySelector('[data-act=cancel]').addEventListener('click', () => { if (!m.busy) m.close(); });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      m.alertArea.innerHTML = '';
      UI.clearFieldErrors(form);

      const errors = opts.validate ? opts.validate(form) : {};
      if (Object.keys(errors).length) {
        UI.setFieldErrors(form, errors);
        UI.showAlertIn(m.alertArea, 'danger', 'Please correct the highlighted fields.');
        return;
      }

      m.setBusy(true);
      UI.setLoading(saveBtn, true, 'Saving');
      try {
        const res = await opts.request(form);
        m.setBusy(false);
        m.close();
        if (opts.onSaved) opts.onSaved(res.message || 'Saved.');
      } catch (err) {
        m.setBusy(false);
        UI.setLoading(saveBtn, false);
        if (err.status === 401) { window.location.replace('login.html'); return; }
        UI.setFieldErrors(form, err.errors);
        UI.showAlertIn(m.alertArea, 'danger', err.errors && err.errors.preparedDocs ? err.errors.preparedDocs : err.message);
      }
    });
    Modal.focusFirst(m);
  }

  // ---------- 1. CAP details ----------
  async function renderCap(m, ctx) {
    const res = await Api.get('/api/cap-details');
    const { capDetails: c, options } = res.data;
    const v = c || { studentName: ctx.studentName || '' };
    m.setTitle(TITLES.cap_details);
    m.body.innerHTML = `
      <p class="text-muted">Copy these from your CAP allotment letter. You can edit them later if something changes.</p>
      <form id="task-form" novalidate>
        <div class="row">
          <div class="col-md-6">${field('Application ID', input('f-applicationId', 'applicationId', v.applicationId, 'maxlength="20" autocomplete="off"'), '5-20 letters, numbers or hyphens.')}</div>
          <div class="col-md-6">${field('Student name', input('f-studentName', 'studentName', v.studentName, 'maxlength="100"'), 'As printed on the allotment letter.')}</div>
        </div>
        ${field('Allotted college', input('f-allottedCollege', 'allottedCollege', v.allottedCollege, 'maxlength="150"'))}
        ${field('Course / branch', input('f-courseBranch', 'courseBranch', v.courseBranch, 'maxlength="100"'))}
        <div class="row">
          <div class="col-md-6">${field('CAP round', select('f-capRound', 'capRound', options.capRounds, v.capRound, 'Select round'))}</div>
          <div class="col-md-6">${field('Allotment status', select('f-allotmentStatus', 'allotmentStatus', options.allotmentStatuses, v.allotmentStatus, 'Select status'))}</div>
        </div>
      </form>`;
    saveCancel(m);

    const labels = {
      applicationId: 'Application ID is required.', studentName: 'Student name is required.',
      allottedCollege: 'Allotted college is required.', courseBranch: 'Course / branch is required.',
      capRound: 'CAP round is required.', allotmentStatus: 'Allotment status is required.',
    };
    wireForm(m, {
      validate(form) {
        const e = {};
        Object.keys(labels).forEach((k) => { if (!form.elements[k].value.trim()) e[k] = labels[k]; });
        const id = form.elements.applicationId.value.trim();
        if (id && !/^[A-Za-z0-9][A-Za-z0-9-]{4,19}$/.test(id)) e.applicationId = 'Application ID must be 5-20 characters (letters, numbers, hyphen).';
        return e;
      },
      request(form) {
        const data = {};
        Object.keys(labels).forEach((k) => { data[k] = form.elements[k].value.trim(); });
        return Api.put('/api/cap-details', data);
      },
      onSaved: ctx.onSaved,
    });
  }

  // ---------- 2 + 3. Allotment acceptance / admission form ----------
  function renderStatusRecord(m, ctx, data) {
    const { task, details } = data;
    const dateLabel = STATUS_DATE_LABEL[task.key];
    m.setTitle(task.title);
    m.body.innerHTML = `
      <p class="text-muted mb-2">${esc(task.description)}</p>
      <p class="guidance mb-3">${esc(task.guidance)}</p>
      <form id="task-form" novalidate>
        ${field('Status', select('f-status', 'status', task.statusOptions, task.status))}
        <div id="date-wrap">${field(dateLabel, input('f-eventDate', 'eventDate', details.eventDate, `type="date" max="${todayLocal()}"`), 'Required once this is complete.')}</div>
        ${field('Notes (optional)', { id: 'f-note', html: `<textarea class="form-control" id="f-note" name="note" rows="3" maxlength="300">${esc(details.note || '')}</textarea>` }, 'Up to 300 characters.')}
      </form>`;
    saveCancel(m);

    const form = m.body.querySelector('#task-form');
    const dateWrap = m.body.querySelector('#date-wrap');
    const sync = () => dateWrap.classList.toggle('d-none', form.elements.status.value === 'pending');
    form.elements.status.addEventListener('change', sync);
    sync();

    wireForm(m, {
      validate(f) {
        const e = {};
        const status = f.elements.status.value;
        const date = f.elements.eventDate.value;
        if (status !== 'pending') {
          if (!date && status === 'completed') e.eventDate = `${STATUS_DATE_NOUN[task.key]} date is required.`;
          else if (date && (!DATE_RE.test(date))) e.eventDate = 'Enter a valid date.';
          else if (date > todayLocal()) e.eventDate = 'The date cannot be in the future.';
        }
        return e;
      },
      request(f) {
        return Api.put(`/api/tasks/${task.key}`, {
          status: f.elements.status.value,
          eventDate: f.elements.eventDate.value,
          note: f.elements.note.value,
        });
      },
      onSaved: ctx.onSaved,
    });
  }

  // ---------- 4. Document preparation ----------
  function renderDocuments(m, ctx, data) {
    const { task, details } = data;
    const row = (d) => `
      <label class="doc-row">
        <input class="form-check-input" type="checkbox" name="doc" value="${esc(d.key)}" data-required="${d.required}" ${d.prepared ? 'checked' : ''}>
        <span><span class="doc-title">${esc(d.title)}</span><span class="doc-note">${esc(d.note)}</span></span>
      </label>`;
    const required = details.documents.filter((d) => d.required);
    const optional = details.documents.filter((d) => !d.required);
    m.setTitle(task.title);
    m.body.innerHTML = `
      <p class="guidance mb-3">${esc(task.guidance)}</p>
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <strong id="doc-count"></strong><span id="doc-pill"></span>
      </div>
      <form id="task-form" novalidate>
        <fieldset class="mb-3"><legend class="doc-legend">Required documents</legend>${required.map(row).join('')}</fieldset>
        <fieldset><legend class="doc-legend">Only if applicable</legend>${optional.map(row).join('')}</fieldset>
      </form>`;
    saveCancel(m);

    const boxes = Array.from(m.body.querySelectorAll('input[name=doc]'));
    const options = task.statusOptions;
    const label = (s) => options.find((o) => o.value === s).label;
    function sync() {
      const reqBoxes = boxes.filter((b) => b.dataset.required === 'true');
      const done = reqBoxes.filter((b) => b.checked).length;
      const any = boxes.some((b) => b.checked);
      const status = done === reqBoxes.length ? 'completed' : (any ? 'in_progress' : 'pending');
      m.body.querySelector('#doc-count').textContent = `${done} of ${reqBoxes.length} required documents prepared`;
      m.body.querySelector('#doc-pill').innerHTML = UI.statusPill(status, label(status));
    }
    boxes.forEach((b) => b.addEventListener('change', sync));
    sync();

    wireForm(m, {
      request() {
        return Api.put('/api/tasks/document_preparation', { preparedDocs: boxes.filter((b) => b.checked).map((b) => b.value) });
      },
      onSaved: ctx.onSaved,
    });
  }

  // ---------- 5. Physical verification (read-only) ----------
  function renderVerification(m, ctx, data) {
    const { task, details } = data;
    const done = task.status === 'completed';
    m.setTitle(task.title);
    m.body.innerHTML = `
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <strong>Current status</strong>${UI.statusPill(task.status, task.statusLabel)}
      </div>
      <div class="manual-note mb-3"><strong>Only the college can verify your original documents, in person.</strong> You cannot change this status yourself. It updates here after the college records the result.</div>
      ${done ? `<dl class="cap-summary mb-3">
        ${details.verifiedBy ? `<dt>Verified by</dt><dd>${esc(details.verifiedBy)}</dd>` : ''}
        ${details.verifiedAt ? `<dt>Verified on</dt><dd>${esc(details.verifiedAt)}</dd>` : ''}
        ${details.remarks ? `<dt>Remarks</dt><dd>${esc(details.remarks)}</dd>` : ''}
      </dl>` : ''}
      <h3 class="h6 fw-bold">What happens</h3>
      <ol class="small text-muted ps-3">${details.steps.map((s) => `<li class="mb-1">${esc(s)}</li>`).join('')}</ol>
      <div class="guidance d-flex flex-wrap justify-content-between align-items-center gap-2">
        <span>${details.documentsPrepared} of ${details.documentsRequired} required documents prepared</span>
        <button type="button" class="btn btn-sm btn-outline-primary" data-act="docs">Review documents</button>
      </div>`;
    setFooter(m, [{ label: 'Close', cls: 'btn-outline-secondary', act: 'cancel' }]);
    m.footer.querySelector('[data-act=cancel]').addEventListener('click', () => m.close());
    m.body.querySelector('[data-act=docs]').addEventListener('click', () => {
      m.close();
      open('document_preparation', ctx);
    });
  }

  // ---------- 6. Fee / payment ----------
  function renderFee(m, ctx, data) {
    const { task, details } = data;
    m.setTitle(task.title);
    m.body.innerHTML = `
      <h3 class="h6 fw-bold">Before you pay</h3>
      <ul class="guidance ps-4 mb-3">${details.instructions.map((s) => `<li class="mb-1">${esc(s)}</li>`).join('')}</ul>
      <form id="task-form" novalidate>
        ${field('Payment status', select('f-status', 'status', task.statusOptions, task.status))}
        ${field('Total fee in rupees (optional)', input('f-totalFee', 'totalFee', details.totalFee, 'type="number" min="0" step="0.01" inputmode="decimal"'), 'From your college notice. Helps check partial payments.')}
        <div id="pay-wrap">
          <div class="row">
            <div class="col-md-6">${field('Amount paid (₹)', input('f-amountPaid', 'amountPaid', details.amountPaid, 'type="number" min="0" step="0.01" inputmode="decimal"'))}</div>
            <div class="col-md-6">${field('Payment date', input('f-paidOn', 'paidOn', details.paidOn, `type="date" max="${todayLocal()}"`))}</div>
          </div>
          ${field('Payment mode', select('f-paymentMode', 'paymentMode', details.paymentModes, details.paymentMode, 'Select mode'))}
          ${field('Receipt / transaction number', input('f-receiptNumber', 'receiptNumber', details.receiptNumber, 'maxlength="40" autocomplete="off"'))}
        </div>
      </form>`;
    saveCancel(m);

    const form = m.body.querySelector('#task-form');
    const payWrap = m.body.querySelector('#pay-wrap');
    const sync = () => payWrap.classList.toggle('d-none', form.elements.status.value === 'pending');
    form.elements.status.addEventListener('change', sync);
    sync();

    wireForm(m, {
      validate(f) {
        const e = {};
        const status = f.elements.status.value;
        const total = f.elements.totalFee.value.trim();
        if (total !== '' && !/^\d+(\.\d{1,2})?$/.test(total)) e.totalFee = 'Enter a valid amount (numbers only, up to 2 decimals).';
        if (status === 'pending') return e;
        const paid = f.elements.amountPaid.value.trim();
        if (!/^\d+(\.\d{1,2})?$/.test(paid) || Number(paid) <= 0) e.amountPaid = 'Enter the amount you have paid.';
        else if (total !== '' && !e.totalFee) {
          if (status === 'in_progress' && Math.round(paid * 100) >= Math.round(total * 100)) e.amountPaid = 'This covers the full fee. Choose "Paid" instead, or lower the amount.';
          if (status === 'completed' && Math.round(paid * 100) < Math.round(total * 100)) e.amountPaid = 'This is less than the total fee. Choose "Partially Paid" instead.';
        }
        if (!f.elements.paymentMode.value) e.paymentMode = 'Select how you paid.';
        if (!f.elements.receiptNumber.value.trim()) e.receiptNumber = 'Receipt or transaction number is required.';
        const date = f.elements.paidOn.value;
        if (!date) e.paidOn = 'Payment date is required.';
        else if (date > todayLocal()) e.paidOn = 'The date cannot be in the future.';
        return e;
      },
      request(f) {
        const g = (n) => f.elements[n].value.trim();
        return Api.put('/api/tasks/fee_payment', {
          status: g('status'), totalFee: g('totalFee'), amountPaid: g('amountPaid'),
          paymentMode: g('paymentMode'), receiptNumber: g('receiptNumber'), paidOn: g('paidOn'),
        });
      },
      onSaved: ctx.onSaved,
    });
  }

  // ---------- entry point ----------
  async function load(m, taskKey, ctx) {
    try {
      if (taskKey === 'cap_details') { await renderCap(m, ctx); return; }
      const res = await Api.get(`/api/tasks/${encodeURIComponent(taskKey)}`);
      if (taskKey === 'allotment_acceptance' || taskKey === 'admission_form') renderStatusRecord(m, ctx, res.data);
      else if (taskKey === 'document_preparation') renderDocuments(m, ctx, res.data);
      else if (taskKey === 'physical_verification') renderVerification(m, ctx, res.data);
      else if (taskKey === 'fee_payment') renderFee(m, ctx, res.data);
      else errorView(m, 'Unknown task.');
    } catch (err) {
      if (err.status === 401) { window.location.replace('login.html'); return; }
      if (err.code === 'CAP_DETAILS_REQUIRED') {
        m.setTitle(TITLES[taskKey] || 'Task');
        m.body.innerHTML = '<p class="mb-0">Enter your CAP details first. Your admission tasks are set up from them.</p>';
        setFooter(m, [
          { label: 'Cancel', cls: 'btn-outline-secondary', act: 'cancel' },
          { label: 'Enter CAP details', cls: 'btn-primary', act: 'cap' },
        ]);
        m.footer.querySelector('[data-act=cancel]').addEventListener('click', () => m.close());
        m.footer.querySelector('[data-act=cap]').addEventListener('click', () => { m.close(); open('cap_details', ctx); });
        return;
      }
      errorView(m, err.message);
    }
  }

  function open(taskKey, ctx) {
    const context = ctx || {};
    const m = Modal.open({ title: TITLES[taskKey] || 'Task', size: taskKey === 'document_preparation' || taskKey === 'fee_payment' ? 'lg' : undefined });
    loadingView(m);
    load(m, taskKey, context);
    return m;
  }

  window.Tasks = { open, TITLES };
})();
