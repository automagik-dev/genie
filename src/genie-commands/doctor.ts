/**
 * Genie Doctor Command
 *
 * Diagnostic tool to check the health of the genie installation.
 * Checks prerequisites, configuration, and tmux connectivity.
 */

import {
  checkCommand,
} from '../lib/system-detect.js';
import {
  getClaudeSettingsPath,
  contractClaudePath,
} from '../lib/claude-settings.js';
import {
  loadGenieConfig,
  genieConfigExists,
  getGenieConfigPath,
  isSetupComplete,
} from '../lib/genie-config.js';
import { $ } from 'bun';
import { existsSync } from 'fs';

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message?: string;
  suggestion?: string;
}

/**
 * Print section header
 */
function printSectionHeader(title: string): void {
  console.log();
  console.log(`\x1b[1m${title}:\x1b[0m`);
}

/**
 * Print a check result
 */
function printCheckResult(result: CheckResult): void {
  const icons = {
    pass: '\x1b[32m\u2713\x1b[0m',
    fail: '\x1b[31m\u2717\x1b[0m',
    warn: '\x1b[33m!\x1b[0m',
  };

  const icon = icons[result.status];
  const message = result.message ? ` ${result.message}` : '';
  console.log(`  ${icon} ${result.name}${message}`);

  if (result.suggestion) {
    console.log(`    \x1b[2m${result.suggestion}\x1b[0m`);
  }
}

/**
 * Check prerequisites (tmux, jq, bun, Claude Code)
 */
async function checkPrerequisites(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Check tmux
  const tmuxCheck = await checkCommand('tmux');
  if (tmuxCheck.exists) {
    results.push({
      name: 'tmux',
      status: 'pass',
      message: tmuxCheck.version || '',
    });
  } else {
    results.push({
      name: 'tmux',
      status: 'fail',
      suggestion: 'Install with: brew install tmux (or apt install tmux)',
    });
  }

  // Check jq
  const jqCheck = await checkCommand('jq');
  if (jqCheck.exists) {
    results.push({
      name: 'jq',
      status: 'pass',
      message: jqCheck.version || '',
    });
  } else {
    results.push({
      name: 'jq',
      status: 'fail',
      suggestion: 'Install with: brew install jq (or apt install jq)',
    });
  }

  // Check bun
  const bunCheck = await checkCommand('bun');
  if (bunCheck.exists) {
    results.push({
      name: 'bun',
      status: 'pass',
      message: bunCheck.version || '',
    });
  } else {
    results.push({
      name: 'bun',
      status: 'fail',
      suggestion: 'Install with: curl -fsSL https://bun.sh/install | bash',
    });
  }

  // Check Claude Code
  const claudeCheck = await checkCommand('claude');
  if (claudeCheck.exists) {
    results.push({
      name: 'Claude Code',
      status: 'pass',
      message: claudeCheck.version || '',
    });
  } else {
    results.push({
      name: 'Claude Code',
      status: 'warn',
      suggestion: 'Install with: npm install -g @anthropic-ai/claude-code',
    });
  }

  return results;
}

/**
 * Check configuration
 */
async function checkConfiguration(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Check if genie config exists
  if (genieConfigExists()) {
    results.push({
      name: 'Genie config exists',
      status: 'pass',
      message: contractClaudePath(getGenieConfigPath()),
    });
  } else {
    results.push({
      name: 'Genie config exists',
      status: 'warn',
      message: 'not found',
      suggestion: 'Run: genie setup',
    });
  }

  // Check if setup is complete
  if (isSetupComplete()) {
    results.push({
      name: 'Setup complete',
      status: 'pass',
    });
  } else {
    results.push({
      name: 'Setup complete',
      status: 'warn',
      message: 'not completed',
      suggestion: 'Run: genie setup',
    });
  }

  // Check if claudio config exists
  const claudeSettingsPath = getClaudeSettingsPath();
  if (existsSync(claudeSettingsPath)) {
    results.push({
      name: 'Claude settings exists',
      status: 'pass',
      message: contractClaudePath(claudeSettingsPath),
    });
  } else {
    results.push({
      name: 'Claude settings exists',
      status: 'warn',
      message: 'not found',
      suggestion: 'Claude Code creates this on first run',
    });
  }

  return results;
}

