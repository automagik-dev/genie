#!/usr/bin/env bun

/**
 * Shared black-box harness for the Codex plugin-only smoke tests
 * (`codex-plugin-only-smoke.ts` + `codex-debug-discovery-smoke.ts`).
 *
 * Design contract (wish `repair-genie-codex-hooks-and-dedupe-skills`, Group C):
 *
 * - The BUILT CLI performs the isolated non-Codex bootstrap install and remains
 *   the system under test for init/MCP surfaces. Fixture delivery publication,
 *   activation, and delivery-aware doctor assertions use one unshipped lifecycle
 *   driver because the deterministic Sigstore bundle is intentionally rejected
 *   without its same-process crypto seam. Setup still runs through a real PTY
 *   and the production consent/authorization/executor/store path. The black-box
 *   inspector imports no runtime-integration oracle (`proveCodexPluginHealth`,
 *   `runBoundedCodexMcpSession`, `inspectCodexFallbackTier`,
 *   `inspectManagedSkillTree`) — those would re-run the code under test against
 *   the harness's OWN `process.env`
 *   (the developer's real `~/.codex`/`~/.agents`). MCP health is proven
 *   black-box by driving `<activePluginRoot>/scripts/mcp-launcher.cjs` over a
 *   hand-rolled JSON-RPC session.
 * - This harness module's ONLY direct `src/` imports are deterministic FIXTURE
 *   BUILDERS with explicit path arguments and no env resolution:
 *   `computeDirDigest` (marker digest) and
 *   `materializeFrozenCodexFallbackRelease` (the frozen 5.260712.1 release).
 * - Every isolated home lives under `os.homedir()` (a `/tmp` home makes real
 *   codex 0.144.1 emit an alias warning). Each is registered and swept on
 *   normal exit, failure, SIGINT, and uncaught errors, and the module refuses
 *   to start if a stale `genie-codex-smoke-*` home already exists.
 * - Preservation is compared by bytes, mode, and symlink target only (mtime is
 *   deliberately excluded; the wish QA contract is bytes/mode/symlink-target).
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeDirDigest } from '../src/lib/agent-sync.ts';
import { materializeFrozenCodexFallbackRelease } from './generate-codex-fallback-allowlist.ts';

// ============================================================================
// Failure + repo constants
// ============================================================================

export class SmokeFailure extends Error {}

export function fail(message: string): never {
  throw new SmokeFailure(message);
}

export function req<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) fail(message);
  return value;
}

export function repositoryRootFromModuleUrl(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..');
}

export const REPO_ROOT = repositoryRootFromModuleUrl(import.meta.url);
export const DIST_CLI = join(REPO_ROOT, 'dist', 'genie.js');
const LIFECYCLE_TEST_RUNNER = join(REPO_ROOT, 'tests', 'support', 'codex-lifecycle-test-runner.ts');

/** The five read-only Genie MCP tools a healthy plugin launcher must expose. */
export const REQUIRED_GENIE_MCP_TOOLS = [
  'genie_board',
  'genie_wish_status',
  'genie_worktree_context',
  'genie_task',
  'genie_active',
] as const;

/** Committed retirement on-disk contract (mirrors agent-sync + doctor). */
export const RETIREMENT_ROOT_NAME = '.genie-codex-fallback-retirement';
const RETIREMENT_TXN_PREFIX = 'txn-';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) fail(message);
  return value;
}

export const TARGET_VERSION = ((): string => {
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as unknown;
  const pkg = asRecord(raw, 'package.json is not an object');
  const version = pkg.version;
  if (typeof version !== 'string' || version.length === 0) fail('package.json version is missing');
  return version;
})();

function resolveRealCodex(): string {
  const which = Bun.which('codex');
  if (which === null) fail('real codex CLI not found on PATH — Group C requires codex 0.144.1+');
  return which;
}

// ============================================================================
// Temp-home lifecycle (A12): registry + sweep + preflight guard
// ============================================================================

const TEMP_PREFIX = 'genie-codex-smoke-';
const liveTempRoots = new Set<string>();
let sweepHandlersInstalled = false;

function sweepTempRoots(): void {
  for (const root of liveTempRoots) rmSync(root, { recursive: true, force: true });
  liveTempRoots.clear();
}

