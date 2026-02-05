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
import { hasClaudioBinary } from '../lib/spawn-command.js';
import { configExists as claudioConfigExists, getProfile as getClaudioProfile } from '../lib/config.js';
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
 * Check worker profiles configuration
 * Validates that profiles using claudio launcher have proper dependencies
 */
async function checkWorkerProfiles(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // First check if genie config exists and has worker profiles
  if (!genieConfigExists()) {
    results.push({
      name: 'Worker profiles',
      status: 'warn',
      message: 'no genie config',
      suggestion: 'Run: genie setup',
    });
    return results;
  }

  const config = await loadGenieConfig();
  const profiles = config.workerProfiles;

  if (!profiles || Object.keys(profiles).length === 0) {
    results.push({
      name: 'Worker profiles',
      status: 'pass',
      message: 'none configured (using defaults)',
    });
    return results;
  }

  // Check for profiles using claudio launcher
  const claudioProfiles: { name: string; claudioProfile?: string }[] = [];
  const claudeProfiles: string[] = [];

  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.launcher === 'claudio') {
      claudioProfiles.push({ name, claudioProfile: profile.claudioProfile });
    } else {
      claudeProfiles.push(name);
    }
  }

  // Report profile count
  const totalProfiles = Object.keys(profiles).length;
  results.push({
    name: 'Profiles configured',
    status: 'pass',
    message: `${totalProfiles} profile${totalProfiles === 1 ? '' : 's'}`,
  });

  // If there are claudio profiles, verify claudio binary and config
  if (claudioProfiles.length > 0) {
    // Check claudio binary
    if (hasClaudioBinary()) {
      results.push({
        name: 'claudio binary',
        status: 'pass',
      });
    } else {
      results.push({
        name: 'claudio binary',
        status: 'warn',
        message: 'not found',
        suggestion: `${claudioProfiles.length} profile${claudioProfiles.length === 1 ? '' : 's'} use claudio. Install or switch to claude launcher.`,
      });
    }

    // Check claudio config exists
    if (claudioConfigExists()) {
      results.push({
        name: 'claudio config',
        status: 'pass',
        message: '~/.claudio/config.json',
      });

      // Validate each claudio profile reference
      for (const { name, claudioProfile } of claudioProfiles) {
        if (!claudioProfile) {
          results.push({
            name: `Profile '${name}'`,
            status: 'warn',
            message: 'no claudioProfile specified',
            suggestion: 'Add claudioProfile to the profile config',
          });
          continue;
        }

        try {
          const profile = await getClaudioProfile(claudioProfile);
          if (profile) {
            results.push({
              name: `Profile '${name}'`,
              status: 'pass',
              message: `claudio:${claudioProfile}`,
            });
          } else {
            results.push({
              name: `Profile '${name}'`,
              status: 'warn',
              message: `claudio profile '${claudioProfile}' not found`,
              suggestion: `Run: claudio profiles add ${claudioProfile}`,
            });
          }
        } catch {
          results.push({
            name: `Profile '${name}'`,
            status: 'warn',
            message: `could not verify claudio profile '${claudioProfile}'`,
          });
        }
      }
    } else {
      results.push({
        name: 'claudio config',
        status: 'warn',
        message: 'not found',
        suggestion: 'Run: claudio setup',
      });

      // Mark all claudio profiles as having issues
      for (const { name, claudioProfile } of claudioProfiles) {
        results.push({
          name: `Profile '${name}'`,
          status: 'warn',
          message: `requires claudio profile '${claudioProfile || 'default'}'`,
          suggestion: 'Set up claudio first',
        });
      }
    }
  }

  // Report claude profiles (always valid)
  for (const name of claudeProfiles) {
    results.push({
      name: `Profile '${name}'`,
      status: 'pass',
      message: 'claude (direct)',
    });
  }

  // Check default profile
  if (config.defaultWorkerProfile) {
    if (profiles[config.defaultWorkerProfile]) {
      results.push({
        name: 'Default profile',
        status: 'pass',
        message: config.defaultWorkerProfile,
      });
    } else {
      results.push({
        name: 'Default profile',
        status: 'warn',
        message: `'${config.defaultWorkerProfile}' not found`,
        suggestion: 'Run: genie profiles default <profile>',
      });
    }
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

  // Worker Profiles
  printSectionHeader('Worker Profiles');
  const profileResults = await checkWorkerProfiles();
  for (const result of profileResults) {
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
