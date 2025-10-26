#!/usr/bin/env node

/**
 * Frontmatter Validator for Genie Framework
 *
 * Validates .md file frontmatter across Genie framework:
 * - YAML syntax validation
 * - Required fields presence
 * - Amendment 7 violations (version, timestamps)
 * - Proper delimiter structure
 *
 * Usage:
 *   node validate-frontmatter.js [path]
 *   (defaults to .genie/ if no path provided)
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { execSync } = require('child_process');

// Configuration
const REQUIRED_FIELDS = {
  agent: ['name', 'description', 'genie'],
  spell: ['name', 'description'],
};

const FORBIDDEN_FIELDS = ['version', 'last_updated', 'author'];

// Valid Claude models
const VALID_CLAUDE_MODELS = ['haiku', 'sonnet', 'opus-4'];

// Valid executors (lowercase, as used in frontmatter)
const VALID_EXECUTORS = ['claude', 'opencode', 'codex', 'gemini', 'cursor'];

// Cache for opencode models (fetched once)
let OPENCODE_MODELS_CACHE = null;

// Results tracking
const results = {
  totalFiles: 0,
  scannedFiles: 0,
  validFiles: 0,
  issues: [],
  skipped: [],
};

/**
 * Fetch valid OpenCode models from `opencode models` command
 */
async function getOpenCodeModels() {
  if (OPENCODE_MODELS_CACHE !== null) {
    return OPENCODE_MODELS_CACHE;
  }

  try {
    const output = execSync('opencode models', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'] // Suppress stderr
    });
    OPENCODE_MODELS_CACHE = output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    return OPENCODE_MODELS_CACHE;
  } catch (err) {
    console.warn('⚠️  Could not fetch opencode models (is opencode installed?). Skipping OpenCode model validation.');
    OPENCODE_MODELS_CACHE = []; // Empty cache = skip validation
    return OPENCODE_MODELS_CACHE;
  }
}

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
    '/backups/',  // Exclude backup directories
    'README.md',  // README files don't need frontmatter
    'SETUP-',     // Setup guide files
  ];

  return !excludePatterns.some(pattern => filePath.includes(pattern));
}

/**
 * Extract frontmatter from markdown content
 */
function extractFrontmatter(content, filePath) {
  const lines = content.split('\n');

  // Check if file starts with frontmatter delimiter
  if (lines[0] !== '---') {
    return { hasFrontmatter: false };
  }

  // Find closing delimiter
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    return {
      hasFrontmatter: true,
      error: 'Missing closing frontmatter delimiter (---)',
      line: 1,
    };
  }

  // Extract YAML content
  const yamlContent = lines.slice(1, closingIndex).join('\n');

  try {
    const parsed = yaml.parse(yamlContent);
    return {
      hasFrontmatter: true,
      frontmatter: parsed,
      yamlContent,
      closingLine: closingIndex + 1,
    };
  } catch (err) {
    return {
      hasFrontmatter: true,
      error: `Invalid YAML syntax: ${err.message}`,
      line: 1,
      yamlContent,
    };
  }
}

/**
 * Detect file type (agent, spell, etc.)
 */
function detectFileType(filePath) {
  if (filePath.includes('/agents/')) return 'agent';
  if (filePath.includes('/spells/')) return 'spell';
  return 'other';
}

/**
 * Validate frontmatter fields
 */
async function validateFields(frontmatter, fileType, filePath) {
  const issues = [];

  // Check required fields
  const required = REQUIRED_FIELDS[fileType] || [];
  for (const field of required) {
    if (!frontmatter[field]) {
      issues.push({
        type: 'missing_required',
        field,
        message: `Missing required field: ${field}`,
      });
    }
  }

  // Check forbidden fields (Amendment 7)
  for (const field of FORBIDDEN_FIELDS) {
    if (frontmatter[field]) {
      issues.push({
        type: 'amendment_7_violation',
        field,
        message: `Forbidden field (Amendment 7): ${field}`,
        suggestion: 'Remove (git tracks this)',
      });
    }
  }

  // Check for nested genie structure (agents only)
  if (fileType === 'agent' && frontmatter.genie) {
    if (typeof frontmatter.genie !== 'object') {
      issues.push({
        type: 'invalid_structure',
        field: 'genie',
        message: 'genie field must be an object',
      });
    } else {
      // Validate genie.executor and genie.model
      const genieIssues = await validateGenieFields(frontmatter.genie);
      issues.push(...genieIssues);
    }
  }

  // Check for empty required fields (present but empty/null)
  for (const field of required) {
    if (frontmatter[field] !== undefined && !frontmatter[field]) {
      issues.push({
        type: 'empty_required',
        field,
        message: `Required field is empty: ${field}`,
        suggestion: 'Provide a value or remove the field',
      });
    }
  }

  return issues;
}

/**
 * Validate genie.executor and genie.model fields
 */
