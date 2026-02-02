/**
 * Genie Setup Command
 *
 * Interactive wizard for configuring genie settings.
 * Supports full wizard, quick mode, and section-specific setup.
 */

import { confirm, input, select } from '@inquirer/prompts';
import { installShortcuts, isShortcutsInstalled } from '../term-commands/shortcuts.js';
import { homedir } from 'os';
import { join } from 'path';
import { checkCommand } from '../lib/system-detect.js';
import {
  loadGenieConfig,
  saveGenieConfig,
  markSetupComplete,
  resetConfig,
  getGenieConfigPath,
  contractPath,
  updateShortcutsConfig,
} from '../lib/genie-config.js';
import type { GenieConfig } from '../types/genie-config.js';

export interface SetupOptions {
  quick?: boolean;
  shortcuts?: boolean;
  claudio?: boolean;
  terminal?: boolean;
  session?: boolean;
  reset?: boolean;
  show?: boolean;
}

/**
 * Print the header banner
 */
function printHeader(): void {
  console.log();
  console.log('\x1b[1m\x1b[36m' + '=' .repeat(64) + '\x1b[0m');
  console.log('\x1b[1m\x1b[36m  Genie Setup Wizard\x1b[0m');
  console.log('\x1b[1m\x1b[36m' + '=' .repeat(64) + '\x1b[0m');
  console.log();
}

/**
 * Print a section header
 */
function printSection(title: string, description?: string): void {
  console.log();
  console.log('\x1b[1m' + title + '\x1b[0m');
  if (description) {
    console.log('\x1b[2m' + description + '\x1b[0m');
  }
  console.log();
}

// ============================================================================
// Prerequisites Check (read-only)
// ============================================================================

async function checkPrerequisites(): Promise<void> {
  printSection('1. Prerequisites Check', 'Checking required tools...');

  const checks = [
    { name: 'tmux', required: true },
    { name: 'bun', required: true },
    { name: 'claude', required: false, displayName: 'Claude Code CLI' },
    { name: 'jq', required: false },
  ];

  for (const check of checks) {
    const result = await checkCommand(check.name);
    const displayName = check.displayName || check.name;
    if (result.exists) {
      console.log(`  \x1b[32m\u2713\x1b[0m ${displayName} ${result.version ? `(${result.version})` : ''}`);
    } else if (check.required) {
      console.log(`  \x1b[31m\u2717\x1b[0m ${displayName} \x1b[2m(required)\x1b[0m`);
    } else {
      console.log(`  \x1b[33m!\x1b[0m ${displayName} \x1b[2m(optional)\x1b[0m`);
    }
  }
}

// ============================================================================
// Session Configuration
// ============================================================================

async function configureSession(config: GenieConfig, quick: boolean): Promise<GenieConfig> {
  printSection('2. Session Configuration', 'Configure tmux session settings');

  if (quick) {
    console.log(`  Using defaults: session="${config.session.name}", window="${config.session.defaultWindow}"`);
    return config;
  }

  const sessionName = await input({
    message: 'Session name:',
    default: config.session.name,
  });

  const defaultWindow = await input({
    message: 'Default window name:',
    default: config.session.defaultWindow,
  });

  const autoCreate = await confirm({
    message: 'Auto-create session on connect?',
    default: config.session.autoCreate,
  });

  config.session = {
    name: sessionName,
    defaultWindow,
    autoCreate,
  };

  return config;
}

// ============================================================================
// Terminal Configuration
// ============================================================================

