/**
 * Project-scoped MCP lifecycle for Codex, Claude Code, and Warp.
 *
 * Codex has two possible routes to Genie's stdio MCP server:
 *   1. the enabled `genie@automagik` plugin; or
 *   2. a marker-owned `<worktree>/.codex/config.toml` fallback.
 *
 * This module is the sole owner of choosing between them. It deliberately
 * treats disabled, unknown, malformed, and timed-out plugin state as
 * ineffective and keeps an absolute-command fallback in those cases.
 */

import { execFileSync } from 'node:child_process';
import {
  constants,
  accessSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { resolveCodexDir, resolveGenieHome } from './genie-home.js';

export type ArtifactAction = 'created' | 'updated' | 'skipped';

export interface McpServerEntry {
  command: string;
  args: string[];
}

export interface McpConfigResult {
  path: string;
  action: ArtifactAction;
  detail?: string;
}

export interface CodexPluginProbe {
  cliAvailable: boolean;
  status: 'ok' | 'unavailable' | 'error';
  installed: boolean;
  enabled?: boolean;
  version?: string;
  /** Exact installed/cache payload proven from the one-shot Codex snapshot. */
  activePluginRoot?: string;
  /** Enabled is insufficient: the official in-plugin launcher and canonical binary must both be usable. */
  usable?: boolean;
  usabilityDetail?: string;
  detail: string;
  timedOut?: boolean;
}

export interface CodexProjectMcpResult extends McpConfigResult {
  ok: boolean;
  route: 'plugin' | 'fallback' | 'unmanaged-fallback' | 'none' | 'conflict';
}

export function isUsableCodexPlugin(plugin: CodexPluginProbe): boolean {
  return plugin.status === 'ok' && plugin.installed && plugin.enabled === true && plugin.usable === true;
}

interface JsonObject {
  [key: string]: unknown;
}

interface PreparedWrite extends McpConfigResult {
  content?: string;
}

export interface CodexProbeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface CodexPluginProbeDeps {
  which?: (name: string) => string | null;
  run?: (command: string, args: string[], timeoutMs: number) => CodexProbeCommandResult;
  timeoutMs?: number;
  inspectUsability?: (options: CodexPluginMcpUsabilityOptions) => CodexPluginMcpUsability;
  codexHome?: string;
}

export interface CodexPluginMcpUsability {
  usable: boolean;
  detail: string;
  pluginRoot?: string;
  launcherPath?: string;
  binaryPath?: string;
  commandPath?: string;
}

export interface CodexPluginMcpUsabilityOptions {
  /** Exact active installed/cache root. Source-bundle roots are not evidence of runtime health. */
  pluginRoot?: string | null;
  /** Snapshot identity that the active manifest must exactly match. */
  expectedPluginName?: string;
  expectedVersion?: string;
  genieHome?: string;
  platform?: NodeJS.Platform;
  /** Resolve the exact bare command declared by .mcp.json under the active PATH. */
  resolveCommand?: (command: string) => string | null;
}

export interface RegisterProjectMcpOptions {
  /** Reuse a caller's one-shot probe so a launch with N worktrees queries Codex once. */
  pluginProbe?: CodexPluginProbe;
  probeDeps?: CodexPluginProbeDeps;
  entry?: McpServerEntry;
}

export interface GitProjectRoots {
  /** Root of the working tree that contains cwd (linked worktrees stay linked). */
  worktreeRoot: string;
  /** Main checkout root that owns Git's common dir and the shared genie.db. */
  commonRoot: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const MCP_WRAPPER_KEYS = ['mcpServers', 'mcp_servers', 'servers'] as const;
const FALLBACK_BEGIN = '# BEGIN GENIE MCP FALLBACK';
const FALLBACK_END = '# END GENIE MCP FALLBACK';
const GENIE_PLUGIN_ID = 'genie@automagik';
const GENIE_PLUGIN_NAME = 'genie';
const GENIE_MARKETPLACE_NAME = 'automagik';
const SAFE_CACHE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

interface CodexPluginSnapshotEntry extends JsonObject {
  pluginId: typeof GENIE_PLUGIN_ID;
  enabled?: boolean;
  version?: string;
  installedPath?: string;
  name?: string;
  marketplaceName?: string;
}

interface ActivePluginRootResult {
  root?: string;
  detail: string;
}

function normalizeGitPath(path: string): string {
  if (process.platform !== 'darwin' || !path.startsWith('/private/')) return path;
  const logical = path.slice('/private'.length);
  return existsSync(logical) ? logical : path;
}

function parseCodexPluginSnapshot(raw: string): CodexPluginSnapshotEntry | null {
  const objectStart = raw.indexOf('{');
  if (objectStart < 0) throw new Error('response did not contain a JSON object');
  const parsed = JSON.parse(raw.slice(objectStart)) as unknown;
  if (!isJsonObject(parsed) || !Array.isArray(parsed.installed)) {
    throw new Error('response field "installed" must be an array');
  }
  const candidate = parsed.installed.find(
    (entry): entry is JsonObject => isJsonObject(entry) && entry.pluginId === GENIE_PLUGIN_ID,
  );
  if (candidate === undefined) return null;
  if ('enabled' in candidate && typeof candidate.enabled !== 'boolean') {
    throw new Error(`${GENIE_PLUGIN_ID} field "enabled" must be boolean when present`);
  }
  for (const key of ['version', 'installedPath', 'name', 'marketplaceName'] as const) {
    if (key in candidate && typeof candidate[key] !== 'string') {
      throw new Error(`${GENIE_PLUGIN_ID} field ${JSON.stringify(key)} must be a string when present`);
    }
  }
  if (candidate.name !== undefined && candidate.name !== GENIE_PLUGIN_NAME) {
    throw new Error(`${GENIE_PLUGIN_ID} reports unexpected plugin name ${JSON.stringify(candidate.name)}`);
  }
  if (candidate.marketplaceName !== undefined && candidate.marketplaceName !== GENIE_MARKETPLACE_NAME) {
    throw new Error(`${GENIE_PLUGIN_ID} reports unexpected marketplace ${JSON.stringify(candidate.marketplaceName)}`);
  }
  return candidate as CodexPluginSnapshotEntry;
}

function isSafeCacheSegment(value: string): boolean {
  return value !== '.' && value !== '..' && SAFE_CACHE_SEGMENT.test(value);
}

function isContainedPath(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent !== '' &&
    pathFromParent !== '..' &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

/**
 * Resolve only the payload Codex says is installed. The CLI's current list
 * snapshot omits `installedPath`, so the documented cache layout is the sole
 * fallback: CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>.
 */
function resolveReportedPluginRoot(reportedRoot: string): ActivePluginRootResult {
  if (!isAbsolute(reportedRoot)) {
    return { detail: `active plugin root is unproven because installedPath is not absolute: ${reportedRoot}` };
  }
  if (normalize(reportedRoot) !== reportedRoot) {
    return { detail: `active plugin installedPath is not normalized or contains traversal: ${reportedRoot}` };
  }
  try {
    const reportedStat = lstatSync(reportedRoot);
    if (!reportedStat.isDirectory() || reportedStat.isSymbolicLink()) {
      return { detail: `active plugin installedPath is not a physical directory: ${reportedRoot}` };
    }
    const canonicalReported = normalizeGitPath(realpathSync(reportedRoot));
    if (canonicalReported !== normalizeGitPath(reportedRoot)) {
      return { detail: `active plugin installedPath resolves through a symlink or outside itself: ${reportedRoot}` };
    }
    return { root: canonicalReported, detail: 'physical absolute installedPath reported by the Codex snapshot' };
  } catch (error) {
    return {
      detail: `active plugin installedPath is unavailable or incomplete at ${reportedRoot}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function resolveDerivedPluginRoot(codexHome: string, version: string): ActivePluginRootResult {
  if (!isAbsolute(codexHome)) {
    return { detail: `active plugin root is unproven because CODEX_HOME is not absolute: ${codexHome}` };
  }
  const cacheRoot = join(resolve(codexHome), 'plugins', 'cache');
  const expectedRoot = join(cacheRoot, GENIE_MARKETPLACE_NAME, GENIE_PLUGIN_NAME, version);
  try {
    const cacheStat = lstatSync(cacheRoot);
    if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()) {
      return { detail: `active plugin cache root is not a physical directory: ${cacheRoot}` };
    }
    const candidateStat = lstatSync(expectedRoot);
    if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
      return { detail: `active plugin root is not a physical directory: ${expectedRoot}` };
    }
    const canonicalCache = normalizeGitPath(realpathSync(cacheRoot));
    const canonicalExpected = normalizeGitPath(realpathSync(expectedRoot));
    if (!isContainedPath(canonicalCache, canonicalExpected)) {
      return { detail: `derived active plugin root escapes the Codex plugin cache: ${expectedRoot}` };
    }
    return { root: canonicalExpected, detail: 'derived from the contained Codex plugin cache' };
  } catch (error) {
    return {
      detail: `active plugin root is unavailable or incomplete at ${expectedRoot}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function resolveActivePluginRoot(entry: CodexPluginSnapshotEntry, codexHome: string): ActivePluginRootResult {
  const version = entry.version;
  if (version === undefined || !isSafeCacheSegment(version)) {
    return {
      detail: `active plugin root is unproven because the Codex snapshot has no safe version for ${GENIE_PLUGIN_ID}`,
    };
  }
  return entry.installedPath === undefined
    ? resolveDerivedPluginRoot(codexHome, version)
    : resolveReportedPluginRoot(entry.installedPath);
}

function defaultProbeRunner(command: string, args: string[], timeoutMs: number): CodexProbeCommandResult {
  const result = Bun.spawnSync([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    timedOut: result.exitedDueToTimeout === true,
  };
}

function resolveConfiguredNodeCommand(options: CodexPluginMcpUsabilityOptions): string {
  const commandPath = (options.resolveCommand ?? ((command: string) => Bun.which(command)))('node');
  if (!commandPath) throw new Error('configured plugin MCP command "node" is not available on PATH');
  if (!isAbsolute(commandPath) || !statSync(commandPath).isFile()) {
    throw new Error(
      `configured plugin MCP command "node" did not resolve to an absolute executable file: ${commandPath}`,
    );
  }
  accessSync(commandPath, (options.platform ?? process.platform) === 'win32' ? constants.F_OK : constants.X_OK);
  return realpathSync(commandPath);
}

function activeManifestError(manifest: unknown, expectedName: string, expectedVersion: string): string | null {
  if (!isJsonObject(manifest)) return 'plugin manifest must contain an object';
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    return `active plugin manifest identity/version mismatch (expected ${expectedName}@${expectedVersion})`;
  }
  return manifest.mcpServers === './.mcp.json' ? null : 'plugin manifest does not point mcpServers to ./.mcp.json';
}

/**
 * Resolve the root of the current Git working tree.
 *
 * `--show-toplevel` intentionally returns a linked worktree's own root (not
 * the main checkout that owns the common Git dir), because project MCP config
 * must live beside the files the agent is editing.
 */
export function resolveGitProjectRoots(
  cwd = process.cwd(),
  exec: typeof execFileSync = execFileSync,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): GitProjectRoots | null {
  try {
    const output = exec('git', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    })
      .trim()
      .split('\n');
    const worktreeRoot = output[0]?.trim();
    const commonDir = output[1]?.trim();
    if (!worktreeRoot || !commonDir) return null;
    return {
      worktreeRoot: normalizeGitPath(worktreeRoot),
      commonRoot: normalizeGitPath(dirname(commonDir)),
    };
  } catch {
    return null;
  }
}

export function resolveGitWorktreeRoot(
  cwd = process.cwd(),
  exec: typeof execFileSync = execFileSync,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): string | null {
  return resolveGitProjectRoots(cwd, exec, timeoutMs)?.worktreeRoot ?? null;
}

/**
 * Verify the exact active plugin MCP indirection plus the only binary the
 * plugin-local launcher is permitted to execute. This is a read-only check;
 * enabled metadata or a healthy source bundle never removes the absolute
 * project fallback.
 */
export function inspectCodexPluginMcpUsability(options: CodexPluginMcpUsabilityOptions = {}): CodexPluginMcpUsability {
  const pluginRoot = options.pluginRoot;
  if (!pluginRoot) {
    return {
      usable: false,
      detail: 'active installed Codex plugin root was not proven by the plugin snapshot',
    };
  }
  if (options.expectedPluginName !== GENIE_PLUGIN_NAME || options.expectedVersion === undefined) {
    return {
      usable: false,
      detail: 'active plugin manifest identity/version was not bound to the Codex snapshot',
      pluginRoot,
    };
  }
  try {
    const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    const manifestError = activeManifestError(manifest, options.expectedPluginName, options.expectedVersion);
    if (manifestError !== null) return { usable: false, detail: manifestError, pluginRoot };

    const configPath = join(pluginRoot, '.mcp.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    if (!isJsonObject(config)) {
      return { usable: false, detail: 'plugin .mcp.json must contain an object', pluginRoot };
    }
    if ('mcpServers' in config) {
      return { usable: false, detail: 'plugin .mcp.json uses unsupported camelCase mcpServers', pluginRoot };
    }
    const serverMap = isJsonObject(config.mcp_servers) ? config.mcp_servers : config;
    const entry = isJsonObject(serverMap.genie)
      ? (serverMap.genie as { command?: unknown; args?: unknown; cwd?: unknown })
      : undefined;
    if (
      entry?.command !== 'node' ||
      !Array.isArray(entry.args) ||
      entry.args.length !== 1 ||
      entry.args[0] !== './scripts/mcp-launcher.cjs' ||
      entry.cwd !== '.'
    ) {
      return { usable: false, detail: 'plugin .mcp.json does not use the canonical plugin-local launcher', pluginRoot };
    }

    const commandPath = resolveConfiguredNodeCommand(options);

    const launcherPath = join(pluginRoot, 'scripts', 'mcp-launcher.cjs');
    const launcherStat = lstatSync(launcherPath);
    if (!launcherStat.isFile() || launcherStat.isSymbolicLink()) {
      return { usable: false, detail: 'plugin-local MCP launcher is not a physical file', pluginRoot, launcherPath };
    }
    if (normalizeGitPath(realpathSync(launcherPath)) !== normalizeGitPath(launcherPath)) {
      return {
        usable: false,
        detail: 'plugin-local MCP launcher resolves outside its expected path',
        pluginRoot,
        launcherPath,
      };
    }

    const platform = options.platform ?? process.platform;
    const genieHome = options.genieHome ?? resolveGenieHome();
    const binaryPath = join(genieHome, 'bin', platform === 'win32' ? 'genie.exe' : 'genie');
    const binaryStat = lstatSync(binaryPath);
    if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) {
      return {
        usable: false,
        detail: `canonical Genie binary is not a physical file: ${binaryPath}`,
        pluginRoot,
        launcherPath,
        binaryPath,
      };
    }
    if (normalizeGitPath(realpathSync(binaryPath)) !== normalizeGitPath(binaryPath)) {
      return {
        usable: false,
        detail: `canonical Genie binary resolves outside its expected path: ${binaryPath}`,
        pluginRoot,
        launcherPath,
        binaryPath,
      };
    }
    accessSync(binaryPath, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return {
      usable: true,
      detail: 'configured Node command, plugin-local launcher, and canonical Genie binary are usable',
      pluginRoot,
      launcherPath,
      binaryPath,
      commandPath,
    };
  } catch (error) {
    return { usable: false, detail: error instanceof Error ? error.message : String(error), pluginRoot };
  }
}

/** Query Codex plugin state once, with a hard deadline and schema-safe errors. */
export function probeCodexGeniePlugin(deps: CodexPluginProbeDeps = {}): CodexPluginProbe {
  const which = deps.which ?? ((name: string) => Bun.which(name));
  if (!which('codex')) {
    return {
      cliAvailable: false,
      status: 'unavailable',
      installed: false,
      detail: 'Codex CLI not found',
    };
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  try {
    const result = (deps.run ?? defaultProbeRunner)('codex', ['plugin', 'list', '--json'], timeoutMs);
    if (result.timedOut) {
      return {
        cliAvailable: true,
        status: 'error',
        installed: false,
        detail: `codex plugin list timed out after ${timeoutMs}ms; retaining the project fallback`,
        timedOut: true,
      };
    }
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim() || `exit ${result.exitCode}`;
      return {
        cliAvailable: true,
        status: 'error',
        installed: false,
        detail: `codex plugin list failed: ${detail}; retaining the project fallback`,
      };
    }
    const snapshot = parseCodexPluginSnapshot(result.stdout);
    if (snapshot === null) {
      return {
        cliAvailable: true,
        status: 'ok',
        installed: false,
        usable: false,
        usabilityDetail: 'plugin is not installed',
        detail: `${GENIE_PLUGIN_ID} is not installed; plugin is not installed`,
      };
    }
    const activeRoot = resolveActivePluginRoot(snapshot, deps.codexHome ?? resolveCodexDir());
    const usability =
      snapshot.enabled === true && activeRoot.root !== undefined
        ? (deps.inspectUsability ?? inspectCodexPluginMcpUsability)({
            pluginRoot: activeRoot.root,
            expectedPluginName: GENIE_PLUGIN_NAME,
            expectedVersion: snapshot.version,
          })
        : {
            usable: false,
            detail:
              snapshot.enabled === true
                ? activeRoot.detail
                : 'plugin is installed but disabled or its enabled state is unknown',
          };
    return {
      cliAvailable: true,
      status: 'ok',
      installed: true,
      enabled: snapshot.enabled,
      version: snapshot.version,
      activePluginRoot: activeRoot.root,
      usable: usability.usable,
      usabilityDetail: usability.detail,
      detail: `${GENIE_PLUGIN_ID} is ${snapshot.enabled === true ? 'enabled' : 'disabled or unknown'}; ${activeRoot.detail}; ${usability.detail}`,
    };
  } catch (error) {
    return {
      cliAvailable: true,
      status: 'error',
      installed: false,
      detail: `invalid Codex plugin response: ${error instanceof Error ? error.message : String(error)}; retaining the project fallback`,
    };
  }
}

/** The absolute stdio entry used by all project-scoped clients. */
export function genieMcpEntry(command = process.execPath): McpServerEntry {
  return { command, args: ['mcp'] };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMcpConfig(raw: string | null, path: string): JsonObject {
  if (raw === null || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Cannot register genie MCP server: ${path} is not valid JSON.`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`Cannot register genie MCP server: ${path} must contain a JSON object.`);
  }
  return parsed;
}

/**
 * Locate an existing server map without overwriting wrong-shaped valid JSON.
 * A known wrapper key with an array/string/null is a configuration error, not
 * an invitation to replace user data with a new object.
 */
function locateServerMap(config: JsonObject, path: string): JsonObject {
  for (const key of MCP_WRAPPER_KEYS) {
    if (!(key in config)) continue;
    const existing = config[key];
    if (!isJsonObject(existing)) {
      throw new Error(`Cannot register genie MCP server: ${path} field ${JSON.stringify(key)} must be an object.`);
    }
    return existing;
  }

  if ('mcp' in config) {
    if (!isJsonObject(config.mcp)) {
      throw new Error(`Cannot register genie MCP server: ${path} field "mcp" must be an object.`);
    }
    if ('servers' in config.mcp) {
      if (!isJsonObject(config.mcp.servers)) {
        throw new Error(`Cannot register genie MCP server: ${path} field "mcp.servers" must be an object.`);
      }
      return config.mcp.servers;
    }
  }

  const created: JsonObject = {};
  config.mcpServers = created;
  return created;
}

function prepareJsonMcpConfig(configPath: string, entry: McpServerEntry): PreparedWrite {
  const raw = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;
  const config = parseMcpConfig(raw, configPath);
  locateServerMap(config, configPath).genie = entry;
  const content = `${JSON.stringify(config, null, 2)}\n`;
  if (raw === content) return { path: configPath, action: 'skipped' };
  return { path: configPath, action: raw === null ? 'created' : 'updated', content };
}

function applyPreparedWrite(prepared: PreparedWrite): McpConfigResult {
  if (prepared.content === undefined) return { path: prepared.path, action: prepared.action, detail: prepared.detail };
  mkdirSync(dirname(prepared.path), { recursive: true });
  writeFileSync(prepared.path, prepared.content, 'utf8');
  return { path: prepared.path, action: prepared.action, detail: prepared.detail };
}

function fallbackBounds(raw: string, path: string): { start: number; end: number } | null {
  const start = raw.indexOf(FALLBACK_BEGIN);
  const endMarker = raw.indexOf(FALLBACK_END);
  if (start < 0 !== endMarker < 0 || (start >= 0 && endMarker < start)) {
    throw new Error(
      `Cannot reconcile genie MCP server: ${path} has an incomplete ${FALLBACK_BEGIN}/${FALLBACK_END} block. Repair or remove that marker block and retry.`,
    );
  }
  return start < 0 ? null : { start, end: endMarker + FALLBACK_END.length };
}

function hasUnmanagedFallback(raw: string, owned: { start: number; end: number } | null): boolean {
  const withoutOwned = owned === null ? raw : `${raw.slice(0, owned.start)}${raw.slice(owned.end)}`;
  return /^\s*\[mcp_servers\.genie\]\s*$/m.test(withoutOwned);
}

function fallbackBlock(entry: McpServerEntry): string {
  return `${FALLBACK_BEGIN}\n[mcp_servers.genie]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n${FALLBACK_END}`;
}

function prepareCodexFallback(
  configPath: string,
  entry: McpServerEntry,
  required: boolean,
): CodexProjectMcpResult & {
  content?: string;
} {
  const exists = existsSync(configPath);
  const raw = exists ? readFileSync(configPath, 'utf8') : '';
  const owned = fallbackBounds(raw, configPath);
  const unmanaged = hasUnmanagedFallback(raw, owned);

  if (!required) {
    if (unmanaged) {
      return {
        path: configPath,
        action: 'skipped',
        ok: false,
        route: 'conflict',
        detail:
          'enabled plugin and an unmanaged [mcp_servers.genie] entry are both present; remove one manually to avoid duplicate routing',
      };
    }
    if (owned === null) {
      return { path: configPath, action: 'skipped', ok: true, route: 'plugin', detail: 'enabled plugin' };
    }
    let content = `${raw.slice(0, owned.start)}${raw.slice(owned.end)}`;
    if (content.startsWith('\n')) content = content.slice(1);
    if (content.length > 0 && !content.endsWith('\n')) content += '\n';
    return {
      path: configPath,
      action: 'updated',
      ok: true,
      route: 'plugin',
      detail: 'enabled plugin; removed marker-owned project fallback',
      content,
    };
  }

  if (unmanaged) {
    return {
      path: configPath,
      action: 'skipped',
      ok: false,
      route: 'unmanaged-fallback',
      detail:
        'preserved user-owned [mcp_servers.genie] fallback byte-for-byte, but its command is unverified; cannot claim a usable Genie MCP route',
    };
  }

  const block = fallbackBlock(entry);
  let content: string;
  if (owned !== null) {
    content = `${raw.slice(0, owned.start)}${block}${raw.slice(owned.end)}`;
  } else {
    const separator = raw.length === 0 ? '' : raw.endsWith('\n') ? '\n' : '\n\n';
    content = `${raw}${separator}${block}\n`;
  }
  if (content === raw) {
    return { path: configPath, action: 'skipped', ok: true, route: 'fallback', detail: 'project fallback current' };
  }
  return {
    path: configPath,
    action: exists ? 'updated' : 'created',
    ok: true,
    route: 'fallback',
    detail: 'project fallback active',
    content,
  };
}

/** Merge only the marker-owned Codex fallback. Kept exported for migration callers/tests. */
export function mergeCodexMcpFallback(configPath: string, entry: McpServerEntry): ArtifactAction {
  const prepared = prepareCodexFallback(configPath, entry, true);
  if ('content' in prepared && prepared.content !== undefined) applyPreparedWrite(prepared);
  return prepared.action;
}

/** Remove only the marker-owned Codex fallback. */
export function removeCodexMcpFallback(configPath: string): ArtifactAction {
  const prepared = prepareCodexFallback(configPath, genieMcpEntry(), false);
  if (prepared.route === 'conflict') return 'skipped';
  if ('content' in prepared && prepared.content !== undefined) applyPreparedWrite(prepared);
  return prepared.action;
}

/** Read-only route inspection used by doctor. */
export function inspectCodexProjectMcp(root: string, plugin: CodexPluginProbe): CodexProjectMcpResult {
  const path = join(root, '.codex', 'config.toml');
  const effectivePlugin = isUsableCodexPlugin(plugin);
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const owned = fallbackBounds(raw, path);
  const unmanaged = hasUnmanagedFallback(raw, owned);
  if (effectivePlugin && (owned !== null || unmanaged)) {
    return {
      path,
      action: 'skipped',
      ok: false,
      route: 'conflict',
      detail: 'enabled plugin plus project fallback (duplicate); run `genie init` to reconcile marker-owned state',
    };
  }
  if (effectivePlugin) {
    return { path, action: 'skipped', ok: true, route: 'plugin', detail: 'enabled plugin' };
  }
  if (owned !== null) {
    return { path, action: 'skipped', ok: true, route: 'fallback', detail: `project fallback; ${plugin.detail}` };
  }
  if (unmanaged) {
    return {
      path,
      action: 'skipped',
      ok: false,
      route: 'unmanaged-fallback',
      detail: `user-owned project fallback preserved but unverified; ${plugin.detail}`,
    };
  }
  return {
    path,
    action: 'skipped',
    ok: !plugin.cliAvailable,
    route: 'none',
    detail: plugin.cliAvailable ? `no usable Codex MCP route; ${plugin.detail}` : plugin.detail,
  };
}

/**
 * Refuse an install/enable mutation when it would collide with a user-owned
 * project registration. Marker-owned state is safe for reconciliation; an
 * unmanaged `[mcp_servers.genie]` entry is preserved byte-for-byte.
 */
export function preflightCodexPluginMutation(root: string): { ok: boolean; path: string; detail: string } {
  const path = join(root, '.codex', 'config.toml');
  try {
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const owned = fallbackBounds(raw, path);
    if (hasUnmanagedFallback(raw, owned)) {
      return {
        ok: false,
        path,
        detail:
          'user-owned [mcp_servers.genie] fallback is present; refusing to install or enable the plugin because that would create duplicate routing',
      };
    }
    return { ok: true, path, detail: 'no unmanaged Genie MCP fallback' };
  } catch (error) {
    return { ok: false, path, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Reconcile the Codex route at an already-resolved worktree root.
 * Query failures fail safe to the absolute project fallback.
 */
export function reconcileCodexProjectMcp(
  root: string,
  plugin: CodexPluginProbe,
  entry = genieMcpEntry(),
): CodexProjectMcpResult {
  const path = join(root, '.codex', 'config.toml');
  const effectivePlugin = isUsableCodexPlugin(plugin);
  const prepared = prepareCodexFallback(path, entry, !effectivePlugin);
  if ('content' in prepared && prepared.content !== undefined) applyPreparedWrite(prepared);
  return prepared;
}

/**
 * Register the shared stdio entry for Claude/Warp, then reconcile exactly one
 * Codex route. All files are parsed before any write, so valid-but-wrong-shaped
 * JSON cannot leave one sibling config partially updated.
 */
export function registerProjectMcpConfigs(root: string, options: RegisterProjectMcpOptions = {}): McpConfigResult[] {
  const entry = options.entry ?? genieMcpEntry();
  const plugin = options.pluginProbe ?? probeCodexGeniePlugin(options.probeDeps);
  const preparedJson = [join(root, '.mcp.json'), join(root, '.warp', '.mcp.json')].map((path) =>
    prepareJsonMcpConfig(path, entry),
  );
  const preparedCodex = plugin.cliAvailable
    ? prepareCodexFallback(join(root, '.codex', 'config.toml'), entry, !isUsableCodexPlugin(plugin))
    : null;

  if (preparedCodex !== null && !preparedCodex.ok) {
    throw new Error(`Cannot reconcile Codex project MCP at ${preparedCodex.path}: ${preparedCodex.detail}`);
  }

  // Parsing/planning above is intentionally complete before the first write.
  const results = preparedJson.map(applyPreparedWrite);
  if (preparedCodex !== null) {
    if ('content' in preparedCodex && preparedCodex.content !== undefined) applyPreparedWrite(preparedCodex);
    results.push({ path: preparedCodex.path, action: preparedCodex.action, detail: preparedCodex.detail });
  }
  return results;
}
