import { homedir } from 'node:os';
import { join } from 'node:path';
import { confirm, input, select } from '@inquirer/prompts';
import {
  contractPath,
  getGenieConfigPath,
  loadGenieConfig,
  markSetupComplete,
  resetConfig,
  saveGenieConfig,
} from '../lib/genie-config.js';
import { resolveGenieHome } from '../lib/genie-home.js';
import { isInteractive } from '../lib/interactivity.js';
import { acquireLifecycleLease } from '../lib/lifecycle-lease.js';
import { type OrcaPluginCompatibilityResult, switchOrchestrationMode } from '../lib/orca-plugin-lifecycle.js';
import type { readIntegrationConsent } from '../lib/runtime-integrations.js';
import type { checkCommand } from '../lib/system-detect.js';
import { printErr, printOut } from '../lib/term-output.js';
import { installShortcuts, isShortcutsInstalled } from '../term-commands/shortcuts.js';
import type { GenieConfig } from '../types/genie-config.js';

export interface SetupOptions {
  quick?: boolean;
  shortcuts?: boolean;
  terminal?: boolean;
  session?: boolean;
  reset?: boolean;
  show?: boolean;
  orchestrationMode?: 'standalone' | 'orca';
}

export interface SetupDeps {
  checkCommand?: typeof checkCommand;
  readIntegrationConsent?: typeof readIntegrationConsent;
  /** Interactive confirmation seam; production uses @inquirer/prompts. */
  confirm?: typeof confirm;
  /**
   * Whether this process may render a prompt at all; production uses
   * {@link isInteractive}. Same gate, same reason as `genie uninstall`: an
   * @inquirer/prompts question on a non-TTY stdin never resolves, so a wizard
   * section must refuse BEFORE it builds one (2026-09-15 dogfood B1).
   */
  canPrompt?: () => boolean;
  acquireLifecycleLease?: typeof acquireLifecycleLease;
  /** Test seam for the once-bound absolute executable path. */
  resolveExecutable?: (name: string, cwd: string) => string | null;
  cwd?: string;
  /** A3 public compatibility probe seam for isolated Orca mode-switch tests. */
  orcaCompatibilityProbe?: () => Promise<OrcaPluginCompatibilityResult>;
}

/** The one stderr line a wizard section that cannot prompt gets, before exit 2. */
export const SETUP_NON_INTERACTIVE_MESSAGE =
  'genie setup needs an interactive terminal for this section. Nothing was changed. Use `genie setup --quick` to accept the defaults, or re-run from a terminal without --no-interactive.';

export class SetupIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupIntegrationError';
  }
}

/**
 * Print the header banner
 */
function printHeader(): void {
  printOut();
  printOut(`\x1b[1m\x1b[36m${'='.repeat(64)}\x1b[0m`);
  printOut('\x1b[1m\x1b[36m  Genie Setup Wizard\x1b[0m');
  printOut(`\x1b[1m\x1b[36m${'='.repeat(64)}\x1b[0m`);
  printOut();
}

/**
 * Print a section header
 */
function printSection(title: string, description?: string): void {
  printOut();
  printOut(`\x1b[1m${title}\x1b[0m`);
  if (description) {
    printOut(`\x1b[2m${description}\x1b[0m`);
  }
  printOut();
}

// ============================================================================
// Session Configuration
// ============================================================================

