/* Small UI helpers shared by all pages. Exposes window.UI. */
(function () {
  const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ENTITIES[c]);

  function alertArea() { return document.getElementById('alert-area'); }

  function showAlert(type, message) {
    const area = alertArea();
    if (!area) return;
    const role = type === 'danger' || type === 'warning' ? 'alert' : 'status';
    area.innerHTML = `<div class="alert alert-${type} mb-3" role="${role}">${esc(message)}</div>`;
    area.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** Same as showAlert but renders inside a given element (used by the task windows). */
  function showAlertIn(container, type, message) {
    if (!container) return;
    const role = type === 'danger' || type === 'warning' ? 'alert' : 'status';
    container.innerHTML = `<div class="alert alert-${type} mb-3" role="${role}">${esc(message)}</div>`;
  }

  function clearAlert() {
    const area = alertArea();
    if (area) area.innerHTML = '';
  }

  function clearFieldErrors(form) {
    form.querySelectorAll('.is-invalid').forEach((el) => el.classList.remove('is-invalid'));
    form.querySelectorAll('.invalid-feedback').forEach((el) => { el.textContent = ''; });
  }

  /** Marks fields invalid, fills their messages and focuses the first one. Returns true if any were shown. */
  function setFieldErrors(form, errors) {
    let first = null;
    Array.from(form.elements).forEach((input) => {
      const msg = input.name && errors && errors[input.name];
      if (!msg) return;
      input.classList.add('is-invalid');
      const fb = input.parentElement.querySelector('.invalid-feedback');
      if (fb) fb.textContent = msg;
      if (!first) first = input;
    });
    if (first) first.focus();
    return Boolean(first);
  }

  function setLoading(button, loading, loadingText) {
    if (!button) return;
    if (loading) {
      button.dataset.label = button.textContent;
      button.disabled = true;
      button.innerHTML = `<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>${esc(loadingText || 'Please wait')}`;
    } else {
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    }
  }

  /** One segment per task, coloured by status. */
  function segmentedBar(statuses) {
    return `<div class="seg-bar" aria-hidden="true">${statuses.map((s) => `<span class="seg ${esc(s)}"></span>`).join('')}</div>`;
  }

  function statusPill(status, label) {
    return `<span class="status-pill ${esc(status)}">${esc(label)}</span>`;
  }

  function formatDate(sqliteUtc) {
    if (!sqliteUtc) return '';
    const d = new Date(String(sqliteUtc).replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  }

  window.UI = { esc, showAlert, showAlertIn, clearAlert, clearFieldErrors, setFieldErrors, setLoading, segmentedBar, statusPill, formatDate };
})();
