'use strict';
// Compiles and runs the C++ unit tests for the DSA structures and the queue engine (cpp_engine/tests).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { ensureTestBinary } = require('../scripts/buildEngine');

test('C++ unit tests: FifoQueue, MinHeap, HashMap and QueueEngine', () => {
  const bin = ensureTestBinary();
  const run = spawnSync(bin, [], { encoding: 'utf8' });
  const summary = (run.stdout || '').trim().split('\n').pop();
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(summary, /\d+ tests, \d+ checks, 0 failed/);
  console.log(`# ${summary}`);
});
