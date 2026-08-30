/**
 * Read-only Codex plugin discovery plus retirement of historical project MCP
 * registrations. No API in this module can create or revive a Genie route.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  constants,
  accessSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { resolveCodexDir, resolveGenieHome } from './genie-home.js';
import { resolveTrustedExecutable, validateTrustedExecutablePath } from './trusted-executable.js';

export type ArtifactAction = 'created' | 'updated' | 'skipped';

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
  /** Repository directory whose enclosing worktree/common roots are untrusted. */
  cwd?: string;
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
  /** Active project directory whose worktree/common checkout roots are untrusted. */
  cwd?: string;
}

export interface RetireProjectMcpOptions {
  readonly retirementOnly?: true;
}

export interface GitProjectRoots {
  /** Root of the working tree that contains cwd (linked worktrees stay linked). */
  worktreeRoot: string;
  /** Main checkout root that owns Git's common dir and the shared genie.db. */
  commonRoot: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
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
  const candidates = parsed.installed.filter(
    (entry): entry is JsonObject => isJsonObject(entry) && entry.pluginId === GENIE_PLUGIN_ID,
  );
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw new Error(`response contained ${candidates.length} entries for ${GENIE_PLUGIN_ID}; expected exactly one`);
  }
  const candidate = candidates[0];
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

function isSameOrContainedPath(parent: string, child: string): boolean {
  return normalize(parent) === normalize(child) || isContainedPath(parent, child);
}

function configProjectRoot(configPath: string): string {
  const parent = dirname(configPath);
  return basename(parent) === '.codex' ? dirname(parent) : parent;
}

/** Reject repository-controlled links before reading or replacing project config. */
function assertSafeProjectConfigPath(root: string, configPath: string): void {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(configPath);
  if (!isContainedPath(absoluteRoot, absoluteTarget)) {
    throw new Error(`Refusing MCP config outside the project root: ${absoluteTarget}`);
  }
  const rootStat = lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Project root is not a physical directory: ${absoluteRoot}`);
  }
  const canonicalRoot = normalizeGitPath(realpathSync(absoluteRoot));
  const parentRelative = relative(absoluteRoot, dirname(absoluteTarget));
  let current = absoluteRoot;
  for (const segment of parentRelative.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`MCP config parent is not a physical directory: ${current}`);
      }
      const canonical = normalizeGitPath(realpathSync(current));
      if (!isSameOrContainedPath(canonicalRoot, canonical)) {
        throw new Error(`MCP config parent escapes the project root: ${current}`);
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break;
      throw error;
    }
  }
  try {
    const targetStat = lstatSync(absoluteTarget);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      throw new Error(`MCP config target is not a physical file: ${absoluteTarget}`);
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
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

function resolveTrustedProbeCommand(command: string, cwd = process.cwd()): string {
  return validateTrustedExecutablePath('Codex CLI', command, cwd);
}

function resolveConfiguredNodeCommand(options: CodexPluginMcpUsabilityOptions): string {
  const commandPath = (options.resolveCommand ?? ((command: string) => Bun.which(command)))('node');
  if (!commandPath) throw new Error('configured plugin MCP command "node" is not available on PATH');
  return validateTrustedExecutablePath(
    'configured plugin MCP command "node"',
    commandPath,
    options.cwd ?? process.cwd(),
    options.platform ?? process.platform,
  );
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
  which: (name: string) => string | null = (name) => Bun.which(name),
): GitProjectRoots | null {
  try {
    const gitCommand = resolveTrustedExecutable('git', cwd, which);
    const output = exec(gitCommand, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], {
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
 * enabled metadata or a healthy source bundle never replaces the absolute
 * project route.
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
  const codexCommand = which('codex');
  if (!codexCommand) {
    return {
      cliAvailable: false,
      status: 'unavailable',
      installed: false,
      detail: 'Codex CLI not found',
    };
  }
  if (!isAbsolute(codexCommand)) {
    return {
      cliAvailable: true,
      status: 'error',
      installed: false,
      detail: `Codex CLI resolved to a non-absolute command (${codexCommand}); retaining the project fallback`,
    };
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  try {
    const command = resolveTrustedProbeCommand(codexCommand, deps.cwd ?? process.cwd());
    const result = (deps.run ?? defaultProbeRunner)(command, ['plugin', 'list', '--json'], timeoutMs);
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
            cwd: deps.cwd ?? process.cwd(),
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

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applyPreparedWrite(prepared: PreparedWrite, root = configProjectRoot(prepared.path)): McpConfigResult {
  if (prepared.content === undefined) return { path: prepared.path, action: prepared.action, detail: prepared.detail };
  assertSafeProjectConfigPath(root, prepared.path);
  mkdirSync(dirname(prepared.path), { recursive: true });
  assertSafeProjectConfigPath(root, prepared.path);
  const tempPath = join(dirname(prepared.path), `.genie-mcp-${randomUUID()}.tmp`);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    writeFileSync(fd, prepared.content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Revalidate immediately before the atomic same-directory replacement.
    assertSafeProjectConfigPath(root, prepared.path);
    renameSync(tempPath, prepared.path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tempPath);
    } catch {
      // The temp may not have been created or may already have been promoted.
    }
    throw error;
  }
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
  if (start < 0) return null;
  if (
    raw.indexOf(FALLBACK_BEGIN, start + FALLBACK_BEGIN.length) >= 0 ||
    raw.indexOf(FALLBACK_END, endMarker + FALLBACK_END.length) >= 0
  ) {
    throw new Error(
      `Cannot reconcile genie MCP server: ${path} has duplicate ${FALLBACK_BEGIN}/${FALLBACK_END} blocks. Repair or remove those marker blocks and retry.`,
    );
  }
  let end = endMarker + FALLBACK_END.length;
  // The generated block owns its line ending and one blank separator. Include
  // those bytes in the marker bounds so update/remove is byte-idempotent and
  // cannot accumulate a blank line on every reconciliation.
  for (let lineEnding = 0; lineEnding < 2; lineEnding += 1) {
    if (raw.startsWith('\r\n', end)) end += 2;
    else if (raw[end] === '\n') end += 1;
    else break;
  }
  return { start, end };
}

function hasUnmanagedFallback(raw: string, owned: { start: number; end: number } | null): boolean {
  const withoutOwned = owned === null ? raw : `${raw.slice(0, owned.start)}${raw.slice(owned.end)}`;
  if (withoutOwned.trim() === '') return false;
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(withoutOwned);
  } catch (error) {
    throw new Error(
      `Cannot inspect Codex MCP fallback because config TOML is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isJsonObject(parsed)) return false;
  return isJsonObject(parsed.mcp_servers) && Object.hasOwn(parsed.mcp_servers, GENIE_PLUGIN_NAME);
}

