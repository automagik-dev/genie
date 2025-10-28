#!/usr/bin/env node
/**
 * Validate MCP Build - Ensure dist files are in sync with source
 *
 * Purpose:
 * - Prevent accidental deletion of MCP dist files
 * - Ensure HTML files are copied from src to dist
 * - Validate TypeScript compilation is up-to-date
 *
 * Triggered by: pre-commit hook
 * Exit codes: 0 = valid, 1 = needs rebuild
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

/**
 * Get list of staged files from git
 */
function getStagedFiles() {
  try {
    const output = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
    if (!output) return [];
    return output.split('\n').filter(Boolean);
  } catch (error) {
    return [];
  }
}

/**
 * Check if any MCP-related files are staged
 */
function hasMCPChanges(stagedFiles) {
  return stagedFiles.some(file =>
    file.startsWith('.genie/mcp/src/') ||
    file.startsWith('.genie/mcp/dist/')
  );
}

/**
 * Check if HTML files exist in dist
 */
function validateHTMLFiles() {
  const errors = [];

  // Check if authorize.html exists in dist
  const srcHtml = path.join(gitRoot, '.genie/mcp/src/lib/views/authorize.html');
  const distHtml = path.join(gitRoot, '.genie/mcp/dist/lib/views/authorize.html');

  if (fs.existsSync(srcHtml) && !fs.existsSync(distHtml)) {
    errors.push({
      file: 'authorize.html',
      message: 'HTML file exists in src/ but missing from dist/'
    });
  }

  // Check if files are identical (if both exist)
  if (fs.existsSync(srcHtml) && fs.existsSync(distHtml)) {
    const srcContent = fs.readFileSync(srcHtml, 'utf8');
    const distContent = fs.readFileSync(distHtml, 'utf8');

    if (srcContent !== distContent) {
      errors.push({
        file: 'authorize.html',
        message: 'HTML file in dist/ is out of sync with src/'
      });
    }
  }

  return errors;
}

/**
 * Check if TypeScript files are compiled
 */
function validateTypeScriptBuild(stagedFiles) {
  const errors = [];

  // Get all staged .ts files in src/
  const stagedTsFiles = stagedFiles.filter(file =>
    file.startsWith('.genie/mcp/src/') && file.endsWith('.ts')
  );

  for (const tsFile of stagedTsFiles) {
    // Convert src path to expected dist path
    const distFile = tsFile
      .replace('.genie/mcp/src/', '.genie/mcp/dist/')
      .replace(/\.ts$/, '.js');

    const distPath = path.join(gitRoot, distFile);

    // Check if compiled file exists
    if (!fs.existsSync(distPath)) {
      errors.push({
        file: tsFile,
        message: `TypeScript file staged but compiled output missing: ${distFile}`
      });
    } else {
      // Check if source is newer than compiled output
      const srcPath = path.join(gitRoot, tsFile);
      const srcMtime = fs.statSync(srcPath).mtime;
      const distMtime = fs.statSync(distPath).mtime;

      if (srcMtime > distMtime) {
        errors.push({
          file: tsFile,
          message: `Source file is newer than compiled output (${distFile})`
        });
      }
    }
  }

  return errors;
}

/**
 * Main validation logic
 */
function main() {
  const stagedFiles = getStagedFiles();

  // Skip validation if no MCP files are staged
  if (!hasMCPChanges(stagedFiles)) {
    return 0; // Success - no validation needed
  }

  let hasErrors = false;
  const allErrors = [];

  // Validate HTML files
  const htmlErrors = validateHTMLFiles();
  if (htmlErrors.length > 0) {
    hasErrors = true;
    allErrors.push(...htmlErrors);
  }

  // Validate TypeScript compilation
  const tsErrors = validateTypeScriptBuild(stagedFiles);
  if (tsErrors.length > 0) {
    hasErrors = true;
    allErrors.push(...tsErrors);
  }

  if (hasErrors) {
    console.error('❌ MCP build validation failed:\n');

    for (const error of allErrors) {
      console.error(`   ${error.file}`);
      console.error(`   └─ ${error.message}\n`);
    }

    console.error('🔧 Fix by running:');
    console.error('   pnpm run build:mcp');
    console.error('   git add .genie/mcp/dist/\n');

    return 1; // Failure
  }

  console.log('✅ MCP build validation passed');
  return 0; // Success
}

process.exit(main());
