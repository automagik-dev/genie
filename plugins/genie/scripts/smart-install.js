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

## 1. CRITICAL: NEVER Use These Native Tools

NEVER use the \`Agent\` tool to spawn agents or subagents. Use \`genie spawn\` instead.
NEVER use \`SendMessage\` to communicate with agents. Use \`genie send\` instead.
NEVER use \`TeamCreate\` or \`TeamDelete\`. Use \`genie team create\` / \`genie team disband\` instead.

If you catch yourself about to use Agent, SendMessage, TeamCreate, or TeamDelete — STOP and use the genie CLI equivalent below.

## 2. CLI Commands Reference

### Agent Lifecycle

\`\`\`bash
genie spawn <role>                         # Spawn agent (implementor, tests, review, fix, refactor)
genie kill <name>                          # Force kill agent
genie stop <name>                          # Graceful stop
genie ls                                   # List all agents
genie agent history <name>                 # Session history
genie agent read <name> --follow           # Tail terminal output
genie agent answer <name> <choice>         # Answer prompt (1-9 or text:...)
\`\`\`

### Messaging

\`\`\`bash
genie send '<text>' --to <agent>           # Send message to agent
genie broadcast '<text>'                   # Broadcast to all agents
genie chat [args...]                       # Interactive chat with agent
genie inbox [agent]                        # View message inbox
\`\`\`

### Teams

\`\`\`bash
genie team create <name>                   # Create a team
genie team hire <agent>                    # Add agent to team
genie team fire <agent>                    # Remove agent from team
genie team ls [name]                       # List teams or team members
genie team disband <name>                  # Disband and clean up team
\`\`\`

### Dispatch (Skill-Bound Work)

\`\`\`bash
genie work <agent> <ref>                   # Dispatch worker bound to wish group
genie brainstorm <agent> <slug>            # Dispatch brainstorm on topic
genie wish <agent> <slug>                  # Dispatch wish planning
genie review <agent> <ref>                 # Dispatch review
\`\`\`

### State Management

\`\`\`bash
genie done <ref>                           # Mark group/task done
genie status <slug>                        # Check wish/group status
genie reset <ref>                          # Reset stuck group
\`\`\`

## 3. Skill Flow — Auto-Invocation Chain

Skills trigger the next step automatically where possible:

\`\`\`
/brainstorm ──(WRS=100)──▸ /review (plan)
      │                        │
      │                   SHIP ▸ /wish
      │                        │
      │                   /wish ──▸ /review (plan)
      │                              │
      │                         SHIP ▸ /work
      │                              │
      │                    /work (per group) ──▸ /review (execution)
      │                                             │
      │                          SHIP ▸ PR     FIX-FIRST ▸ /fix ──▸ /review
      │                                              │
      │                                   unclear root cause ▸ /trace
      │
      ▾
  Decisions stuck after 2+ exchanges ──▸ suggest /council
\`\`\`

## 4. Team Lifecycle

\`\`\`
create team ──▸ hire agents ──▸ dispatch work ──▸ review ──▸ PR to dev ──▸ QA ──▸ disband
\`\`\`

1. \`genie team create <name>\` — create team for the initiative
2. \`genie team hire <agent>\` — add agents with needed roles
3. \`genie work <agent> <ref>\` — dispatch groups to workers
4. Monitor via \`genie status <slug>\`, mark done via \`genie done <ref>\`
5. Workers signal completion via \`genie send\`; leader runs \`/review\`
6. Create PR targeting \`dev\`. CI must be green before merge.
7. QA loop on dev: test against wish criteria → \`/fix\` → retest
8. \`genie team disband <name>\` — clean up when done

## 5. Rules

- **No native tools.** All agent/team/messaging operations go through \`genie\` CLI.
- **Role separation.** Leader orchestrates; workers implement. Workers never spawn other agents.
- **Critical: PR review.** Every PR gets \`/review\` before merge. Auto-invoke \`/fix\` on FIX-FIRST.
- **CI green before merge.** Never merge with failing checks. Poll CI status, don't sleep.
- **Agents merge to dev, not main.** PRs always target \`dev\`. Only humans merge \`dev\` → \`main\`.
- **Signal, don't poll.** Workers use \`genie send\` to report completion. Leader uses \`genie done\` to track state.
</GENIE_CLI>
`;

/**
 * Read the current marker version (before installDeps overwrites it).
 * Returns the version string or null if not found.
 */
function getMarkerVersion() {
  try {
    if (existsSync(MARKER)) {
      const marker = JSON.parse(readFileSync(MARKER, 'utf-8'));
      return marker.version || null;
    }
  } catch {
    // Ignore
  }
  return null;
}

/**
 * Inject the orchestration prompt into ~/.claude/rules/genie-orchestration.md
 * Only writes/rewrites if the plugin version changed.
 * @param {string|null} oldVersion - marker version captured before installDeps ran
 */
function injectOrchestrationPrompt(oldVersion) {
  const rulesDir = join(homedir(), '.claude', 'rules');
  const destFile = join(rulesDir, 'genie-orchestration.md');

  if (!existsSync(rulesDir)) {
    mkdirSync(rulesDir, { recursive: true });
  }

  let pluginVersion = null;
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    pluginVersion = pkg.version || null;
  } catch {
    // Ignore
  }

  const fileExists = existsSync(destFile);
  const versionChanged = !fileExists || oldVersion !== pluginVersion;

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
    writeFileSync(configPath, JSON.stringify({
      version: 2,
      promptMode: 'append',
      session: { name: 'genie', defaultWindow: 'shell', autoCreate: true },
      terminal: { execTimeout: 120000, readLines: 100, worktreeBase: '.worktrees' },
      logging: { tmuxDebug: false, verbose: false },
      shell: { preference: 'auto' },
      shortcuts: { tmuxInstalled: false, shellInstalled: false },
      setupComplete: false,
    }, null, 2), 'utf-8');
    console.error('Created default ~/.genie/config.json');
  }
}

/**
 * Ensure tmux base-index defaults are set in ~/.tmux.conf
 * Only runs when version changes (or file missing).
 * @param {string|null} oldVersion - marker version captured before installDeps ran
 */
function ensureTmuxDefaults(oldVersion) {
  let pluginVersion = null;
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    pluginVersion = pkg.version || null;
  } catch {
    // Ignore
  }

  if (oldVersion === pluginVersion) return;

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
    console.error('tmux is required for agent orchestration (genie spawn, teams, etc.).');
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

  // Capture marker version BEFORE installDeps overwrites it
  const oldVersion = getMarkerVersion();

  // 3. Install plugin dependencies if needed
  if (needsInstall()) {
    installDeps();
    console.error('Dependencies installed');
  }

  // 3a. Inject orchestration prompt (idempotent — checks version marker)
  try {
    injectOrchestrationPrompt(oldVersion);
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
    ensureTmuxDefaults(oldVersion);
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
