/* CAP details page: Read-only display of the student's CAP allotment details. */
(async function () {
  const esc = UI.esc;
  const root = document.getElementById('cap-content');
  const student = await Auth.requireLogin('cap-details.html');
  if (!student) return;

  function render(data) {
    const c = data && data.capDetails;
    const ver = data && data.verification;

    if (!c) {
      root.innerHTML = `
        <div class="alert alert-info" role="status">
          <strong>No record found.</strong> There are no CAP allotment details linked to your account. Please contact the college admission cell.
        </div>`;
      return;
    }

    const isVerified = Boolean(c.verified || (ver && ver.status === 'verified'));
    const isRevoked = Boolean(c.status === 'revoked' || (ver && ver.status === 'revoked'));
    const isPending = !isVerified && !isRevoked;

    const statusBadge = isVerified
      ? '<span class="status-pill completed">Verified</span>'
      : (isRevoked
        ? '<span class="status-pill rejected">Revoked</span>'
        : '<span class="status-pill in_progress">Verification Pending</span>');

    const statusNotice = isVerified
      ? `<div class="alert alert-success py-2 small mb-0" role="status">
           Verified by the college admission cell${ver && ver.verifiedAt ? ` on ${esc(UI.formatDate(ver.verifiedAt))}` : ''}. These details are read-only.
         </div>`
      : (isRevoked
        ? `<div class="alert alert-danger py-2 small mb-0" role="alert">
             This allotment record has been revoked by the college admission cell. Please contact the admission office.
           </div>`
        : `<div class="alert alert-warning py-2 small mb-0" role="status">
             <strong>Verification Pending:</strong> The college admission cell has not verified this allotment record yet. Your allotment details are read-only.
           </div>`);

    root.innerHTML = `
      <section class="panel">
        <div class="d-flex justify-content-between align-items-center mb-3">
          <h2 class="panel-title mb-0">Your CAP Allotment</h2>
          ${statusBadge}
        </div>
        <dl class="cap-summary mb-3">
          <dt>Application ID</dt><dd class="fw-semibold">${esc(c.applicationId)}</dd>
          <dt>Candidate Name</dt><dd>${esc(c.studentName)}</dd>
          <dt>Allotted College</dt><dd>${esc(c.allottedCollege)}</dd>
          <dt>Course / Branch</dt><dd>${esc(c.courseBranch)}</dd>
          <dt>CAP Round</dt><dd>${esc(c.capRound)}</dd>
          <dt>Allotment Status</dt><dd>${esc(c.allotmentStatus)}</dd>
        </dl>
        ${statusNotice}
      </section>`;
  }

  try {
    const res = await Api.get('/api/cap-details');
    render(res.data);
  } catch (err) {
    UI.showAlert('danger', err.message);
  }
})();
