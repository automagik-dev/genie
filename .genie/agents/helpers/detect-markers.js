#!/usr/bin/env node

/**
 * TODO/FIXME/WIP Marker Detector
 *
 * Scans files for incomplete work markers:
 * - TODO, FIXME, XXX, HACK, WIP, TBD
 * - Placeholder text patterns
 *
 * Usage:
 *   node detect-markers.js [path]
 *   (defaults to current directory if no path provided)
 */

const fs = require('fs');
const path = require('path');

// Marker patterns
const MARKERS = {
  todo: /\bTODO\b:?/gi,
  fixme: /\bFIXME\b:?/gi,
  xxx: /\bXXX\b:?/gi,
  hack: /\bHACK\b:?/gi,
  wip: /\bWIP\b:?/gi,
  tbd: /\bTBD\b:?/gi,
};

const PLACEHOLDER_PATTERNS = [
  /coming soon/gi,
  /to be documented/gi,
  /fill this in later/gi,
  /\[placeholder\]/gi,
  /lorem ipsum/gi,
  /TODO: write this section/gi,
];

// Git conflict markers (CRITICAL)
const CONFLICT_MARKERS = [
  /^<<<<<<< /m,
  /^=======/m,
  /^>>>>>>> /m,
  /^\|\|\|\|\|\|\| merged common ancestors/m,
];

// Configuration
const EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '/backups/',
  '.min.js',
  '.bundle.js',
];

// File extensions to scan
const SCAN_EXTENSIONS = ['.md', '.js', '.ts', '.jsx', '.tsx', '.json', '.yaml', '.yml'];

// Results
const results = {
  totalFiles: 0,
  scannedFiles: 0,
  issues: [],
  summary: {
    markers: {},
    placeholders: 0,
    conflicts: 0,
  },
};

/**
 * Should scan this file?
 */
function shouldScan(filePath) {
  // Check exclusions
  if (EXCLUDE_PATTERNS.some(pattern => filePath.includes(pattern))) {
    return false;
  }

  // Check extension
  const ext = path.extname(filePath);
  return SCAN_EXTENSIONS.includes(ext);
}

/**
 * Check if line is inside code block (markdown)
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
 * Scan single file
 */
function scanFile(filePath) {
  results.totalFiles++;

  if (!shouldScan(filePath)) {
    return;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const isMarkdown = filePath.endsWith('.md');

    results.scannedFiles++;

    lines.forEach((line, index) => {
      const lineNum = index + 1;

      // Skip code blocks in markdown (intentional examples)
      if (isMarkdown && isInCodeBlock(lines, index)) {
        return;
      }

      // Check for git conflict markers (CRITICAL)
      CONFLICT_MARKERS.forEach(pattern => {
        if (pattern.test(line)) {
          results.issues.push({
            file: filePath,
            line: lineNum,
            type: 'conflict_marker',
            severity: 'critical',
            content: line.trim(),
            message: 'Unresolved git merge conflict marker',
          });
          results.summary.conflicts++;
        }
      });

      // Check for TODO/FIXME markers
      Object.entries(MARKERS).forEach(([type, pattern]) => {
        const match = line.match(pattern);
        if (match) {
          results.issues.push({
            file: filePath,
            line: lineNum,
            type: `marker_${type}`,
            severity: 'warning',
            content: line.trim(),
            message: `${type.toUpperCase()} marker found`,
          });
          results.summary.markers[type] = (results.summary.markers[type] || 0) + 1;
        }
      });

      // Check for placeholder text
      PLACEHOLDER_PATTERNS.forEach(pattern => {
        const match = line.match(pattern);
        if (match) {
          results.issues.push({
            file: filePath,
            line: lineNum,
            type: 'placeholder',
            severity: 'warning',
            content: line.trim(),
            message: `Placeholder text: "${match[0]}"`,
          });
          results.summary.placeholders++;
        }
      });
    });

  } catch (err) {
    console.error(`Error scanning ${filePath}: ${err.message}`);
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
    } else if (entry.isFile()) {
      scanFile(fullPath);
    }
  }
}

/**
 * Generate report
 */
function generateReport() {
  console.log('\n=== TODO/FIXME/Placeholder Detection Report ===\n');

  console.log(`Total files: ${results.totalFiles}`);
  console.log(`Scanned: ${results.scannedFiles}`);
  console.log(`Issues found: ${results.issues.length}\n`);

  if (results.issues.length === 0) {
    console.log('✅ No markers or placeholders found!\n');
    return 0;
  }

  // Group by severity
  const critical = results.issues.filter(i => i.severity === 'critical');
  const warnings = results.issues.filter(i => i.severity === 'warning');

  // Show critical first
  if (critical.length > 0) {
    console.log(`🔴 CRITICAL (${critical.length}):\n`);
    critical.forEach(issue => {
      console.log(`  ${issue.file}:${issue.line}`);
      console.log(`    ${issue.message}`);
      console.log(`    Content: ${issue.content}`);
      console.log('');
    });
  }

  // Show warnings
  if (warnings.length > 0) {
    console.log(`⚠️  WARNINGS (${warnings.length}):\n`);

    // Group by type for cleaner output
    const byType = {};
    warnings.forEach(issue => {
      if (!byType[issue.type]) byType[issue.type] = [];
      byType[issue.type].push(issue);
    });

    Object.entries(byType).forEach(([type, issues]) => {
      console.log(`  ${type.toUpperCase()} (${issues.length}):`);
      issues.forEach(issue => {
        console.log(`    ${issue.file}:${issue.line} - ${issue.content.substring(0, 80)}`);
      });
      console.log('');
    });
  }

  // Summary
  console.log('\n=== Summary ===\n');

  if (results.summary.conflicts > 0) {
    console.log(`  🔴 Conflict markers: ${results.summary.conflicts} (CRITICAL - FIX IMMEDIATELY)`);
  }

  const totalMarkers = Object.values(results.summary.markers).reduce((a, b) => a + b, 0);
  if (totalMarkers > 0) {
    console.log(`  ⚠️  TODO/FIXME markers: ${totalMarkers}`);
    Object.entries(results.summary.markers).forEach(([type, count]) => {
      console.log(`      ${type.toUpperCase()}: ${count}`);
    });
  }

  if (results.summary.placeholders > 0) {
    console.log(`  ⚠️  Placeholder text: ${results.summary.placeholders}`);
  }

  console.log('');

  // Exit code: 1 if critical issues found, 0 otherwise
  return critical.length > 0 ? 1 : 0;
}

/**
 * Main
 */
function main() {
  const targetPath = process.argv[2] || '.';

  if (!fs.existsSync(targetPath)) {
    console.error(`Error: Path not found: ${targetPath}`);
    process.exit(1);
  }

  console.log(`Scanning: ${targetPath}\n`);

  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    scanDirectory(targetPath);
  } else {
    scanFile(targetPath);
  }

  const exitCode = generateReport();
  process.exit(exitCode);
}

main();