async function configureTerminal(config: GenieConfig, quick: boolean): Promise<GenieConfig> {
  printSection('3. Terminal Defaults', 'Configure default values for term commands');

  if (quick) {
    console.log(`  Using defaults: timeout=${config.terminal.execTimeout}ms, lines=${config.terminal.readLines}`);
    return config;
  }

  const timeoutStr = await input({
    message: 'Exec timeout (milliseconds):',
    default: String(config.terminal.execTimeout),
    validate: (v) => {
      const n = parseInt(v, 10);
      return !isNaN(n) && n > 0 ? true : 'Must be a positive number';
    },
  });

  const linesStr = await input({
    message: 'Read lines (default for term read):',
    default: String(config.terminal.readLines),
    validate: (v) => {
      const n = parseInt(v, 10);
      return !isNaN(n) && n > 0 ? true : 'Must be a positive number';
    },
  });

  const worktreeBase = await input({
    message: 'Worktree base directory:',
    default: config.terminal.worktreeBase,
  });

  config.terminal = {
    execTimeout: parseInt(timeoutStr, 10),
    readLines: parseInt(linesStr, 10),
    worktreeBase,
  };

  return config;
}

// ============================================================================
// Keyboard Shortcuts
// ============================================================================

async function configureShortcuts(config: GenieConfig, quick: boolean): Promise<GenieConfig> {
  printSection('4. Keyboard Shortcuts', 'Warp-like tmux shortcuts for quick navigation');

  const home = homedir();
  const tmuxConf = join(home, '.tmux.conf');
  const tmuxInstalled = isShortcutsInstalled(tmuxConf);

  if (tmuxInstalled) {
    console.log('  \x1b[32m\u2713\x1b[0m Tmux shortcuts already installed');
    config.shortcuts.tmuxInstalled = true;
    return config;
  }

  console.log('  Available shortcuts:');
  console.log('    \x1b[36mCtrl+T\x1b[0m \u2192 New tab (window)');
  console.log('    \x1b[36mCtrl+S\x1b[0m \u2192 Vertical split');
  console.log('    \x1b[36mCtrl+H\x1b[0m \u2192 Horizontal split');
  console.log();

  if (quick) {
    console.log('  Skipped in quick mode. Run \x1b[36mgenie setup --shortcuts\x1b[0m to install.');
    return config;
  }

  const installChoice = await confirm({
    message: 'Install tmux keyboard shortcuts?',
    default: false,
  });

  if (installChoice) {
    console.log();
    await installShortcuts();
    config.shortcuts.tmuxInstalled = true;
    await updateShortcutsConfig({ tmuxInstalled: true });
  } else {
    console.log('  Skipped. Run \x1b[36mgenie shortcuts install\x1b[0m later.');
  }

  return config;
}

// ============================================================================
// Claudio Integration
// ============================================================================

async function configureClaudio(config: GenieConfig, quick: boolean): Promise<GenieConfig> {
  printSection('5. Claudio Integration', 'LLM router profile management');

  const claudeCheck = await checkCommand('claude');

  if (!claudeCheck.exists) {
    console.log('  \x1b[33m!\x1b[0m Claude Code CLI not found. Skipping claudio integration.');
    return config;
  }

  if (quick) {
    console.log('  Skipped in quick mode. Run \x1b[36mclaudio setup\x1b[0m to configure.');
    return config;
  }

  const enableClaudio = await confirm({
    message: 'Configure Claudio API profiles?',
    default: false,
  });

  if (enableClaudio) {
    config.claudio = { enabled: true };
    console.log();
    console.log('  Run \x1b[36mclaudio setup\x1b[0m to configure API profiles.');
  } else {
    console.log('  Skipped. Run \x1b[36mclaudio setup\x1b[0m later.');
  }

  return config;
}

// ============================================================================
// Debug Options
// ============================================================================

async function configureDebug(config: GenieConfig, quick: boolean): Promise<GenieConfig> {
  printSection('6. Debug Options', 'Logging and debugging settings');

  if (quick) {
    console.log('  Using defaults: tmuxDebug=false, verbose=false');
    return config;
  }

  const tmuxDebug = await confirm({
    message: 'Enable tmux debug logging?',
    default: config.logging.tmuxDebug,
  });

  const verbose = await confirm({
    message: 'Enable verbose mode?',
    default: config.logging.verbose,
  });

  config.logging = {
    tmuxDebug,
    verbose,
  };

  return config;
}

