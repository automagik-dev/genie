#!/usr/bin/env node
/**
 * Path Validator - Scans codebase for broken LITERAL file path references
 *
 * Usage:
 *   genie helper validate-paths [--verbose]
 *   genie helper validate-paths --staged  (only scan staged files)
 *
 * Focuses on:
 * - Literal file paths in strings (not imports)
 * - File system operations (readFileSync, existsSync, etc.)
 * - Configuration file paths
 * - Documentation references
 *
 * Ignores:
 * - import/require statements (handled by TypeScript)
 * - Node.js built-in modules
 * - npm packages
 *
 * Exit codes:
 *   0 - All paths valid
 *   1 - Broken paths found
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE_ROOT = process.cwd();
const VERBOSE = process.argv.includes('--verbose');
const STAGED_ONLY = process.argv.includes('--staged');

// Node.js built-in modules (to ignore)
const BUILTIN_MODULES = new Set([
  'fs', 'path', 'os', 'util', 'events', 'stream', 'crypto', 'http', 'https',
  'net', 'url', 'querystring', 'zlib', 'child_process', 'cluster', 'readline',
  'assert', 'buffer', 'string_decoder', 'tty', 'vm', 'dns', 'dgram', 'timers',
  'punycode', 'process', 'console', 'module', 'perf_hooks', 'worker_threads',
  'v8', 'trace_events', 'async_hooks', 'inspector'
]);

// Results
const results = {
  scanned: 0,
  broken: [],
  valid: [],
  exceptions: [],
};

/**
 * Security: Validate resolved path is within workspace
 * Allows relative paths that resolve inside workspace
 */
