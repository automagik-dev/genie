#!/usr/bin/env node
/**
 * Token Efficiency Validator
 *
 * Validates token count hasn't increased >5% without justification
 * Part of self-updating ecosystem (Group C)
 *
 * Usage:
 *   node .genie/scripts/validate-token-count.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Tiktoken } = require('js-tiktoken/lite');
const cl100k_base = require('js-tiktoken/ranks/cl100k_base');

// Configuration
const AGENTS_MD_PATH = path.join(process.cwd(), 'AGENTS.md');
const THRESHOLD_PERCENT = 5;

// Initialize tiktoken encoder (cl100k_base for GPT-4/3.5-turbo)
const encoder = new Tiktoken(cl100k_base);

/**
 * Count tokens using tiktoken (accurate GPT-4 token counting)
 */
function countTokens(text) {
  return encoder.encode(text).length;
}

/**
 * Extract @ references from markdown content
 */
function extractAtReferences(content) {
  const matches = content.match(/@[\w/./-]+\.md/g) || [];
  return [...new Set(matches.map(ref => ref.substring(1)))];
}

/**
 * Resolve file path
 */
function resolveFilePath(refPath, basePath) {
  if (refPath.startsWith('.')) {
    return path.resolve(basePath, refPath);
  }
  return path.resolve(process.cwd(), refPath);
}

/**
 * Count tokens with recursive @ reference resolution
 */
function countTokensWithRefs(filePath, visited = new Set(), depth = 0) {
  const normalizedPath = path.normalize(filePath);

  // Prevent circular references
  if (visited.has(normalizedPath)) {
    return 0;
  }
  visited.add(normalizedPath);

  // Max depth safeguard
  if (depth > 10) {
    return 0;
  }

  // Check file exists
  if (!fs.existsSync(filePath)) {
    return 0;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  let totalTokens = countTokens(content);

  // Recursively count referenced files
  const basePath = path.dirname(filePath);
  const atRefs = extractAtReferences(content);

  for (const ref of atRefs) {
    const childPath = resolveFilePath(ref, basePath);
    totalTokens += countTokensWithRefs(childPath, visited, depth + 1);
  }

  return totalTokens;
}

/**
 * Extract baseline token count from AGENTS.md agent graph section
 */
function extractBaseline() {
  if (!fs.existsSync(AGENTS_MD_PATH)) {
    console.error(`❌ AGENTS.md not found at ${AGENTS_MD_PATH}`);
    return null;
  }

  const content = fs.readFileSync(AGENTS_MD_PATH, 'utf8');

  // Look for "**Total Tokens:** X (baseline for efficiency validation)"
  const match = content.match(/\*\*Total Tokens:\*\* ([\d,]+)/);

  if (!match) {
    console.warn('⚠️  No baseline found in AGENTS.md');
    console.warn('   Run: node .genie/scripts/update-agent-graph.js');
    return null;
  }

  // Remove commas and parse
  const baseline = parseInt(match[1].replace(/,/g, ''), 10);
  return baseline;
}

/**
 * Check for override flag
 */
function checkOverride() {
  try {
    const override = execSync('git config commit.token-override', { encoding: 'utf8' }).trim();
    return override || null;
  } catch (error) {
    // No override set
    return null;
  }
}

/**
 * Clear override flag
 */
function clearOverride() {
  try {
    execSync('git config --unset commit.token-override', { stdio: 'ignore' });
  } catch (error) {
    // Ignore errors (flag might not exist)
  }
}

/**
 * Main validation logic
 */
function validate(dryRun = false) {
  console.log('🔍 Token Efficiency Validator');
  console.log('');

  if (dryRun) {
    console.log('Mode: DRY RUN (no git config changes)');
    console.log('');
  }

  // Get baseline
  const baseline = extractBaseline();
  if (!baseline) {
    console.error('❌ Cannot validate without baseline');
    console.error('   Run: node .genie/scripts/update-agent-graph.js');
    process.exit(1);
  }

  console.log(`📊 Baseline: ${baseline.toLocaleString()} tokens`);

  // Count current tokens
  console.log('📊 Counting current tokens with @ resolution...');
  const current = countTokensWithRefs(AGENTS_MD_PATH);
  console.log(`📊 Current: ${current.toLocaleString()} tokens`);

  // Calculate change
  const change = current - baseline;
  const changePercent = ((change / baseline) * 100).toFixed(2);

  console.log('');
  console.log(`📈 Change: ${change >= 0 ? '+' : ''}${change.toLocaleString()} tokens (${changePercent}%)`);
  console.log('');

  // Check if increase exceeds threshold
  if (change > 0 && Math.abs(parseFloat(changePercent)) > THRESHOLD_PERCENT) {
    // Check for override
    const override = checkOverride();

    if (override) {
      console.log('✅ Token increase justified:');
      console.log(`   "${override}"`);
      console.log('');

      if (!dryRun) {
        // Clear override after use
        clearOverride();
        console.log('ℹ️  Override flag cleared (one-time use)');
      }

      console.log('');
      console.log('⚠️  Remember to update baseline:');
      console.log('   node .genie/scripts/update-agent-graph.js');
      process.exit(0);
    }

    // Block commit
    console.error(`❌ Token count increased by ${changePercent}% (threshold: ${THRESHOLD_PERCENT}%)`);
    console.error('');
    console.error('If this increase is justified:');
    console.error(`  git config commit.token-override "Reason for increase"`);
    console.error('  git commit ...');
    console.error('');
    console.error('Or reduce token count to stay within threshold.');
    process.exit(1);
  }

  // Validation passed
  if (change > 0) {
    console.log(`✅ Token efficiency validated (increase: ${changePercent}%, within ${THRESHOLD_PERCENT}% threshold)`);
  } else if (change < 0) {
    console.log(`✅ Token efficiency improved (reduction: ${changePercent}%)`);
  } else {
    console.log('✅ Token count unchanged');
  }

  process.exit(0);
}

/**
 * Show help
 */
function showHelp() {
  console.log('Token Efficiency Validator');
  console.log('');
  console.log('Usage:');
  console.log('  node .genie/scripts/validate-token-count.js [--dry-run]');
  console.log('');
  console.log('Options:');
  console.log('  --dry-run    Preview validation without clearing override flag');
  console.log('  --help, -h   Show this help message');
  console.log('');
  console.log('Description:');
  console.log('  Validates token count hasn\'t increased >5% without justification');
  console.log('  Counts tokens using tiktoken (GPT-4 accurate) with recursive @ resolution');
  console.log('  Compares against baseline from AGENTS.md agent graph');
  console.log('  Blocks commit if increase exceeds threshold without override');
  console.log('');
  console.log('Override mechanism:');
  console.log('  git config commit.token-override "Reason for increase"');
  console.log('  (Override is automatically cleared after successful validation)');
  console.log('');
  console.log('Exit codes:');
  console.log('  0 - Validation passed');
  console.log('  1 - Validation failed or error');
  process.exit(0);
}

// Parse arguments
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  showHelp();
}

const dryRun = process.argv.includes('--dry-run');

// Run validation
try {
  validate(dryRun);
} catch (error) {
  console.error('❌ Validation error:', error.message);
  console.error(error.stack);
  process.exit(1);
}