// ============================================================================
// Summary and Save
// ============================================================================

async function showSummaryAndSave(config: GenieConfig): Promise<void> {
  printSection('Summary', 'Configuration will be saved to ' + contractPath(getGenieConfigPath()));

  console.log(`  Session: \x1b[36m${config.session.name}\x1b[0m (window: ${config.session.defaultWindow})`);
  console.log(`  Terminal: timeout=${config.terminal.execTimeout}ms, lines=${config.terminal.readLines}`);
  console.log(`  Shortcuts: ${config.shortcuts.tmuxInstalled ? '\x1b[32minstalled\x1b[0m' : '\x1b[2mnot installed\x1b[0m'}`);
  console.log(`  Claudio: ${config.claudio?.enabled ? '\x1b[32menabled\x1b[0m' : '\x1b[2mnot configured\x1b[0m'}`);
  console.log(`  Debug: tmux=${config.logging.tmuxDebug}, verbose=${config.logging.verbose}`);
  console.log();

  // Save config
  config.setupComplete = true;
  config.lastSetupAt = new Date().toISOString();
  await saveGenieConfig(config);

  console.log('\x1b[32m\u2713 Configuration saved!\x1b[0m');
}

// ============================================================================
// Show Current Config
// ============================================================================

async function showCurrentConfig(): Promise<void> {
  const config = await loadGenieConfig();

  console.log();
  console.log('\x1b[1mCurrent Genie Configuration\x1b[0m');
  console.log('\x1b[2m' + contractPath(getGenieConfigPath()) + '\x1b[0m');
  console.log();
  console.log(JSON.stringify(config, null, 2));
  console.log();
}

// ============================================================================
// Print Next Steps
// ============================================================================

function printNextSteps(): void {
  console.log();
  console.log('\x1b[1mNext Steps:\x1b[0m');
  console.log();
  console.log('  Start a session:  \x1b[36mclaudio launch\x1b[0m');
  console.log('  Watch AI work:    \x1b[36mtmux attach -t genie\x1b[0m');
  console.log('  Check health:     \x1b[36mgenie doctor\x1b[0m');
  console.log();
}

// ============================================================================
// Main Setup Command
// ============================================================================

export async function setupCommand(options: SetupOptions = {}): Promise<void> {
  // Handle --show flag
  if (options.show) {
    await showCurrentConfig();
    return;
  }

  // Handle --reset flag
  if (options.reset) {
    await resetConfig();
    console.log('\x1b[32m\u2713 Configuration reset to defaults.\x1b[0m');
    console.log();
    return;
  }

  // Load existing config
  let config = await loadGenieConfig();

  // Handle section-specific flags
  if (options.shortcuts) {
    printHeader();
    await configureShortcuts(config, false);
    await markSetupComplete();
    return;
  }

  if (options.terminal) {
    printHeader();
    config = await configureTerminal(config, false);
    await saveGenieConfig(config);
    console.log('\x1b[32m\u2713 Terminal configuration saved.\x1b[0m');
    return;
  }

  if (options.session) {
    printHeader();
    config = await configureSession(config, false);
    await saveGenieConfig(config);
    console.log('\x1b[32m\u2713 Session configuration saved.\x1b[0m');
    return;
  }

  if (options.claudio) {
    printHeader();
    await configureClaudio(config, false);
    await markSetupComplete();
    return;
  }

  // Full wizard
  const quick = options.quick ?? false;

  printHeader();

  if (quick) {
    console.log('\x1b[2mQuick mode: accepting all defaults\x1b[0m');
  }

  // Run all sections
  await checkPrerequisites();
  config = await configureSession(config, quick);
  config = await configureTerminal(config, quick);
  config = await configureShortcuts(config, quick);
  config = await configureClaudio(config, quick);
  config = await configureDebug(config, quick);

  // Save and show summary
  await showSummaryAndSave(config);

  // Print next steps
  printNextSteps();
}
