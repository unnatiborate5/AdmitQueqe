/* Landing page: swap the buttons for a dashboard link when already logged in. */
(async function () {
  try {
    const student = await Auth.getCurrentStudent();
    if (!student) return;
    const html = '<a class="btn btn-primary" href="dashboard.html">Go to dashboard</a>';
    document.getElementById('home-actions').innerHTML = html;
    document.getElementById('hero-actions').innerHTML = html.replace('btn btn-primary', 'btn btn-primary btn-lg');
  } catch (_) { /* server unreachable: keep default buttons */ }
})();
