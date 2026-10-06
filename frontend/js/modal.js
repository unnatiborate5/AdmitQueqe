/* Minimal accessible modal window (no Bootstrap JS needed). Exposes window.Modal. */
(function () {
  let current = null;

  function focusables(root) {
    return Array.from(root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter((el) => el.offsetParent !== null);
  }

  /**
   * Opens a window. Returns { body, footer, alertArea, setTitle, setBusy, close }.
   * `onClose` runs whenever the window closes (Cancel, X, Esc, backdrop or after saving).
   */
  function open({ title, size, onClose }) {
    if (current) current.close();
    const opener = document.activeElement;

    const backdrop = document.createElement('div');
    backdrop.className = 'af-modal-backdrop';
    backdrop.innerHTML = `
      <div class="af-modal ${size === 'lg' ? 'af-modal-lg' : ''}" role="dialog" aria-modal="true" aria-labelledby="af-modal-title" tabindex="-1">
        <div class="af-modal-header">
          <h2 class="af-modal-title" id="af-modal-title"></h2>
          <button type="button" class="btn-close" aria-label="Close"></button>
        </div>
        <div class="af-modal-body"><div class="modal-alert" aria-live="polite"></div><div class="modal-content-area"></div></div>
        <div class="af-modal-footer"></div>
      </div>`;
    document.body.appendChild(backdrop);
    document.body.classList.add('af-modal-open');

    const dialog = backdrop.querySelector('.af-modal');
    const api = {
      body: backdrop.querySelector('.modal-content-area'),
      alertArea: backdrop.querySelector('.modal-alert'),
      footer: backdrop.querySelector('.af-modal-footer'),
      busy: false,
      setTitle(text) { backdrop.querySelector('.af-modal-title').textContent = text; },
      setBusy(flag) { api.busy = flag; dialog.classList.toggle('is-busy', flag); },
      close() {
        if (current !== api) return;
        current = null;
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        if (!document.querySelector('.af-modal-backdrop')) document.body.classList.remove('af-modal-open');
        if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
        if (onClose) onClose();
      },
    };
    api.setTitle(title || '');

    function onKey(event) {
      if (event.key === 'Escape' && !api.busy) { event.preventDefault(); api.close(); return; }
      if (event.key !== 'Tab') return;
      const items = focusables(dialog);
      if (!items.length) { event.preventDefault(); dialog.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);

    backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop && !api.busy) api.close(); });
    backdrop.querySelector('.btn-close').addEventListener('click', () => { if (!api.busy) api.close(); });

    current = api;
    dialog.focus();
    return api;
  }

  /** Moves focus to the first field in the window body (call after rendering a form). */
  function focusFirst(api) {
    const el = api.body.querySelector('input:not([type=hidden]), select, textarea');
    if (el) el.focus();
  }

  window.Modal = { open, focusFirst, isOpen: () => Boolean(current) };
})();