function installSweepHandlers(): void {
  if (sweepHandlersInstalled) return;
  sweepHandlersInstalled = true;
  const onSignal = (): void => {
    sweepTempRoots();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('uncaughtException', (error) => {
    sweepTempRoots();
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
  process.once('exit', sweepTempRoots);
}

/** Fail loudly if a previous crashed run left temp homes behind (A12). */
export function assertNoStaleTempHomes(): void {
  const home = homedir();
  const stale = readdirSync(home, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(TEMP_PREFIX))
    .map((entry) => join(home, entry.name));
  if (stale.length > 0) {
    fail(`refusing to start: stale smoke temp homes remain under ${home}: ${stale.join(', ')} — remove them first`);
  }
}

// ============================================================================
// Build the CLI once
// ============================================================================

let cliBuilt = false;

export function buildCliOnce(): void {
  if (cliBuilt) return;
  const result = Bun.spawnSync(['bun', 'run', 'build'], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    fail(`bun run build failed: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`);
  }
  if (!existsSync(DIST_CLI)) fail(`build did not produce ${DIST_CLI}`);
  cliBuilt = true;
}

// ============================================================================
// Isolated home
// ============================================================================

export interface IsolatedHome {
  home: string;
  genieHome: string;
  codexHome: string;
  skillsDir: string;
  bin: string;
  genieBin: string;
  project: string;
  env: Record<string, string>;
}

const AUX_LAYOUT_DIRS = ['plugins', 'skills', 'templates', '.agents', '.claude-plugin'] as const;

function makeIsolatedHome(): IsolatedHome {
  installSweepHandlers();
  const home = mkdtempSync(join(homedir(), TEMP_PREFIX));
  liveTempRoots.add(home);
  const genieHome = join(home, '.genie');
  const codexHome = join(home, '.codex');
  const claudeConfigDir = join(home, '.claude');
  const skillsDir = join(home, '.agents', 'skills');
  const bin = join(home, 'bin');
  const project = join(home, 'project');
  const tempDir = join(home, 'tmp');
  const xdgConfig = join(home, '.config');
  const xdgCache = join(home, '.cache');
  const xdgData = join(home, '.local', 'share');
  const xdgState = join(home, '.local', 'state');
  const basePath = process.env.PATH ?? '';
  for (const path of [tempDir, xdgConfig, xdgCache, xdgData, xdgState]) mkdirSync(path, { recursive: true });
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    GENIE_HOME: genieHome,
    CODEX_HOME: codexHome,
    // Rebase CLAUDE_CONFIG_DIR into the isolated home too — without this a
    // developer/CI environment that sets CLAUDE_CONFIG_DIR explicitly (rather
    // than relying on the ~/.claude default) leaks a real Claude config dir
    // into the smoke despite HOME being isolated (genie-home.ts resolves it
    // via `process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')`).
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    GENIE_AGENTS_SKILLS_DIR: skillsDir,
    TMPDIR: tempDir,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    BUN_INSTALL_CACHE_DIR: join(xdgCache, 'bun'),
    NPM_CONFIG_CACHE: join(xdgCache, 'npm'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${bin}:${basePath}`,
  };
  return { home, genieHome, codexHome, skillsDir, bin, genieBin: join(genieHome, 'bin', 'genie'), project, env };
}

/** Run `fn` against a fully isolated home; always sweep the temp root (A12). */
export function withIsolatedHome<T>(fn: (iso: IsolatedHome) => T): T {
  const iso = makeIsolatedHome();
  try {
    return fn(iso);
  } finally {
    rmSync(iso.home, { recursive: true, force: true });
    liveTempRoots.delete(iso.home);
  }
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function spawnCli(command: string[], iso: IsolatedHome, env = iso.env): CliResult {
  const result = Bun.spawnSync(command, { cwd: iso.project, env, stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** Invoke the BUILT, installed CLI at `$GENIE_HOME/bin/genie`. */
export function runCli(iso: IsolatedHome, args: string[]): CliResult {
  return spawnCli([iso.genieBin, ...args], iso);
}

function lifecycleEnv(iso: IsolatedHome): Record<string, string> {
  return { ...iso.env, CI: '', CODEX_THREAD_ID: '' };
}

/** Invoke the unshipped lifecycle driver with deterministic evidence verification. */
export function runLifecycleCli(iso: IsolatedHome, args: string[]): CliResult {
  return spawnCli([process.execPath, LIFECYCLE_TEST_RUNNER, ...args], iso, lifecycleEnv(iso));
}

export interface PtyCliResult {
  exitCode: number;
  output: string;
}

/** Invoke setup through a real PTY so A's genuine consent guards and brand minter remain live. */
export function runLifecycleSetup(iso: IsolatedHome): PtyCliResult {
  const cli = [process.execPath, LIFECYCLE_TEST_RUNNER, 'setup', '--codex'];
  const env = lifecycleEnv(iso);
  if (process.platform === 'darwin') {
    const expect = Bun.which('expect');
    if (expect === null) fail('real-PTY lifecycle smoke requires expect(1) on macOS');
    const spawnWords = cli.map((part) => `{${part}}`).join(' ');
    const script = [
      'set timeout 120',
      `spawn -noecho ${spawnWords}`,
      'send -- "yes\\r"',
      'expect eof',
      'catch wait result',
      'exit [lindex $result 3]',
    ].join('\n');
    const proc = Bun.spawnSync([expect, '-c', script], {
      cwd: iso.project,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 150_000,
    });
    return { exitCode: proc.exitCode ?? -1, output: proc.stdout.toString() + proc.stderr.toString() };
  }
  if (process.platform === 'linux') {
    const script = Bun.which('script');
    if (script === null) fail('real-PTY lifecycle smoke requires script(1) on Linux');
    const command = cli.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(' ');
    const proc = Bun.spawnSync([script, '-qec', command, '/dev/null'], {
      cwd: iso.project,
      env,
      stdin: Buffer.from('yes\n'),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
    });
    return { exitCode: proc.exitCode ?? -1, output: proc.stdout.toString() + proc.stderr.toString() };
  }
  fail(`real-PTY lifecycle smoke is unsupported on ${process.platform}`);
}

/** Invoke the real codex on the isolated PATH. */
export function runCodex(iso: IsolatedHome, args: string[]): CliResult {
  return spawnCli([join(iso.bin, 'codex'), ...args], iso);
}

/**
 * Invoke the resolved real Codex executable directly. C8 uses this instead of
 * relying on the isolated-PATH symlink, while preserving the isolated env and
 * project cwd that determine Codex's effective project configuration.
 */
export function runRealCodex(iso: IsolatedHome, args: string[]): CliResult {
  return spawnCli([resolveRealCodex(), ...args], iso);
}

/**
 * Explicitly trust only the isolated project fixture so real Codex will load
 * its project-scoped `.codex/config.toml`. Cover logical and physical spellings
 * because macOS temp paths can differ by a `/private` prefix.
 */
export function trustIsolatedCodexProject(iso: IsolatedHome): void {
  const spellings = [...new Set([iso.project, realpathSync(iso.project)])];
  const trust = spellings
    .map((spelling) => `[projects.${JSON.stringify(spelling)}]\ntrust_level = "trusted"\n`)
    .join('');
  appendFileSync(join(iso.codexHome, 'config.toml'), `\n${trust}`);
}

export interface EffectiveCodexMcpRoute {
  name: 'genie';
  enabled: true;
  transport: {
    type: 'stdio';
    command: string;
    args: ['mcp'];
    cwd: null;
  };
}

export interface EffectiveCodexMcpSnapshot {
  route: EffectiveCodexMcpRoute;
  getJson: string;
  listJson: string;
}

function parseCodexJson(result: CliResult, command: string): unknown {
  if (result.exitCode !== 0) {
    fail(
      `${command} failed with exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || '<no output>'}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    fail(`${command} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function assertGenieTransport(value: Record<string, unknown>, expectedCommand: string, source: string): void {
  if (value.name !== 'genie') fail(`${source} route name must be "genie"`);
  if (value.enabled !== true) fail(`${source} genie route must be enabled`);
  const transport = asRecord(value.transport, `${source} genie transport is not an object`);
  if (transport.type !== 'stdio') fail(`${source} genie transport type must be "stdio"`);
  if (typeof transport.command !== 'string') fail(`${source} genie transport command must be a string`);
  const normalizedCommand = transport.command.replaceAll('\\', '/');
  if (normalizedCommand.includes('/plugins/cache/') || normalizedCommand.includes('/.codex/plugins/')) {
    fail(`${source} genie command must not resolve through a plugin cache: ${transport.command}`);
  }
  if (transport.command !== expectedCommand) {
    fail(
      `${source} genie command is ${JSON.stringify(transport.command)}, expected ${JSON.stringify(expectedCommand)}`,
    );
  }
  if (!Array.isArray(transport.args) || transport.args.length !== 1 || transport.args[0] !== 'mcp') {
    fail(`${source} genie args must be exactly ["mcp"]`);
  }
  if ('cwd' in transport && transport.cwd !== null) {
    fail(`${source} genie cwd must be absent or null`);
  }
}

/**
 * Parse and structurally prove Codex's effective project MCP route from both
 * official JSON surfaces. This is intentionally independent of Genie's TOML
 * parser and rejects duplicate, disabled, non-stdio, cache-root, cwd-overridden,
 * or get/list-divergent routes.
 */
export function assertEffectiveCodexProjectRoute(
  getResult: CliResult,
  listResult: CliResult,
  expectedCommand: string,
): EffectiveCodexMcpSnapshot {
  const getParsed = parseCodexJson(getResult, 'codex mcp get genie --json');
  const listParsed = parseCodexJson(listResult, 'codex mcp list --json');
  const getRoute = asRecord(getParsed, 'codex mcp get genie --json is not an object');
  if (!Array.isArray(listParsed)) fail('codex mcp list --json is not an array');
  const genieRoutes = listParsed
    .map((entry) => asRecord(entry, 'codex mcp list --json entry is not an object'))
    .filter((entry) => entry.name === 'genie');
  if (genieRoutes.length !== 1) {
    fail(`codex mcp list --json must contain exactly one genie route, found ${genieRoutes.length}`);
  }
  const listRoute = genieRoutes[0];
  assertGenieTransport(getRoute, expectedCommand, 'codex mcp get');
  assertGenieTransport(listRoute, expectedCommand, 'codex mcp list');
  return {
    route: {
      name: 'genie',
      enabled: true,
      transport: { type: 'stdio', command: expectedCommand, args: ['mcp'], cwd: null },
    },
    getJson: canonicalJson(getParsed),
    listJson: canonicalJson(listParsed),
  };
}

/** Require one complete marker-owned route block, with no duplicate marker. */
export function assertSingleCodexProjectRouteMarker(toml: string): void {
  const begin = '# BEGIN GENIE MCP FALLBACK';
  const end = '# END GENIE MCP FALLBACK';
  const begins = toml.split(begin).length - 1;
  const ends = toml.split(end).length - 1;
  if (begins !== 1 || ends !== 1 || toml.indexOf(begin) >= toml.indexOf(end)) {
    fail(`Codex project config must contain exactly one intact ${begin}/${end} block`);
  }
}

// ============================================================================
// Fixture builders
// ============================================================================

/**
 * Populate `$GENIE_HOME` as the installed marketplace/bundle root and place the
 * BUILT binary at `$GENIE_HOME/bin/genie` (A14 — the MCP launcher and update
 * self-version both resolve this exact path). Then run the finishing install
 * step with no integrations so consent + genie.db exist.
 */
export function installGenieHome(iso: IsolatedHome): void {
  buildCliOnce();
  mkdirSync(join(iso.genieHome, 'bin'), { recursive: true });
  mkdirSync(iso.codexHome, { recursive: true });
  mkdirSync(iso.bin, { recursive: true });
  mkdirSync(iso.project, { recursive: true });
  copyFileSync(DIST_CLI, iso.genieBin);
  chmodSync(iso.genieBin, 0o755);
  // package.json makes `$GENIE_HOME/bin/genie --version` report the target
  // version so `update --post-delivery-converge` matches the installed plugin.
  copyFileSync(join(REPO_ROOT, 'package.json'), join(iso.genieHome, 'package.json'));
  // A real release tarball installs VERSION beside plugins/ at the canonical
  // delivery root. The black-box fixture must reproduce that authenticated
  // layout; package.json affects CLI version reporting but is not delivery
  // evidence and cannot substitute for the canonical VERSION stamp.
  writeFileSync(join(iso.genieHome, 'VERSION'), `${TARGET_VERSION}\n`);
  for (const dir of AUX_LAYOUT_DIRS) {
    cpSync(join(REPO_ROOT, dir), join(iso.genieHome, dir), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
  const gitInit = Bun.spawnSync(['git', 'init', '-q'], { cwd: iso.project, stdout: 'pipe', stderr: 'pipe' });
  if (gitInit.exitCode !== 0) fail(`git init failed in isolated project: ${gitInit.stderr.toString().trim()}`);
  const install = runCli(iso, ['install', '--integrations', 'none']);
  if (install.exitCode !== 0)
    fail(`install --integrations none failed: ${install.stderr.trim() || install.stdout.trim()}`);
  const stat = lstatSync(iso.genieBin);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`installed genie binary must be a regular file: ${iso.genieBin}`);
}

/** Symlink the real codex CLI onto the isolated PATH. */
export function linkRealCodex(iso: IsolatedHome): void {
  mkdirSync(iso.bin, { recursive: true });
  symlinkSync(resolveRealCodex(), join(iso.bin, 'codex'));
}

const FALLBACK_MARKER_NAME = '.genie-sync.json';
const FROZEN_MARKER_VERSION = '5.260712.1';

/**
 * Seed a shipped-5.260712.2-style layout with 23 clean, allowlisted historical
 * fallbacks (A3): materialize the frozen verified 5.260712.1 release, copy each
 * skill directory into the user tier preserving mode + symlinks, and stamp a
 * strict v2 marker whose `digest` is the recomputed physical digest — exactly
 * reproducing the physical digests so historical-tuple acceptance holds.
 * Returns the 23 seeded skill names.
 */
export function seedShippedFallbackLayout(iso: IsolatedHome, exclude: readonly string[] = []): string[] {
  mkdirSync(iso.skillsDir, { recursive: true });
  const releaseParent = mkdtempSync(join(iso.home, 'frozen-release-'));
  try {
    const release = materializeFrozenCodexFallbackRelease(join(releaseParent, 'release'));
    const releaseSkills = join(release.payloadRoot, 'skills');
    const allNames = readdirSync(releaseSkills, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (allNames.length !== 23) fail(`frozen release must expose 23 skill directories, got ${allNames.length}`);
    const names = allNames.filter((name) => !exclude.includes(name));
    for (const name of names) {
      const dest = join(iso.skillsDir, name);
      cpSync(join(releaseSkills, name), dest, { recursive: true, dereference: false, verbatimSymlinks: true });
      const digest = computeDirDigest(dest);
      const marker = {
        managedBy: 'genie-agent-sync',
        version: FROZEN_MARKER_VERSION,
        digest,
        syncedAt: '2026-07-12T00:00:00.000Z',
        identityVersion: 2,
      };
      writeFileSync(join(dest, FALLBACK_MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`);
    }
    return names;
  } finally {
    rmSync(releaseParent, { recursive: true, force: true });
  }
}

export interface PersonalFixtures {
  names: { modifiedManaged: string; malformedMarker: string; symlinked: string; unmanaged: string };
  externalTarget: string;
  /** Absolute paths whose byte/mode/symlink identity must survive every mutation. */
  protectedPaths: string[];
}

/**
 * Seed the four personal-collision classes the migration must preserve
 * byte/mode/link-identical: a modified managed skill (clean marker + edited
 * body), a malformed marker, a symlinked skill (points outside the tier), and
 * an unmanaged same-name skill that duplicates a plugin name (`wish`).
 */
export function seedPersonalFixtures(iso: IsolatedHome): PersonalFixtures {
  mkdirSync(iso.skillsDir, { recursive: true });
  const names = {
    modifiedManaged: 'personal-modified',
    malformedMarker: 'personal-malformed',
    symlinked: 'personal-symlinked',
    unmanaged: 'wish',
  };

  // modified-managed: a real clean marker whose digest no longer matches the body.
  const modified = join(iso.skillsDir, names.modifiedManaged);
  mkdirSync(modified, { recursive: true });
  writeFileSync(join(modified, 'SKILL.md'), '# personal edits\nhand-modified after sync\n');
  const staleDigest = computeDirDigest(modified);
  writeFileSync(join(modified, 'SKILL.md'), '# personal edits\nEDITED AGAIN so digest no longer matches marker\n');
  writeFileSync(
    join(modified, FALLBACK_MARKER_NAME),
    `${JSON.stringify({ managedBy: 'genie-agent-sync', version: FROZEN_MARKER_VERSION, digest: staleDigest, syncedAt: '2026-07-12T00:00:00.000Z', identityVersion: 2 }, null, 2)}\n`,
  );

  // malformed-marker: managedBy present but JSON is corrupt.
  const malformed = join(iso.skillsDir, names.malformedMarker);
  mkdirSync(malformed, { recursive: true });
  // Pin the mode explicitly rather than trusting mkdirSync's umask-derived
  // default: under umask 077 the directory is already created at 0o700, the
  // same value the mode-sabotage self-test chmods to, making the "sabotage" a
  // no-op and false-failing `expectOracleCatches('mode-sabotage', ...)` below.
  chmodSync(malformed, 0o755);
  writeFileSync(join(malformed, 'SKILL.md'), '# personal skill with a broken marker\n');
  writeFileSync(join(malformed, FALLBACK_MARKER_NAME), '{ "managedBy": "genie-agent-sync", broken');

  // symlinked skill: the tier entry is a symlink to an external directory.
  const externalTarget = join(iso.home, 'external-skill-target');
  mkdirSync(externalTarget, { recursive: true });
  writeFileSync(join(externalTarget, 'SKILL.md'), '# external skill body\n');
  symlinkSync(externalTarget, join(iso.skillsDir, names.symlinked));

  // unmanaged same-name: a personal `wish` skill with no marker at all.
  const unmanaged = join(iso.skillsDir, names.unmanaged);
  mkdirSync(unmanaged, { recursive: true });
  writeFileSync(join(unmanaged, 'SKILL.md'), '# my own wish skill — no genie marker\n');

  return {
    names,
    externalTarget,
    protectedPaths: [modified, malformed, join(iso.skillsDir, names.symlinked), unmanaged, externalTarget],
  };
}

// ============================================================================
// Snapshot / diff (A6): lstat-only, mode + symlink target, no traversal of links
// ============================================================================

export interface TreeEntry {
  kind: 'dir' | 'file' | 'symlink' | 'other';
  mode: number;
  target?: string;
  hash?: string;
}

export type TreeSnapshot = Map<string, TreeEntry>;

function snapshotInto(root: string, current: string, out: TreeSnapshot): void {
  for (const name of readdirSync(current).sort()) {
    const abs = join(current, name);
    const rel = abs.slice(root.length + 1);
    const stat = lstatSync(abs);
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) {
      out.set(rel, { kind: 'symlink', mode, target: readlinkSync(abs) });
      continue; // never traverse (covers dangling + symlinked-skill fixtures)
    }
    if (stat.isDirectory()) {
      out.set(rel, { kind: 'dir', mode });
      snapshotInto(root, abs, out);
      continue;
    }
    if (stat.isFile()) {
      out.set(rel, { kind: 'file', mode, hash: createHash('sha256').update(readFileSync(abs)).digest('hex') });
      continue;
    }
    out.set(rel, { kind: 'other', mode });
  }
}

