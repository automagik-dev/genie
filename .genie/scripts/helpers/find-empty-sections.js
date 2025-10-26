#!/usr/bin/env node

/**
 * Find Empty Sections Helper
 *
 * Detect markdown headings with no content (heading followed immediately by another heading or EOF).
 * These are placeholder sections that were never filled in.
 *
 * Usage:
 *   node find-empty-sections.js <file-path>     # Check single file
 *   node find-empty-sections.js <directory>     # Check all .md files recursively
 *
 * Output:
 *   <file>:<line>: Empty section "Heading Text"
 */

const fs = require('fs');
const path = require('path');

/**
 * Detect empty sections in file content
 * Returns: [{ line, heading }]
 */
function detectEmptySections(content) {
  const lines = content.split('\n');
  const issues = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check if this is a heading (starts with #)
    if (/^#+\s+.+/.test(line)) {
      const heading = line.replace(/^#+\s+/, '');
      let hasContent = false;

      // Look ahead for content until next heading or EOF
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();

        // Found another heading - section is empty
        if (/^#+\s+/.test(nextLine)) {
          break;
        }

        // Found non-empty content - section has content
        if (nextLine.length > 0) {
          hasContent = true;
          break;
        }
      }

      // If we reached EOF or next heading without finding content, it's empty
      if (!hasContent) {
        issues.push({
          line: i + 1,
          heading,
        });
      }
    }
  }

  return issues;
}

/**
 * Check single file
 */
function checkFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const issues = detectEmptySections(content);

    return issues.map(issue => ({
      file: filePath,
      line: issue.line,
      heading: issue.heading,
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
  node find-empty-sections.js <file-path>     # Check single file
  node find-empty-sections.js <directory>     # Check all .md files recursively

Output:
  <file>:<line>: Empty section "Heading Text"

Exit code:
  0 = No empty sections found
  1 = Empty sections found
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
    console.log('No empty sections found');
    process.exit(0);
  }

  issues.forEach(issue => {
    if (issue.line) {
      console.log(`${issue.file}:${issue.line}: Empty section "${issue.heading}"`);
    } else {
      console.log(`${issue.file}: ${issue.error}`);
    }
  });

  process.exit(1);
}

main();