async function validateGenieFields(genie) {
  const issues = [];
  const executor = genie.executor;
  const model = genie.model;
  const variant = genie.executorVariant || genie.variant || genie.executor_variant || genie.executorProfile;

  // Validate executor (should be lowercase)
  if (executor) {
    if (!VALID_EXECUTORS.includes(executor.toLowerCase())) {
      issues.push({
        type: 'invalid_executor',
        field: 'genie.executor',
        message: `Unknown executor: ${executor}`,
        suggestion: `Valid executors: ${VALID_EXECUTORS.join(', ')}`,
      });
    }

    if (executor !== executor.toLowerCase()) {
      issues.push({
        type: 'executor_case',
        field: 'genie.executor',
        message: `Executor should be lowercase: ${executor}`,
        suggestion: `Change to: ${executor.toLowerCase()}`,
      });
    }
  }

  // Validate executorVariant (should be uppercase)
  if (variant && variant !== variant.toUpperCase()) {
    issues.push({
      type: 'variant_case',
      field: 'genie.executorVariant',
      message: `Variant should be uppercase: ${variant}`,
      suggestion: `Change to: ${variant.toUpperCase()}`,
    });
  }

  // Validate model based on executor
  if (executor && model) {
    if (executor === 'claude') {
      // Claude models: haiku, sonnet, opus-4
      if (!VALID_CLAUDE_MODELS.includes(model)) {
        issues.push({
          type: 'invalid_claude_model',
          field: 'genie.model',
          message: `Invalid Claude model: ${model}`,
          suggestion: `Valid Claude models: ${VALID_CLAUDE_MODELS.join(', ')}`,
        });
      }
    } else if (executor === 'opencode') {
      // OpenCode models: must be in `opencode models` output
      const validModels = await getOpenCodeModels();
      if (validModels.length > 0 && !validModels.includes(model)) {
        issues.push({
          type: 'invalid_opencode_model',
          field: 'genie.model',
          message: `OpenCode model not found: ${model}`,
          suggestion: `Run 'opencode models' to see valid models`,
        });
      }
    }
  }

  return issues;
}

/**
 * Scan single markdown file
 */
async function scanFile(filePath) {
  results.totalFiles++;

  if (!shouldScan(filePath)) {
    results.skipped.push({ file: filePath, reason: 'Excluded path' });
    return;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const extracted = extractFrontmatter(content, filePath);

    results.scannedFiles++;

    // No frontmatter (may be valid for some files)
    if (!extracted.hasFrontmatter) {
      const fileType = detectFileType(filePath);
      if (fileType === 'agent' || fileType === 'spell') {
        results.issues.push({
          file: filePath,
          line: 1,
          type: 'missing_frontmatter',
          message: `${fileType} file missing frontmatter`,
          severity: 'error',
        });
      }
      return;
    }

    // Frontmatter extraction error
    if (extracted.error) {
      results.issues.push({
        file: filePath,
        line: extracted.line,
        type: 'invalid_frontmatter',
        message: extracted.error,
        severity: 'error',
        yaml: extracted.yamlContent,
      });
      return;
    }

    // Validate fields
    const fileType = detectFileType(filePath);
    const fieldIssues = await validateFields(extracted.frontmatter, fileType, filePath);

    if (fieldIssues.length > 0) {
      fieldIssues.forEach(issue => {
        results.issues.push({
          file: filePath,
          line: 2, // Approximate (inside frontmatter)
          type: issue.type,
          field: issue.field,
          message: issue.message,
          suggestion: issue.suggestion,
          severity: ['amendment_7_violation', 'variant_case', 'executor_case'].includes(issue.type) ? 'warning' : 'error',
        });
      });
    } else {
      results.validFiles++;
    }

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
async function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await scanDirectory(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      await scanFile(fullPath);
    }
  }
}

/**
 * Generate report
 */
function generateReport() {
  console.log('\n=== Frontmatter Validation Report ===\n');

  console.log(`Total files: ${results.totalFiles}`);
  console.log(`Scanned: ${results.scannedFiles}`);
  console.log(`Valid: ${results.validFiles}`);
  console.log(`Issues found: ${results.issues.length}`);
  console.log(`Skipped: ${results.skipped.length}\n`);

  if (results.issues.length === 0) {
    console.log('✅ No frontmatter issues found!\n');
    return 0;
  }

  // Group issues by severity
  const errors = results.issues.filter(i => i.severity === 'error');
  const warnings = results.issues.filter(i => i.severity === 'warning');

  if (errors.length > 0) {
    console.log(`🔴 ERRORS (${errors.length}):\n`);
    errors.forEach(issue => {
      console.log(`  ${issue.file}:${issue.line || '?'}`);
      console.log(`    Type: ${issue.type}`);
      console.log(`    Message: ${issue.message}`);
      if (issue.field) console.log(`    Field: ${issue.field}`);
      if (issue.suggestion) console.log(`    Suggestion: ${issue.suggestion}`);
      if (issue.yaml) console.log(`    YAML:\n${issue.yaml.split('\n').map(l => '      ' + l).join('\n')}`);
      console.log('');
    });
  }

  if (warnings.length > 0) {
    console.log(`⚠️  WARNINGS (${warnings.length}):\n`);
    warnings.forEach(issue => {
      console.log(`  ${issue.file}:${issue.line || '?'}`);
      console.log(`    Type: ${issue.type}`);
      console.log(`    Message: ${issue.message}`);
      if (issue.field) console.log(`    Field: ${issue.field}`);
      if (issue.suggestion) console.log(`    Suggestion: ${issue.suggestion}`);
      console.log('');
    });
  }

  // Summary
  console.log('\n=== Summary by Issue Type ===\n');
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
async function main() {
  const targetPath = process.argv[2] || '.genie';

  if (!fs.existsSync(targetPath)) {
    console.error(`Error: Path not found: ${targetPath}`);
    process.exit(1);
  }

  console.log(`Scanning: ${targetPath}\n`);

  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    await scanDirectory(targetPath);
  } else if (targetPath.endsWith('.md')) {
    await scanFile(targetPath);
  } else {
    console.error('Error: Target must be a directory or .md file');
    process.exit(1);
  }

  const exitCode = generateReport();
  process.exit(exitCode);
}

main();