/** Capture bytes + mode + symlink target for every entry under `dir` (mtime excluded by design). */
export function snapshotTree(dir: string): TreeSnapshot {
  const out: TreeSnapshot = new Map();
  if (!existsSync(dir)) return out;
  snapshotInto(resolve(dir), resolve(dir), out);
  return out;
}

function lstatSafe(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Capture ONE node (the node itself keyed by basename, plus its subtree for
 * directories) using lstat semantics — records dangling symlinks as
 * `(target, no content)` without traversal (A6). Absent = empty map.
 */
export function snapshotNode(nodePath: string): TreeSnapshot {
  const out: TreeSnapshot = new Map();
  const resolved = resolve(nodePath);
  const root = dirname(resolved);
  const name = basename(resolved);
  const stat = lstatSafe(resolved);
  if (stat === null) return out;
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    out.set(name, { kind: 'symlink', mode, target: readlinkSync(resolved) });
    return out;
  }
  if (stat.isDirectory()) {
    out.set(name, { kind: 'dir', mode });
    snapshotInto(root, resolved, out);
    return out;
  }
  if (stat.isFile()) {
    out.set(name, { kind: 'file', mode, hash: createHash('sha256').update(readFileSync(resolved)).digest('hex') });
    return out;
  }
  out.set(name, { kind: 'other', mode });
  return out;
}

