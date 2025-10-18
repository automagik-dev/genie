#!/usr/bin/env node
/**
 * Test crypto.randomUUID() behavior
 * Checks if UUID generation is truly random or if there's any caching
 */

const crypto = require('crypto');

console.log('=== Crypto UUID Test ===');
console.log('Node version:', process.version);
console.log('');

// Test 1: Generate 10 UUIDs in quick succession
console.log('Test 1: Generate 10 UUIDs rapidly');
const uuids = [];
for (let i = 0; i < 10; i++) {
  const uuid = crypto.randomUUID();
  uuids.push(uuid);
  console.log(`  ${i + 1}. ${uuid}`);
}

// Check for duplicates
const uniqueUuids = new Set(uuids);
console.log('');
console.log(`Generated: ${uuids.length} UUIDs`);
console.log(`Unique: ${uniqueUuids.size} UUIDs`);
console.log(`Result: ${uuids.length === uniqueUuids.size ? '✓ PASS' : '✗ FAIL - DUPLICATES DETECTED!'}`);
console.log('');

// Test 2: Verify randomUUID function exists and is native
console.log('Test 2: Function properties');
console.log(`  typeof crypto.randomUUID: ${typeof crypto.randomUUID}`);
console.log(`  Is native code: ${crypto.randomUUID.toString().includes('[native code]')}`);
console.log('');

// Test 3: Module require behavior
console.log('Test 3: Module caching behavior');
const crypto1 = require('crypto');
const crypto2 = require('crypto');
console.log(`  Same module instance: ${crypto1 === crypto2 ? 'Yes (expected)' : 'No (unexpected)'}`);
console.log(`  randomUUID function identical: ${crypto1.randomUUID === crypto2.randomUUID ? 'Yes (expected)' : 'No (unexpected)'}`);

const uuid1 = crypto1.randomUUID();
const uuid2 = crypto2.randomUUID();
console.log(`  UUID from require #1: ${uuid1}`);
console.log(`  UUID from require #2: ${uuid2}`);
console.log(`  Different values: ${uuid1 !== uuid2 ? '✓ PASS' : '✗ FAIL'}`);
console.log('');

// Test 4: Check if require.cache affects behavior
console.log('Test 4: require.cache impact');
const cacheKey = require.resolve('crypto');
console.log(`  Cache key: ${cacheKey}`);
console.log(`  In cache: ${cacheKey in require.cache ? 'Yes' : 'No'}`);

// Generate UUID, clear cache, generate again
const beforeClear = crypto.randomUUID();
console.log(`  UUID before cache clear: ${beforeClear}`);

// Note: Can't actually clear crypto from cache (it's native)
// But we can test if a fresh require would give same result
const afterClear = crypto.randomUUID();
console.log(`  UUID after (no clear): ${afterClear}`);
console.log(`  Different: ${beforeClear !== afterClear ? '✓ PASS' : '✗ FAIL'}`);
console.log('');

console.log('=== Conclusion ===');
console.log('If all tests pass, crypto.randomUUID() is working correctly.');
console.log('UUID reuse would be caused by application logic, not Node.js crypto module.');
