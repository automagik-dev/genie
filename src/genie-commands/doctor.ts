/**
 * Genie Doctor Command
 *
 * Diagnostic tool to check the health of the genie installation.
 * Checks prerequisites, configuration, and tmux connectivity.
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { $ } from 'bun';
import type { BridgeStatusResult, PingOptions } from '../lib/bridge-status.js';
import { contractClaudePath, getClaudeSettingsPath } from '../lib/claude-settings.js';
import { isAvailable as isRuntimePgAvailable } from '../lib/db.js';
import { tmuxBin } from '../lib/ensure-tmux.js';
import { genieConfigExists, getGenieConfigPath, isSetupComplete, loadGenieConfig } from '../lib/genie-config.js';
import { checkCommand } from '../lib/system-detect.js';
import { findWorkspace } from '../lib/workspace.js';
import {
  GENIE_AGENTS_TEMPLATE,
  GENIE_HEARTBEAT_TEMPLATE,
  GENIE_SOUL_TEMPLATE,
  STALE_GENIE_AGENTS_MD_MARKER,
  STALE_GENIE_AGENT_YAML_MISSING_MODEL_REGEX,
} from '../templates/index.js';
import { collectInstallerResolution } from './installer-resolution.js';
import { collectObservabilityHealth } from './observability-health.js';

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

interface BinarySpec {
  cmd: string;
  displayName: string;
  missingStatus: 'fail' | 'warn';
  missingSuggestion: string;
}

const PREREQ_BINARIES: BinarySpec[] = [
  {
    cmd: 'tmux',
    displayName: 'tmux',
    missingStatus: 'fail',
    missingSuggestion: 'Install with: brew install tmux (or apt install tmux)',
  },
  {
    cmd: 'jq',
    displayName: 'jq',
    missingStatus: 'fail',
    missingSuggestion: 'Install with: brew install jq (or apt install jq)',
  },
  {
    cmd: 'bun',
    displayName: 'bun',
    missingStatus: 'fail',
    missingSuggestion: 'Install with: curl -fsSL https://bun.sh/install | bash',
  },
  {
    cmd: 'claude',
    displayName: 'Claude Code',
    missingStatus: 'warn',
    missingSuggestion: 'Install with: npm install -g @anthropic-ai/claude-code',
  },
  // Codex is required for `genie spawn ... --provider codex` to work.
  {
    cmd: 'codex',
    displayName: 'Codex CLI',
    missingStatus: 'warn',
    missingSuggestion: 'Install via OpenAI account; codex is optional unless using --provider codex',
  },
];

/**
 * Check prerequisites (tmux, jq, bun, Claude Code)
 */
async function checkPrerequisites(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const spec of PREREQ_BINARIES) {
    results.push(await checkBinaryPrereq(spec));
  }

  // Non-interactive PATH check (Group 6 deliverable 1).
  //
  // Spawn-scripts at ~/.genie/spawn-scripts/*.sh run via `tmux send-keys`
  // and `sh -c`, which load ~/.profile but NOT ~/.bashrc (the latter is
  // typically gated by an interactive-shell guard). If `genie`, `bun`,
  // `node`, `npm`, `claude`, `codex`, or `git` is on PATH only via .bashrc,
  // worker spawn scripts will fail with `posix_spawn 'X': ENOENT` even
  // though `genie doctor` (running interactively) reports them OK.
  //
  // Felipe hit this exact failure today on the `genie update` flow:
  // `ENOENT: no such file or directory, posix_spawn 'git'` because git
  // wasn't on the non-interactive PATH for that user.
  const requiredForSpawn = ['genie', 'bun', 'node', 'npm', 'git', 'claude', 'codex'] as const;
  for (const bin of requiredForSpawn) {
    const result = await checkNonInteractivePath(bin);
    if (result) results.push(result);
  }

  return results;
}

async function checkBinaryPrereq(spec: BinarySpec): Promise<CheckResult> {
  const check = await checkCommand(spec.cmd);
  if (check.exists) {
    return { name: spec.displayName, status: 'pass', message: check.version || '' };
  }
  return { name: spec.displayName, status: spec.missingStatus, suggestion: spec.missingSuggestion };
}

async function checkNonInteractivePath(bin: string): Promise<CheckResult | null> {
  const interactivePath = await resolveBinaryInteractive(bin);
  const nonInteractivePath = await resolveBinaryNonInteractive(bin);

  if (interactivePath && nonInteractivePath) {
    // OK in both shells — green.
    return { name: `Non-interactive PATH: ${bin}`, status: 'pass', message: nonInteractivePath };
  }
  if (interactivePath && !nonInteractivePath) {
    // Available interactively but missing in non-interactive shells —
    // spawn-scripts will fail. This is the actionable warning case.
    return {
      name: `Non-interactive PATH: ${bin}`,
      status: 'warn',
      message: 'interactive-only',
      suggestion: `Move PATH export from ~/.bashrc to ~/.profile so spawn-scripts can resolve ${bin}. (Or use a stable symlink in ~/.local/bin.)`,
    };
  }
  // Codex absence is already reported by the per-tool check above; skip duplicate.
  // For other tools, drop into the soft-warn branch.
  // Not resolvable in non-interactive shell — soft warning only,
  // because most of our spawn-scripts use absolute paths (resolved
  // at spawn time via `which` from the parent shell). This still
  // bites flows that shell out to bare names — `genie update`'s
  // `git fetch` is the canonical failure case. Operator can ignore
  // these for binaries they don't use; the warning is informational.
  if (!interactivePath && (bin === 'genie' || bin === 'node' || bin === 'npm' || bin === 'git')) {
    return {
      name: `Non-interactive PATH: ${bin}`,
      status: 'warn',
      message: 'not in non-interactive PATH',
      suggestion: `Add ${bin} to ~/.profile (not just ~/.bashrc). Some flows (e.g. genie update) shell out to bare '${bin}' from non-interactive subprocesses.`,
    };
  }
  return null;
}

