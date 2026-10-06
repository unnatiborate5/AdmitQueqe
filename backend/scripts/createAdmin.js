'use strict';
/**
 * Creates a college admin account. There is deliberately no public admin sign-up.
 *
 *   npm run create-admin -- --name "Asha Rao" --email asha@college.edu --role super_admin
 *
 * Roles: super_admin | admission_officer | viewer
 * The password is asked for interactively (hidden). For automation you can set ADMIN_PASSWORD
 * in the environment instead; avoid --password because it ends up in your shell history.
 */
const readline = require('readline');
const adminAuthService = require('../services/adminAuthService');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput;
    rl._writeToOutput = function muted(text) { if (text.includes(question)) write.call(rl, text); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  const fullName = arg('name') || process.env.ADMIN_NAME;
  const email = arg('email') || process.env.ADMIN_EMAIL;
  const role = arg('role') || process.env.ADMIN_ROLE || 'admission_officer';
  let password = arg('password') || process.env.ADMIN_PASSWORD;

  if (!fullName || !email) {
    console.error('Usage: npm run create-admin -- --name "Full Name" --email you@college.edu [--role super_admin|admission_officer|viewer]');
    process.exit(1);
  }
  if (!password) {
    if (!process.stdin.isTTY) { console.error('No password given. Set ADMIN_PASSWORD or run this in a terminal.'); process.exit(1); }
    password = await askHidden('Password (min 10 characters, letters and numbers): ');
  }
  try {
    const admin = await adminAuthService.createAdmin({ fullName, email, password, role });
    console.log(`Created ${admin.roleLabel}: ${admin.fullName} <${admin.email}>`);
  } catch (err) {
    console.error(`Could not create admin: ${err.message}`);
    process.exit(1);
  }
})();
