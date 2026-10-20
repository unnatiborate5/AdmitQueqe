'use strict';
// Compiles and runs the C++ unit tests (cpp_engine/tests):
//   test_engine   Phase 4: FifoQueue, MinHeap, HashMap, QueueEngine
//   test_toolkit  Phase 5: merge sort, binary/linear search, Stack, dense/sparse matrices, search index, planner, undo stacks
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { ensureTestBinary, TEST_NAMES } = require('../scripts/buildEngine');

assert.deepEqual(TEST_NAMES, ['test_engine', 'test_toolkit']);

for (const name of TEST_NAMES) {
  test(`C++ unit tests: ${name}`, () => {
    const run = spawnSync(ensureTestBinary(name), [], { encoding: 'utf8' });
    const summary = (run.stdout || '').trim().split('\n').pop();
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(summary, /\d+ tests, \d+ checks, 0 failed/);
    console.log(`# ${name}: ${summary}`);
  });
}