function isPathSafe(resolvedPath) {
  try {
    const relative = path.relative(WORKSPACE_ROOT, resolvedPath);
    // Path is safe if it doesn't escape workspace
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

/**
 * Check if it's a module import (not a file path)
 */
function isModuleImport(pathStr) {
  // Built-in module
  if (BUILTIN_MODULES.has(pathStr)) return true;

  // npm package (doesn't start with . or /)
  if (!/^[./]/.test(pathStr)) return true;

  // Relative import without extension (TypeScript module)
  if (/^\.\.?\//.test(pathStr) && !/\.(js|ts|json|md|yaml|yml|html|css)$/.test(pathStr)) {
    return true;
  }

  return false;
}

/**
 * Check if path is expected to not exist
 */
function isException(pathStr) {
  const exceptions = {
    runtime: [
      '.genie/state/current-session.json',
      '.genie/state/stats-history.json',
      '.genie/state/forge.log',
      'dist/cli/genie.js', // Built at compile time
      'dist/mcp/server.js', // Built at compile time
    ],
    userWorkspace: [
      '.genie/cli/config.yaml',
      '.genie/config.yaml',
      '.mcp.json',
      '.genie/CONTEXT.md',
      '.genie/MASTER-PLAN.md',
      '.genie/SESSION-STATE.md',
      '.genie/TODO.md',
      '.genie/sleepy-state.json',
    ],
    examples: [
      // Example paths in documentation
      /^\/path\/to\//,
      /^\.\/file\./,
      /\bexample\b/i,
      /\bmy-custom-/,
      /\bcustom-deployment/,
      /\bold-workflow/,
      /\bdeprecated-spell/,
      /\bprototype\./,
      /\/wish\.md$/,
      /\/identity\.md$/,
    ],
    templates: [
      /\$\{/, /<[^>]+>/, /\[.*?\]/,
    ],
  };

  if (exceptions.runtime.includes(pathStr)) return 'runtime';
  if (exceptions.userWorkspace.includes(pathStr)) return 'user-workspace';
  if (exceptions.examples.some(regex => regex.test(pathStr))) return 'example';
  if (exceptions.templates.some(regex => regex.test(pathStr))) return 'template';

  return null;
}

/**
 * Extract literal file paths from content
 * Only paths that look like actual files (with extensions)
 */
function extractFilePaths(content, filePath) {
  const paths = new Set();

  // Skip import/require statements (they're handled by TypeScript/Node.js)
  const contentWithoutImports = content
    .replace(/^import\s+.*?from\s+['\"][^'\"]+['\"]/gm, '')
    .replace(/^export\s+.*?from\s+['\"][^'\"]+['\"]/gm, '')
    .replace(/require\(['\"][^'\"]+['\"][\),]/g, '');

  // Pattern: file paths with extensions in strings
  const filePathPattern = /['\"`]([^'\"`]*\.(?:md|json|yaml|yml|sh|html|css|txt|log|cjs))['\"]/g;

  let match;
  while ((match = filePathPattern.exec(contentWithoutImports)) !== null) {
    const pathStr = match[1];

    // Skip if it's clearly a module import (TypeScript modules without extension)
    if (isModuleImport(pathStr)) continue;

    // Skip URLs
    if (/^https?:\/\//.test(pathStr)) continue;

    // Skip very short paths (likely false positives like ".md" in endsWith('.md'))
    if (pathStr.length < 5) continue;

    // Skip template variables and patterns
    if (/^\$\{|\}$/.test(pathStr)) continue;

    // Skip if it's just an extension (e.g., ".md" from .endsWith('.md'))
    if (/^\.[\w]+$/.test(pathStr)) continue;

    // Skip glob patterns (**, *, ?, {, })
    if (/[\*\?\{\}]/.test(pathStr)) continue;

    // Skip template filenames (e.g., ".template.md")
    if (/^\.template\./.test(pathStr)) continue;

    paths.add(pathStr);
  }

  return Array.from(paths);
}

/**
 * Validate a path
 */
function validatePath(pathStr, sourceFile) {
  // Check exceptions first
  const exceptionType = isException(pathStr);
  if (exceptionType) {
    results.exceptions.push({ path: pathStr, source: sourceFile, type: exceptionType });
    return { valid: true, reason: exceptionType };
  }

  // Resolve path
  let resolvedPath;
  if (pathStr.startsWith('.genie/') || pathStr.startsWith('src/') || pathStr.startsWith('dist/')) {
    // Workspace-relative paths (always resolve from workspace root)
    resolvedPath = path.resolve(WORKSPACE_ROOT, pathStr);
  } else if (pathStr.startsWith('./') || pathStr.startsWith('../')) {
    // Relative to source file
    resolvedPath = path.resolve(path.dirname(sourceFile), pathStr);
  } else if (pathStr.startsWith('/')) {
    // Absolute
    resolvedPath = pathStr;
  } else {
    // Default: relative to workspace root
    resolvedPath = path.resolve(WORKSPACE_ROOT, pathStr);
  }

  // Security check (after resolving)
  if (!isPathSafe(resolvedPath)) {
    return { valid: false, reason: 'unsafe-path', resolvedPath };
  }

  // Check if exists
  try {
    fs.accessSync(resolvedPath, fs.constants.R_OK);
    results.valid.push({ path: pathStr, source: sourceFile });
    return { valid: true, resolvedPath };
  } catch {
    return { valid: false, reason: 'not-found', resolvedPath };
  }
}

/**
 * Scan a file
 */
function scanFile(filePath) {
  results.scanned++;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const paths = extractFilePaths(content, filePath);

    for (const pathStr of paths) {
      const result = validatePath(pathStr, filePath);

      if (!result.valid) {
        results.broken.push({
          path: pathStr,
          source: filePath.replace(WORKSPACE_ROOT + '/', ''),
          reason: result.reason,
          resolved: result.resolvedPath,
        });
      }
    }
  } catch (err) {
    if (VERBOSE) {
      console.error(`Error scanning ${filePath}: ${err.message}`);
    }
  }
}

/**
 * Scan directory recursively
 */
function scanDirectory(dir, extensions) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip
        if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
        if (fullPath.includes('.genie/reports')) continue;
        if (fullPath.includes('.genie/wishes')) continue;
        if (fullPath.includes('.genie/qa')) continue;

        scanDirectory(fullPath, extensions);
      } else if (entry.isFile()) {
        if (extensions.some(ext => entry.name.endsWith(ext))) {
          scanFile(fullPath);
        }
      }
    }
  } catch (err) {
    if (VERBOSE) {
      console.error(`Error scanning ${dir}: ${err.message}`);
    }
  }
}

/**
 * Get staged files only
 */
function getStagedFiles() {
  try {
    const output = execSync('git diff --cached --name-only --diff-filter=ACMR', {
      encoding: 'utf8',
      cwd: WORKSPACE_ROOT
    });
    return output.trim().split('\n').filter(Boolean).map(f => path.join(WORKSPACE_ROOT, f));
  } catch {
    return [];
  }
}

/**
 * Main
 */
function main() {
  console.log('🔍 Path Validator - Scanning for broken file references\n');

  if (STAGED_ONLY) {
    // Only scan staged files
    console.log('📂 Scanning staged files only...');
    const stagedFiles = getStagedFiles();

    if (stagedFiles.length === 0) {
      console.log('No staged files to scan\n');
      process.exit(0);
    }

    stagedFiles.forEach(file => {
      if (fs.existsSync(file) && (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.md'))) {
        scanFile(file);
      }
    });
  } else {
    // Full codebase scan
    console.log('📂 Scanning source files...');
    scanDirectory(path.join(WORKSPACE_ROOT, 'src'), ['.ts', '.js']);

    console.log('📂 Scanning documentation...');
    scanDirectory(path.join(WORKSPACE_ROOT, '.genie'), ['.md']);
    if (fs.existsSync(path.join(WORKSPACE_ROOT, 'docs'))) {
      scanDirectory(path.join(WORKSPACE_ROOT, 'docs'), ['.md']);
    }

    // Scan scripts
    if (fs.existsSync(path.join(WORKSPACE_ROOT, '.genie/scripts'))) {
      console.log('📂 Scanning scripts...');
      scanDirectory(path.join(WORKSPACE_ROOT, '.genie/scripts'), ['.sh', '.js', '.cjs']);
    }
  }

  // Report
  console.log(`\n✅ Scanned ${results.scanned} files\n`);

  if (results.broken.length > 0) {
    console.log(`❌ Found ${results.broken.length} broken path reference(s):\n`);

    results.broken.forEach(({ path, source, reason, resolved }) => {
      console.log(`  📄 ${path}`);
      console.log(`     Source: ${source}`);
      console.log(`     Reason: ${reason}`);
      if (resolved && reason === 'not-found') {
        console.log(`     Expected: ${resolved}`);
      }
      console.log();
    });

    process.exit(1);
  } else {
    console.log('✅ No broken paths found!');
    console.log(`✅ Validated ${results.valid.length} file path references`);

    if (VERBOSE) {
      console.log(`\nℹ️  Exceptions: ${results.exceptions.length} (runtime/user-workspace files)`);

      // Show some examples
      if (results.valid.length > 0) {
        console.log(`\nℹ️  Sample valid paths:`);
        results.valid.slice(0, 5).forEach(({ path }) => {
          console.log(`  ✓ ${path}`);
        });
        if (results.valid.length > 5) {
          console.log(`  ... and ${results.valid.length - 5} more`);
        }
      }
    }

    process.exit(0);
  }
}

main();