async function configureSession(config: GenieConfig, quick: boolean): Promise<GenieConfig> {
  printSection('2. Session Configuration', 'Configure tmux session settings');

  if (quick) {
    printOut(`  Using defaults: session="${config.session.name}", window="${config.session.defaultWindow}"`);
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
    printOut(`  Using defaults: timeout=${config.terminal.execTimeout}ms, lines=${config.terminal.readLines}`);
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

async function configureShortcuts(config: GenieConfig, quick: boolean, deps: SetupDeps): Promise<GenieConfig> {
  printSection('4. Keyboard Shortcuts', 'Warp-like tmux shortcuts for quick navigation');

  const home = homedir();
  const tmuxConf = join(home, '.tmux.conf');
  const tmuxInstalled = isShortcutsInstalled(tmuxConf);

  if (tmuxInstalled) {
    printOut('  \x1b[32m\u2713\x1b[0m Tmux shortcuts already installed');
    config.shortcuts.tmuxInstalled = true;
    return config;
  }

  printOut('  Available shortcuts:');
  printOut('    \x1b[36mCtrl+T\x1b[0m \u2192 New tab (window)');
  printOut('    \x1b[36mCtrl+S\x1b[0m \u2192 Vertical split');
  printOut('    \x1b[36mCtrl+H\x1b[0m \u2192 Horizontal split');
  printOut();

  if (quick) {
    printOut('  Skipped in quick mode. Run \x1b[36mgenie setup --shortcuts\x1b[0m to install.');
    return config;
  }

  const installChoice = await confirm({
    message: 'Install tmux keyboard shortcuts?',
    default: false,
  });

  if (installChoice) {
    printOut();
    await withSetupLease(deps, async () => {
      // The prompt was answered without a lease. Re-read the target immediately
      // after acquisition so a concurrent setup cannot cause duplicate writes.
      if (!isShortcutsInstalled(tmuxConf)) await installShortcuts();
      config.shortcuts.tmuxInstalled = true;
    });
  } else {
    printOut('  Skipped. Run \x1b[36mgenie shortcuts install\x1b[0m later.');
  }

  return config;
}

// ============================================================================
// Debug Options
// ============================================================================

async function configureDebug(config: GenieConfig, quick: boolean): Promise<GenieConfig> {
  printSection('6. Debug Options', 'Logging and debugging settings');

  if (quick) {
    printOut('  Using defaults: tmuxDebug=false, verbose=false');
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
    printOut(`  Using default: promptMode="${config.promptMode}"`);
    return config;
  }

  printOut('  append  — Uses --append-system-prompt-file (preserves Claude Code default system prompt)');
  printOut('  system  — Uses --system-prompt-file (replaces Claude Code default system prompt)');
  printOut();

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

function showSummary(config: GenieConfig): void {
  printSection('Summary', `Configuration saved to ${contractPath(getGenieConfigPath())}`);

  printOut(`  Session: \x1b[36m${config.session.name}\x1b[0m (window: ${config.session.defaultWindow})`);
  printOut(`  Terminal: timeout=${config.terminal.execTimeout}ms, lines=${config.terminal.readLines}`);
  printOut(
    `  Shortcuts: ${config.shortcuts.tmuxInstalled ? '\x1b[32minstalled\x1b[0m' : '\x1b[2mnot installed\x1b[0m'}`,
  );
  printOut(`  Debug: tmux=${config.logging.tmuxDebug}, verbose=${config.logging.verbose}`);
  printOut(`  Prompt mode: \x1b[36m${config.promptMode}\x1b[0m`);
  printOut();
}

async function showSummaryAndSave(config: GenieConfig, baseline: GenieConfig, deps: SetupDeps): Promise<void> {
  config.setupComplete = true;
  config.lastSetupAt = new Date().toISOString();
  await saveSetupConfig(config, baseline, deps);

  showSummary(config);
  printOut('\x1b[32m\u2713 Configuration saved!\x1b[0m');
}

// ============================================================================
// Show Current Config
// ============================================================================

async function showCurrentConfig(): Promise<void> {
  const config = await loadGenieConfig();

  printOut();
  printOut('\x1b[1mCurrent Genie Configuration\x1b[0m');
  printOut(`\x1b[2m${contractPath(getGenieConfigPath())}\x1b[0m`);
  printOut();
  printOut(JSON.stringify(config, null, 2));
  printOut();
}

// ============================================================================
// Print Next Steps
// ============================================================================

function printNextSteps(): void {
  printOut();
  printOut('\x1b[1mNext Steps:\x1b[0m');
  printOut();
  printOut('  Start a session:  \x1b[36mgenie\x1b[0m');
  printOut('  Watch AI work:    \x1b[36mtmux attach -t genie\x1b[0m');
  printOut('  Check health:     \x1b[36mgenie doctor\x1b[0m');
  printOut();
}

// ============================================================================
// Main Setup Command
// ============================================================================

async function runSetupCommand(options: SetupOptions, deps: SetupDeps): Promise<void> {
  // Handle --show flag
  if (options.show) {
    await showCurrentConfig();
    return;
  }

  // Handle --reset flag
  if (options.reset) {
    await withSetupLease(deps, () => resetConfig());
    printOut('\x1b[32m\u2713 Configuration reset to defaults.\x1b[0m');
    printOut();
    return;
  }

  if (options.orchestrationMode !== undefined) {
    if (options.orchestrationMode !== 'standalone' && options.orchestrationMode !== 'orca') {
      throw new SetupIntegrationError('orchestration mode must be either "standalone" or "orca"');
    }
    const result = await switchOrchestrationMode(options.orchestrationMode, { probe: deps.orcaCompatibilityProbe });
    const detail = result.changed ? 'changed' : 'already selected';
    printOut(`\x1b[32m\u2713\x1b[0m Orchestration mode ${detail}: ${result.mode}`);
    if (result.backupPath !== null) printOut(`  Previous config backed up at ${contractPath(result.backupPath)}`);
    return;
  }

  // Every path below this line renders prompts, except `--quick`, which answers
  // every section from the defaults and is therefore the scripted route. Decide
  // BEFORE the first prompt object exists: an @inquirer prompt on a non-TTY
  // stdin renders its question and then never resolves.
  const quick = options.quick ?? false;
  const willPrompt = !quick || options.shortcuts === true || options.terminal === true || options.session === true;
  if (willPrompt && !(deps.canPrompt ?? isInteractive)()) {
    printErr(SETUP_NON_INTERACTIVE_MESSAGE);
    process.exitCode = 2;
    return;
  }

  // Load existing config
  let config = await loadGenieConfig();
  const baseline = structuredClone(config);

  // Handle section-specific flags
  if (options.shortcuts) {
    printHeader();
    await configureShortcuts(config, false, deps);
    await withSetupLease(deps, () => markSetupComplete());
    return;
  }

  if (options.terminal) {
    printHeader();
    config = await configureTerminal(config, false);
    await saveSetupConfig(config, baseline, deps);
    printOut('\x1b[32m\u2713 Terminal configuration saved.\x1b[0m');
    return;
  }

  if (options.session) {
    printHeader();
    config = await configureSession(config, false);
    await saveSetupConfig(config, baseline, deps);
    printOut('\x1b[32m\u2713 Session configuration saved.\x1b[0m');
    return;
  }

  // Full wizard
  printHeader();

  if (quick) {
    printOut('\x1b[2mQuick mode: accepting all defaults\x1b[0m');
  }

  // Run all sections
  config = await configureSession(config, quick);
  config = await configureTerminal(config, quick);
  config = await configureShortcuts(config, quick, deps);
  config = await configureDebug(config, quick);
  config = await configurePromptMode(config, quick);

  await showSummaryAndSave(config, baseline, deps);

  // This file mutation follows the same just-acquired/revalidated config
  // commit rather than extending a lease across any wizard prompt.
  await withSetupLease(deps, () => installGenieTmuxConf());

  // Print next steps
  printNextSteps();
}

/** Run setup with clean, actionable failure semantics and no false success banner. */
export async function setupCommand(options: SetupOptions = {}, deps: SetupDeps = {}): Promise<void> {
  try {
    await runSetupCommand(options, deps);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    printErr(`Error: Genie setup failed: ${detail}`);
    process.exitCode = 1;
  }
}

/** Acquire only for a bounded mutation; no interactive prompt calls this helper. */
async function withSetupLease<T>(deps: SetupDeps, mutation: () => T | Promise<T>): Promise<T> {
  const lifecycleLease = (deps.acquireLifecycleLease ?? acquireLifecycleLease)(resolveGenieHome());
  if ('skipped' in lifecycleLease) throw new SetupIntegrationError(lifecycleLease.skipped);
  try {
    return await mutation();
  } finally {
    lifecycleLease.release();
  }
}

/** Fail closed instead of overwriting config changed while the wizard prompted. */
async function saveSetupConfig(config: GenieConfig, baseline: GenieConfig, deps: SetupDeps): Promise<void> {
  await withSetupLease(deps, () => saveSetupConfigUnderHeldLease(config, baseline));
}

/** Config CAS used after the caller has acquired the outer lifecycle lease. */
async function saveSetupConfigUnderHeldLease(config: GenieConfig, baseline: GenieConfig): Promise<void> {
  const current = await loadGenieConfig();
  if (JSON.stringify(current) !== JSON.stringify(baseline)) {
    throw new SetupIntegrationError('Genie configuration changed while setup was open; review it and retry setup');
  }
  await saveGenieConfig(config);
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
    mkdirSync(genieHome, { recursive: true, mode: 0o700 });
    copyFileSync(src, dest);
    printOut(`\x1b[32m\u2713\x1b[0m Installed genie tmux config to ${dest}`);
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
