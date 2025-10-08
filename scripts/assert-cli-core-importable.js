#!/usr/bin/env node
/**
 * Assert that cli-core module can be imported without side effects
 *
 * Genie RISK-1 mitigation: Verify that importing cli-core does NOT execute CLI main()
 */

const assert = require('assert');

console.log('Testing cli-core importability (no side effects)...');

// Track if main() was called (it shouldn't be)
let mainExecuted = false;
const originalExit = process.exit;
process.exit = (...args) => {
  mainExecuted = true;
  console.error('ERROR: process.exit() called during import - main() executed!');
  originalExit(...args);
};

try {
  // Import cli-core - should NOT trigger main() execution
  const cliCore = require('../.genie/cli/dist/cli-core');

  // Verify exports exist
  assert.strictEqual(typeof cliCore.SessionService, 'function', 'SessionService should be exported');
  assert.strictEqual(typeof cliCore.createHandlers, 'function', 'createHandlers should be exported');

  // Verify no side effects
  assert.strictEqual(mainExecuted, false, 'main() should NOT execute on import');

  // Restore original exit before our own exit
  process.exit = originalExit;

  console.log('✅ cli-core is importable without side effects');
  console.log('✅ SessionService exported');
  console.log('✅ createHandlers exported');
  console.log('✅ No main() execution detected');

  process.exit(0);
} catch (err) {
  process.exit = originalExit;
  console.error('❌ Importability check failed:', err.message);
  process.exit(1);
}
