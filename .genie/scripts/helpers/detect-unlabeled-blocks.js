#!/usr/bin/env node

/**
 * Detect Unlabeled Code Blocks Helper
 *
 * Find fenced code blocks without language identifiers.
 * Detects ``` without language specification (should be ```bash, ```typescript, etc.)
 *
 * Usage:
 *   node detect-unlabeled-blocks.js <file-path>     # Check single file
 *   node detect-unlabeled-blocks.js <directory>     # Check all .md files recursively
 *
 * Output:
 *   <file>:<line>: Unlabeled code block (missing language identifier)
 */

const fs = require('fs');
const path = require('path');

/**
 * Detect unlabeled code blocks in file content
 * Returns: [{ line, content }]
 */
function detectUnlabeledBlocks(content) {
  const lines = content.split('\n');
  const issues = [];

  lines.forEach((line, idx) => {
    // Match ``` at start of line with optional whitespace
    // But NOT ```language or ``` followed by text on same line
    if (/^```\s*$/.test(line.trim())) {
      issues.push({
        line: idx + 1,
        content: line.trim(),
      });
    }
  });

  return issues;
}

/**
 * Check single file
 */
function checkFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const issues = detectUnlabeledBlocks(content);

    return issues.map(issue => ({
      file: filePath,
      line: issue.line,
      content: issue.content,
    }));
  } catch (err) {
    return [{ file: filePath, error: `Failed to read file: ${err.message}` }];
  }
}

/**
 * Check all .md files in directory
 */
function checkDirectory(dirPath) {
  const allIssues = [];

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    entries.forEach(entry => {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const issues = checkFile(fullPath);
        allIssues.push(...issues);
      }
    });
  }

  scanDir(dirPath);
  return allIssues;
}

/**
 * Main
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(`
Usage:
  node detect-unlabeled-blocks.js <file-path>     # Check single file
  node detect-unlabeled-blocks.js <directory>     # Check all .md files recursively

Output:
  <file>:<line>: Unlabeled code block (missing language identifier)

Exit code:
  0 = All code blocks labeled
  1 = Unlabeled blocks found
`);
    process.exit(1);
  }

  const target = args[0];

  if (!fs.existsSync(target)) {
    console.error(`Error: Path not found: ${target}`);
    process.exit(1);
  }

  const stat = fs.statSync(target);
  const issues = stat.isDirectory()
    ? checkDirectory(target)
    : checkFile(target);

  if (issues.length === 0) {
    console.log('All code blocks properly labeled');
    process.exit(0);
  }

  issues.forEach(issue => {
    if (issue.line) {
      console.log(`${issue.file}:${issue.line}: Unlabeled code block (missing language identifier)`);
    } else {
      console.log(`${issue.file}: ${issue.error}`);
    }
  });

  process.exit(1);
}

main();
