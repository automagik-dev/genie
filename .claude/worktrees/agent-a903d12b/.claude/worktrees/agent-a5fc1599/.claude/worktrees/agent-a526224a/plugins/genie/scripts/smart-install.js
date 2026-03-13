#!/usr/bin/env node
import { execSync, spawnSync } from 'node:child_process';
/**
 * Smart Install Script for genie
 *
 * Ensures required dependencies are installed:
 * - Bun runtime (auto-installs if missing)
 * - tmux (guides user if missing - can't auto-install)
 * - genie CLI (installed globally via bun)
 *
 * Also handles:
 * - Dependency installation when version changes
 * - Version marker management
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(homedir(), '.claude', 'plugins', 'genie');
const GENIE_DIR = join(homedir(), '.genie');
const MARKER = join(GENIE_DIR, '.install-version');
const IS_WINDOWS = process.platform === 'win32';

// Common installation paths (handles fresh installs before PATH reload)
const BUN_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
  : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

const GENIE_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.bun', 'bin', 'genie.exe')]
  : [join(homedir(), '.bun', 'bin', 'genie'), '/usr/local/bin/genie', '/opt/homebrew/bin/genie'];

/**
 * Get the Bun executable path
 */
function getBunPath() {
  // Try PATH first
  try {
    const result = spawnSync('bun', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    if (result.status === 0) return 'bun';
  } catch {
    // Not in PATH
  }
  return BUN_COMMON_PATHS.find(existsSync) || null;
}

function isBunInstalled() {
  return getBunPath() !== null;
}

function getBunVersion() {
  const bunPath = getBunPath();
  if (!bunPath) return null;
  try {
    const result = spawnSync(bunPath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Install Bun automatically
 */
function installBun() {
  console.error('Installing Bun runtime...');
  try {
    if (IS_WINDOWS) {
      execSync('powershell -c "irm bun.com/install.ps1 | iex"', { stdio: 'inherit', shell: true });
    } else {
      execSync('curl -fsSL https://bun.com/install | bash', { stdio: 'inherit', shell: true });
    }
    if (!isBunInstalled()) {
      throw new Error('Bun installation completed but binary not found. Please restart your terminal.');
    }
    console.error(`Bun ${getBunVersion()} installed`);
  } catch (error) {
    console.error('Failed to install Bun. Please install manually:');
    if (IS_WINDOWS) {
      console.error('  winget install Oven-sh.Bun');
    } else {
      console.error('  curl -fsSL https://bun.com/install | bash');
    }
    throw error;
  }
}

/**
 * Check if tmux is installed
 */
function isTmuxInstalled() {
  try {
    const result = spawnSync('tmux', ['-V'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Get tmux version
 */
function getTmuxVersion() {
  try {
    const result = spawnSync('tmux', ['-V'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Check if dependencies need to be installed
 */
function needsInstall() {
  if (!existsSync(join(ROOT, 'node_modules'))) return true;
  if (!existsSync(join(ROOT, 'package.json'))) return false; // No package.json = no deps needed

  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    if (!existsSync(MARKER)) return true;
    const marker = JSON.parse(readFileSync(MARKER, 'utf-8'));
    return pkg.version !== marker.version || getBunVersion() !== marker.bun;
  } catch {
    return true;
  }
}

/**
 * Install dependencies using Bun
 */
function installDeps() {
  const bunPath = getBunPath();
  if (!bunPath) {
    throw new Error('Bun executable not found');
  }

  console.error('Installing dependencies...');

  // Ensure .genie directory exists
  if (!existsSync(GENIE_DIR)) {
    mkdirSync(GENIE_DIR, { recursive: true });
  }

  const bunCmd = IS_WINDOWS && bunPath.includes(' ') ? `"${bunPath}"` : bunPath;
  execSync(`${bunCmd} install`, { cwd: ROOT, stdio: 'inherit', shell: IS_WINDOWS });

  // Write version marker
  let version = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    version = pkg.version;
  } catch {
    // Ignore
  }

  writeFileSync(
    MARKER,
    JSON.stringify({
      version,
      bun: getBunVersion(),
      tmux: getTmuxVersion(),
      installedAt: new Date().toISOString(),
    }),
  );
}

/**
 * Get the genie executable path
 */
function getGeniePath() {
  // Try PATH first
  try {
    const result = spawnSync('genie', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    if (result.status === 0) return 'genie';
  } catch {
    // Not in PATH
  }
  return GENIE_COMMON_PATHS.find(existsSync) || null;
}

/**
 * Get installed genie CLI version (via bun global)
 */
function getGenieVersion() {
  const geniePath = getGeniePath();
  if (!geniePath) return null;
  try {
    const result = spawnSync(geniePath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Get the plugin's package version
 */
function getPluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

/**
 * Check if genie CLI needs install or upgrade via bun global
 */
function genieCliNeedsInstall() {
  const installed = getGenieVersion();
  if (!installed) return true;
  const pluginVersion = getPluginVersion();
  if (!pluginVersion) return false;
  return installed !== pluginVersion;
}

const ORCHESTRATION_PROMPT = `<GENIE_CLI>
# Genie CLI — MANDATORY Agent Orchestration

You are a team-lead in a **genie-managed environment**. ALL agent spawning, messaging, and team management MUST go through the genie CLI via Bash.

## CRITICAL: NEVER Use These Native Tools

NEVER use the \`Agent\` tool to spawn agents or subagents. Use \`genie agent spawn\` instead.
NEVER use \`SendMessage\` to communicate with agents. Use \`genie send\` instead.
NEVER use \`TeamCreate\` or \`TeamDelete\`. Use \`genie team ensure\` / \`genie team delete\` instead.

If you catch yourself about to use Agent, SendMessage, TeamCreate, or TeamDelete — STOP and use the genie CLI equivalent below.

## Agents

\`\`\`bash
# Spawn an agent (ALWAYS use this instead of Agent tool)
genie agent spawn --role <role>                    # implementor, tests, review, fix, refactor
genie agent spawn --role <role> --skill <skill>    # With specific skill

# Monitor
genie agent list                           # List all agents
genie agent dashboard                      # Live dashboard
genie agent history <agent>                # Session history
genie agent read <agent> --follow          # Tail terminal output

# Control
genie agent kill <id>                      # Force kill
genie agent suspend <id>                   # Suspend (preserves session)
genie agent exec <agent> "<cmd>"           # Run command in agent pane
genie agent answer <agent> <choice>        # Answer prompt (1-9 or text:...)
\`\`\`

## Messaging

\`\`\`bash
# Send message to an agent (ALWAYS use this instead of SendMessage)
genie send "<text>" --to <agent>            # Send to specific agent
genie inbox <agent>                         # View agent inbox
genie inbox <agent> --unread                # Unread only
\`\`\`

## Teams

\`\`\`bash
genie team ensure <name>                    # Ensure team exists (creates if needed)
genie team list                             # List teams
genie team delete <name>                    # Delete team
\`\`\`

## Typical Flow

\`\`\`bash
# 1. Spawn an agent
genie agent spawn --role implementor

# 2. Monitor
genie agent list

# 3. Send instructions
genie send "Implement endpoint X" --to <agent-name>

# 4. Check progress
genie agent history <agent-name>

# 5. Shut down
genie agent kill <agent-id>
\`\`\`
</GENIE_CLI>
`;

/**
 * Inject the orchestration prompt into ~/.claude/rules/genie-orchestration.md
 * Only writes/rewrites if the plugin version changed.
 */
function injectOrchestrationPrompt() {
  const rulesDir = join(homedir(), '.claude', 'rules');
  const destFile = join(rulesDir, 'genie-orchestration.md');

  if (!existsSync(rulesDir)) {
    mkdirSync(rulesDir, { recursive: true });
  }

  // Check version: only rewrite if version changed or file missing
  let currentVersion = null;
  try {
    if (existsSync(MARKER)) {
      const marker = JSON.parse(readFileSync(MARKER, 'utf-8'));
      currentVersion = marker.version || null;
    }
  } catch {
    // Ignore
  }

  let pluginVersion = null;
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    pluginVersion = pkg.version || null;
  } catch {
    // Ignore
  }

  const fileExists = existsSync(destFile);
  const versionChanged = !fileExists || currentVersion !== pluginVersion;

  if (versionChanged) {
    writeFileSync(destFile, ORCHESTRATION_PROMPT, 'utf-8');
    console.error('Orchestration prompt written to ~/.claude/rules/genie-orchestration.md');
  }
}

/**
 * Create default ~/.genie/config.json with schema v2 defaults if missing.
 */
function createDefaultConfig() {
  const configPath = join(GENIE_DIR, 'config.json');
  if (!existsSync(configPath)) {
    if (!existsSync(GENIE_DIR)) {
      mkdirSync(GENIE_DIR, { recursive: true });
    }
    writeFileSync(configPath, JSON.stringify({ version: 2, promptMode: 'append', setupComplete: false }), 'utf-8');
    console.error('Created default ~/.genie/config.json');
  }
}

/**
 * Ensure tmux base-index defaults are set in ~/.tmux.conf
 * Only runs when version changes (or file missing).
 */
function ensureTmuxDefaults() {
  // Guard: only run on version change
  let currentVersion = null;
  try {
    if (existsSync(MARKER)) {
      const marker = JSON.parse(readFileSync(MARKER, 'utf-8'));
      currentVersion = marker.version || null;
    }
  } catch {
    // Ignore
  }

  let pluginVersion = null;
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    pluginVersion = pkg.version || null;
  } catch {
    // Ignore
  }

  if (currentVersion === pluginVersion) return;

  const tmuxConf = join(homedir(), '.tmux.conf');
  let contents = '';
  if (existsSync(tmuxConf)) {
    contents = readFileSync(tmuxConf, 'utf-8');
  }

  if (!contents.includes('base-index 0')) {
    const append = '\n# Genie defaults\nset -g base-index 0\nsetw -g pane-base-index 0\n';
    writeFileSync(tmuxConf, contents + append, 'utf-8');
    console.error('Added tmux base-index defaults to ~/.tmux.conf');
  }
}

/**
 * Install or upgrade genie CLI globally via bun
 */
function installGenieCli() {
  const bunPath = getBunPath();
  if (!bunPath) {
    throw new Error('Bun executable not found — cannot install genie CLI');
  }

  const pluginVersion = getPluginVersion();
  const installed = getGenieVersion();

  if (installed) {
    console.error(`Upgrading genie CLI: ${installed} → ${pluginVersion}...`);
  } else {
    console.error('Installing genie CLI globally via bun...');
  }

  const bunCmd = IS_WINDOWS && bunPath.includes(' ') ? `"${bunPath}"` : bunPath;
  const versionSuffix = pluginVersion ? `@${pluginVersion}` : '';
  execSync(`${bunCmd} install -g @automagik/genie${versionSuffix}`, { stdio: 'inherit', shell: IS_WINDOWS });

  const newVersion = getGenieVersion();
  if (!newVersion) {
    throw new Error('genie CLI installation completed but binary not found. Restart your terminal.');
  }
  console.error(`genie CLI ${newVersion} installed`);
}

// Main execution
try {
  // Quick check: if everything is already installed, exit silently
  if (isBunInstalled() && isTmuxInstalled() && !needsInstall() && !genieCliNeedsInstall()) {
    process.exit(0);
  }

  // 1. Check/install Bun (required — fatal if fails)
  if (!isBunInstalled()) {
    installBun();
  }

  // 2. Check tmux (required for agent orchestration — fatal)
  if (!isTmuxInstalled()) {
    console.error('');
    console.error('WARNING: tmux is not installed.');
    console.error('tmux is required for agent orchestration (genie agent spawn, teams, etc.).');
    console.error('Non-interactive features still work without it.');
    console.error('');
    console.error('Install tmux:');
    if (process.platform === 'darwin') {
      console.error('  brew install tmux');
    } else if (process.platform === 'linux') {
      console.error('  sudo apt install tmux    # Debian/Ubuntu');
      console.error('  sudo dnf install tmux    # Fedora/RHEL');
      console.error('  sudo pacman -S tmux      # Arch');
    } else if (IS_WINDOWS) {
      console.error('  WSL is required for tmux on Windows');
      console.error('  Inside WSL: sudo apt install tmux');
    }
    console.error('');
    // Don't exit — let the rest of the chain run
  }

  // 3. Install plugin dependencies if needed
  if (needsInstall()) {
    installDeps();
    console.error('Dependencies installed');
  }

  // 3a. Inject orchestration prompt (idempotent — checks version marker)
  try {
    injectOrchestrationPrompt();
  } catch (e) {
    console.error(`Warning: Could not write orchestration prompt: ${e.message}`);
  }

  // 3b. Create default config if missing (idempotent — never overwrites)
  try {
    createDefaultConfig();
  } catch (e) {
    console.error(`Warning: Could not create default config: ${e.message}`);
  }

  // 3c. Ensure tmux base-index defaults (idempotent — checks version marker)
  try {
    ensureTmuxDefaults();
  } catch (e) {
    console.error(`Warning: Could not update ~/.tmux.conf: ${e.message}`);
  }

  // 4. Install or upgrade genie CLI via bun global (non-fatal)
  if (genieCliNeedsInstall()) {
    try {
      installGenieCli();
    } catch (e) {
      console.error(`Warning: genie CLI install/upgrade failed: ${e.message}`);
      console.error('The plugin will still work. Install genie CLI manually later.');
    }
  }
} catch (e) {
  // Only Bun install failure reaches here — everything else is graceful
  console.error('Critical installation failed:', e.message);
  console.error('Continuing anyway to let remaining hooks run...');
  // Exit 0 so the hook chain continues (first-run-check, session-context)
  process.exit(0);
}
