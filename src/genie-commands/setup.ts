/**
 * Genie Setup Command
 *
 * Interactive wizard for configuring genie settings.
 * Supports full wizard, quick mode, and section-specific setup.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { confirm, input, select } from '@inquirer/prompts';
import { ensureCodexOtelConfig, getCodexConfigPath, isCodexConfigured } from '../lib/codex-config.js';
import {
  contractPath,
  getGenieConfigPath,
  loadGenieConfig,
  markSetupComplete,
  resetConfig,
  saveGenieConfig,
  updateShortcutsConfig,
} from '../lib/genie-config.js';
import { checkCommand } from '../lib/system-detect.js';
import { installShortcuts, isShortcutsInstalled } from '../term-commands/shortcuts.js';
import type { GenieConfig } from '../types/genie-config.js';

export interface SetupOptions {
  quick?: boolean;
  shortcuts?: boolean;
  codex?: boolean;
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
  console.log(`\x1b[1m\x1b[36m${'='.repeat(64)}\x1b[0m`);
  console.log('\x1b[1m\x1b[36m  Genie Setup Wizard\x1b[0m');
  console.log(`\x1b[1m\x1b[36m${'='.repeat(64)}\x1b[0m`);
  console.log();
}

/**
 * Print a section header
 */
function printSection(title: string, description?: string): void {
  console.log();
  console.log(`\x1b[1m${title}\x1b[0m`);
  if (description) {
    console.log(`\x1b[2m${description}\x1b[0m`);
  }
  console.log();
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
      const n = Number.parseInt(v, 10);
      return !Number.isNaN(n) && n > 0 ? true : 'Must be a positive number';
    },
  });

  const linesStr = await input({
    message: 'Read lines (default for genie agent read):',
    default: String(config.terminal.readLines),
    validate: (v) => {
      const n = Number.parseInt(v, 10);
      return !Number.isNaN(n) && n > 0 ? true : 'Must be a positive number';
    },
  });

  const worktreeBase = await input({
    message: 'Worktree base directory (leave empty for ~/.genie/worktrees/<project>/):',
    default: config.terminal.worktreeBase ?? '',
  });

  config.terminal = {
    execTimeout: Number.parseInt(timeoutStr, 10),
    readLines: Number.parseInt(linesStr, 10),
    ...(worktreeBase ? { worktreeBase } : {}),
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
// Codex Integration
// ============================================================================

function printCodexResult(result: 'changed' | 'unchanged' | 'error'): void {
  if (result === 'changed') console.log('  \x1b[32m\u2713\x1b[0m Codex config updated');
  else if (result === 'unchanged') console.log('  \x1b[32m\u2713\x1b[0m Codex config already up to date');
  else console.log('  \x1b[31m\u2717\x1b[0m Failed to update codex config');
}

async function configureCodex(config: GenieConfig, quick: boolean): Promise<GenieConfig> {
  printSection('5. Codex Integration', 'Configure OpenAI Codex for genie agents');

  const codexCheck = await checkCommand('codex');
  if (!codexCheck.exists) {
    console.log('  \x1b[33m!\x1b[0m Codex CLI not found. Skipping codex integration.');
    return config;
  }

  console.log(`  \x1b[32m\u2713\x1b[0m Codex CLI found (${codexCheck.version ?? 'unknown version'})`);

  if (isCodexConfigured()) {
    console.log('  \x1b[32m\u2713\x1b[0m Codex config already configured');
    config.codex = { configured: true };
    return config;
  }

  console.log();
  console.log('  Genie needs to configure codex for agent communication:');
  console.log('    \x1b[36mdisable_paste_burst\x1b[0m \u2192 Reliable tmux command injection');
  console.log('    \x1b[36mOTel exporter\x1b[0m       \u2192 Telemetry relay for state detection');
  console.log(`  Config: \x1b[2m${contractPath(getCodexConfigPath())}\x1b[0m`);
  console.log();

  if (quick) {
    const result = ensureCodexOtelConfig();
    printCodexResult(result);
    config.codex = { configured: result !== 'error' };
    return config;
  }

  const enableCodex = await confirm({ message: 'Configure Codex for genie agent integration?', default: true });
  if (enableCodex) {
    const result = ensureCodexOtelConfig();
    printCodexResult(result);
    config.codex = { configured: result !== 'error' };
  } else {
    console.log('  Skipped. Run \x1b[36mgenie setup --codex\x1b[0m later.');
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
// Prompt Mode Configuration
// ============================================================================

async function configurePromptMode(config: GenieConfig, quick: boolean): Promise<GenieConfig> {
  printSection('7. Prompt Mode', 'Controls how genie injects system prompts into Claude Code');

  if (quick) {
    console.log(`  Using default: promptMode="${config.promptMode}"`);
    return config;
  }

  console.log('  append  — Uses --append-system-prompt-file (preserves Claude Code default system prompt)');
  console.log('  system  — Uses --system-prompt-file (replaces Claude Code default system prompt)');
  console.log();

  const promptMode = await select({
    message: 'Prompt mode:',
    choices: [
      { name: 'append (recommended — preserves CC default)', value: 'append' as const },
      { name: 'system (replaces CC default)', value: 'system' as const },
    ],
    default: config.promptMode,
  });

  config.promptMode = promptMode;
  return config;
}

// ============================================================================
// Summary and Save
// ============================================================================

async function showSummaryAndSave(config: GenieConfig): Promise<void> {
  printSection('Summary', `Configuration will be saved to ${contractPath(getGenieConfigPath())}`);

  console.log(`  Session: \x1b[36m${config.session.name}\x1b[0m (window: ${config.session.defaultWindow})`);
  console.log(`  Terminal: timeout=${config.terminal.execTimeout}ms, lines=${config.terminal.readLines}`);
  console.log(
    `  Shortcuts: ${config.shortcuts.tmuxInstalled ? '\x1b[32minstalled\x1b[0m' : '\x1b[2mnot installed\x1b[0m'}`,
  );
  console.log(`  Codex:   ${config.codex?.configured ? '\x1b[32mconfigured\x1b[0m' : '\x1b[2mnot configured\x1b[0m'}`);
  console.log(`  Debug: tmux=${config.logging.tmuxDebug}, verbose=${config.logging.verbose}`);
  console.log(`  Prompt mode: \x1b[36m${config.promptMode}\x1b[0m`);
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
  console.log(`\x1b[2m${contractPath(getGenieConfigPath())}\x1b[0m`);
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
  console.log('  Start a session:  \x1b[36mgenie\x1b[0m');
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

  if (options.codex) {
    printHeader();
    config = await configureCodex(config, false);
    await saveGenieConfig(config);
    if (config.codex?.configured) {
      console.log('\x1b[32m\u2713 Codex configuration saved.\x1b[0m');
    }
    return;
  }

  // Full wizard
  const quick = options.quick ?? false;

  printHeader();

  if (quick) {
    console.log('\x1b[2mQuick mode: accepting all defaults\x1b[0m');
  }

  // Run all sections
  config = await configureSession(config, quick);
  config = await configureTerminal(config, quick);
  config = await configureShortcuts(config, quick);
  config = await configureCodex(config, quick);
  config = await configureDebug(config, quick);
  config = await configurePromptMode(config, quick);

  // Save and show summary
  await showSummaryAndSave(config);

  // Install genie tmux config
  installGenieTmuxConf();

  // Print next steps
  printNextSteps();
}

/** Copy shipped genie.tmux.conf to ~/.genie/tmux.conf if it doesn't exist yet. */
function installGenieTmuxConf(): void {
  const { existsSync, copyFileSync, mkdirSync, chmodSync } = require('node:fs') as typeof import('node:fs');
  const { resolve, dirname } = require('node:path') as typeof import('node:path');
  const genieHome = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  const dest = join(genieHome, 'tmux.conf');
  if (existsSync(dest)) return; // already installed

  // Resolve shipped config relative to package root
  const candidates = [
    resolve(__dirname, '..', '..', 'scripts', 'tmux', 'genie.tmux.conf'),
    resolve(__dirname, '..', 'scripts', 'tmux', 'genie.tmux.conf'),
  ];
  const src = candidates.find((p) => existsSync(p));
  if (!src) return;

  try {
    mkdirSync(genieHome, { recursive: true });
    copyFileSync(src, dest);
    console.log(`\x1b[32m\u2713\x1b[0m Installed genie tmux config to ${dest}`);
  } catch {
    // non-fatal
  }

  // Install osc52-copy.sh clipboard helper alongside the tmux config
  const osc52Src = join(dirname(src), 'osc52-copy.sh');
  const osc52Dest = join(genieHome, 'osc52-copy.sh');
  if (existsSync(osc52Src)) {
    try {
      copyFileSync(osc52Src, osc52Dest);
      chmodSync(osc52Dest, 0o755);
    } catch {
      // non-fatal
    }
  }
}