/** Capture a set of protected node paths for later byte/mode/symlink comparison. */
export function captureProtected(paths: string[]): Map<string, TreeSnapshot> {
  const captured = new Map<string, TreeSnapshot>();
  for (const path of paths) captured.set(path, snapshotNode(path));
  return captured;
}

/** Assert every captured protected node is still byte/mode/symlink identical (A6). */
export function assertProtectedUnchanged(label: string, captured: Map<string, TreeSnapshot>): void {
  for (const [path, before] of captured) {
    const diffs = diffTree(before, snapshotNode(path));
    if (diffs.length > 0) fail(`${label}: protected node ${path} changed: ${diffs.join(' | ')}`);
  }
}

function describeEntry(entry: TreeEntry | undefined): string {
  if (entry === undefined) return '<absent>';
  const suffix =
    entry.kind === 'symlink' ? `→${entry.target}` : entry.kind === 'file' ? `#${entry.hash?.slice(0, 12)}` : '';
  return `${entry.kind}(${entry.mode.toString(8)})${suffix}`;
}

/** Return human-readable differences between two snapshots (empty = identical). */
export function diffTree(before: TreeSnapshot, after: TreeSnapshot): string[] {
  const diffs: string[] = [];
  const keys = new Set<string>([...before.keys(), ...after.keys()]);
  for (const key of [...keys].sort()) {
    const a = before.get(key);
    const b = after.get(key);
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
      diffs.push(`${key}: ${describeEntry(a)} != ${describeEntry(b)}`);
    }
  }
  return diffs;
}

