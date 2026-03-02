#!/usr/bin/env node

/**
 * Bullet ID Generator
 *
 * Generates unique IDs for structured learning bullets.
 * Format: [prefix-NNN] where NNN is zero-padded 3-digit counter.
 *
 * Usage:
 *   genie helper bullet-id file.md
 *   genie helper bullet-id file.md --count=10
 *   genie helper bullet-id file.md --peek (show next without incrementing)
 */

const fs = require('fs');
const path = require('path');

// Maximum bullet ID number (supports 001-999)
const MAX_BULLET_ID = 999;

/**
 * Extract prefix from filename
 * learn.md → learn
 * orchestration-boundary-protocol.md → orchestration
 */
function getFilePrefix(filePath) {
  const basename = path.basename(filePath, '.md');

  // For multi-word files, use first word
  const firstWord = basename.split('-')[0];

  // Lowercase for consistency
  return firstWord.toLowerCase();
}

/**
 * Get cache directory path
 */
function getCacheDir() {
  const cacheDir = path.join(process.cwd(), '.genie', '.cache', 'bullet-ids');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return cacheDir;
}

/**
 * Get cache file path for prefix
 */
function getCachePath(prefix) {
  return path.join(getCacheDir(), `${prefix}.json`);
}

/**
 * Read last ID from cache
 */
function getLastIdFromCache(prefix) {
  const cachePath = getCachePath(prefix);

  if (!fs.existsSync(cachePath)) {
    return 0;
  }

  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    return cache.lastId || 0;
  } catch (err) {
    console.error(`Warning: Cache read failed for ${prefix}, starting from 0`);
    return 0;
  }
}

/**
 * Scan file for highest existing ID
 * Handles cases where file was manually edited
 */
function scanFileForHighestId(filePath, prefix) {
  if (!fs.existsSync(filePath)) {
    return 0;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const pattern = new RegExp(`\\[${prefix}-(\\d{3})\\]`, 'g');

    let highest = 0;
    let match;

    while ((match = pattern.exec(content)) !== null) {
      const idNum = parseInt(match[1], 10);
      if (idNum > highest) {
        highest = idNum;
      }
    }

    return highest;
  } catch (err) {
    console.error(`Warning: Could not scan ${filePath}`);
    return 0;
  }
}

/**
 * Get next ID (reconciles cache and file scan)
 */
function getNextId(filePath, prefix) {
  const cachedId = getLastIdFromCache(prefix);
  const scannedId = scanFileForHighestId(filePath, prefix);

  // Use whichever is higher (handles manual edits)
  const lastId = Math.max(cachedId, scannedId);

  return lastId + 1;
}

/**
 * Save last ID to cache
 */
function saveIdToCache(prefix, lastId) {
  const cachePath = getCachePath(prefix);

  fs.writeFileSync(cachePath, JSON.stringify({
    prefix,
    lastId,
    updated: new Date().toISOString()
  }, null, 2));
}

/**
 * Generate formatted ID
 */
function formatId(prefix, number) {
  const paddedNum = String(number).padStart(3, '0');
  return `${prefix}-${paddedNum}`;
}

/**
 * Generate single ID
 */
function generateSingleId(filePath, peek = false) {
  const prefix = getFilePrefix(filePath);
  const nextNum = getNextId(filePath, prefix);

  if (nextNum > MAX_BULLET_ID) {
    console.error(`ERROR: ID limit reached for ${prefix} (max ${MAX_BULLET_ID})`);
    process.exit(1);
  }

  const id = formatId(prefix, nextNum);

  // Save to cache unless peek mode
  if (!peek) {
    saveIdToCache(prefix, nextNum);
  }

  return id;
}

/**
 * Generate batch of IDs
 */
function generateBatchIds(filePath, count) {
  const prefix = getFilePrefix(filePath);
  let nextNum = getNextId(filePath, prefix);

  if (nextNum + count > MAX_BULLET_ID) {
    console.error(`ERROR: Batch would exceed ID limit for ${prefix} (max ${MAX_BULLET_ID})`);
    process.exit(1);
  }

  const ids = [];
  for (let i = 0; i < count; i++) {
    ids.push(formatId(prefix, nextNum + i));
  }

  // Save final ID to cache
  saveIdToCache(prefix, nextNum + count - 1);

  return ids;
}

/**
 * Main CLI
 */
async function main() {
  const args = process.argv.slice(2);

  // Help
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Usage:');
    console.log('  genie helper bullet-id file.md');
    console.log('    Generate next ID for file');
    console.log('');
    console.log('  genie helper bullet-id file.md --count=10');
    console.log('    Generate batch of 10 IDs');
    console.log('');
    console.log('  genie helper bullet-id file.md --peek');
    console.log('    Show next ID without incrementing');
    console.log('');
    console.log('Examples:');
    console.log('  $ genie helper bullet-id .genie/spells/learn.md');
    console.log('  learn-042');
    console.log('');
    console.log('  $ genie helper bullet-id .genie/spells/learn.md --count=5');
    console.log('  learn-042');
    console.log('  learn-043');
    console.log('  learn-044');
    console.log('  learn-045');
    console.log('  learn-046');
    return;
  }

  const filePath = args[0];
  const countArg = args.find(a => a.startsWith('--count='));
  const peek = args.includes('--peek');

  if (!filePath) {
    console.error('Error: File path required');
    console.error('Usage: genie helper bullet-id file.md');
    process.exit(1);
  }

  // Batch generation
  if (countArg) {
    const count = parseInt(countArg.split('=')[1], 10);
    if (isNaN(count) || count < 1) {
      console.error('Error: Invalid count');
      process.exit(1);
    }

    const ids = generateBatchIds(filePath, count);
    ids.forEach(id => console.log(id));
    return;
  }

  // Single ID generation
  const id = generateSingleId(filePath, peek);
  console.log(id);
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
