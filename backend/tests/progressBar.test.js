'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const frontend = path.join(__dirname, '..', '..', 'frontend');

test('shared progress bar renders one green-capable segment for each completed admission task', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(frontend, 'js', 'ui.js'), 'utf8'), sandbox);
  const statuses = ['completed', 'approved', 'approved', 'approved', 'approved', 'approved'];
  const html = sandbox.window.UI.segmentedBar(statuses);
  assert.equal((html.match(/class="seg /g) || []).length, 6);
  assert.equal((html.match(/seg approved/g) || []).length, 5);
  assert.match(fs.readFileSync(path.join(frontend, 'css', 'style.css'), 'utf8'), /\.seg\.completed, \.seg\.approved \{ background: var\(--af-done\); \}/);
});