/** Assert a directory is byte/mode/symlink-identical to an earlier snapshot. */
export function assertTreeIdentical(label: string, before: TreeSnapshot, dir: string): void {
  const diffs = diffTree(before, snapshotTree(dir));
  if (diffs.length > 0) fail(`${label} changed after a mutating command: ${diffs.join(' | ')}`);
}

// ============================================================================
// Codex plugin discovery (black-box)
// ============================================================================

export interface CodexPluginEntry {
  pluginId: string;
  version: string;
  enabled: boolean;
  installed: boolean;
}

/** Parse `codex plugin list --json` and return the single genie@automagik entry. */
export function readCodexGeniePlugin(iso: IsolatedHome): CodexPluginEntry {
  const result = runCodex(iso, ['plugin', 'list', '--json']);
  if (result.exitCode !== 0) fail(`codex plugin list --json failed: ${result.stderr.trim() || result.stdout.trim()}`);
  const parsed = asRecord(JSON.parse(result.stdout), 'codex plugin list --json is not an object');
  const installed = parsed.installed;
  if (!Array.isArray(installed)) fail('codex plugin list --json has no installed array');
  const genie = installed
    .map((entry) => asRecord(entry, 'plugin entry is not an object'))
    .filter((entry) => entry.pluginId === 'genie@automagik');
  if (genie.length !== 1) fail(`expected exactly one genie@automagik plugin, found ${genie.length}`);
  const entry = genie[0];
  const version = entry.version;
  const enabled = entry.enabled;
  const flagInstalled = entry.installed;
  if (typeof version !== 'string' || typeof enabled !== 'boolean' || typeof flagInstalled !== 'boolean') {
    fail('genie@automagik plugin entry is missing version/enabled/installed');
  }
  return { pluginId: 'genie@automagik', version, enabled, installed: flagInstalled };
}

