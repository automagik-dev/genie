const assert = require('assert');
const {
  recordRuntimeWarning,
  getRuntimeWarnings,
  clearRuntimeWarnings,
  resolveDisplayStatus
} = require('../.genie/cli/dist/lib/session-helpers.js');

// Test: recordRuntimeWarning and getRuntimeWarnings
(function testRecordAndGetRuntimeWarnings() {
  clearRuntimeWarnings(); // Clear any previous warnings
  recordRuntimeWarning('Test warning 1');
  recordRuntimeWarning('Test warning 2');
  const warnings = getRuntimeWarnings();
  assert.ok(Array.isArray(warnings), 'should return an array');
  assert.ok(warnings.includes('Test warning 1'), 'should include first warning');
  assert.ok(warnings.includes('Test warning 2'), 'should include second warning');
  clearRuntimeWarnings();
})();

// Test: clearRuntimeWarnings
(function testClearRuntimeWarnings() {
  recordRuntimeWarning('Test warning');
  clearRuntimeWarnings();
  const warnings = getRuntimeWarnings();
  assert.strictEqual(warnings.length, 0, 'should clear all warnings');
})();

// Test: getRuntimeWarnings returns copy
(function testGetRuntimeWarningsReturnsCopy() {
  clearRuntimeWarnings();
  recordRuntimeWarning('Test warning');
  const warnings1 = getRuntimeWarnings();
  warnings1.push('Modified warning');
  const warnings2 = getRuntimeWarnings();
  assert.strictEqual(warnings2.length, 1, 'modifying returned array should not affect original');
  assert.strictEqual(warnings2[0], 'Test warning', 'original warning should be preserved');
  clearRuntimeWarnings();
})();

// Test: resolveDisplayStatus with running status and executor running
(function testResolveDisplayStatusRunning() {
  const entry = {
    status: 'running',
    executorPid: 999999, // Non-existent PID, will be false when checked
    runnerPid: undefined,
    exitCode: undefined
  };
  const status = resolveDisplayStatus(entry);
  // Since PIDs are non-existent, should detect as stopped or check exit code
  assert.ok(typeof status === 'string', 'should return a string status');
})();

// Test: resolveDisplayStatus with completed status
(function testResolveDisplayStatusCompleted() {
  const entry = {
    status: 'completed',
    executorPid: undefined,
    runnerPid: undefined,
    exitCode: 0
  };
  const status = resolveDisplayStatus(entry);
  assert.strictEqual(status, 'completed', 'should return completed for completed status');
})();

// Test: resolveDisplayStatus with failed status
(function testResolveDisplayStatusFailed() {
  const entry = {
    status: 'failed',
    executorPid: undefined,
    runnerPid: undefined,
    exitCode: 1
  };
  const status = resolveDisplayStatus(entry);
  assert.strictEqual(status, 'failed', 'should return failed for failed status');
})();

// Test: resolveDisplayStatus with unknown status
(function testResolveDisplayStatusUnknown() {
  const entry = {
    status: undefined,
    executorPid: undefined,
    runnerPid: undefined,
    exitCode: undefined
  };
  const status = resolveDisplayStatus(entry);
  assert.strictEqual(status, 'unknown', 'should return unknown for undefined status');
})();

// Test: resolveDisplayStatus with exit code 0
(function testResolveDisplayStatusWithExitCode0() {
  const entry = {
    status: 'running',
    executorPid: undefined,
    runnerPid: undefined,
    exitCode: 0
  };
  const status = resolveDisplayStatus(entry);
  assert.strictEqual(status, 'completed', 'should return completed when exit code is 0');
})();

// Test: resolveDisplayStatus with non-zero exit code
(function testResolveDisplayStatusWithNonZeroExitCode() {
  const entry = {
    status: 'running',
    executorPid: undefined,
    runnerPid: undefined,
    exitCode: 1
  };
  const status = resolveDisplayStatus(entry);
  assert.strictEqual(status, 'failed (1)', 'should return failed with exit code');
})();

// Test: resolveDisplayStatus with runner still running
(function testResolveDisplayStatusPendingCompletion() {
  const entry = {
    status: 'running',
    executorPid: undefined, // Executor stopped
    runnerPid: process.pid, // Runner still running (use current process PID as it exists)
    exitCode: undefined
  };
  const status = resolveDisplayStatus(entry);
  assert.strictEqual(status, 'pending-completion', 'should return pending-completion when executor stopped but runner running');
})();

// Test: resolveDisplayStatus with no PIDs and no exit code
(function testResolveDisplayStatusStopped() {
  const entry = {
    status: 'running',
    executorPid: undefined,
    runnerPid: undefined,
    exitCode: undefined
  };
  const status = resolveDisplayStatus(entry);
  assert.strictEqual(status, 'stopped', 'should return stopped when no process is running and no exit code');
})();

console.log('✅ session-helpers tests passed');