function removeOwnedFallback(raw: string, owned: { start: number; end: number }): string {
  return `${raw.slice(0, owned.start)}${raw.slice(owned.end)}`;
}

function canonicalTomlValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalTomlValue);
  if (!isJsonObject(value)) return value;
  const result: JsonObject = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalTomlValue(value[key]);
  return result;
}

function nonGenieTomlSemantics(raw: string, path: string): string {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(raw);
  } catch (error) {
    throw new Error(
      `Cannot reconcile genie MCP server because ${path} is invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isJsonObject(parsed)) return JSON.stringify(parsed);
  const copy = structuredClone(parsed) as JsonObject;
  const { mcp_servers: mcpServers, ...withoutServers } = copy;
  if (isJsonObject(mcpServers)) {
    const remaining = Object.fromEntries(Object.entries(mcpServers).filter(([key]) => key !== GENIE_PLUGIN_NAME));
    if (Object.keys(remaining).length > 0) withoutServers.mcp_servers = remaining;
    return JSON.stringify(canonicalTomlValue(withoutServers));
  }
  return JSON.stringify(canonicalTomlValue(copy));
}

function assertNonGenieTomlSemantics(raw: string, next: string, path: string): void {
  if (nonGenieTomlSemantics(raw, path) !== nonGenieTomlSemantics(next, path)) {
    throw new Error(
      `Cannot reconcile genie MCP server: removing or updating the marker-owned block would change non-Genie TOML semantics in ${path}. Move root keys before the legacy block or add an explicit table header, then retry.`,
    );
  }
}

/** Remove only the marker-owned Codex fallback. */
export function removeCodexMcpFallback(configPath: string): ArtifactAction {
  assertSafeProjectConfigPath(configProjectRoot(configPath), configPath);
  if (!existsSync(configPath)) return 'skipped';
  const raw = readFileSync(configPath, 'utf8');
  const owned = fallbackBounds(raw, configPath);
  if (owned === null) return 'skipped';
  const content = removeOwnedFallback(raw, owned);
  assertNonGenieTomlSemantics(raw, content, configPath);
  applyPreparedWrite({ path: configPath, action: 'updated', content });
  return 'updated';
}

// ============================================================================
// `.mcp.json` — the retired `genie mcp` registration
// ============================================================================

/**
 * The `.mcp.json` filename every Claude Code project uses. It carries NO
 * ownership marker, so only one exactly-shaped entry is ever eligible for
 * retirement (see {@link isRetiredGenieMcpServer}); everything else in the
 * file is user-owned.
 */
const PROJECT_JSON_MCP_FILE = '.mcp.json';

/**
 * True when `command` names the Genie binary itself rather than a user wrapper.
 * Both separators are recognized because a `.mcp.json` is committed and read on
 * whatever platform its author used, not only on the one running this check.
 */
function isGenieBinaryCommand(command: string): boolean {
  const trimmed = command.trim();
  const name = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
  return name === 'genie' || name === 'genie.exe';
}

/**
 * True for EXACTLY the registration a pre-retirement `genie init` wrote: the
 * Genie binary invoked with the single argument `mcp`. `genie mcp` is retired
 * and now exits 1, so this entry can only ever render as a failed MCP server.
 *
 * Anything else under the `genie` key is user-owned and never touched — a
 * different command (a personal wrapper, another binary), extra or different
 * args, or a non-object value.
 */
export function isRetiredGenieMcpServer(entry: unknown): boolean {
  if (!isJsonObject(entry)) return false;
  if (typeof entry.command !== 'string' || !isGenieBinaryCommand(entry.command)) return false;
  return Array.isArray(entry.args) && entry.args.length === 1 && entry.args[0] === 'mcp';
}

/**
 * What a project `.mcp.json` holds with respect to the retired registration.
 * `present` is the ONLY state that permits a write; every other state is a
 * reported no-op, so neither doctor nor init can ever be blocked by it.
 */
export type RetiredJsonMcpState = 'absent' | 'symlink' | 'unreadable' | 'clean' | 'present';

export interface RetiredJsonMcpFinding {
  path: string;
  state: RetiredJsonMcpState;
  /** Human reason, safe to print verbatim in doctor and init output. */
  detail: string;
}

/** Read-only `.mcp.json` inspection shared by doctor and init. Never throws. */
export function inspectRetiredJsonMcpEntry(root: string): RetiredJsonMcpFinding {
  const path = join(root, PROJECT_JSON_MCP_FILE);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { path, state: 'absent', detail: 'no .mcp.json in this repository' };
    }
    return { path, state: 'unreadable', detail: `.mcp.json is unreadable: ${diagnostic(error)}` };
  }
  // A symlinked .mcp.json is repository-controlled indirection: Genie neither
  // follows it nor rewrites it, and says so instead of failing.
  if (stat.isSymbolicLink()) {
    return {
      path,
      state: 'symlink',
      detail: '.mcp.json is a symlink; left untouched (retire the `genie` entry by hand)',
    };
  }
  if (!stat.isFile()) return { path, state: 'unreadable', detail: '.mcp.json is not a regular file; left untouched' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      path,
      state: 'unreadable',
      detail: `.mcp.json is not valid JSON, so it is preserved: ${diagnostic(error)}`,
    };
  }
  if (!isJsonObject(parsed) || !isJsonObject(parsed.mcpServers)) {
    return { path, state: 'clean', detail: 'no retired `genie mcp` registration in .mcp.json' };
  }
  if (!isRetiredGenieMcpServer(parsed.mcpServers[GENIE_PLUGIN_NAME])) {
    return { path, state: 'clean', detail: 'no retired `genie mcp` registration in .mcp.json' };
  }
  return { path, state: 'present', detail: 'a `genie` server still launches the retired `genie mcp` command' };
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The document's own indentation, so the re-serialization fallback keeps the
 * shape the author chose instead of reformatting a file Genie only removes one
 * key from.
 */
function detectJsonIndent(raw: string): string | number {
  const match = /\n([ \t]+)"/.exec(raw);
  return match === null ? 2 : match[1];
}

// ---------------------------------------------------------------------------
// Byte-surgical property removal
//
// Removing one dead server must not reformat a git-tracked file the user owns,
// so the retirement splices exactly that property's bytes out of the original
// text and every other byte survives untouched. These scanners run only on
// text `JSON.parse` has ALREADY accepted, so they need to agree with it, not
// validate it — and the caller re-parses and compares the spliced result
// against the intended object before writing, falling back to a plain
// re-serialization if it ever disagrees.
// ---------------------------------------------------------------------------

function skipJsonWhitespace(raw: string, index: number): number {
  let i = index;
  while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\n' || raw[i] === '\r')) i += 1;
  return i;
}

/** Index just past the string literal that starts at `index` (a `"`). */
function scanJsonString(raw: string, index: number): number {
  let i = index + 1;
  while (i < raw.length) {
    if (raw[i] === '\\') {
      i += 2;
      continue;
    }
    if (raw[i] === '"') return i + 1;
    i += 1;
  }
  throw new Error('unterminated JSON string');
}

/** Index just past the value that starts at `index`. */
function scanJsonValue(raw: string, index: number): number {
  const start = skipJsonWhitespace(raw, index);
  const first = raw[start];
  if (first === '"') return scanJsonString(raw, start);
  if (first === '{' || first === '[') return scanJsonContainer(raw, start).end;
  let i = start;
  while (i < raw.length && !',}] \t\r\n'.includes(raw[i])) i += 1;
  return i;
}

interface JsonPropertySpan {
  key: string;
  /** Index of the property key's opening quote. */
  start: number;
  /** Index just past the property's value. */
  end: number;
}

/**
 * Walk the container that starts at `index`, returning where it ends and — for
 * an object — the span of every property it declares directly.
 */
function scanJsonContainer(raw: string, index: number): { end: number; properties: JsonPropertySpan[] } {
  const isObject = raw[index] === '{';
  const close = isObject ? '}' : ']';
  const properties: JsonPropertySpan[] = [];
  let i = index + 1;
  for (;;) {
    i = skipJsonWhitespace(raw, i);
    if (i >= raw.length) throw new Error('unterminated JSON container');
    if (raw[i] === close) return { end: i + 1, properties };
    if (raw[i] === ',') {
      i += 1;
      continue;
    }
    if (!isObject) {
      i = scanJsonValue(raw, i);
      continue;
    }
    const keyStart = i;
    const keyEnd = scanJsonString(raw, i);
    i = skipJsonWhitespace(raw, keyEnd);
    if (raw[i] !== ':') throw new Error('malformed JSON member');
    const valueEnd = scanJsonValue(raw, i + 1);
    properties.push({ key: JSON.parse(raw.slice(keyStart, keyEnd)) as string, start: keyStart, end: valueEnd });
    i = valueEnd;
  }
}

/**
 * `raw` with `container[property]` spliced out — key, value, and exactly one
 * adjacent comma — or null when the property (or its container) is not a
 * directly declared top-level member. Every surviving byte is untouched.
 */
function spliceJsonProperty(raw: string, containerKey: string, propertyKey: string): string | null {
  const documentStart = skipJsonWhitespace(raw, 0);
  if (raw[documentStart] !== '{') return null;
  const root = scanJsonContainer(raw, documentStart);
  const container = root.properties.find((prop) => prop.key === containerKey);
  if (container === undefined) return null;
  const containerStart = skipJsonWhitespace(raw, raw.indexOf(':', container.start + containerKey.length) + 1);
  if (raw[containerStart] !== '{') return null;
  const target = scanJsonContainer(raw, containerStart).properties.find((prop) => prop.key === propertyKey);
  if (target === undefined) return null;

  // Take the FOLLOWING comma when there is one; otherwise the preceding one,
  // so removing the last member never leaves a dangling comma.
  const afterValue = skipJsonWhitespace(raw, target.end);
  if (raw[afterValue] === ',') {
    const nextMember = skipJsonWhitespace(raw, afterValue + 1);
    const targetLineStart = raw.lastIndexOf('\n', target.start) + 1;
    const nextMemberLineStart = raw.lastIndexOf('\n', nextMember - 1) + 1;
    // Members on separate lines: drop the target's whole line, indentation
    // included, so the survivor keeps the indentation its author gave it.
    // Members sharing a line: drop exactly the target's bytes and its comma.
    return nextMemberLineStart > targetLineStart
      ? `${raw.slice(0, targetLineStart)}${raw.slice(nextMemberLineStart)}`
      : `${raw.slice(0, target.start)}${raw.slice(nextMember)}`;
  }
  let start = target.start;
  let before = start - 1;
  while (before >= 0 && (raw[before] === ' ' || raw[before] === '\t' || raw[before] === '\n' || raw[before] === '\r')) {
    before -= 1;
  }
  if (raw[before] === ',') start = before;
  return `${raw.slice(0, start)}${raw.slice(target.end)}`;
}

/**
 * The bytes to write after removing the dead `genie` server: the surgical
 * splice when re-parsing it yields exactly `expected`, and a re-serialization
 * that preserves key order, indentation, and the trailing newline otherwise.
 */
function rewriteWithoutGenieServer(raw: string, expected: JsonObject): string {
  const spliced = spliceJsonProperty(raw, 'mcpServers', GENIE_PLUGIN_NAME);
  if (spliced !== null) {
    try {
      if (JSON.stringify(JSON.parse(spliced)) === JSON.stringify(expected)) return spliced;
    } catch {
      // Fall through to re-serialization.
    }
  }
  return `${JSON.stringify(expected, null, detectJsonIndent(raw))}${raw.endsWith('\n') ? '\n' : ''}`;
}

/**
 * Retire ONLY the exactly-shaped dead `genie mcp` entry from `.mcp.json`,
 * backing the file up first (`<path>.genie-backup-<stamp>`, the same
 * backup-first pattern as the Codex OTel migration). Key order, every other
 * server, every other top-level key, the file's indentation, its trailing
 * newline, and its mode are preserved; the file itself is removed only when
 * retiring the entry leaves an empty `mcpServers` and nothing else.
 *
 * Total by contract: any failure is reported as `skipped` with the reason, so
 * `genie init` is never blocked by the state of a user-owned file.
 */
export function retireJsonMcpGenieEntry(root: string, now: Date = new Date()): McpConfigResult {
  const finding = inspectRetiredJsonMcpEntry(root);
  if (finding.state !== 'present') return { path: finding.path, action: 'skipped', detail: finding.detail };
  try {
    const raw = readFileSync(finding.path, 'utf8');
    const parsed = JSON.parse(raw) as JsonObject;
    const servers = { ...(parsed.mcpServers as JsonObject) };
    delete servers[GENIE_PLUGIN_NAME];
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const backupPath = `${finding.path}.genie-backup-${stamp}`;
    copyFileSync(finding.path, backupPath);
    const otherKeys = Object.keys(parsed).filter((key) => key !== 'mcpServers');
    if (Object.keys(servers).length === 0 && otherKeys.length === 0) {
      unlinkSync(finding.path);
      return {
        path: finding.path,
        action: 'updated',
        detail: `retired the dead \`genie mcp\` registration; .mcp.json held nothing else and was removed (backup: ${basename(backupPath)})`,
      };
    }
    const next: JsonObject = {};
    for (const key of Object.keys(parsed)) next[key] = key === 'mcpServers' ? servers : parsed[key];
    const content = rewriteWithoutGenieServer(raw, next);
    const mode = lstatSync(finding.path).mode & 0o777;
    applyPreparedWrite({ path: finding.path, action: 'updated', content }, root);
    chmodSync(finding.path, mode);
    return {
      path: finding.path,
      action: 'updated',
      detail: `retired the dead \`genie mcp\` registration; every other server preserved (backup: ${basename(backupPath)})`,
    };
  } catch (error) {
    return {
      path: finding.path,
      action: 'skipped',
      detail: `left untouched — could not retire the dead \`genie mcp\` registration: ${diagnostic(error)}`,
    };
  }
}

/** Read-only route inspection used by doctor. */
export function inspectCodexProjectMcp(root: string, plugin: CodexPluginProbe): CodexProjectMcpResult {
  const path = join(root, '.codex', 'config.toml');
  const effectivePlugin = isUsableCodexPlugin(plugin);
  let raw: string;
  let owned: { start: number; end: number } | null;
  let unmanaged: boolean;
  try {
    assertSafeProjectConfigPath(root, path);
    raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
    owned = fallbackBounds(raw, path);
    unmanaged = hasUnmanagedFallback(raw, owned);
  } catch (error) {
    return {
      path,
      action: 'skipped',
      ok: false,
      route: 'none',
      detail: `unsafe or invalid Codex project MCP config: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
 * Retire the two historical Genie project registrations and nothing else: the
 * dead `genie mcp` entry a pre-retirement `genie init` wrote into `.mcp.json`,
 * and the marker-owned Codex fallback block. Every other server, key, and byte
 * in either file is user-owned and preserved.
 *
 * Neither step may abort init: the `.mcp.json` step is total (it reports a
 * symlink, an unreadable file, or a failed rewrite as `skipped` with the
 * reason), and the reported Codex detail states the outcome it actually
 * produced rather than a fixed claim.
 */
export function retireProjectMcpConfigs(root: string, _options: RetireProjectMcpOptions = {}): McpConfigResult[] {
  const results = [retireJsonMcpGenieEntry(root)];
  const codexPath = join(root, '.codex', 'config.toml');
  const action = removeCodexMcpFallback(codexPath);
  results.push({
    path: codexPath,
    action,
    detail:
      action === 'updated'
        ? 'retired marker-owned project registration'
        : 'no marker-owned project registration to retire',
  });
  return results;
}