/** Resolve the active plugin cache root Codex loads from. */
export function activePluginRoot(iso: IsolatedHome, version: string): string {
  const root = join(iso.codexHome, 'plugins', 'cache', 'automagik', 'genie', version);
  if (!existsSync(join(root, 'scripts', 'mcp-launcher.cjs'))) {
    fail(`active plugin launcher missing at ${root}/scripts/mcp-launcher.cjs`);
  }
  return root;
}

// ============================================================================
// Black-box MCP JSON-RPC probe (A1 replacement for proveCodexPluginHealth)
// ============================================================================

interface JsonRpcReply {
  id?: number | string | null;
  result?: unknown;
  error?: { message?: string; code?: number };
}

export interface McpProbeResult {
  initialized: boolean;
  tools: string[];
  wishStatusReadOnly: boolean;
  detail: string;
}

function buildMcpRequestStream(): string {
  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex-smoke', version: '1' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'genie_wish_status', arguments: {} } },
  ];
  return `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`;
}

function indexReplies(stdout: string): Map<number, JsonRpcReply> {
  const byId = new Map<number, JsonRpcReply>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const reply = JSON.parse(trimmed) as JsonRpcReply;
      if (typeof reply.id === 'number') byId.set(reply.id, reply);
    } catch {
      // ignore non-JSON framing noise
    }
  }
  return byId;
}

