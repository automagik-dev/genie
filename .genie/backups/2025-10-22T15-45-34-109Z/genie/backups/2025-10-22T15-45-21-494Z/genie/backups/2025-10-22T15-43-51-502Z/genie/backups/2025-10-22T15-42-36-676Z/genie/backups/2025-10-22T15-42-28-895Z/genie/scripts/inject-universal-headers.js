#!/usr/bin/env node

/**
 * Universal Headers Injection
 *
 * Auto-injects "Last Updated" headers to all .md files in .genie/
 *
 * Usage:
 *   node .genie/scripts/inject-universal-headers.js          # Apply changes
 *   node .genie/scripts/inject-universal-headers.js --dry-run  # Preview only
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { execSync } from 'child_process';

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = process.cwd();
const GENIE_DIR = join(ROOT, '.genie');

// Header template using ! command for auto-execution
const HEADER_TEMPLATE = '**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`';

/**
 * Recursively find all .md files in directory
 */
function findMarkdownFiles(dir) {
  const files = [];

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Recurse into subdirectories
      files.push(...findMarkdownFiles(fullPath));
    } else if (entry.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Check if file already has Last Updated header
 */
function hasLastUpdatedHeader(content) {
  // Match both forms:
  // - **Last Updated:** !`date ...`
  // - **Last Updated:** YYYY-MM-DD (static timestamp)
  return /^\*\*Last Updated:\*\*/m.test(content);
}

/**
 * Inject Last Updated header after title (line 2)
 */
function injectHeader(content) {
  const lines = content.split('\n');

  // Find title line (first line starting with #)
  let titleIndex = -1;
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    if (lines[i].trim().startsWith('#')) {
      titleIndex = i;
      break;
    }
  }

  if (titleIndex === -1) {
    // No title found, inject at top
    return `${HEADER_TEMPLATE}\n\n${content}`;
  }

  // Inject after title
  const before = lines.slice(0, titleIndex + 1);
  const after = lines.slice(titleIndex + 1);

  // Skip empty lines after title
  let skipLines = 0;
  while (skipLines < after.length && after[skipLines].trim() === '') {
    skipLines++;
  }

  return [
    ...before,
    HEADER_TEMPLATE,
    ...after.slice(skipLines)
  ].join('\n');
}

/**
 * Process a single markdown file
 */
function processFile(filePath) {
  const content = readFileSync(filePath, 'utf8');

  if (hasLastUpdatedHeader(content)) {
    return null; // Already has header
  }

  const updated = injectHeader(content);

  if (DRY_RUN) {
    return { filePath, action: 'would-inject' };
  }

  writeFileSync(filePath, updated, 'utf8');

  // Stage the file
  const relPath = relative(ROOT, filePath);
  try {
    execSync(`git add "${relPath}"`, { cwd: ROOT, stdio: 'pipe' });
  } catch (err) {
    // Ignore git errors (file might not be tracked)
  }

  return { filePath, action: 'injected' };
}

/**
 * Main execution
 */
function main() {
  console.log('🔍 Scanning for markdown files in .genie/...\n');

  const markdownFiles = findMarkdownFiles(GENIE_DIR);
  console.log(`Found ${markdownFiles.length} markdown files\n`);

  const results = [];
  for (const file of markdownFiles) {
    const result = processFile(file);
    if (result) {
      results.push(result);
    }
  }

  // Summary
  console.log('📊 Summary:\n');

  if (results.length === 0) {
    console.log('✅ All markdown files already have Last Updated headers');
  } else {
    const verb = DRY_RUN ? 'would be modified' : 'modified';
    console.log(`${results.length} files ${verb}:\n`);

    for (const { filePath, action } of results) {
      const relPath = relative(ROOT, filePath);
      const icon = action === 'injected' ? '✅' : '🔍';
      console.log(`  ${icon} ${relPath}`);
    }

    if (DRY_RUN) {
      console.log('\n💡 Run without --dry-run to apply changes');
    } else {
      console.log('\n✅ Headers injected and files staged');
    }
  }
}

main();
