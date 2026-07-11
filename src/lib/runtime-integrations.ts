import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getCodexConfigPath, getCodexHome, migrateDeadGenieOtel } from './codex-config.js';
import { resolveGenieHome } from './genie-home.js';
import { VERSION } from './version.js';

export type IntegrationSelection = 'auto' | 'codex' | 'claude' | 'all' | 'none';
export type RuntimeName = 'codex' | 'claude';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => CommandResult;

const defaultRunner: CommandRunner = (command, args) => {
  const result = Bun.spawnSync([command, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

function commandExists(command: string): boolean {
  return Boolean(Bun.which(command));
}

/**
 * A directory qualifies as the bundle root only when it actually carries the
 * genie plugin payload the integrations reference (`plugins/genie/codex-agents`
 * ships in every bundle and repo checkout). This guard is what keeps virtual
 * compile-time paths (`/$bunfs/...` → `/`) from ever being returned.
 */
function isBundleRoot(root: string): boolean {
  return existsSync(join(root, 'plugins', 'genie', 'codex-agents'));
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Locate the directory that contains `plugins/genie` plus the marketplace
 * manifests (`.agents/plugins/marketplace.json`, `.claude-plugin/marketplace.json`).
 *
 * Probe order (first qualifying root wins):
 *   1. explicit argument / GENIE_BUNDLE_ROOT — caller's assertion, unvalidated
 *   2. GENIE_HOME (`~/.genie`) — the installed layout: install.sh extracts to
 *      `~/.genie/bin/` and normalizeAuxLayout moves plugins/ + manifests to the
 *      home root, so the home itself is the marketplace root
 *   3. dirname(execPath) and its parent (both as-invoked and symlink-resolved) —
 *      covers a binary run straight out of an unpacked tarball
 *   4. `import.meta.dir/../..` — source checkout under `bun test`/`bun run`;
 *      under `bun --compile` this is the virtual `/$bunfs` tree and is skipped
 *
 * Returns null when no candidate carries the payload — callers surface that as
 * a per-runtime failure instead of pointing `plugin marketplace add` at junk.
 */
export function resolveBundleRoot(explicit?: string): string | null {
  if (explicit) return resolve(explicit);
  if (process.env.GENIE_BUNDLE_ROOT) return resolve(process.env.GENIE_BUNDLE_ROOT);
  const candidates: string[] = [resolveGenieHome()];
  for (const execPath of [process.execPath, safeRealpath(process.execPath)]) {
    if (!execPath) continue;
    const execDir = dirname(execPath);
    candidates.push(execDir, resolve(execDir, '..'));
  }
  if (!import.meta.dir.startsWith('/$bunfs')) candidates.push(resolve(import.meta.dir, '..', '..'));
  return candidates.find(isBundleRoot) ?? null;
}

function jsonPayload(raw: string): unknown {
  const start = raw.indexOf('{');
  const arrayStart = raw.indexOf('[');
  const first = start < 0 ? arrayStart : arrayStart < 0 ? start : Math.min(start, arrayStart);
  if (first < 0) return undefined;
  try {
    return JSON.parse(raw.slice(first));
  } catch {
    return undefined;
  }
}

export function codexPluginState(raw: string): { installed: boolean; enabled?: boolean; version?: string } {
  const payload = jsonPayload(raw) as { installed?: Array<Record<string, unknown>> } | undefined;
  const plugin = payload?.installed?.find((entry) => entry.pluginId === 'genie@automagik');
  return plugin
    ? { installed: true, enabled: plugin.enabled === true, version: String(plugin.version ?? '') }
    : { installed: false };
}

export function claudePluginState(raw: string): { installed: boolean; enabled?: boolean; version?: string } {
  const payload = jsonPayload(raw) as Array<Record<string, unknown>> | undefined;
  const plugin = Array.isArray(payload) ? payload.find((entry) => entry.id === 'genie@automagik') : undefined;
  return plugin
    ? { installed: true, enabled: plugin.enabled === true, version: String(plugin.version ?? '') }
    : { installed: false };
}

function runChecked(runner: CommandRunner, command: string, args: string[], allowAlready = false): CommandResult {
  const result = runner(command, args);
  if (
    result.exitCode !== 0 &&
    !(allowAlready && /already|exists|configured/i.test(`${result.stdout}\n${result.stderr}`))
  ) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

/** Sentinel marking a role-agent TOML as genie-managed (mirrors removeRuntimeIntegrations). */
const CODEX_AGENT_SENTINEL = '# Managed by Genie.';

export interface CodexAgentInstallResult {
  /** Files written (fresh, unchanged, or refreshed-after-backup). */
  installed: number;
  /** Existing files that differ AND lack the sentinel — user-owned, never overwritten. */
  skippedUserOwned: string[];
  /** Sentinel-carrying files that differed — preserved as `<name>.toml.genie-backup` before overwrite. */
  backedUp: string[];
}

export function installCodexAgents(bundleRoot: string, codexHome = getCodexHome()): CodexAgentInstallResult {
  const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents');
  if (!existsSync(source)) throw new Error(`Codex agents are missing from bundle: ${source}`);
  const target = join(codexHome, 'agents');
  mkdirSync(target, { recursive: true });
  const result: CodexAgentInstallResult = { installed: 0, skippedUserOwned: [], backedUp: [] };
  for (const name of readdirSync(source)) {
    if (!name.startsWith('genie-') || !name.endsWith('.toml')) continue;
    const sourcePath = join(source, name);
    const targetPath = join(target, name);
    if (existsSync(targetPath)) {
      const existing = readFileSync(targetPath, 'utf8');
      if (existing !== readFileSync(sourcePath, 'utf8')) {
        if (!existing.startsWith(CODEX_AGENT_SENTINEL)) {
          // Not genie's file — the user owns it. Never clobber; report instead.
          result.skippedUserOwned.push(name);
          continue;
        }
        // A genie-managed file the user tuned: keep their copy beside the fresh one.
        copyFileSync(targetPath, `${targetPath}.genie-backup`);
        result.backedUp.push(name);
      }
    }
    copyFileSync(sourcePath, targetPath);
    result.installed += 1;
  }
  return result;
}

/** Restore an explicit disabled state after Codex refreshes an installed plugin. */
export function setCodexPluginEnabled(enabled: boolean, configPath = getCodexConfigPath()): void {
  if (!existsSync(configPath)) return;
  const content = readFileSync(configPath, 'utf8');
  const header = '[plugins."genie@automagik"]';
  const at = content.indexOf(header);
  if (at < 0) return;
  const next = content.indexOf('\n[', at + header.length);
  const end = next < 0 ? content.length : next + 1;
  const section = content.slice(at, end);
  const replacement = /(^|\n)enabled\s*=\s*(true|false)/.test(section)
    ? section.replace(/(^|\n)enabled\s*=\s*(true|false)/, `$1enabled = ${enabled}`)
    : section.replace(header, `${header}\nenabled = ${enabled}`);
  writeFileSync(configPath, `${content.slice(0, at)}${replacement}${content.slice(end)}`, 'utf8');
}

export interface IntegrationResult {
  runtime: RuntimeName;
  ok: boolean;
  detail: string;
  preservedDisabled?: boolean;
}

export interface InstallIntegrationsOptions {
  selection?: IntegrationSelection;
  bundleRoot?: string;
  runner?: CommandRunner;
  detected?: Partial<Record<RuntimeName, boolean>>;
  codexHome?: string;
}

export function installRuntimeIntegrations(options: InstallIntegrationsOptions = {}): IntegrationResult[] {
  const selection = options.selection ?? 'auto';
  if (selection === 'none') return [];
  const runner = options.runner ?? defaultRunner;
  const bundleRoot = resolveBundleRoot(options.bundleRoot);
  const detected = {
    codex: options.detected?.codex ?? commandExists('codex'),
    claude: options.detected?.claude ?? commandExists('claude'),
  };
  const targets: RuntimeName[] =
    selection === 'all'
      ? ['codex', 'claude']
      : selection === 'auto'
        ? (Object.keys(detected) as RuntimeName[]).filter((runtime) => detected[runtime])
        : [selection];

  return targets.map((runtime) => {
    if (!detected[runtime]) return { runtime, ok: false, detail: `${runtime} CLI not found` };
    try {
      if (bundleRoot === null) {
        throw new Error(
          'genie bundle root not found — expected plugins/genie under $GENIE_HOME (~/.genie) or beside the genie binary; set GENIE_BUNDLE_ROOT to override',
        );
      }
      return runtime === 'codex'
        ? installCodexIntegration(runner, bundleRoot, options.codexHome)
        : installClaudeIntegration(runner, bundleRoot);
    } catch (error) {
      return { runtime, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  });
}

/**
 * Register the canonical marketplace root. `plugin marketplace add` refuses when
 * the `automagik` marketplace already points at a DIFFERENT source — live case:
 * a deleted live-test worktree kept feeding every install/repair a stale plugin
 * — and that refusal matches the generic `already` tolerance, so it must be
 * handled first: repoint the marketplace instead of keeping the stale root.
 */
function addCodexMarketplace(runner: CommandRunner, bundleRoot: string): void {
  const result = runner('codex', ['plugin', 'marketplace', 'add', bundleRoot, '--json']);
  if (result.exitCode === 0) return;
  const output = `${result.stdout}\n${result.stderr}`;
  if (/different source/i.test(output)) {
    runChecked(runner, 'codex', ['plugin', 'marketplace', 'remove', 'automagik', '--json'], true);
    runChecked(runner, 'codex', ['plugin', 'marketplace', 'add', bundleRoot, '--json']);
    return;
  }
  if (!/already|exists|configured/i.test(output)) {
    throw new Error(
      `codex plugin marketplace add ${bundleRoot} --json failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

/**
 * `plugin add` is a no-op when the id is already installed, so a plugin that
 * came from a previous marketplace root stays pinned to that root's version
 * forever. When the installed version disagrees with the CLI, reinstall once
 * from the (now canonical) marketplace and re-verify — a repair that cannot
 * converge fails loudly instead of reporting "refreshed".
 */
function verifyCodexPluginCurrent(runner: CommandRunner): void {
  let state = codexPluginState(runChecked(runner, 'codex', ['plugin', 'list', '--json']).stdout);
  if (!state.installed || state.version === VERSION) return;
  runChecked(runner, 'codex', ['plugin', 'remove', 'genie@automagik', '--json'], true);
  runChecked(runner, 'codex', ['plugin', 'add', 'genie@automagik', '--json']);
  state = codexPluginState(runChecked(runner, 'codex', ['plugin', 'list', '--json']).stdout);
  if (state.installed && state.version !== VERSION) {
    throw new Error(`codex plugin stuck at v${state.version} (CLI v${VERSION}) — marketplace root may be stale`);
  }
}

function installCodexIntegration(runner: CommandRunner, bundleRoot: string, codexHome?: string): IntegrationResult {
  const configPath = join(codexHome ?? getCodexHome(), 'config.toml');
  const migration = migrateDeadGenieOtel(configPath);
  if (migration.status === 'error') throw new Error(`Codex config migration failed: ${migration.error}`);
  const agents = installCodexAgents(bundleRoot, codexHome);
  const before = codexPluginState(runChecked(runner, 'codex', ['plugin', 'list', '--json']).stdout);
  addCodexMarketplace(runner, bundleRoot);
  runChecked(runner, 'codex', ['plugin', 'add', 'genie@automagik', '--json']);
  verifyCodexPluginCurrent(runner);
  if (before.installed && before.enabled === false) setCodexPluginEnabled(false, configPath);
  const notes = [`${agents.installed} role agents installed`];
  if (agents.backedUp.length > 0) notes.push(`${agents.backedUp.length} user-tuned backed up (*.genie-backup)`);
  if (agents.skippedUserOwned.length > 0) notes.push(`kept user-owned: ${agents.skippedUserOwned.join(', ')}`);
  return {
    runtime: 'codex',
    ok: true,
    detail: `plugin refreshed; ${notes.join('; ')}`,
    preservedDisabled: before.installed && before.enabled === false,
  };
}

function installClaudeIntegration(runner: CommandRunner, bundleRoot: string): IntegrationResult {
  const before = claudePluginState(runChecked(runner, 'claude', ['plugin', 'list', '--json']).stdout);
  runChecked(runner, 'claude', ['plugin', 'marketplace', 'add', bundleRoot], true);
  if (before.installed) runChecked(runner, 'claude', ['plugin', 'update', 'genie@automagik']);
  else runChecked(runner, 'claude', ['plugin', 'install', 'genie@automagik']);
  return {
    runtime: 'claude',
    ok: true,
    detail: 'plugin refreshed',
    preservedDisabled: before.installed && before.enabled === false,
  };
}

/** Remove only Genie-owned runtime integration state; shared marketplaces are opt-in. */
export function removeRuntimeIntegrations(removeMarketplace = false): void {
  const codexHome = getCodexHome();
  const agentsDir = join(codexHome, 'agents');
  if (existsSync(agentsDir)) {
    for (const name of readdirSync(agentsDir)) {
      if (!/^genie-.+\.toml$/.test(name)) continue;
      const path = join(agentsDir, name);
      try {
        if (readFileSync(path, 'utf8').startsWith('# Managed by Genie.')) unlinkSync(path);
      } catch {
        // Preserve unreadable or user-modified files.
      }
    }
  }
  if (commandExists('codex')) defaultRunner('codex', ['plugin', 'remove', 'genie@automagik']);
  if (commandExists('claude')) defaultRunner('claude', ['plugin', 'uninstall', 'genie@automagik']);
  if (removeMarketplace) {
    if (commandExists('codex')) defaultRunner('codex', ['plugin', 'marketplace', 'remove', 'automagik']);
    if (commandExists('claude')) defaultRunner('claude', ['plugin', 'marketplace', 'remove', 'automagik']);
  }
}