/**
 * Drive a bounded JSON-RPC session through the installed launcher — the exact
 * `<activePluginRoot>/scripts/mcp-launcher.cjs` that Codex would spawn — and
 * prove `initialize` → `tools/list` (5 Genie tools) → read-only
 * `genie_wish_status` without importing any runtime-integration oracle.
 */
export function probePluginMcp(iso: IsolatedHome, launcherRoot: string): McpProbeResult {
  const launcher = join(launcherRoot, 'scripts', 'mcp-launcher.cjs');
  const cwd = mkdtempSync(join(iso.home, 'mcp-cwd-'));
  try {
    const spawned = Bun.spawnSync(['node', launcher], {
      cwd,
      env: iso.env,
      stdin: Buffer.from(buildMcpRequestStream(), 'utf8'),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    if (spawned.exitedDueToTimeout === true) {
      return { initialized: false, tools: [], wishStatusReadOnly: false, detail: 'bounded MCP session timed out' };
    }
    const byId = indexReplies(spawned.stdout.toString());
    const init = byId.get(1);
    const initialized = init !== undefined && init.error === undefined && isRecord(init.result);
    const listResult = byId.get(2)?.result;
    const tools =
      isRecord(listResult) && Array.isArray(listResult.tools)
        ? listResult.tools
            .map((tool) => (isRecord(tool) && typeof tool.name === 'string' ? tool.name : null))
            .filter((name): name is string => name !== null)
            .sort()
        : [];
    const call = byId.get(3);
    const wishStatusReadOnly = call !== undefined && call.error === undefined && isRecord(call.result);
    return {
      initialized,
      tools,
      wishStatusReadOnly,
      detail: `exit=${spawned.exitCode} stderr=${spawned.stderr.toString().trim().slice(0, 200)}`,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Full black-box health assertion: exactly one enabled target-version plugin + usable MCP. */
export function assertPluginHealthy(iso: IsolatedHome, version: string): void {
  const entry = readCodexGeniePlugin(iso);
  if (!entry.installed || !entry.enabled) fail(`plugin is not installed+enabled: ${JSON.stringify(entry)}`);
  if (entry.version !== version) fail(`plugin version ${entry.version} != expected ${version}`);
  const root = activePluginRoot(iso, version);
  const probe = probePluginMcp(iso, root);
  if (!probe.initialized) fail(`MCP initialize failed: ${probe.detail}`);
  const missing = REQUIRED_GENIE_MCP_TOOLS.filter((tool) => !probe.tools.includes(tool));
  if (missing.length > 0) fail(`MCP tools/list missing ${missing.join(', ')} (got ${probe.tools.join(', ')})`);
  if (!probe.wishStatusReadOnly) fail(`read-only genie_wish_status did not return a result: ${probe.detail}`);
}

// ============================================================================
// Retirement transaction inspection (on-disk contract)
// ============================================================================

export interface RetirementSummary {
  txnIds: string[];
  journalPhase: string | null;
  acceptedCount: number;
  quarantineCount: number;
  evidenceTxns: string[];
}

export function inspectRetirement(skillsDir: string): RetirementSummary {
  const root = join(skillsDir, RETIREMENT_ROOT_NAME);
  const summary: RetirementSummary = {
    txnIds: [],
    journalPhase: null,
    acceptedCount: 0,
    quarantineCount: 0,
    evidenceTxns: [],
  };
  if (!existsSync(root)) return summary;
  const txns = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(RETIREMENT_TXN_PREFIX))
    .map((entry) => entry.name)
    .sort();
  summary.txnIds = txns;
  if (txns.length !== 1) return summary;
  const txnDir = join(root, txns[0]);
  const journal = asRecord(
    JSON.parse(readFileSync(join(txnDir, 'journal.json'), 'utf8')),
    'journal.json is not an object',
  );
  summary.journalPhase = typeof journal.phase === 'string' ? journal.phase : null;
  summary.acceptedCount = Array.isArray(journal.accepted) ? journal.accepted.length : 0;
  const quarantine = join(txnDir, 'quarantine');
  summary.quarantineCount = existsSync(quarantine) ? readdirSync(quarantine).length : 0;
  if (existsSync(join(txnDir, 'evidence')) && readdirSync(join(txnDir, 'evidence')).length > 0) {
    summary.evidenceTxns.push(txns[0]);
  }
  return summary;
}

// ============================================================================
// Doctor JSON parsing (black-box tier report)
// ============================================================================

export interface DoctorCheck {
  name: string;
  status: string;
  detail: string;
  suggestion?: string;
}

export function readDoctorChecks(iso: IsolatedHome): DoctorCheck[] {
  return parseDoctorChecks(runCli(iso, ['doctor', '--json']));
}

/** Delivery-aware doctor through the fixture's crypto-only verification seam. */
export function readLifecycleDoctorChecks(iso: IsolatedHome): DoctorCheck[] {
  return parseDoctorChecks(runLifecycleCli(iso, ['doctor', '--json']));
}

function parseDoctorChecks(result: CliResult): DoctorCheck[] {
  const parsed = asRecord(JSON.parse(result.stdout), 'doctor --json is not an object');
  const checks = parsed.checks;
  if (!Array.isArray(checks)) fail('doctor --json has no checks array');
  return checks.map((raw) => {
    const check = asRecord(raw, 'doctor check is not an object');
    return {
      name: String(check.name),
      status: String(check.status),
      detail: typeof check.detail === 'string' ? check.detail : '',
      suggestion: typeof check.suggestion === 'string' ? check.suggestion : undefined,
    };
  });
}

export function findCheck(checks: DoctorCheck[], name: string): DoctorCheck | undefined {
  return checks.find((check) => check.name === name);
}