/**
 * Resolve a binary's path in the *interactive* shell (the one the user
 * is running `genie doctor` from). Uses Bun's `$` which inherits the
 * parent process environment.
 */
async function resolveBinaryInteractive(bin: string): Promise<string | null> {
  try {
    const result = await $`command -v ${bin}`.quiet().text();
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a binary's path in a *non-interactive* shell — the same
 * environment that `tmux send-keys` + spawn-scripts run under.
 *
 * Uses `sh -c` to ensure ~/.profile loads but ~/.bashrc's interactive-only
 * sections are skipped. This catches the `posix_spawn ENOENT` class of
 * failures BEFORE they break a worker spawn at runtime.
 */
async function resolveBinaryNonInteractive(bin: string): Promise<string | null> {
  try {
    const result = await $`sh -c "command -v ${bin}"`.quiet().text();
    return result.trim() || null;
  } catch {
    return null;
  }
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

  // Check if claude settings exists
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
    const serverResult = await $`${tmuxBin()} -L genie list-sessions 2>/dev/null`.quiet();
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
    // `=` prefix forces literal session-name match — without it tmux parses
    // values like `@46` as window-id syntax and fails lookup.
    const sessionResult = await $`${tmuxBin()} -L genie has-session -t ${`=${sessionName}`} 2>/dev/null`.quiet();
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

  return results;
}

/**
 * Check worker profiles configuration
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

  // Report profile count
  const totalProfiles = Object.keys(profiles).length;
  results.push({
    name: 'Profiles configured',
    status: 'pass',
    message: `${totalProfiles} profile${totalProfiles === 1 ? '' : 's'}`,
  });

  // Report claude profiles
  for (const name of Object.keys(profiles)) {
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
 * Check Omni bridge health via cross-process IPC (pidfile + NATS ping).
 *
 * This used to reach for the in-process bridge singleton which only
 * ever returned a bridge when doctor ran inside the same process as serve.
 * Now doctor is authoritative across processes: it reads the pidfile written
 * by the bridge, validates the owning PID, and issues a `omni.bridge.ping`
 * request with a 2s timeout. The result includes pid, uptime, subjects, and
 * the ping round-trip latency.
 */
async function checkBridge(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  try {
    const { getBridgeStatus, removeBridgePidfile } = await import('../lib/bridge-status.js');
    // Explicit PingOptions — doctor uses the default 2s timeout, but we
    // annotate the type so this call site stays self-documenting and so
    // the PingOptions export has a concrete consumer.
    const pingOpts: PingOptions = {};
    const res: BridgeStatusResult = await getBridgeStatus(undefined, pingOpts);

    if (res.state === 'stopped') {
      results.push({
        name: 'Bridge',
        status: 'warn',
        message: 'stopped (no pidfile)',
        suggestion: 'Start the bridge with: genie serve',
      });
      return results;
    }

    if (res.state === 'stale') {
      // Stale pidfile = owning process is dead or ping timed out. Clean up
      // the pidfile so the next `genie serve` start can retake cleanly.
      if (res.pidfile) {
        removeBridgePidfile();
      }
      results.push({
        name: 'Bridge',
        status: 'fail',
        message: `stale: ${res.detail}`,
        suggestion: 'Restart the bridge with: genie serve restart',
      });
      return results;
    }

    // state === 'running'
    const pong = res.pong;
    const pidfile = res.pidfile;
    if (!pong || !pidfile) {
      results.push({
        name: 'Bridge',
        status: 'warn',
        message: 'running state missing pong/pidfile metadata',
      });
      return results;
    }

    const uptimeSec = Math.round(pong.uptimeMs / 1000);
    results.push({
      name: 'Bridge running',
      status: 'pass',
      message: `running (pid ${pong.pid}, uptime ${uptimeSec}s)`,
    });

    results.push({
      name: 'NATS ping',
      status: 'pass',
      message: `pong in ${res.latencyMs ?? 0}ms (${pidfile.natsUrl})`,
    });

    results.push({
      name: 'Subjects',
      status: 'pass',
      message: pong.subjects.join(', '),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({
      name: 'Bridge module',
      status: 'warn',
      message: `could not probe bridge: ${detail}`,
    });
  }

  return results;
}

/**
 * Detect workspaces scaffolded before the GENIE_AGENTS_TEMPLATE branch
 * landed. Their `agents/genie/AGENTS.md` still carries the generic
 * placeholder template (gray TUI, no model resolution); upgrading the
 * package never re-runs scaffold, so the file persists. See #1374.
 *
 * Two independent symptoms — either is enough to flag:
 *   1. AGENTS.md contains the generic-template marker phrase.
 *   2. agent.yaml is missing a `model:` field.
 *
 * Exported so the `--fix` path and unit tests can share the detection.
 */
export function checkGenieAgentTemplate(workspaceRoot?: string): CheckResult[] {
  const root = workspaceRoot ?? findWorkspace()?.root;
  if (!root) return [];

  const genieDir = join(root, 'agents', 'genie');
  if (!existsSync(genieDir)) return [];

  const agentsMd = join(genieDir, 'AGENTS.md');
  const agentYaml = join(genieDir, 'agent.yaml');

  const issues: string[] = [];
  if (existsSync(agentsMd)) {
    try {
      const text = readFileSync(agentsMd, 'utf-8');
      if (text.includes(STALE_GENIE_AGENTS_MD_MARKER)) {
        issues.push('AGENTS.md uses generic placeholder template');
      }
    } catch {
      // unreadable — skip silently; another check will surface IO problems
    }
  }
  if (existsSync(agentYaml)) {
    try {
      const text = readFileSync(agentYaml, 'utf-8');
      if (!STALE_GENIE_AGENT_YAML_MISSING_MODEL_REGEX.test(text)) {
        issues.push('agent.yaml missing model field (TUI falls back to gray)');
      }
    } catch {
      // unreadable — skip silently
    }
  }

  if (issues.length === 0) {
    return [{ name: 'agents/genie scaffold up to date', status: 'pass' }];
  }
  return [
    {
      name: 'agents/genie stale scaffold',
      status: 'warn',
      message: issues.join('; '),
      suggestion: 'Run: genie doctor --fix (re-emits genie specialist templates, preserves user edits)',
    },
  ];
}

/**
 * Locate the bundled `scripts/tmux/*.conf` directory shipped with this
 * version of @automagik/genie. The path differs between the dev tree
 * (workspace), the global bun install, and the npm install (under dist/),
 * so we walk up from this module's URL to find a `scripts/tmux/` sibling.
 *
 * Returns null if the bundled configs can't be found — in which case the
 * tmux-config staleness check is skipped (we can't compute a diff target).
 */
export function findBundledTmuxConfigDir(): string | null {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    // Walk up: src/genie-commands/ → src/ → repo-root, then look for scripts/tmux
    for (let i = 0; i < 6; i += 1) {
      const candidate = resolve(moduleDir, '../'.repeat(i + 1), 'scripts', 'tmux');
      if (existsSync(join(candidate, 'tui-tmux.conf')) && existsSync(join(candidate, 'genie.tmux.conf'))) {
        return candidate;
      }
    }
  } catch {
    // import.meta.url unavailable (CJS); fall through
  }
  return null;
}

/**
 * Detect stale `~/.genie/{tui-tmux,tmux}.conf` files. The `MouseDown3*`
 * unbinds for tmux 3.3+ context menus shipped in #1153 — workspaces from
 * before that fix carry conf files that allow right-click to corrupt the
 * TUI render. Same fix-on-upgrade gap as #1374: postinstall-tmux only
 * copies on first install.
 *
 * Strategy: read the bundled scripts/tmux/*.conf and check that ~/.genie
 * counterparts contain the same MouseDown3 unbind block. Difference =>
 * stale. (Full byte-equality is too strict — users may have local edits.)
 */
export function checkTmuxConfigs(): CheckResult[] {
  const bundledDir = findBundledTmuxConfigDir();
  if (!bundledDir) {
    return [{ name: 'tmux configs', status: 'pass', message: 'bundled configs unavailable (skipped)' }];
  }

  const home = join(homedir(), '.genie');
  const stale: string[] = [];
  const expectedSnippet = 'unbind -n MouseDown3Pane';

  for (const file of ['tui-tmux.conf', 'tmux.conf']) {
    const installedPath = join(home, file);
    if (!existsSync(installedPath)) continue;
    try {
      const installed = readFileSync(installedPath, 'utf-8');
      if (!installed.includes(expectedSnippet)) {
        stale.push(file);
      }
    } catch {
      // unreadable — surface as stale to be safe
      stale.push(file);
    }
  }

  if (stale.length === 0) {
    return [{ name: '~/.genie tmux configs up to date', status: 'pass' }];
  }
  return [
    {
      name: '~/.genie tmux configs stale',
      status: 'warn',
      message: `missing right-click unbind in: ${stale.join(', ')}`,
      suggestion: 'Run: genie doctor --fix (refreshes ~/.genie tmux configs from bundled scripts/tmux/)',
    },
  ];
}

/**
 * Check that no agent has leftover `---` frontmatter in its `AGENTS.md`
 * when `agent.yaml` is also present. Wish `dir-sync-frontmatter-refresh`
 * (Group 6) eliminates frontmatter entirely post-migration — if a user
 * pastes config back into AGENTS.md, sync silently ignores it, which is
 * confusing. This check surfaces the drift loudly.
 *
 * Exported for unit tests and for callers that want to run this check
 * outside `genie doctor` (e.g. a pre-sync lint).
 */
function isAgentDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasLegacyFrontmatter(agentDir: string): boolean {
  const yamlPath = join(agentDir, 'agent.yaml');
  const agentsMdPath = join(agentDir, 'AGENTS.md');
  if (!existsSync(yamlPath) || !existsSync(agentsMdPath)) return false;
  try {
    return readFileSync(agentsMdPath, 'utf-8').slice(0, 4).startsWith('---');
  } catch {
    return false;
  }
}

export function checkLegacyAgentFrontmatter(workspaceRoot?: string): CheckResult[] {
  const results: CheckResult[] = [];
  const root = workspaceRoot ?? findWorkspace()?.root;
  if (!root) return [];

  const agentsDir = join(root, 'agents');
  if (!existsSync(agentsDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return [];
  }

  for (const name of entries) {
    const agentDir = join(agentsDir, name);
    if (!isAgentDirectory(agentDir)) continue;
    if (!hasLegacyFrontmatter(agentDir)) continue;

    results.push({
      name: `agents/${name}/AGENTS.md`,
      status: 'warn',
      message: 'legacy frontmatter detected (ignored by sync)',
      suggestion: `Move config into agents/${name}/agent.yaml — AGENTS.md is prompt-only post-migration.`,
    });
  }

  if (results.length === 0) {
    results.push({ name: 'No legacy frontmatter in agents/*/AGENTS.md', status: 'pass' });
  }
  return results;
}

/**
 * Check canonical pgserve state — whether the pgserve binary is on PATH,
 * registered under pm2, and listening on the canonical port. Mirrors omni
 * doctor's `pgserve-canonical` check so both halves of the canonical-stack
 * surface the same shared-backbone visibility.
 *
 * Three outcomes:
 *   - pgserve missing → WARN with install hint (not FAIL because genie can
 *     auto-spawn its own daemon as a fallback for fingerprint-routed CLI).
 *   - pgserve installed but not under pm2 → WARN pointing at `pgserve install`.
 *   - pgserve registered + reachable → PASS, surface the canonical URL so
 *     operators can verify what genie-serve / omni-api are connecting to.
 */
async function checkPgserveCanonical(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Step 1: pgserve binary on PATH? Probe via `pgserve port` (NOT --version
  // — that flag doesn't exist in pgserve@^2.1.0 and false-negatived in
  // historical doctor implementations).
  let canonicalPort: number | null = null;
  try {
    const out = execFileSync('pgserve', ['port'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = Number.parseInt(out.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) {
      canonicalPort = parsed;
    }
  } catch {
    /* pgserve binary missing or non-zero exit — handled below */
  }

  if (canonicalPort === null) {
    results.push({
      name: 'pgserve binary',
      status: 'warn',
      message: 'not on PATH (or `pgserve port` failed)',
      suggestion:
        'Install canonical pgserve: bun add -g pgserve@^2.1.0 (then run `pgserve install` to register under pm2)',
    });
    return results;
  }
  results.push({
    name: 'pgserve binary',
    status: 'pass',
    message: `canonical port ${canonicalPort}`,
  });

  // Step 2: pm2-supervised? Check via `pgserve status --json`.
  try {
    const status = execFileSync('pgserve', ['status', '--json'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(status) as { installed?: boolean; status?: string };
    if (parsed.installed === true && parsed.status === 'online') {
      results.push({
        name: 'pgserve under pm2',
        status: 'pass',
        message: `online — shared backbone for genie-serve + omni-api on :${canonicalPort}`,
      });
    } else if (parsed.installed === true) {
      // pm2 has the entry but reports stopped. Under the consumer-only
      // cutover model genie connects via the embedded socket regardless
      // of pm2's view, so probe the runtime PG before warning. If the
      // runtime is healthy, this is a stale pm2 registration — a cleanup
      // hint, not a recovery action.
      const runtimeReachable = await isRuntimePgAvailable();
      if (runtimeReachable) {
        results.push({
          name: 'pgserve under pm2',
          status: 'pass',
          message: `pm2 entry status=${parsed.status ?? 'unknown'} but runtime PG reachable (consumer-only)`,
          suggestion: 'Optional cleanup: pm2 delete pgserve  (the embedded backbone is the source of truth)',
        });
      } else {
        results.push({
          name: 'pgserve under pm2',
          status: 'warn',
          message: `registered but status=${parsed.status ?? 'unknown'}; runtime PG also unreachable`,
          suggestion: 'Recover with: pm2 restart pgserve   (logs: ~/.pgserve/logs/)',
        });
      }
    } else {
      results.push({
        name: 'pgserve under pm2',
        status: 'warn',
        message: 'binary present but not registered under pm2',
        suggestion: 'Register canonical pgserve: pgserve install',
      });
    }
  } catch {
    results.push({
      name: 'pgserve under pm2',
      status: 'warn',
      message: '`pgserve status` failed (pm2 unreachable?)',
      suggestion: 'Verify pm2: pm2 list   |   Re-register: pgserve install',
    });
  }

  return results;
}

/**
 * Main doctor command
 */
function runCheckSection(label: string, results: CheckResult[], counts: { errors: boolean; warnings: boolean }): void {
  printSectionHeader(label);
  for (const result of results) {
    printCheckResult(result);
    if (result.status === 'fail') counts.errors = true;
    if (result.status === 'warn') counts.warnings = true;
  }
}

export async function doctorCommand(options?: {
  fix?: boolean;
  observability?: boolean;
  perf?: boolean;
  fixTeamOrphans?: boolean;
  dryRun?: boolean;
  json?: boolean;
}): Promise<void> {
  if (options?.fix) {
    await doctorFix();
    return;
  }

  if (options?.fixTeamOrphans) {
    await runFixTeamOrphans({ dryRun: Boolean(options.dryRun), json: Boolean(options.json) });
    return;
  }

  if (options?.observability) {
    await runObservabilityCheck(Boolean(options.json));
    return;
  }

  if (options?.perf) {
    const { runPerfCheck } = await import('./perf-check.js');
    await runPerfCheck(Boolean(options.json));
    return;
  }

  console.log();
  console.log('\x1b[1mGenie Doctor\x1b[0m');
  console.log(`\x1b[2m${'\u2500'.repeat(40)}\x1b[0m`);

  const counts = { errors: false, warnings: false };

  runCheckSection('Prerequisites', await checkPrerequisites(), counts);
  runCheckSection('Installer Resolution', await collectInstallerResolution(), counts);
  runCheckSection('Configuration', await checkConfiguration(), counts);
  runCheckSection('Tmux', await checkTmux(), counts);
  runCheckSection('Tmux Configs', checkTmuxConfigs(), counts);
  runCheckSection('Worker Profiles', await checkWorkerProfiles(), counts);
  runCheckSection('Pgserve (canonical backbone)', await checkPgserveCanonical(), counts);
  runCheckSection('Omni Bridge', await checkBridge(), counts);
  runCheckSection('Agent Config', checkLegacyAgentFrontmatter(), counts);
  runCheckSection('Genie Specialist', checkGenieAgentTemplate(), counts);

  printDoctorSummary(counts);
  if (counts.errors) process.exit(1);
}

function printObservabilityReport(report: Awaited<ReturnType<typeof collectObservabilityHealth>>): void {
  console.log();
  console.log('\x1b[1mObservability Health\x1b[0m');
  console.log(`\x1b[2m${'\u2500'.repeat(40)}\x1b[0m`);
  console.log(`  partition_health:  ${report.partition_health}`);
  console.log(`  partition_count:   ${report.partition_count}`);
  console.log(`  next_rotation_at:  ${report.next_rotation_at ?? 'n/a'}`);
  console.log(`  oldest_partition:  ${report.oldest_partition ?? 'n/a'}`);
  console.log(`  newest_partition:  ${report.newest_partition ?? 'n/a'}`);
  console.log(`  GENIE_WIDE_EMIT:   ${report.wide_emit_flag}`);
  if (report.message) console.log(`  note:              ${report.message}`);
  console.log();
}

async function runObservabilityCheck(json: boolean): Promise<void> {
  const report = await collectObservabilityHealth();
  if (json) console.log(JSON.stringify(report, null, 2));
  else printObservabilityReport(report);
  if (report.partition_health === 'fail') process.exit(1);
}

/**
 * `genie doctor --fix-team-orphans` — companion to invincible-genie
 * migration 050. Walks `<claudeConfigDir>/teams/`, archives stale dirs
 * missing `config.json`, leaves active orphans visible for `genie status`
 * + `genie team repair <name>`. Idempotent — safe to re-run.
 */
async function runFixTeamOrphans(opts: { dryRun: boolean; json: boolean }): Promise<void> {
  const { archiveOrphanTeamConfigs } = await import('../../scripts/archive-orphan-team-configs.js');
  const decisions = archiveOrphanTeamConfigs({ dryRun: opts.dryRun });

  if (opts.json) {
    console.log(JSON.stringify({ dryRun: opts.dryRun, decisions }, null, 2));
    return;
  }

  if (decisions.length === 0) {
    console.log('  no team config dirs found — nothing to do');
    return;
  }
  for (const d of decisions) {
    const tag =
      d.classification === 'stale' ? (opts.dryRun ? 'WOULD ARCHIVE' : 'ARCHIVED') : d.classification.toUpperCase();
    const tail = d.archivedTo ? ` → ${d.archivedTo}` : '';
    console.log(`  [${tag}] ${d.team}  — ${d.reason}${tail}`);
  }
  const stale = decisions.filter((d) => d.classification === 'stale').length;
  const active = decisions.filter((d) => d.classification === 'active').length;
  console.log(`\n  ${decisions.length} dirs inspected, ${stale} archived, ${active} flagged active.`);
}

function printDoctorSummary(counts: { errors: boolean; warnings: boolean }): void {
  console.log();
  console.log(`\x1b[2m${'\u2500'.repeat(40)}\x1b[0m`);
  if (counts.errors) {
    console.log('\x1b[31mSome checks failed.\x1b[0m Run \x1b[36mgenie setup\x1b[0m to fix.');
  } else if (counts.warnings) {
    console.log('\x1b[33mSome warnings detected.\x1b[0m Everything should still work.');
  } else {
    console.log('\x1b[32mAll checks passed!\x1b[0m');
  }
  console.log();
}

function legacyPgserveRepairEnabled(): boolean {
  return process.env.GENIE_PG_FORCE_TCP === '1' || process.env.GENIE_DOCTOR_FIX_LEGACY_PGSERVE === '1';
}

/**
 * `genie doctor --fix` — automated recovery for daemon state.
 *
 * pgserve v2 is portless and must coexist with pgserve v1 (latest v1:
 * 1.2.0). Default doctor repair therefore avoids broad pgserve/postgres
 * process kills. Legacy TCP cleanup is opt-in via GENIE_PG_FORCE_TCP=1 or
 * GENIE_DOCTOR_FIX_LEGACY_PGSERVE=1 and is scoped to Genie's legacy data dir.
 */
/**
 * After the canonical-pgserve cutover, the doctor never shells out to pkill
 * pgserve / postgres. The canonical daemon is supervised by pm2; any "heal"
 * that touches the postgres process tree fights pm2's restart-on-crash and
 * produces the "Could not kill stale postgres processes" failure mode that
 * triggered the cutover wish. Recovery is hint-only: print the pm2 commands
 * and let the operator run them.
 */
function printPgserveRecoveryHint(): void {
  console.log('  \x1b[33m[!!] pgserve unreachable \u2014 canonical daemon may not be running.\x1b[0m');
  console.log('    Recovery (run as the operator, not the doctor):');
  console.log('      pm2 status              # is pgserve registered?');
  console.log('      pm2 restart pgserve     # OR: autopg restart');
  console.log('      pgserve install         # if not registered yet');
  console.log('    See https://github.com/automagik-dev/genie/blob/main/docs/install.md');
}

async function cleanSharedMemory(): Promise<void> {
  console.log('  Cleaning shared memory...');
  try {
    const { execSync } = await import('node:child_process');
    // Linux ipcs -m columns: key shmid owner perms bytes nattch status
    //   \u2192 `$6 == 0` filter removes only segments with no attached processes.
    // Darwin (macOS) ipcs -m columns: T ID KEY MODE OWNER GROUP
    //   \u2192 no nattch column. We blind-call ipcrm on every segment owned by
    //   the current uid and let the kernel reject in-use ones with EBUSY.
    //   Real PostgreSQL 18 (pgserve 1.2.0+) needs SysV shmem; without this
    //   path, leaked segments accumulate to SHMMNI=32 and pgserve startup
    //   fails with "could not create shared memory segment: No space left
    //   on device" \u2014 surfacing as the #1335 / #1273 test flake.
    if (process.platform === 'darwin') {
      execSync(`ipcs -m 2>/dev/null | awk '/^m/ {print $2}' | xargs -I{} ipcrm -m {} 2>/dev/null || true`, {
        stdio: 'ignore',
        timeout: 5000,
      });
    } else {
      execSync(`ipcs -m 2>/dev/null | awk '$6 == 0 {print $2}' | xargs -I{} ipcrm -m {} 2>/dev/null || true`, {
        stdio: 'ignore',
        timeout: 5000,
      });
    }
    console.log('  \x1b[32m\u2713\x1b[0m Shared memory cleaned');
  } catch {
    console.log('  \x1b[32m\u2713\x1b[0m No stale shared memory');
  }
}

async function stopExistingDaemon(pidFile: string): Promise<void> {
  try {
    const { readFileSync } = await import('node:fs');
    const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (!Number.isNaN(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`  \x1b[32m\u2713\x1b[0m Stopped existing daemon (PID ${pid})`);
        await new Promise((r) => setTimeout(r, 1000));
      } catch {
        // Already dead
      }
    }
  } catch {
    // No PID file or unreadable — no daemon to stop
  }
}

function removeStaleFiles(genieHome: string, pidFile: string): void {
  const files = [pidFile];
  if (legacyPgserveRepairEnabled()) {
    files.push(join(genieHome, 'pgserve.port'), join(genieHome, 'data', 'pgserve', 'postmaster.pid'));
  } else {
    console.log('  Leaving legacy pgserve v1 port/data files untouched (v1/v2 coexistence)');
  }

  for (const file of files) {
    if (existsSync(file)) {
      try {
        unlinkSync(file);
        console.log(`  \x1b[32m\u2713\x1b[0m Removed ${file}`);
      } catch {
        console.log(`  \x1b[33m!\x1b[0m Could not remove ${file}`);
      }
    }
  }
}

async function restartDaemon(): Promise<void> {
  console.log('  Restarting daemon...');
  try {
    const { spawn } = await import('node:child_process');
    const bunPath = process.execPath ?? 'bun';
    const genieBin = process.argv[1] ?? 'genie';
    const child = spawn(bunPath, [genieBin, 'daemon', 'start'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log('  \x1b[32m\u2713\x1b[0m Daemon restart initiated');
  } catch {
    console.log('  \x1b[33m!\x1b[0m Could not restart daemon \u2014 run: genie daemon start');
  }
}

/**
 * User-edited heuristic for AGENTS.md: existing file is non-empty AND does
 * NOT contain the stale generic-template marker. The marker only appears in
 * the pre-#1374 generic AGENTS_TEMPLATE; absence of it implies the user has
 * customized the file. Conservative on purpose \u2014 better to write `.new`
 * than overwrite real edits.
 *
 * SOUL.md and HEARTBEAT.md don't carry a useful marker, so we always
 * overwrite them \u2014 the genie specialist soul/heartbeat are framework code
 * (command listings, pipeline definitions) that users should not be editing.
 */
function isAgentsMdUserEdited(target: string, fresh: string): boolean {
  if (!existsSync(target)) return false;
  try {
    const current = readFileSync(target, 'utf-8');
    if (current.trim().length === 0) return false;
    if (current.includes(STALE_GENIE_AGENTS_MD_MARKER)) return false;
    return current !== fresh;
  } catch {
    return false;
  }
}

function writeGenieTemplate(targetDir: string, name: string, content: string): void {
  const target = join(targetDir, name);
  const userEdited = name === 'AGENTS.md' && isAgentsMdUserEdited(target, content);
  const writeTo = userEdited ? `${target}.new` : target;
  try {
    writeFileSync(writeTo, content);
    const marker = userEdited ? `wrote ${name}.new (user edits preserved \u2014 merge manually)` : `wrote ${name}`;
    console.log(`  \x1b[32m\u2713\x1b[0m ${marker}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`  \x1b[31m\u2717\x1b[0m ${name}: ${detail}`);
  }
}

/**
 * Re-emit the genie specialist templates for workspaces flagged by
 * checkGenieAgentTemplate. Preserves user edits to AGENTS.md by writing to
 * `AGENTS.md.new` when the file looks customized; otherwise overwrites in
 * place. See #1374.
 */
function fixGenieAgentTemplate(workspaceRoot?: string): void {
  const root = workspaceRoot ?? findWorkspace()?.root;
  if (!root) {
    console.log('  \x1b[33m!\x1b[0m No workspace detected \u2014 skipping genie-template repair');
    return;
  }
  const genieDir = join(root, 'agents', 'genie');
  if (!existsSync(genieDir)) {
    console.log('  \x1b[2m\u00b7\x1b[0m No agents/genie directory \u2014 skipping');
    return;
  }
  console.log('  Refreshing agents/genie scaffold...');
  writeGenieTemplate(genieDir, 'AGENTS.md', GENIE_AGENTS_TEMPLATE);
  writeGenieTemplate(genieDir, 'SOUL.md', GENIE_SOUL_TEMPLATE);
  writeGenieTemplate(genieDir, 'HEARTBEAT.md', GENIE_HEARTBEAT_TEMPLATE);
}

function ensureGenieHomeDir(home: string): boolean {
  if (existsSync(home)) return true;
  try {
    mkdirSync(home, { recursive: true });
    return true;
  } catch {
    console.log(`  \x1b[31m\u2717\x1b[0m Could not create ${home}`);
    return false;
  }
}

function refreshTmuxConfFile(bundledDir: string, home: string, srcFile: string, dstFile: string): void {
  const src = join(bundledDir, srcFile);
  const dst = join(home, dstFile);
  if (!existsSync(src)) return;
  if (existsSync(dst)) {
    try {
      copyFileSync(dst, `${dst}.bak`);
    } catch {
      // best-effort backup
    }
  }
  try {
    copyFileSync(src, dst);
    console.log(`  \x1b[32m\u2713\x1b[0m wrote ${dstFile} (previous saved as ${dstFile}.bak)`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`  \x1b[31m\u2717\x1b[0m ${dstFile}: ${detail}`);
  }
}

/**
 * Refresh `~/.genie/{tui-tmux,tmux}.conf` from the bundled scripts/tmux
 * versions. Backs up the existing file to `<name>.bak` before overwriting
 * so users can recover any local edits. See #1153 + this PR's audit.
 *
 * Source/destination names differ for the agent server config \u2014 the
 * bundle ships `genie.tmux.conf` and the postinstall/setup steps copy it
 * to `~/.genie/tmux.conf` (renamed to avoid colliding with the user's
 * own tmux config if they happen to run `tmux -L genie -f ~/.genie/...`).
 * The TUI server config keeps the same name on both sides.
 */
function fixTmuxConfigs(): void {
  const bundledDir = findBundledTmuxConfigDir();
  if (!bundledDir) {
    console.log('  \x1b[33m!\x1b[0m Bundled tmux configs not found \u2014 skipping');
    return;
  }
  const home = join(homedir(), '.genie');
  if (!ensureGenieHomeDir(home)) return;
  console.log('  Refreshing ~/.genie tmux configs...');
  refreshTmuxConfFile(bundledDir, home, 'tui-tmux.conf', 'tui-tmux.conf');
  refreshTmuxConfFile(bundledDir, home, 'genie.tmux.conf', 'tmux.conf');
}

async function runMaintenancePreconditions(silent = false, log?: (line: string) => void): Promise<void> {
  // Heavy preconditions live here, NOT in `ensureServeReady`: watchdog install,
  // foreground backfill convergence, stale team-config archive. Boot is fast;
  // upgrades and explicit `doctor --fix` are where housekeeping happens.
  try {
    const { runDoctorMaintenance } = await import('../term-commands/serve/ensure-ready.js');
    await runDoctorMaintenance({ silent, deps: log ? { log } : undefined });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!silent) console.warn(`  Maintenance preconditions skipped: ${msg}`);
  }
}

async function doctorFix(): Promise<void> {
  console.log('\n\x1b[1mGenie Doctor \u2014 Auto Fix\x1b[0m');
  console.log(`\x1b[2m${'\u2500'.repeat(40)}\x1b[0m\n`);

  const genieHome = process.env.GENIE_HOME ?? join(homedir(), '.genie');

  printPgserveRecoveryHint();
  await cleanSharedMemory();

  const pidFile = join(genieHome, 'scheduler.pid');

  await stopExistingDaemon(pidFile);
  removeStaleFiles(genieHome, pidFile);

  // macOS-hardening repairs (#1374, #1390 companion). Both are workspace/host
  // state, not daemon state, so they run independent of the postgres path.
  fixGenieAgentTemplate();
  fixTmuxConfigs();

  // Maintenance preconditions previously gated boot; now they live here so
  // `genie` (auto-start) stays fast and one-time work happens at upgrade /
  // explicit doctor invocations.
  await runMaintenancePreconditions();

  await restartDaemon();

  console.log(`\n\x1b[2m${'\u2500'.repeat(40)}\x1b[0m`);
  console.log('\x1b[32mFix complete.\x1b[0m Run \x1b[36mgenie doctor\x1b[0m to verify.\n');
}

/**
 * Silent maintenance pass for the post-update hook. Skips daemon restart and
 * stops/cleans state \u2014 those are explicit doctor concerns. Only runs the
 * shells-out / one-time-cost preconditions that day-one users would otherwise
 * hit on first `genie` after upgrade.
 */
export interface PostUpdateMaintenanceOptions {
  silent?: boolean;
  log?: (line: string) => void;
}

export async function runPostUpdateMaintenance(options: PostUpdateMaintenanceOptions = {}): Promise<void> {
  await reapStaleGenieProcessesSafe(options);
  await runMaintenancePreconditions(options.silent ?? false, options.log);
}

/**
 * Walk a process's parent chain via /proc/<pid>/status. Returns the set of
 * PIDs from `pid` up to init (1). Used by the stale-genie reaper to avoid
 * killing ourselves or our caller (the npm/bun update wrapper or the user's
 * shell).
 */
function getParentChain(pid: number): Set<number> {
  const chain = new Set<number>();
  let current = pid;
  while (current > 1 && !chain.has(current)) {
    chain.add(current);
    try {
      const status = readFileSync(`/proc/${current}/status`, 'utf-8');
      const match = status.match(/^PPid:\s+(\d+)/m);
      if (!match) break;
      const next = Number.parseInt(match[1], 10);
      if (!Number.isFinite(next) || next <= 0) break;
      current = next;
    } catch {
      break;
    }
  }
  return chain;
}

/**
 * Identify candidate stale genie processes from /proc.
 *
 * A candidate is any process whose argv contains `dist/genie.js` AND is NOT
 * in the exclude set. Caller is responsible for populating `exclude` with
 * the current PID, parent chain, and the active serve-daemon PID.
 *
 * Exposed for unit tests.
 */
export function findStaleGenieCandidates(exclude: Set<number>): number[] {
  if (process.platform !== 'linux') return [];
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  const candidates: number[] = [];
  for (const entry of entries) {
    const pid = Number.parseInt(entry, 10);
    if (!Number.isFinite(pid) || pid <= 1) continue;
    if (exclude.has(pid)) continue;
    let cmdline = '';
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    } catch {
      continue; // permission denied, exited mid-scan, etc.
    }
    // Match the bun-bundle invocation form. Argv pieces are NUL-separated
    // (file is read whole) so substring match is sufficient.
    if (!cmdline.includes('dist/genie.js')) continue;
    candidates.push(pid);
  }
  return candidates;
}

interface Pm2ListEntry {
  name?: string;
  pid?: number;
  pm2_env?: { status?: string; pm_exec_path?: string; created_at?: number };
}

/**
 * Read pm2's process list. Returns empty when pm2 is not installed, not
 * running, or returns malformed JSON. Any error path is non-fatal — the
 * post-update cleanup must continue even when pm2 is absent.
 */
function safePm2List(): Pm2ListEntry[] {
  try {
    const out = execFileSync('pm2', ['jlist'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? (parsed as Pm2ListEntry[]) : [];
  } catch {
    return [];
  }
}

function safePm2Delete(name: string): boolean {
  try {
    execFileSync('pm2', ['delete', name], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop pm2 entries that are stale post-update. Two cases:
 *
 *   1. **Broken legacy name** (`genie-serve.ecosystem`) — created by the
 *      pre-fix install code that wrote the ecosystem config with a
 *      non-`.config.cjs` filename, causing pm2 to run the config as a
 *      regular script (no actual genie-serve, just a no-op restart-loop).
 *   2. **Stale `pm_exec_path`** — entry's resolved script path doesn't
 *      match the currently-installed `genie` binary (e.g. user moved
 *      install method from npm to bun). pm2 supervises the wrong file.
 *
 * After cleanup, the next `genie install` will re-create the entry
 * correctly. Safe to skip if pm2 isn't installed — pure operator hygiene.
 */
function cleanupStalePm2Entries(log: (line: string) => void): void {
  const entries = safePm2List();
  if (entries.length === 0) return; // pm2 absent or empty — nothing to clean

  const stale: Array<{ name: string; reason: string }> = [];
  for (const entry of entries) {
    if (!entry.name) continue;
    if (entry.name === 'genie-serve.ecosystem') {
      stale.push({ name: entry.name, reason: 'legacy broken filename pattern' });
    }
    // Future heuristic: detect stale pm_exec_path. Skipped for now —
    // requires path canonicalisation (npm vs bun vs symlinks) and the
    // false-positive cost is "user has to re-run genie install".
  }

  for (const { name, reason } of stale) {
    log(`  [fix] pm2 delete ${name} (${reason})`);
    if (!safePm2Delete(name)) {
      log(`  [!!] pm2 delete ${name} failed (non-blocking)`);
    }
  }
}

/**
 * Reap stale genie processes + pm2 entries left over from before this
 * update. Runs as part of `runPostUpdateMaintenance`. Why: the in-memory
 * binary loaded by any long-running genie process (`genie serve`, TUIs,
 * orphan subprocesses) is the OLD version — the connection-leak,
 * direct-postmaster, and bind-to-local fixes shipped today only protect
 * NEW invocations. Old processes keep holding leaked pgserve connections
 * until they die, which on busy hosts saturates `max_connections` and
 * locks out everything else with `sorry, too many clients already`.
 *
 * Behaviour
 * ---------
 *
 *   - Kills all genie processes whose argv contains `dist/genie.js`,
 *     **including the active serve daemon** read from `~/.genie/serve.pid`.
 *     The daemon is the most-leaking process post-update; preserving it
 *     defeats the purpose of the update. The next `genie *` invocation
 *     will autospawn a fresh daemon on the new binary, OR pm2 will if
 *     `genie install` ran successfully.
 *   - Excludes self (`process.pid`) and the entire parent chain so we
 *     don't kill the npm/bun update wrapper or the user's shell.
 *   - Cleans up stale pm2 entries (`genie-serve.ecosystem` legacy form
 *     and any other obvious mismatches).
 *
 * Safety
 * ------
 *
 *   - Linux-only (relies on /proc). macOS/Windows skip with a notice.
 *   - Opt out via `GENIE_UPDATE_NO_REAP=1` (preserve the daemon for
 *     debugging — operator must manually `genie serve restart`).
 *   - Failures are non-fatal — the update flow continues.
 */
async function reapStaleGenieProcesses(opts: { log?: (line: string) => void } = {}): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line));
  if (process.env.GENIE_UPDATE_NO_REAP === '1') {
    log('  [--] Stale genie reap skipped (GENIE_UPDATE_NO_REAP=1)');
    return;
  }
  if (process.platform !== 'linux') {
    log('  [--] Stale genie reap: Linux-only (procfs); skipping on this platform');
    return;
  }

  // Exclude self + parent chain only. The active `genie serve` daemon is
  // intentionally NOT excluded — its in-memory binary is stale post-update
  // and it's the largest leak source. Killing it triggers autospawn of a
  // fresh daemon under the new code on the next genie invocation.
  const exclude = getParentChain(process.pid);

  const candidates = findStaleGenieCandidates(exclude);
  if (candidates.length === 0) {
    log('  [ok] No stale genie processes to reap');
  } else {
    log(`  [fix] Reaping ${candidates.length} stale genie process(es) (incl. serve daemon): ${candidates.join(', ')}`);
    for (const pid of candidates) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already dead between scan and signal — fine.
      }
    }

    // Give SIGTERM 2s to settle. Most genie processes have shutdown handlers
    // (the same beforeExit handler we added in #1580) that drain pools and
    // exit cleanly within a second.
    await new Promise((r) => setTimeout(r, 2000));

    const stragglers: number[] = [];
    for (const pid of candidates) {
      try {
        process.kill(pid, 0); // signal 0 = liveness probe
        stragglers.push(pid);
      } catch {
        // Gone after SIGTERM — good.
      }
    }
    if (stragglers.length > 0) {
      log(`  [fix] SIGKILL stragglers: ${stragglers.join(', ')}`);
      for (const pid of stragglers) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Race: died between probe and SIGKILL — fine.
        }
      }
    }

    // Daemon was just killed — clear the stale pid file so the next
    // genie invocation autospawns cleanly instead of probing a dead pid.
    try {
      const home = process.env.GENIE_HOME ?? join(homedir(), '.genie');
      const servePidPath = join(home, 'serve.pid');
      if (existsSync(servePidPath)) unlinkSync(servePidPath);
    } catch {
      // serve.pid is stale-tolerant — next caller will recover.
    }
  }

  cleanupStalePm2Entries(log);

  log('  [ok] Stale genie reap complete');
}

/**
 * Wrapper that swallows reap failures so the rest of post-update maintenance
 * still runs. The reaper itself catches per-PID errors; this guards against
 * unexpected throws (e.g. /proc readdir denied in unusual sandboxes).
 */
async function reapStaleGenieProcessesSafe(opts: PostUpdateMaintenanceOptions): Promise<void> {
  try {
    await reapStaleGenieProcesses({ log: opts.log });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const log = opts.log ?? ((line: string) => console.log(line));
    log(`  [!!] Stale genie reap failed (non-blocking): ${msg}`);
  }
}
