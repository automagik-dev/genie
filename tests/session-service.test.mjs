#!/usr/bin/env node
/**
 * SessionService Unit Tests
 *
 * Tests production-grade file locking, atomic writes, stale lock reclamation,
 * and concurrent write handling.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { SessionService } = await import('../.genie/cli/dist/cli-core/session-service.js');

const TEST_DIR = path.join(__dirname, '.tmp-session-tests');
const TEST_SESSION_FILE = path.join(TEST_DIR, 'sessions.json');

let testsPassed = 0;
let testsFailed = 0;

// Helper to create test directory
function setupTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

// Helper to cleanup test directory
function cleanupTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// Test assertion helper
function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    testsFailed++;
    throw new Error(message);
  }
  testsPassed++;
}

// Test 1: Basic load/save cycle
async function testBasicLoadSave() {
  console.log('\n=== Test 1: Basic Load/Save ===');
  setupTestDir();

  const service = new SessionService({
    paths: { sessionsFile: TEST_SESSION_FILE },
    defaults: {}
  });

  // Initial load should create empty store (v3 format after migration)
  const store1 = service.load();
  assert(store1.version === 3, 'Initial store has version 3');
  assert(Object.keys(store1.sessions || store1.agents || {}).length === 0, 'Initial store has no sessions');

  // Add an agent and save
  store1.sessions['test-agent'] = {
    agent: 'test-agent',
    status: 'running',
    sessionId: 'test-123',
    created: new Date().toISOString()
  };

  const result = await service.save(store1);
  assert(result.store.sessions['test-agent'].status === 'running', 'Agent saved with correct status');

  // Load again and verify persistence
  const store2 = service.load();
  assert(store2.sessions['test-agent'].sessionId === 'test-123', 'Agent persisted correctly');

  cleanupTestDir();
  console.log('✅ Test 1 passed');
}

// Test 2: Atomic write protection (no partial reads)
async function testAtomicWrites() {
  console.log('\n=== Test 2: Atomic Write Protection ===');
  setupTestDir();

  const service = new SessionService({
    paths: { sessionsFile: TEST_SESSION_FILE },
    defaults: {}
  });

  const store = service.load();
  store.sessions['agent1'] = { agent: 'agent1', status: 'running' };

  // Save and immediately check file integrity
  await service.save(store);

  // File should be complete JSON, not partial
  const fileContent = fs.readFileSync(TEST_SESSION_FILE, 'utf8');
  let parsed = null;
  try {
    parsed = JSON.parse(fileContent);
    assert(true, 'File contains complete JSON after save');
  } catch (err) {
    assert(false, `File should contain complete JSON, got parse error: ${err.message}`);
  }

  assert(parsed.sessions['agent1'].status === 'running', 'Atomic write preserves complete data');

  // Verify no .tmp file left behind
  const tmpFile = TEST_SESSION_FILE + '.tmp';
  assert(!fs.existsSync(tmpFile), 'Temporary file cleaned up after save');

  cleanupTestDir();
  console.log('✅ Test 2 passed');
}

// Test 3: Stale lock reclamation
async function testStaleLockReclamation() {
  console.log('\n=== Test 3: Stale Lock Reclamation ===');
  setupTestDir();

  const service = new SessionService({
    paths: { sessionsFile: TEST_SESSION_FILE },
    defaults: {},
    onWarning: (msg) => console.log(`  [Warning] ${msg}`)
  });

  // Create a stale lock file (>30 seconds old)
  const lockPath = TEST_SESSION_FILE + '.lock';
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 99999, // Non-existent PID
    timestamp: Date.now() - 35000, // 35 seconds ago
    host: os.hostname()
  }), 'utf8');

  // Force the mtime to be old
  const oldTime = Date.now() - 35000;
  fs.utimesSync(lockPath, oldTime / 1000, oldTime / 1000);

  // Save should reclaim the stale lock
  const store = service.load();
  store.sessions['agent1'] = { agent: 'agent1', status: 'running' };

  await service.save(store);
  assert(true, 'Save succeeded despite stale lock file');

  // Lock should be cleaned up after save
  assert(!fs.existsSync(lockPath), 'Stale lock file removed after save');

  cleanupTestDir();
  console.log('✅ Test 3 passed');
}

// Test 4: Fresh reload before merge (prevents data loss)
async function testFreshReloadBeforeMerge() {
  console.log('\n=== Test 4: Fresh Reload Before Merge ===');
  setupTestDir();

  const service = new SessionService({
    paths: { sessionsFile: TEST_SESSION_FILE },
    defaults: {}
  });

  // Initial save with agent1
  const store1 = service.load();
  store1.sessions['agent1'] = { agent: 'agent1', status: 'running', data: 'original' };
  await service.save(store1);

  // Simulate concurrent modification directly to file
  const diskStore = JSON.parse(fs.readFileSync(TEST_SESSION_FILE, 'utf8'));
  diskStore.sessions['agent2'] = { agent: 'agent2', status: 'completed' };
  fs.writeFileSync(TEST_SESSION_FILE, JSON.stringify(diskStore, null, 2), 'utf8');

  // Now save with stale store1 (should reload and merge)
  store1.sessions['agent1'].status = 'completed'; // Update agent1
  const result = await service.save(store1);

  // Both agents should be present (fresh reload preserved agent2)
  assert(result.store.sessions['agent1'].status === 'completed', 'agent1 updated correctly');
  assert(result.store.sessions['agent2'].status === 'completed', 'agent2 preserved from disk');

  cleanupTestDir();
  console.log('✅ Test 4 passed');
}

// Test 5: Concurrent writes (multiple saves in parallel)
async function testConcurrentWrites() {
  console.log('\n=== Test 5: Concurrent Writes ===');
  setupTestDir();

  const service = new SessionService({
    paths: { sessionsFile: TEST_SESSION_FILE },
    defaults: {}
  });

  // Start 5 concurrent saves
  const promises = [];
  for (let i = 1; i <= 5; i++) {
    const store = service.load();
    store.sessions[`agent${i}`] = {
      agent: `agent${i}`,
      status: 'running',
      data: `data-${i}`,
      sessionId: `agent${i}`
    };
    promises.push(service.save(store));
  }

  // Wait for all to complete
  await Promise.all(promises);

  // Load final state
  const finalStore = service.load();

  // All 5 agents should be present (no data loss)
  for (let i = 1; i <= 5; i++) {
    assert(
      finalStore.sessions[`agent${i}`] !== undefined,
      `agent${i} preserved in concurrent writes`
    );
  }

  assert(Object.keys(finalStore.sessions).length === 5, 'All 5 agents persisted');

  cleanupTestDir();
  console.log('✅ Test 5 passed');
}

// Test 6: Lock retry on contention
async function testLockRetry() {
  console.log('\n=== Test 6: Lock Retry on Contention ===');
  setupTestDir();

  const service = new SessionService({
    paths: { sessionsFile: TEST_SESSION_FILE },
    defaults: {}
  });

  // Create a lock file (simulating another process)
  const lockPath = TEST_SESSION_FILE + '.lock';
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    timestamp: Date.now(),
    host: os.hostname()
  }), 'utf8');

  // Release lock after 200ms
  setTimeout(() => {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  }, 200);

  // This save should retry and eventually succeed
  const store = service.load();
  store.sessions['agent1'] = { agent: 'agent1', status: 'running' };

  const startTime = Date.now();
  await service.save(store);
  const duration = Date.now() - startTime;

  assert(duration >= 200, 'Save waited for lock release (retry mechanism)');
  assert(duration < 1000, 'Save completed within reasonable time');

  cleanupTestDir();
  console.log('✅ Test 6 passed');
}

// Run all tests
async function runAllTests() {
  console.log('Starting SessionService Unit Tests...\n');

  try {
    await testBasicLoadSave();
    await testAtomicWrites();
    await testStaleLockReclamation();
    await testFreshReloadBeforeMerge();
    await testConcurrentWrites();
    await testLockRetry();

    console.log(`\n========================================`);
    console.log(`✅ All tests passed: ${testsPassed}/${testsPassed + testsFailed}`);
    console.log(`========================================\n`);
    process.exit(0);
  } catch (err) {
    console.error(`\n========================================`);
    console.error(`❌ Tests failed: ${testsFailed} failures, ${testsPassed} passed`);
    console.error(`Error: ${err.message}`);
    console.error(`========================================\n`);
    process.exit(1);
  }
}

runAllTests();
