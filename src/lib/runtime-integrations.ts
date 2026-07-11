import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
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
  timedOut?: boolean;
}

export interface CommandRunOptions {
  timeoutMs: number;
}

export type CommandRunner = (command: string, args: string[], options?: CommandRunOptions) => CommandResult;

const INTEGRATION_TIMEOUT_MS = 15_000;

class IntegrationCommandError extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

const defaultRunner: CommandRunner = (command, args, options) => {
  const timeoutMs = options?.timeoutMs ?? INTEGRATION_TIMEOUT_MS;
  const result = Bun.spawnSync([command, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    timedOut: result.exitedDueToTimeout === true,
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

function runChecked(
  runner: CommandRunner,
  command: string,
  args: string[],
  allowAlready = false,
  timeoutMs = INTEGRATION_TIMEOUT_MS,
): CommandResult {
  const result = runner(command, args, { timeoutMs });
  if (result.timedOut) {
    throw new IntegrationCommandError(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`, true);
  }
  if (
    result.exitCode !== 0 &&
    !(allowAlready && /already|exists|configured/i.test(`${result.stdout}\n${result.stderr}`))
  ) {
    throw new IntegrationCommandError(
      `${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
}

export const CODEX_AGENT_INVENTORY_NAME = '.genie-role-agents.json';
const CODEX_AGENT_INVENTORY_OWNER = 'genie-codex-role-agents';
const CODEX_AGENT_NAME_RE = /^genie-[A-Za-z0-9][A-Za-z0-9_-]*\.toml$/;
const CODEX_AGENT_SENTINEL = '# Managed by Genie.';

interface CodexAgentInventory {
  version: 1;
  managedBy: typeof CODEX_AGENT_INVENTORY_OWNER;
  files: Record<string, { digest: string }>;
}

export type CodexAgentOwnership = 'absent' | 'user-owned' | 'managed-clean' | 'managed-modified';

export interface CodexAgentOwnershipEntry {
  name: string;
  path: string;
  ownership: CodexAgentOwnership;
}

export interface CodexAgentOwnershipReport {
  inventoryPath: string;
  status: 'missing' | 'valid' | 'corrupt';
  entries: CodexAgentOwnershipEntry[];
  error?: string;
}

function emptyCodexAgentInventory(): CodexAgentInventory {
  return { version: 1, managedBy: CODEX_AGENT_INVENTORY_OWNER, files: {} };
}

function inventoryPath(codexHome: string): string {
  return join(codexHome, 'agents', CODEX_AGENT_INVENTORY_NAME);
}

function fileDigest(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function readCodexAgentInventory(codexHome: string): {
  status: 'missing' | 'valid' | 'corrupt';
  inventory: CodexAgentInventory;
  error?: string;
} {
  const path = inventoryPath(codexHome);
  if (!existsSync(path)) return { status: 'missing', inventory: emptyCodexAgentInventory() };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CodexAgentInventory>;
    if (
      parsed.version !== 1 ||
      parsed.managedBy !== CODEX_AGENT_INVENTORY_OWNER ||
      typeof parsed.files !== 'object' ||
      parsed.files === null ||
      Object.entries(parsed.files).some(
        ([name, value]) =>
          !CODEX_AGENT_NAME_RE.test(name) ||
          typeof value !== 'object' ||
          value === null ||
          typeof (value as { digest?: unknown }).digest !== 'string' ||
          !/^[a-f0-9]{64}$/.test((value as { digest: string }).digest),
      )
    ) {
      throw new Error('invalid inventory schema');
    }
    return { status: 'valid', inventory: parsed as CodexAgentInventory };
  } catch (error) {
    return {
      status: 'corrupt',
      inventory: emptyCodexAgentInventory(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function writeCodexAgentInventory(codexHome: string, inventory: CodexAgentInventory): void {
  const path = inventoryPath(codexHome);
  mkdirSync(dirname(path), { recursive: true });
  if (Object.keys(inventory.files).length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  const staging = `${path}.staging-${process.pid}`;
  writeFileSync(staging, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  renameSync(staging, path);
}

function classifyCodexAgentFile(path: string, recorded: { digest: string } | undefined): CodexAgentOwnership {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return recorded === undefined ? 'user-owned' : 'managed-modified';
  } catch {
    return 'absent';
  }
  if (recorded === undefined) return 'user-owned';
  const digest = fileDigest(path);
  return digest !== null && digest === recorded.digest ? 'managed-clean' : 'managed-modified';
}

/** Shared digest-backed classifier for setup/update, doctor, and uninstall. */
export function inspectCodexAgentOwnership(codexHome = getCodexHome()): CodexAgentOwnershipReport {
  const state = readCodexAgentInventory(codexHome);
  const agentsDir = join(codexHome, 'agents');
  const names = new Set<string>(Object.keys(state.inventory.files));
  if (existsSync(agentsDir)) {
    for (const name of readdirSync(agentsDir)) if (CODEX_AGENT_NAME_RE.test(name)) names.add(name);
  }
  return {
    inventoryPath: inventoryPath(codexHome),
    status: state.status,
    error: state.error,
    entries: [...names].sort().map((name) => ({
      name,
      path: join(agentsDir, name),
      ownership: classifyCodexAgentFile(join(agentsDir, name), state.inventory.files[name]),
    })),
  };
}

export interface CodexAgentInstallResult {
  /** Files converged (fresh, unchanged, or digest-clean updates). */
  installed: number;
  /** Existing files without inventory ownership — user-owned, never overwritten. */
  skippedUserOwned: string[];
  /** Modified inventory-owned files preserved byte-identically and relinquished when orphaned. */
  keptModified: string[];
  /** Digest-clean inventory entries no longer shipped and removed during convergence. */
  removed: string[];
  /** Legacy compatibility field. Modified files are no longer overwritten or backed up. */
  backedUp: string[];
}

export function installCodexAgents(bundleRoot: string, codexHome = getCodexHome()): CodexAgentInstallResult {
  const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents');
  if (!existsSync(source)) throw new Error(`Codex agents are missing from bundle: ${source}`);
  const target = join(codexHome, 'agents');
  const state = readCodexAgentInventory(codexHome);
  if (state.status === 'corrupt') {
    throw new Error(
      `Codex role-agent ownership inventory is corrupt (${inventoryPath(codexHome)}): ${state.error}; review and move it aside before retrying`,
    );
  }
  mkdirSync(target, { recursive: true });
  const inventory = state.inventory;
  const result: CodexAgentInstallResult = {
    installed: 0,
    skippedUserOwned: [],
    keptModified: [],
    removed: [],
    backedUp: [],
  };
  const sourceNames = readdirSync(source)
    .filter((name) => CODEX_AGENT_NAME_RE.test(name))
    .sort();
  for (const name of sourceNames) {
    const sourcePath = join(source, name);
    const targetPath = join(target, name);
    const sourceContent = readFileSync(sourcePath);
    if (!sourceContent.toString('utf8').startsWith(CODEX_AGENT_SENTINEL)) {
      throw new Error(`Codex role-agent source lacks the managed sentinel: ${sourcePath}`);
    }
    const sourceDigest = fileDigest(sourcePath);
    if (sourceDigest === null) throw new Error(`Codex role-agent source is not a regular readable file: ${sourcePath}`);
    const ownership = classifyCodexAgentFile(targetPath, inventory.files[name]);
    if (ownership === 'user-owned') {
      // Inventory is the sole ownership grant. An exact or sentinel-bearing
      // personal copy is still user-owned when no inventory entry names it.
      result.skippedUserOwned.push(name);
      continue;
    }
    if (ownership === 'managed-modified') {
      result.keptModified.push(name);
      continue;
    }
    if (ownership === 'absent' || inventory.files[name]?.digest !== sourceDigest) {
      writeFileSync(targetPath, sourceContent);
    }
    inventory.files[name] = { digest: sourceDigest };
    result.installed += 1;
  }
  for (const name of Object.keys(inventory.files)) {
    if (sourceNames.includes(name)) continue;
    const targetPath = join(target, name);
    const ownership = classifyCodexAgentFile(targetPath, inventory.files[name]);
    if (ownership === 'managed-clean') {
      unlinkSync(targetPath);
      result.removed.push(name);
    } else if (ownership === 'managed-modified') {
      result.keptModified.push(name);
    }
    delete inventory.files[name];
  }
  writeCodexAgentInventory(codexHome, inventory);
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
  timedOut?: boolean;
}

export interface InstallIntegrationsOptions {
  selection?: IntegrationSelection;
  bundleRoot?: string;
  runner?: CommandRunner;
  detected?: Partial<Record<RuntimeName, boolean>>;
  codexHome?: string;
  timeoutMs?: number;
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
        ? installCodexIntegration(runner, bundleRoot, options.codexHome, options.timeoutMs)
        : installClaudeIntegration(runner, bundleRoot, options.timeoutMs);
    } catch (error) {
      return {
        runtime,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        timedOut: error instanceof IntegrationCommandError && error.timedOut,
      };
    }
  });
}

/**
 * Register the canonical marketplace root. Codex refuses an add when the same
 * marketplace name points at a different source; remove only that registration,
 * add the requested root again, and keep every subprocess deadline-bounded.
 */
function addCodexMarketplace(runner: CommandRunner, bundleRoot: string, timeoutMs: number): void {
  const args = ['plugin', 'marketplace', 'add', bundleRoot, '--json'];
  const result = runner('codex', args, { timeoutMs });
  if (result.timedOut) {
    throw new IntegrationCommandError(`codex ${args.join(' ')} timed out after ${timeoutMs}ms`, true);
  }
  if (result.exitCode === 0) return;
  const output = `${result.stdout}\n${result.stderr}`;
  if (/different source/i.test(output)) {
    runChecked(runner, 'codex', ['plugin', 'marketplace', 'remove', 'automagik', '--json'], true, timeoutMs);
    runChecked(runner, 'codex', args, false, timeoutMs);
    return;
  }
  if (!/already|exists|configured/i.test(output)) {
    throw new IntegrationCommandError(`codex ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

/**
 * `plugin add` can leave an already-installed plugin pinned to its old
 * marketplace payload. Reinstall once when its reported version differs from
 * the running CLI, then fail loudly if the registry still reports stale state.
 */
function verifyCodexPluginCurrent(runner: CommandRunner, timeoutMs: number): void {
  let state = codexPluginState(runChecked(runner, 'codex', ['plugin', 'list', '--json'], false, timeoutMs).stdout);
  if (!state.installed || state.version === VERSION) return;
  runChecked(runner, 'codex', ['plugin', 'remove', 'genie@automagik', '--json'], true, timeoutMs);
  runChecked(runner, 'codex', ['plugin', 'add', 'genie@automagik', '--json'], false, timeoutMs);
  state = codexPluginState(runChecked(runner, 'codex', ['plugin', 'list', '--json'], false, timeoutMs).stdout);
  if (state.installed && state.version !== VERSION) {
    throw new IntegrationCommandError(
      `codex plugin stuck at v${state.version} (CLI v${VERSION}) — marketplace root may be stale`,
    );
  }
}

function installCodexIntegration(
  runner: CommandRunner,
  bundleRoot: string,
  codexHome?: string,
  timeoutMs = INTEGRATION_TIMEOUT_MS,
): IntegrationResult {
  const configPath = join(codexHome ?? getCodexHome(), 'config.toml');
  const migration = migrateDeadGenieOtel(configPath);
  if (migration.status === 'error') throw new Error(`Codex config migration failed: ${migration.error}`);
  const agents = installCodexAgents(bundleRoot, codexHome);
  const before = codexPluginState(runChecked(runner, 'codex', ['plugin', 'list', '--json'], false, timeoutMs).stdout);
  addCodexMarketplace(runner, bundleRoot, timeoutMs);
  runChecked(runner, 'codex', ['plugin', 'add', 'genie@automagik', '--json'], false, timeoutMs);
  verifyCodexPluginCurrent(runner, timeoutMs);
  if (before.installed && before.enabled === false) setCodexPluginEnabled(false, configPath);
  const notes = [`${agents.installed} role agents installed`];
  if (agents.removed.length > 0) notes.push(`removed obsolete: ${agents.removed.join(', ')}`);
  if (agents.keptModified.length > 0) notes.push(`kept modified: ${agents.keptModified.join(', ')}`);
  if (agents.skippedUserOwned.length > 0) notes.push(`kept user-owned: ${agents.skippedUserOwned.join(', ')}`);
  return {
    runtime: 'codex',
    ok: true,
    detail: `plugin refreshed; ${notes.join('; ')}`,
    preservedDisabled: before.installed && before.enabled === false,
  };
}

function installClaudeIntegration(
  runner: CommandRunner,
  bundleRoot: string,
  timeoutMs = INTEGRATION_TIMEOUT_MS,
): IntegrationResult {
  const before = claudePluginState(runChecked(runner, 'claude', ['plugin', 'list', '--json'], false, timeoutMs).stdout);
  runChecked(runner, 'claude', ['plugin', 'marketplace', 'add', bundleRoot], true, timeoutMs);
  if (before.installed) runChecked(runner, 'claude', ['plugin', 'update', 'genie@automagik'], false, timeoutMs);
  else runChecked(runner, 'claude', ['plugin', 'install', 'genie@automagik'], false, timeoutMs);
  return {
    runtime: 'claude',
    ok: true,
    detail: 'plugin refreshed',
    preservedDisabled: before.installed && before.enabled === false,
  };
}

export interface CodexAgentRemovalResult {
  removed: string[];
  keptModified: string[];
  missing: string[];
  failures: Array<{ name: string; detail: string }>;
}

/** Remove only digest-clean inventory-owned role agents; modified/user files stay byte-identical. */
export function removeCodexAgents(codexHome = getCodexHome()): CodexAgentRemovalResult {
  const result: CodexAgentRemovalResult = { removed: [], keptModified: [], missing: [], failures: [] };
  const state = readCodexAgentInventory(codexHome);
  if (state.status === 'corrupt') {
    result.failures.push({
      name: CODEX_AGENT_INVENTORY_NAME,
      detail: `ownership inventory is corrupt; no role agents were removed: ${state.error}; review and move it aside before retrying`,
    });
    return result;
  }
  const inventory = state.inventory;
  for (const name of Object.keys(inventory.files).sort()) {
    const path = join(codexHome, 'agents', name);
    const ownership = classifyCodexAgentFile(path, inventory.files[name]);
    try {
      if (ownership === 'managed-clean') {
        unlinkSync(path);
        result.removed.push(name);
      } else if (ownership === 'managed-modified') {
        result.keptModified.push(name);
      } else if (ownership === 'absent') {
        result.missing.push(name);
      }
      // Uninstall relinquishes ownership of modified files without editing them.
      delete inventory.files[name];
    } catch (error) {
      result.failures.push({ name, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  if (result.failures.length === 0) {
    try {
      writeCodexAgentInventory(codexHome, inventory);
    } catch (error) {
      result.failures.push({
        name: CODEX_AGENT_INVENTORY_NAME,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

export interface IntegrationRemovalStep {
  runtime: RuntimeName;
  operation: 'plugin' | 'marketplace';
  ok: boolean;
  detail: string;
  timedOut?: boolean;
}

export interface RuntimeIntegrationRemovalResult {
  ok: boolean;
  agents: CodexAgentRemovalResult;
  steps: IntegrationRemovalStep[];
}

export interface RemoveRuntimeIntegrationsOptions {
  removeMarketplace?: boolean;
  runner?: CommandRunner;
  detected?: Partial<Record<RuntimeName, boolean>>;
  codexHome?: string;
  timeoutMs?: number;
}

function removalStep(
  runner: CommandRunner,
  runtime: RuntimeName,
  operation: IntegrationRemovalStep['operation'],
  args: string[],
  timeoutMs: number,
): IntegrationRemovalStep {
  try {
    const result = runner(runtime, args, { timeoutMs });
    if (result.timedOut) {
      return {
        runtime,
        operation,
        ok: false,
        timedOut: true,
        detail: `timed out after ${timeoutMs}ms; retry the removal`,
      };
    }
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      if (/not installed|not found|does not exist|no such|unknown (plugin|marketplace)/i.test(detail)) {
        return { runtime, operation, ok: true, detail: 'already absent' };
      }
      return {
        runtime,
        operation,
        ok: false,
        detail: detail || `exited ${result.exitCode}; retry the removal`,
      };
    }
    return { runtime, operation, ok: true, detail: 'removed' };
  } catch (error) {
    return { runtime, operation, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Remove only Genie-owned runtime state and report every failure; shared marketplaces are opt-in. */
export function removeRuntimeIntegrations(
  input: boolean | RemoveRuntimeIntegrationsOptions = false,
): RuntimeIntegrationRemovalResult {
  const options: RemoveRuntimeIntegrationsOptions = typeof input === 'boolean' ? { removeMarketplace: input } : input;
  const runner = options.runner ?? defaultRunner;
  const timeoutMs = options.timeoutMs ?? INTEGRATION_TIMEOUT_MS;
  const detected = {
    codex: options.detected?.codex ?? commandExists('codex'),
    claude: options.detected?.claude ?? commandExists('claude'),
  };
  const agents = removeCodexAgents(options.codexHome);
  const steps: IntegrationRemovalStep[] = [];
  if (detected.codex) {
    steps.push(removalStep(runner, 'codex', 'plugin', ['plugin', 'remove', 'genie@automagik'], timeoutMs));
  }
  if (detected.claude) {
    steps.push(removalStep(runner, 'claude', 'plugin', ['plugin', 'uninstall', 'genie@automagik'], timeoutMs));
  }
  if (options.removeMarketplace) {
    if (detected.codex) {
      steps.push(
        removalStep(runner, 'codex', 'marketplace', ['plugin', 'marketplace', 'remove', 'automagik'], timeoutMs),
      );
    }
    if (detected.claude) {
      steps.push(
        removalStep(runner, 'claude', 'marketplace', ['plugin', 'marketplace', 'remove', 'automagik'], timeoutMs),
      );
    }
  }
  return { ok: agents.failures.length === 0 && steps.every((step) => step.ok), agents, steps };
}
