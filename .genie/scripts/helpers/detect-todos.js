#!/usr/bin/env node

/**
 * TODO/FIXME Marker Detection
 *
 * Scans markdown files for incomplete work markers:
 * - TODO, FIXME, XXX, HACK, TBD, WIP
 * - "Coming soon", placeholder text
 * - Git merge conflict markers
 *
 * Usage:
 *   node detect-todos.js [path]
 *   (defaults to .genie/ if no path provided)
 */

const fs = require('fs');
const path = require('path');

// Marker patterns (case-insensitive)
const MARKERS = {
  todo: /\bTODO:?/i,
  fixme: /\bFIXME:?/i,
  xxx: /\bXXX:?/i,
  hack: /\bHACK:?/i,
  tbd: /\bTBD:?/i,
  wip: /\bWIP:?/i,
};

const PLACEHOLDER_PATTERNS = [
  /\bcoming soon\b/i,
  /\bto be documented\b/i,
  /\bfill this in later\b/i,
  /\[placeholder\]/i,
  /\blorem ipsum\b/i,
  /\bTODO:\s*write this section\b/i,
];

const CONFLICT_MARKERS = [
  /^<<<<<<< /m,
  /^=======$/m,
  /^>>>>>>> /m,
  /^\|\|\|\|\|\|\| /m,
];

// Results tracking
const results = {
  totalFiles: 0,
  scannedFiles: 0,
  issues: [],
  skipped: [],
};

/**
 * Check if file should be scanned
 */
function shouldScan(filePath) {
  const excludePatterns = [
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '/backups/',
    'detect-todos.js', // Don't scan self
    'GARBAGE-DETECTION-IDEAS.md', // Ideas doc has intentional TODOs
  ];

  return !excludePatterns.some(pattern => filePath.includes(pattern));
}

/**
 * Check if line is inside code block
 */
function isInCodeBlock(lines, lineIndex) {
  let inCodeBlock = false;
  for (let i = 0; i < lineIndex; i++) {
    if (lines[i].trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }
  }
  return inCodeBlock;
}

/**
 * Scan file for markers
 */
function scanFile(filePath) {
  results.totalFiles++;

  if (!shouldScan(filePath)) {
    results.skipped.push({ file: filePath, reason: 'Excluded path' });
    return;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    results.scannedFiles++;

    lines.forEach((line, index) => {
      const lineNum = index + 1;
      const inCodeBlock = isInCodeBlock(lines, index);

      // Skip code blocks for markers (but not conflict markers)
      if (!inCodeBlock) {
        // Check TODO/FIXME/etc markers
        for (const [type, pattern] of Object.entries(MARKERS)) {
          if (pattern.test(line)) {
            results.issues.push({
              file: filePath,
              line: lineNum,
              type: `marker_${type}`,
              severity: 'warning',
              content: line.trim(),
              message: `${type.toUpperCase()} marker found`,
              suggestion: 'Complete the work or remove the marker',
            });
          }
        }

        // Check placeholder patterns
        for (const pattern of PLACEHOLDER_PATTERNS) {
          if (pattern.test(line)) {
            results.issues.push({
              file: filePath,
              line: lineNum,
              type: 'placeholder_text',
              severity: 'warning',
              content: line.trim(),
              message: 'Placeholder text found',
              suggestion: 'Complete the content or remove the placeholder',
            });
            break; // Only report first match per line
          }
        }
      }

      // Check conflict markers (even in code blocks)
      for (const pattern of CONFLICT_MARKERS) {
        if (pattern.test(line)) {
          results.issues.push({
            file: filePath,
            line: lineNum,
            type: 'merge_conflict',
            severity: 'error',
            content: line.trim(),
            message: 'Git merge conflict marker found',
            suggestion: 'Resolve the conflict immediately',
          });
          break;
        }
      }
    });

  } catch (err) {
    results.issues.push({
      file: filePath,
      type: 'read_error',
      message: `Failed to read file: ${err.message}`,
      severity: 'error',
    });
  }
}

/**
 * Recursively scan directory
 */
function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      scanDirectory(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      scanFile(fullPath);
    }
  }
}

/**
 * Generate report
 */
function generateReport() {
  console.log('\n=== TODO/FIXME Detection Report ===\n');

  console.log(`Total files: ${results.totalFiles}`);
  console.log(`Scanned: ${results.scannedFiles}`);
  console.log(`Issues found: ${results.issues.length}`);
  console.log(`Skipped: ${results.skipped.length}\n`);

  if (results.issues.length === 0) {
    console.log('✅ No TODO/FIXME markers found!\n');
    return 0;
  }

  // Group by severity
  const errors = results.issues.filter(i => i.severity === 'error');
  const warnings = results.issues.filter(i => i.severity === 'warning');

  if (errors.length > 0) {
    console.log(`🔴 ERRORS (${errors.length}):\n`);
    errors.forEach(issue => {
      console.log(`  ${issue.file}:${issue.line || '?'}`);
      console.log(`    Type: ${issue.type}`);
      console.log(`    Message: ${issue.message}`);
      console.log(`    Content: ${issue.content}`);
      console.log(`    Suggestion: ${issue.suggestion}`);
      console.log('');
    });
  }

  if (warnings.length > 0) {
    console.log(`⚠️  WARNINGS (${warnings.length}):\n`);
    warnings.forEach(issue => {
      console.log(`  ${issue.file}:${issue.line || '?'}`);
      console.log(`    Type: ${issue.type}`);
      console.log(`    Content: ${issue.content}`);
      console.log('');
    });
  }

  // Summary by type
  console.log('\n=== Summary by Type ===\n');
  const byType = {};
  results.issues.forEach(issue => {
    byType[issue.type] = (byType[issue.type] || 0) + 1;
  });

  Object.entries(byType).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
  });

  console.log('');
  return errors.length > 0 ? 1 : 0;
}

/**
 * Main
 */
function main() {
  const targetPath = process.argv[2] || '.genie';

  if (!fs.existsSync(targetPath)) {
    console.error(`Error: Path not found: ${targetPath}`);
    process.exit(1);
  }

  console.log(`Scanning: ${targetPath}\n`);

  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    scanDirectory(targetPath);
  } else if (targetPath.endsWith('.md')) {
    scanFile(targetPath);
  } else {
    console.error('Error: Target must be a directory or .md file');
    process.exit(1);
  }

  const exitCode = generateReport();
  process.exit(exitCode);
}

main();