/**
 * Check tmux status
 */
async function checkTmux(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Check if tmux server is running
  try {
    const serverResult = await $`tmux list-sessions 2>/dev/null`.quiet();
    if (serverResult.exitCode === 0) {
      results.push({
        name: 'Server running',
        status: 'pass',
      });
    } else {
      results.push({
        name: 'Server running',
        status: 'warn',
        message: 'no sessions',
        suggestion: 'Start with: tmux new-session -d -s genie',
      });
      return results;
    }
  } catch {
    results.push({
      name: 'Server running',
      status: 'warn',
      message: 'could not check',
    });
    return results;
  }

  // Check if genie session exists
  const config = await loadGenieConfig();
  const sessionName = config.session.name;

  try {
    const sessionResult = await $`tmux has-session -t ${sessionName} 2>/dev/null`.quiet();
    if (sessionResult.exitCode === 0) {
      results.push({
        name: `Session '${sessionName}' exists`,
        status: 'pass',
      });
    } else {
      results.push({
        name: `Session '${sessionName}' exists`,
        status: 'warn',
        suggestion: `Start with: tmux new-session -d -s ${sessionName}`,
      });
    }
  } catch {
    results.push({
      name: `Session '${sessionName}' exists`,
      status: 'warn',
      message: 'could not check',
    });
  }

  // Check if term exec works
  try {
    const termCheck = await checkCommand('term');
    if (termCheck.exists) {
      results.push({
        name: 'term command available',
        status: 'pass',
      });
    } else {
      results.push({
        name: 'term command available',
        status: 'fail',
        suggestion: 'Ensure genie-cli is properly installed',
      });
    }
  } catch {
    results.push({
      name: 'term command available',
      status: 'warn',
      message: 'could not check',
    });
  }

  return results;
}

/**
 * Main doctor command
 */
export async function doctorCommand(): Promise<void> {
  console.log();
  console.log('\x1b[1mGenie Doctor\x1b[0m');
  console.log('\x1b[2m' + '\u2500'.repeat(40) + '\x1b[0m');

  let hasErrors = false;
  let hasWarnings = false;

  // Prerequisites
  printSectionHeader('Prerequisites');
  const prereqResults = await checkPrerequisites();
  for (const result of prereqResults) {
    printCheckResult(result);
    if (result.status === 'fail') hasErrors = true;
    if (result.status === 'warn') hasWarnings = true;
  }

  // Configuration
  printSectionHeader('Configuration');
  const configResults = await checkConfiguration();
  for (const result of configResults) {
    printCheckResult(result);
    if (result.status === 'fail') hasErrors = true;
    if (result.status === 'warn') hasWarnings = true;
  }

  // Tmux
  printSectionHeader('Tmux');
  const tmuxResults = await checkTmux();
  for (const result of tmuxResults) {
    printCheckResult(result);
    if (result.status === 'fail') hasErrors = true;
    if (result.status === 'warn') hasWarnings = true;
  }

  // Summary
  console.log();
  console.log('\x1b[2m' + '\u2500'.repeat(40) + '\x1b[0m');

  if (hasErrors) {
    console.log('\x1b[31mSome checks failed.\x1b[0m Run \x1b[36mgenie setup\x1b[0m to fix.');
  } else if (hasWarnings) {
    console.log('\x1b[33mSome warnings detected.\x1b[0m Everything should still work.');
  } else {
    console.log('\x1b[32mAll checks passed!\x1b[0m');
  }

  console.log();

  if (hasErrors) {
    process.exit(1);
  }
}
