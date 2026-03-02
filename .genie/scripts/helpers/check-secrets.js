#!/usr/bin/env node

/**
 * Check Secrets Helper
 *
 * Fast, deterministic secret detection using regex patterns.
 * No LLM needed - pure pattern matching.
 *
 * Usage:
 *   genie helper check-secrets [files...]
 *   genie helper check-secrets --staged (check git staged files)
 *
 * Exit codes:
 *   0 - No secrets found
 *   1 - Secrets detected
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Secret patterns (regex)
const SECRET_PATTERNS = [
  // API Keys
  { pattern: /['"]?[A-Z_]{3,}API[_-]?KEY['"]?\s*[:=]\s*['"][^'"]{20,}['"]/, name: 'API Key', severity: 'critical' },
  { pattern: /AKIA[0-9A-Z]{16}/, name: 'AWS Access Key', severity: 'critical' },

  // Private Keys
  { pattern: /-----BEGIN (RSA |DSA |EC )?PRIVATE KEY-----/, name: 'Private Key', severity: 'critical' },
  { pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/, name: 'SSH Private Key', severity: 'critical' },

  // Tokens
  { pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/, name: 'GitHub Token', severity: 'critical' },
  { pattern: /glpat-[A-Za-z0-9_-]{20,}/, name: 'GitLab Token', severity: 'critical' },
  { pattern: /sk-[A-Za-z0-9]{20,}/, name: 'OpenAI API Key', severity: 'critical' },
  { pattern: /AIza[0-9A-Za-z_-]{35}/, name: 'Google API Key', severity: 'high' },

  // Credentials
  { pattern: /['"]?password['"]?\s*[:=]\s*['"][^'"]{8,}['"]/, name: 'Password in Code', severity: 'high' },
  { pattern: /['"]?secret['"]?\s*[:=]\s*['"][^'"]{8,}['"]/, name: 'Secret in Code', severity: 'high' },
  { pattern: /['"]?token['"]?\s*[:=]\s*['"][^'"]{16,}['"]/, name: 'Token in Code', severity: 'medium' },

  // Database URLs
  { pattern: /postgresql:\/\/[^:]+:[^@]+@/, name: 'PostgreSQL Connection String', severity: 'high' },
  { pattern: /mongodb(\+srv)?:\/\/[^:]+:[^@]+@/, name: 'MongoDB Connection String', severity: 'high' },

  // Cryptocurrency
  { pattern: /0x[a-fA-F0-9]{40}/, name: 'Ethereum Address', severity: 'medium' },
  { pattern: /[13][a-km-zA-HJ-NP-Z1-9]{25,34}/, name: 'Bitcoin Address', severity: 'medium' },
];

// Files to always skip (even if staged)
const SKIP_FILES = [
  '.genie/scripts/helpers/check-secrets.js', // This file (contains patterns)
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.git/',
  'node_modules/',
  '.genie/state/',
  '.genie/backups/',
];

// Load .secretsignore file if it exists
function loadSecretsIgnore() {
  const ignorePath = path.join(process.cwd(), '.genie', '.secretsignore');
  if (!fs.existsSync(ignorePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(ignorePath, 'utf8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => {
        // Parse "file:line" format
        const parts = line.split(':');
        return {
          file: parts[0],
          line: parts[1] ? parseInt(parts[1]) : null
        };
      });
  } catch (e) {
    return [];
  }
}

function shouldSkipFile(file) {
  return SKIP_FILES.some(skip => file.includes(skip));
}

function isIgnoredFinding(finding, ignoreList) {
  return ignoreList.some(ignore => {
    const fileMatches = finding.file === ignore.file || finding.file.endsWith(ignore.file);
    const lineMatches = ignore.line === null || ignore.line === finding.line;
    return fileMatches && lineMatches;
  });
}

function getStagedFiles() {
  try {
    const files = execSync('git diff --cached --name-only --diff-filter=ACM', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim().split('\n').filter(Boolean);

    return files.filter(f => !shouldSkipFile(f) && fs.existsSync(f));
  } catch (e) {
    return [];
  }
}

function checkFile(filePath) {
  const findings = [];

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, lineNum) => {
      SECRET_PATTERNS.forEach(({ pattern, name, severity }) => {
        if (pattern.test(line)) {
          findings.push({
            file: filePath,
            line: lineNum + 1,
            pattern: name,
            severity,
            snippet: line.trim().substring(0, 80)
          });
        }
      });
    });
  } catch (e) {
    // Skip files that can't be read (binary, etc)
  }

  return findings;
}

function formatFindings(findings) {
  if (findings.length === 0) {
    return '✅ No secrets detected';
  }

  const critical = findings.filter(f => f.severity === 'critical');
  const high = findings.filter(f => f.severity === 'high');
  const medium = findings.filter(f => f.severity === 'medium');

  let report = [];
  report.push('');
  report.push('❌ SECRETS DETECTED IN STAGED FILES');
  report.push('━'.repeat(60));
  report.push('');

  if (critical.length > 0) {
    report.push('🔴 CRITICAL (blocks commit):');
    critical.forEach(f => {
      report.push(`   ${f.file}:${f.line}`);
      report.push(`   Pattern: ${f.pattern}`);
      report.push(`   Snippet: ${f.snippet}`);
      report.push('');
    });
  }

  if (high.length > 0) {
    report.push('🟠 HIGH (blocks commit):');
    high.forEach(f => {
      report.push(`   ${f.file}:${f.line}`);
      report.push(`   Pattern: ${f.pattern}`);
      report.push('');
    });
  }

  if (medium.length > 0) {
    report.push('🟡 MEDIUM (warning):');
    medium.forEach(f => {
      report.push(`   ${f.file}:${f.line} - ${f.pattern}`);
    });
    report.push('');
  }

  report.push('━'.repeat(60));
  report.push('');
  report.push('🔧 How to fix:');
  report.push('   1. Remove secrets from code');
  report.push('   2. Use environment variables instead (.env files)');
  report.push('   3. Add .env* to .gitignore');
  report.push('   4. If false positive, add to .genie/.secretsignore');
  report.push('');

  return report.join('\n');
}

function main() {
  const args = process.argv.slice(2);

  let files = [];

  if (args.includes('--staged') || args.length === 0) {
    // Default: check staged files
    files = getStagedFiles();
  } else {
    // Check specific files
    files = args.filter(f => fs.existsSync(f) && !shouldSkipFile(f));
  }

  if (files.length === 0) {
    console.log('✅ No files to check');
    process.exit(0);
  }

  // Load ignore list
  const ignoreList = loadSecretsIgnore();

  let allFindings = [];
  files.forEach(file => {
    const findings = checkFile(file);
    allFindings = allFindings.concat(findings);
  });

  // Filter out ignored findings
  const filteredFindings = allFindings.filter(f => !isIgnoredFinding(f, ignoreList));

  console.log(formatFindings(filteredFindings));

  // Block on critical or high severity
  const blocking = filteredFindings.filter(f => f.severity === 'critical' || f.severity === 'high');
  if (blocking.length > 0) {
    process.exit(1);
  }

  process.exit(0);
}

main();
