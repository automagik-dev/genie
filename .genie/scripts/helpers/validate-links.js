#!/usr/bin/env node

/**
 * Validate Markdown Links Helper
 *
 * Check markdown links for broken references (files and anchors).
 * Detects [text](path) links pointing to non-existent files or anchors.
 *
 * Usage:
 *   node validate-links.js <file-path>     # Check links in file
 *   node validate-links.js <directory>     # Check all .md files in directory
 *
 * Output:
 *   <file>:<line>: Broken link [text](path) - File not found
 *   <file>:<line>: Broken link [text](path#anchor) - Anchor not found
 */

const fs = require('fs');
const path = require('path');

/**
 * Extract markdown links from text
 * Returns: [{ text, href, line }]
 */
function extractLinks(content) {
  const lines = content.split('\n');
  const links = [];
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;

  lines.forEach((line, idx) => {
    let match;
    while ((match = linkRegex.exec(line)) !== null) {
      const text = match[1];
      const href = match[2];

      // Skip external URLs
      if (href.startsWith('http://') || href.startsWith('https://')) {
        continue;
      }

      links.push({ text, href, line: idx + 1 });
    }
  });

  return links;
}

/**
 * Check if file exists
 */
function fileExists(filePath, basePath) {
  const fullPath = path.resolve(path.dirname(basePath), filePath);
  return fs.existsSync(fullPath);
}

/**
 * Check if anchor exists in file
 */
function anchorExists(filePath, anchor, basePath) {
  try {
    const fullPath = path.resolve(path.dirname(basePath), filePath);
    const content = fs.readFileSync(fullPath, 'utf-8');

    // Convert anchor to heading format
    // #my-heading → ## My Heading or ### My Heading, etc.
    const headingText = anchor.toLowerCase().replace(/-/g, ' ');
    const headingRegex = new RegExp(`^#+\\s+${headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'im');

    return headingRegex.test(content);
  } catch (err) {
    return false;
  }
}

/**
 * Validate links in file
 */
function validateFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const links = extractLinks(content);
    const issues = [];

    links.forEach(({ text, href, line }) => {
      // Split href into path and anchor
      const [linkPath, anchor] = href.split('#');

      // Check if it's just an anchor (same file)
      if (!linkPath && anchor) {
        if (!anchorExists(filePath, anchor, filePath)) {
          issues.push({
            file: filePath,
            line,
            text,
            href,
            error: `Anchor not found: #${anchor}`,
          });
        }
        return;
      }

      // Check if file exists
      if (!fileExists(linkPath, filePath)) {
        issues.push({
          file: filePath,
          line,
          text,
          href,
          error: 'File not found',
        });
        return;
      }

      // If anchor specified, check if it exists in target file
      if (anchor && !anchorExists(linkPath, anchor, filePath)) {
        issues.push({
          file: filePath,
          line,
          text,
          href,
          error: `Anchor not found: #${anchor}`,
        });
      }
    });

    return issues;
  } catch (err) {
    return [{ file: filePath, error: `Failed to read file: ${err.message}` }];
  }
}

/**
 * Validate all .md files in directory
 */
function validateDirectory(dirPath) {
  const allIssues = [];

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    entries.forEach(entry => {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const issues = validateFile(fullPath);
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
  node validate-links.js <file-path>     # Check links in single file
  node validate-links.js <directory>     # Check all .md files recursively

Output:
  <file>:<line>: Broken link [text](path) - error description

Exit code:
  0 = All links valid
  1 = Broken links found
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
    ? validateDirectory(target)
    : validateFile(target);

  if (issues.length === 0) {
    console.log('All links valid');
    process.exit(0);
  }

  issues.forEach(issue => {
    if (issue.line) {
      console.log(`${issue.file}:${issue.line}: Broken link [${issue.text}](${issue.href}) - ${issue.error}`);
    } else {
      console.log(`${issue.file}: ${issue.error}`);
    }
  });

  process.exit(1);
}

main();
