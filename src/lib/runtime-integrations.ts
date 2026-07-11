import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { acquireLifecycleLease } from './agent-sync.js';
import { getCodexConfigPath, getCodexHome, migrateDeadGenieOtel } from './codex-config.js';
import { resolveClaudeDir, resolveGenieHome } from './genie-home.js';
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

export interface RuntimePluginState {
  installed: boolean;
  enabled?: boolean;
  version?: string;
}

export type RuntimePluginStateParseResult = { ok: true; state: RuntimePluginState } | { ok: false; detail: string };

const SAFE_PLUGIN_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;

function validateInstalledPluginEntry(
  runtime: 'Codex' | 'Claude',
  plugin: Record<string, unknown>,
): RuntimePluginStateParseResult {
  if (typeof plugin.enabled !== 'boolean') {
    return { ok: false, detail: `${runtime} plugin list returned malformed JSON (enabled must be boolean)` };
  }
  if (typeof plugin.version !== 'string' || !SAFE_PLUGIN_VERSION_RE.test(plugin.version)) {
    return {
      ok: false,
      detail: `${runtime} plugin list returned malformed JSON (version must be a safe non-empty string)`,
    };
  }
  return { ok: true, state: { installed: true, enabled: plugin.enabled, version: plugin.version } };
}

export function parseCodexPluginState(raw: string): RuntimePluginStateParseResult {
  const payload = jsonPayload(raw);
  if (typeof payload !== 'object' || payload === null || !Array.isArray(Reflect.get(payload, 'installed'))) {
    return { ok: false, detail: 'Codex plugin list returned malformed JSON (expected an installed array)' };
  }
  const plugins = (Reflect.get(payload, 'installed') as unknown[]).filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && Reflect.get(entry, 'pluginId') === 'genie@automagik',
  );
  if (plugins.length > 1) {
    return { ok: false, detail: 'Codex plugin list returned malformed JSON (duplicate Genie entries)' };
  }
  const plugin = plugins[0];
  return plugin ? validateInstalledPluginEntry('Codex', plugin) : { ok: true, state: { installed: false } };
}

export function parseClaudePluginState(raw: string): RuntimePluginStateParseResult {
  const payload = jsonPayload(raw);
  if (!Array.isArray(payload)) {
    return { ok: false, detail: 'Claude plugin list returned malformed JSON (expected an array)' };
  }
  const plugins = (payload as unknown[]).filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && Reflect.get(entry, 'id') === 'genie@automagik',
  );
  if (plugins.length > 1) {
    return { ok: false, detail: 'Claude plugin list returned malformed JSON (duplicate Genie entries)' };
  }
  const plugin = plugins[0];
  return plugin ? validateInstalledPluginEntry('Claude', plugin) : { ok: true, state: { installed: false } };
}

/** Compatibility parser for read-only callers that treat invalid output as unavailable. */
export function codexPluginState(raw: string): RuntimePluginState {
  const parsed = parseCodexPluginState(raw);
  return parsed.ok ? parsed.state : { installed: false };
}

/** Compatibility parser for read-only callers that treat invalid output as unavailable. */
export function claudePluginState(raw: string): RuntimePluginState {
  const parsed = parseClaudePluginState(raw);
  return parsed.ok ? parsed.state : { installed: false };
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
  /** Exact known prior Genie payloads adopted through backup-first migration. */
  adoptedLegacy?: string[];
}

export interface CodexAgentTransactionOptions {
  /** Failure-injection seam invoked immediately before each live promotion. */
  beforePromotion?: (stage: string) => void;
}

interface CodexAgentTransactionJournal {
  version: 1;
  operations: Array<{ name: string; nextDigest: string | null; hadTarget: boolean }>;
  inventoryDigest: string | null;
  inventoryHadTarget: boolean;
}

const CODEX_AGENT_TRANSACTION_PREFIX = '.genie-role-agents.txn-';
const LEGACY_CODEX_AGENT_DIGESTS: Readonly<Record<string, readonly string[]>> = {
  'genie-engineer-complex.toml': ['62ecc570f1d77783511a9e7f0aa67b3a65d8bba292963409a02c7712c93ebc3b'],
  'genie-engineer-standard.toml': ['dc746813b9b4b6aa984c17fa2fd75d4dbe34eba08494a174c0715da07aa9dd30'],
  'genie-engineer-trivial.toml': ['249deced5a02eb2cbe3303db566992d1336c75d853967f851bf1d0e85b6b0f47'],
  'genie-final-gate.toml': ['10ef070db8aace75bd80ef9e060a6ec601e3768f177fdd843f4db11035738f7e'],
  'genie-fixer.toml': ['b3c1f407d4a3a2cfe204dee7b4a9c038e1a8f4644c446fcfa23f4a681bf0c7b3'],
  'genie-reviewer.toml': ['91f40a07905834716311419375581e3245544a77eac3d93d082842652c6452bf'],
  'genie-scout.toml': ['03a9fb3ca0e5f36c69c8f934d37adce1bae736e4c3895b144a0001ad31b1ba59'],
};

function digestBytes(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function readRoleTransactionJournal(path: string): CodexAgentTransactionJournal {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CodexAgentTransactionJournal>;
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.operations) ||
    parsed.operations.some(
      (op) =>
        typeof op !== 'object' ||
        op === null ||
        !CODEX_AGENT_NAME_RE.test((op as { name?: string }).name ?? '') ||
        typeof (op as { hadTarget?: unknown }).hadTarget !== 'boolean' ||
        ((op as { nextDigest?: unknown }).nextDigest !== null &&
          !/^[a-f0-9]{64}$/.test(String((op as { nextDigest?: unknown }).nextDigest))),
    ) ||
    (parsed.inventoryDigest !== null && !/^[a-f0-9]{64}$/.test(String(parsed.inventoryDigest))) ||
    typeof parsed.inventoryHadTarget !== 'boolean'
  ) {
    throw new Error(`invalid role-agent transaction journal: ${path}`);
  }
  return parsed as CodexAgentTransactionJournal;
}

function rollbackRoleTransaction(
  agentsDir: string,
  transactionDir: string,
  journal: CodexAgentTransactionJournal,
): void {
  const beforeDir = join(transactionDir, 'before');
  for (const operation of journal.operations) {
    const target = join(agentsDir, operation.name);
    const before = join(beforeDir, operation.name);
    if (pathExists(before)) {
      if (pathExists(target)) {
        if (operation.nextDigest === null || fileDigest(target) !== operation.nextDigest) {
          throw new Error(`role-agent transaction target changed during recovery: ${target}`);
        }
        rmSync(target, { recursive: true, force: true });
      }
      renameSync(before, target);
    } else if (!operation.hadTarget && pathExists(target)) {
      if (operation.nextDigest === null || fileDigest(target) !== operation.nextDigest) {
        throw new Error(`role-agent transaction target changed during recovery: ${target}`);
      }
      rmSync(target, { recursive: true, force: true });
    } else if (operation.hadTarget && !pathExists(target)) {
      throw new Error(`role-agent transaction lost its prior target during recovery: ${target}`);
    }
  }
  const targetInventory = join(agentsDir, CODEX_AGENT_INVENTORY_NAME);
  const beforeInventory = join(beforeDir, CODEX_AGENT_INVENTORY_NAME);
  if (pathExists(beforeInventory)) {
    if (pathExists(targetInventory)) {
      if (journal.inventoryDigest === null || fileDigest(targetInventory) !== journal.inventoryDigest) {
        throw new Error(`role-agent inventory changed during recovery: ${targetInventory}`);
      }
      rmSync(targetInventory, { force: true });
    }
    renameSync(beforeInventory, targetInventory);
  } else if (!journal.inventoryHadTarget && pathExists(targetInventory)) {
    if (journal.inventoryDigest === null || fileDigest(targetInventory) !== journal.inventoryDigest) {
      throw new Error(`role-agent inventory changed during recovery: ${targetInventory}`);
    }
    rmSync(targetInventory, { force: true });
  } else if (journal.inventoryHadTarget && !pathExists(targetInventory)) {
    throw new Error(`role-agent transaction lost its prior inventory during recovery: ${targetInventory}`);
  }
  rmSync(transactionDir, { recursive: true, force: true });
}

function recoverRoleAgentTransactions(agentsDir: string): void {
  if (!pathExists(agentsDir)) return;
  for (const name of readdirSync(agentsDir).filter((entry) => entry.startsWith(CODEX_AGENT_TRANSACTION_PREFIX))) {
    const transactionDir = join(agentsDir, name);
    const journal = readRoleTransactionJournal(join(transactionDir, 'journal.json'));
    if (pathExists(join(transactionDir, 'COMMITTED'))) {
      const coherent =
        journal.operations.every((operation) => {
          const target = join(agentsDir, operation.name);
          return operation.nextDigest === null ? !pathExists(target) : fileDigest(target) === operation.nextDigest;
        }) &&
        (journal.inventoryDigest === null
          ? !pathExists(join(agentsDir, CODEX_AGENT_INVENTORY_NAME))
          : fileDigest(join(agentsDir, CODEX_AGENT_INVENTORY_NAME)) === journal.inventoryDigest);
      if (!coherent) throw new Error(`committed role-agent transaction is inconsistent: ${transactionDir}`);
      rmSync(transactionDir, { recursive: true, force: true });
      continue;
    }
    rollbackRoleTransaction(agentsDir, transactionDir, journal);
  }
}

function backupLegacyRoleAgent(codexHome: string, name: string, source: string): void {
  const root = join(dirname(resolve(codexHome)), '.genie-recovery', 'role-agent-bootstrap');
  mkdirSync(root, { recursive: true });
  const destination = join(root, `${name}.${fileDigest(source)}`);
  if (!pathExists(destination)) copyFileSync(source, destination);
}

function publishRoleAgentTransaction(
  agentsDir: string,
  writes: Map<string, Buffer>,
  removals: string[],
  inventory: CodexAgentInventory,
  options: CodexAgentTransactionOptions,
): void {
  const operations = [
    ...[...writes].map(([name, content]) => ({
      name,
      nextDigest: digestBytes(content),
      hadTarget: pathExists(join(agentsDir, name)),
    })),
    ...removals.map((name) => ({ name, nextDigest: null, hadTarget: pathExists(join(agentsDir, name)) })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const inventoryContent =
    Object.keys(inventory.files).length === 0 ? null : Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`);
  const journal: CodexAgentTransactionJournal = {
    version: 1,
    operations,
    inventoryDigest: inventoryContent === null ? null : digestBytes(inventoryContent),
    inventoryHadTarget: pathExists(join(agentsDir, CODEX_AGENT_INVENTORY_NAME)),
  };
  const transactionDir = join(
    agentsDir,
    `${CODEX_AGENT_TRANSACTION_PREFIX}${process.pid}-${Date.now()}-${randomTransactionSuffix()}`,
  );
  const stagedDir = join(transactionDir, 'staged');
  const beforeDir = join(transactionDir, 'before');
  mkdirSync(stagedDir, { recursive: true });
  mkdirSync(beforeDir, { recursive: true });
  for (const [name, content] of writes) writeFileSync(join(stagedDir, name), content);
  if (inventoryContent !== null) writeFileSync(join(stagedDir, CODEX_AGENT_INVENTORY_NAME), inventoryContent);
  writeFileSync(join(transactionDir, 'journal.json'), `${JSON.stringify(journal, null, 2)}\n`);

  try {
    for (const operation of operations) {
      options.beforePromotion?.(`payload:${operation.name}`);
      const target = join(agentsDir, operation.name);
      if (pathExists(target)) renameSync(target, join(beforeDir, operation.name));
      if (operation.nextDigest !== null) renameSync(join(stagedDir, operation.name), target);
    }
    options.beforePromotion?.('inventory');
    const targetInventory = join(agentsDir, CODEX_AGENT_INVENTORY_NAME);
    if (pathExists(targetInventory)) renameSync(targetInventory, join(beforeDir, CODEX_AGENT_INVENTORY_NAME));
    if (inventoryContent !== null) renameSync(join(stagedDir, CODEX_AGENT_INVENTORY_NAME), targetInventory);
    writeFileSync(join(transactionDir, 'COMMITTED'), 'ok\n');
    rmSync(transactionDir, { recursive: true, force: true });
  } catch (error) {
    try {
      rollbackRoleTransaction(agentsDir, transactionDir, journal);
    } catch (rollbackError) {
      throw new Error(
        `role-agent transaction failed (${error instanceof Error ? error.message : String(error)}); rollback failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}); retry after reviewing ${transactionDir}`,
      );
    }
    throw error;
  }
}

function randomTransactionSuffix(): string {
  return createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12);
}

export function installCodexAgents(
  bundleRoot: string,
  codexHome = getCodexHome(),
  transactionOptions: CodexAgentTransactionOptions = {},
): CodexAgentInstallResult {
  const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents');
  if (!existsSync(source)) throw new Error(`Codex agents are missing from bundle: ${source}`);
  const target = join(codexHome, 'agents');
  mkdirSync(target, { recursive: true });
  recoverRoleAgentTransactions(target);
  const state = readCodexAgentInventory(codexHome);
  if (state.status === 'corrupt') {
    throw new Error(
      `Codex role-agent ownership inventory is corrupt (${inventoryPath(codexHome)}): ${state.error}; review and move it aside before retrying`,
    );
  }
  const inventory: CodexAgentInventory = JSON.parse(JSON.stringify(state.inventory)) as CodexAgentInventory;
  const result: CodexAgentInstallResult = {
    installed: 0,
    skippedUserOwned: [],
    keptModified: [],
    removed: [],
    backedUp: [],
  };
  const writes = new Map<string, Buffer>();
  const removals: string[] = [];
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
    let ownership = classifyCodexAgentFile(targetPath, inventory.files[name]);
    if (ownership === 'user-owned') {
      const targetDigest = fileDigest(targetPath);
      const legacyDigests = new Set([sourceDigest, ...(LEGACY_CODEX_AGENT_DIGESTS[name] ?? [])]);
      if (targetDigest !== null && legacyDigests.has(targetDigest)) {
        backupLegacyRoleAgent(codexHome, name, targetPath);
        result.adoptedLegacy ??= [];
        result.adoptedLegacy.push(name);
        ownership = 'managed-clean';
      } else {
        result.skippedUserOwned.push(name);
        continue;
      }
    }
    if (ownership === 'managed-modified') {
      result.keptModified.push(name);
      continue;
    }
    if (ownership === 'absent' || inventory.files[name]?.digest !== sourceDigest) {
      writes.set(name, sourceContent);
    }
    inventory.files[name] = { digest: sourceDigest };
    result.installed += 1;
  }
  for (const name of Object.keys(inventory.files)) {
    if (sourceNames.includes(name)) continue;
    const targetPath = join(target, name);
    const ownership = classifyCodexAgentFile(targetPath, inventory.files[name]);
    if (ownership === 'managed-clean') {
      removals.push(name);
      result.removed.push(name);
    } else if (ownership === 'managed-modified') {
      result.keptModified.push(name);
    }
    delete inventory.files[name];
  }
  const currentInventory = readCodexAgentInventory(codexHome).inventory;
  if (writes.size > 0 || removals.length > 0 || JSON.stringify(currentInventory) !== JSON.stringify(inventory)) {
    publishRoleAgentTransaction(target, writes, removals, inventory, transactionOptions);
  }
  return result;
}

export interface CodexEnabledMutationResult {
  ok: boolean;
  detail: string;
}

/** Restore explicit Codex consent with a backup-first, same-directory atomic replacement. */
export function setCodexPluginEnabled(enabled: boolean, configPath = getCodexConfigPath()): CodexEnabledMutationResult {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(configPath);
  } catch {
    return { ok: false, detail: `Codex config is missing; cannot restore plugin enabled=${enabled}: ${configPath}` };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { ok: false, detail: `Codex config is not a physical file: ${configPath}` };
  }
  try {
    const content = readFileSync(configPath, 'utf8');
    const header = '[plugins."genie@automagik"]';
    const occurrences = content.split(header).length - 1;
    if (occurrences !== 1) {
      return {
        ok: false,
        detail: `Codex config must contain exactly one ${header} section; found ${occurrences}`,
      };
    }
    const at = content.indexOf(header);
    const next = content.indexOf('\n[', at + header.length);
    const end = next < 0 ? content.length : next + 1;
    const section = content.slice(at, end);
    const replacement = /(^|\n)enabled\s*=\s*(true|false)/.test(section)
      ? section.replace(/(^|\n)enabled\s*=\s*(true|false)/, `$1enabled = ${enabled}`)
      : section.replace(header, `${header}\nenabled = ${enabled}`);
    const nextContent = `${content.slice(0, at)}${replacement}${content.slice(end)}`;
    const backup = `${configPath}.genie-refresh-backup`;
    const staging = `${configPath}.genie-refresh-staging-${process.pid}`;
    copyFileSync(configPath, backup);
    writeFileSync(staging, nextContent, { encoding: 'utf8', mode: stat.mode & 0o777 });
    chmodSync(staging, stat.mode & 0o777);
    renameSync(staging, configPath);
    rmSync(backup, { force: true });
    return { ok: true, detail: `Codex plugin enabled=${enabled}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
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
  /** Durable refresh intent root. Production defaults to GENIE_HOME. */
  stateDir?: string;
  /** Lifecycle lease identity. Always GENIE_HOME, never a source bundle root. */
  genieHome?: string;
  /** Deterministic test seam; production verifies the installed cache bytes. */
  verifyCodexPayload?: CodexPayloadVerifier;
}

export function installRuntimeIntegrations(options: InstallIntegrationsOptions = {}): IntegrationResult[] {
  const selection = options.selection ?? 'auto';
  if (selection === 'none') return [];
  const runner = options.runner ?? defaultRunner;
  const bundleRoot = resolveBundleRoot(options.bundleRoot);
  const genieHome = options.genieHome ?? resolveGenieHome();
  const lifecycleLease = acquireLifecycleLease(genieHome);
  if ('skipped' in lifecycleLease) {
    return [{ runtime: selection === 'claude' ? 'claude' : 'codex', ok: false, detail: lifecycleLease.skipped }];
  }
  try {
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
          ? installCodexIntegration(
              runner,
              bundleRoot,
              options.codexHome,
              options.timeoutMs,
              options.stateDir ?? genieHome,
              options.verifyCodexPayload,
            )
          : installClaudeIntegration(runner, bundleRoot, options.timeoutMs, options.stateDir ?? genieHome);
      } catch (error) {
        return {
          runtime,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          timedOut: error instanceof IntegrationCommandError && error.timedOut,
        };
      }
    });
  } finally {
    lifecycleLease.release();
  }
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

function requireCodexPluginState(raw: string, phase: string): RuntimePluginState {
  const parsed = parseCodexPluginState(raw);
  if (!parsed.ok) throw new IntegrationCommandError(`${parsed.detail} ${phase}`);
  return parsed.state;
}

interface RefreshIntent {
  schemaVersion: 1;
  runtime: RuntimeName;
  installed: true;
  enabled: boolean;
  createdAt: string;
}

export interface ConvergePluginOptions {
  runner: CommandRunner;
  bundleRoot: string;
  expectedVersion: string;
  /** Explicit install/setup may create an absent registration; update may not. */
  installIfAbsent: boolean;
  statePath: string;
  timeoutMs?: number;
  configPath?: string;
  codexHome?: string;
  verifyCodexPayload?: CodexPayloadVerifier;
}

export interface CodexPayloadVerificationInput {
  bundleRoot: string;
  codexHome: string;
  expectedVersion: string;
}

export type CodexPayloadVerifier = (input: CodexPayloadVerificationInput) => void;

/**
 * Bind a reported Codex version to the physical plugin bytes installed from
 * the canonical bundle. Version equality alone cannot distinguish a cache
 * populated from an obsolete or hostile marketplace source.
 */
export function verifyCodexPhysicalPayload(input: CodexPayloadVerificationInput): void {
  const source = join(input.bundleRoot, 'plugins', 'genie');
  const installed = join(input.codexHome, 'plugins', 'cache', 'automagik', 'genie', input.expectedVersion);
  let sourceDigest: string;
  let installedDigest: string;
  try {
    sourceDigest = fingerprintPhysicalPluginTree(source);
  } catch (error) {
    throw new IntegrationCommandError(
      `canonical Codex plugin payload is unreadable at ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    installedDigest = fingerprintPhysicalPluginTree(installed);
  } catch (error) {
    throw new IntegrationCommandError(
      `installed Codex plugin payload is unreadable at ${installed}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (installedDigest !== sourceDigest) {
    throw new IntegrationCommandError(
      `installed Codex plugin payload identity mismatch at ${installed} (expected canonical source ${source})`,
    );
  }
}

function fingerprintPhysicalPluginTree(root: string): string {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('root is not a physical directory');
  }
  const entries: Array<{ path: string; kind: 'directory' | 'file'; executable: boolean; digest?: string }> = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.orphaned_at') continue;
      const absolute = join(current, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`payload contains a symlink: ${absolute}`);
      const path = relative(root, absolute);
      if (stat.isDirectory()) {
        entries.push({ path, kind: 'directory', executable: false });
        visit(absolute);
      } else if (stat.isFile()) {
        entries.push({
          path,
          kind: 'file',
          executable: (stat.mode & 0o111) !== 0,
          digest: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
        });
      } else {
        throw new Error(`payload contains an unsupported entry: ${absolute}`);
      }
    }
  };
  visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const digest = createHash('sha256');
  for (const entry of entries) {
    digest.update(`${entry.kind}\0${entry.path}\0${entry.executable ? 'x' : '-'}\0${entry.digest ?? ''}\0`);
  }
  return digest.digest('hex');
}

function readRefreshIntent(path: string, runtime: RuntimeName): RefreshIntent | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`refresh intent is not a physical file: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`refresh intent is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Reflect.get(parsed, 'schemaVersion') !== 1 ||
    Reflect.get(parsed, 'runtime') !== runtime ||
    Reflect.get(parsed, 'installed') !== true ||
    typeof Reflect.get(parsed, 'enabled') !== 'boolean' ||
    typeof Reflect.get(parsed, 'createdAt') !== 'string'
  ) {
    throw new Error(`refresh intent has an invalid schema: ${path}`);
  }
  return parsed as RefreshIntent;
}

function writeRefreshIntent(path: string, intent: RefreshIntent): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.staging-${process.pid}`;
  writeFileSync(staging, `${JSON.stringify(intent, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(staging, path);
}

function clearRefreshIntent(path: string): void {
  rmSync(path, { force: true });
}

function integrationFailure(runtime: RuntimeName, error: unknown): IntegrationResult {
  return {
    runtime,
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
    timedOut: error instanceof IntegrationCommandError && error.timedOut,
  };
}

function requireExpectedState(
  runtime: RuntimeName,
  state: RuntimePluginState,
  expectedVersion: string,
  expectedEnabled: boolean,
  phase: string,
): void {
  if (!state.installed || state.version !== expectedVersion || state.enabled !== expectedEnabled) {
    throw new IntegrationCommandError(
      `${runtime} ${phase} verification failed (installed=${state.installed}, enabled=${String(state.enabled)}, version=${state.version || 'missing'}; expected ${expectedEnabled ? 'enabled' : 'disabled'} v${expectedVersion})`,
    );
  }
}

function convergeCodexPayloadIdentity(
  options: ConvergePluginOptions,
  installed: RuntimePluginState,
  timeoutMs: number,
): RuntimePluginState {
  const verifyPayload = options.verifyCodexPayload ?? verifyCodexPhysicalPayload;
  const verificationInput = {
    bundleRoot: options.bundleRoot,
    codexHome: options.codexHome ?? getCodexHome(),
    expectedVersion: options.expectedVersion,
  };
  try {
    verifyPayload(verificationInput);
    return installed;
  } catch (firstVerificationError) {
    // Same-version caches can still originate from the wrong marketplace.
    // Force one canonical source re-registration and reinstall, then require
    // physical identity again before clearing the durable intent.
    runChecked(options.runner, 'codex', ['plugin', 'remove', 'genie@automagik', '--json'], true, timeoutMs);
    runChecked(options.runner, 'codex', ['plugin', 'marketplace', 'remove', 'automagik', '--json'], true, timeoutMs);
    addCodexMarketplace(options.runner, options.bundleRoot, timeoutMs);
    runChecked(options.runner, 'codex', ['plugin', 'add', 'genie@automagik', '--json'], false, timeoutMs);
    const repaired = requireCodexPluginState(
      runChecked(options.runner, 'codex', ['plugin', 'list', '--json'], false, timeoutMs).stdout,
      'after payload-identity reinstall',
    );
    if (!repaired.installed || repaired.version !== options.expectedVersion) {
      throw new IntegrationCommandError(
        `Codex payload-identity repair did not restore v${options.expectedVersion}: installed=${repaired.installed}, version=${repaired.version || 'missing'}`,
      );
    }
    try {
      verifyPayload(verificationInput);
      return repaired;
    } catch (finalVerificationError) {
      throw new IntegrationCommandError(
        `Codex plugin payload identity did not converge after canonical reinstall: ${finalVerificationError instanceof Error ? finalVerificationError.message : String(finalVerificationError)}; initial verification: ${firstVerificationError instanceof Error ? firstVerificationError.message : String(firstVerificationError)}`,
      );
    }
  }
}

/**
 * One Codex plugin convergence state machine for install/setup/update. The
 * durable intent preserves both installation consent and disabled consent
 * across a process crash or a failed remove/re-add.
 */
export function convergeCodexPlugin(options: ConvergePluginOptions): IntegrationResult | null {
  const timeoutMs = options.timeoutMs ?? INTEGRATION_TIMEOUT_MS;
  let intent: RefreshIntent | null = null;
  let primaryError: unknown;
  try {
    intent = readRefreshIntent(options.statePath, 'codex');
    const before = requireCodexPluginState(
      runChecked(options.runner, 'codex', ['plugin', 'list', '--json'], false, timeoutMs).stdout,
      'before plugin convergence',
    );
    if (!before.installed && intent === null && !options.installIfAbsent) return null;
    intent ??= {
      schemaVersion: 1,
      runtime: 'codex',
      installed: true,
      enabled: before.installed ? before.enabled === true : true,
      createdAt: new Date().toISOString(),
    };
    writeRefreshIntent(options.statePath, intent);

    addCodexMarketplace(options.runner, options.bundleRoot, timeoutMs);
    runChecked(options.runner, 'codex', ['plugin', 'add', 'genie@automagik', '--json'], false, timeoutMs);
    let installed = requireCodexPluginState(
      runChecked(options.runner, 'codex', ['plugin', 'list', '--json'], false, timeoutMs).stdout,
      'after plugin add',
    );
    if (!installed.installed) throw new IntegrationCommandError('Codex plugin is missing after plugin add');
    if (installed.installed && installed.version !== options.expectedVersion) {
      runChecked(options.runner, 'codex', ['plugin', 'remove', 'genie@automagik', '--json'], true, timeoutMs);
      runChecked(options.runner, 'codex', ['plugin', 'add', 'genie@automagik', '--json'], false, timeoutMs);
      installed = requireCodexPluginState(
        runChecked(options.runner, 'codex', ['plugin', 'list', '--json'], false, timeoutMs).stdout,
        'after plugin reinstall',
      );
      if (!installed.installed) throw new IntegrationCommandError('Codex plugin is missing after plugin reinstall');
    }
    if (!installed.installed || installed.version !== options.expectedVersion) {
      throw new IntegrationCommandError(
        `codex plugin stuck at v${installed.version || 'missing'} (expected v${options.expectedVersion}) — marketplace root may be stale`,
      );
    }
    installed = convergeCodexPayloadIdentity(options, installed, timeoutMs);
    if (intent.enabled) {
      requireExpectedState('codex', installed, options.expectedVersion, true, 'enabled-state');
    }
  } catch (error) {
    primaryError = error;
  }

  if (intent?.enabled === false) {
    try {
      const restored = setCodexPluginEnabled(false, options.configPath ?? getCodexConfigPath());
      if (!restored.ok) throw new IntegrationCommandError(restored.detail);
      const state = requireCodexPluginState(
        runChecked(options.runner, 'codex', ['plugin', 'list', '--json'], false, timeoutMs).stdout,
        'after restoring disabled state',
      );
      requireExpectedState('codex', state, options.expectedVersion, false, 'disabled-state restore');
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError !== undefined) return integrationFailure('codex', primaryError);
  clearRefreshIntent(options.statePath);
  return {
    runtime: 'codex',
    ok: true,
    detail: `plugin/hooks refreshed to v${options.expectedVersion}`,
    preservedDisabled: intent?.enabled === false,
  };
}

function requireClaudePluginState(raw: string, phase: string): RuntimePluginState {
  const parsed = parseClaudePluginState(raw);
  if (!parsed.ok) throw new IntegrationCommandError(`${parsed.detail} ${phase}`);
  return parsed.state;
}

/** Durable Claude convergence with disabled-state restoration in all mutation outcomes. */
export function convergeClaudePlugin(options: ConvergePluginOptions): IntegrationResult | null {
  const timeoutMs = options.timeoutMs ?? INTEGRATION_TIMEOUT_MS;
  let intent: RefreshIntent | null = null;
  let primaryError: unknown;
  try {
    intent = readRefreshIntent(options.statePath, 'claude');
    const before = requireClaudePluginState(
      runChecked(options.runner, 'claude', ['plugin', 'list', '--json'], false, timeoutMs).stdout,
      'before plugin convergence',
    );
    if (!before.installed && intent === null && !options.installIfAbsent) return null;
    intent ??= {
      schemaVersion: 1,
      runtime: 'claude',
      installed: true,
      enabled: before.installed ? before.enabled === true : true,
      createdAt: new Date().toISOString(),
    };
    writeRefreshIntent(options.statePath, intent);

    runChecked(options.runner, 'claude', ['plugin', 'marketplace', 'add', options.bundleRoot], true, timeoutMs);
    runChecked(
      options.runner,
      'claude',
      ['plugin', before.installed ? 'update' : 'install', 'genie@automagik'],
      false,
      timeoutMs,
    );
    const installed = requireClaudePluginState(
      runChecked(options.runner, 'claude', ['plugin', 'list', '--json'], false, timeoutMs).stdout,
      'after plugin refresh',
    );
    if (!installed.installed || installed.version !== options.expectedVersion) {
      throw new IntegrationCommandError(
        `Claude plugin refresh reported v${installed.version || 'missing'}; expected v${options.expectedVersion}`,
      );
    }
    if (intent.enabled) requireExpectedState('claude', installed, options.expectedVersion, true, 'enabled-state');
  } catch (error) {
    primaryError = error;
  }

  if (intent?.enabled === false) {
    try {
      runChecked(options.runner, 'claude', ['plugin', 'disable', 'genie@automagik'], false, timeoutMs);
      const restored = requireClaudePluginState(
        runChecked(options.runner, 'claude', ['plugin', 'list', '--json'], false, timeoutMs).stdout,
        'after restoring disabled state',
      );
      requireExpectedState('claude', restored, options.expectedVersion, false, 'disabled-state restore');
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError !== undefined) return integrationFailure('claude', primaryError);
  clearRefreshIntent(options.statePath);
  return {
    runtime: 'claude',
    ok: true,
    detail: `plugin/hooks refreshed to v${options.expectedVersion}`,
    preservedDisabled: intent?.enabled === false,
  };
}

function installCodexIntegration(
  runner: CommandRunner,
  bundleRoot: string,
  codexHome?: string,
  timeoutMs = INTEGRATION_TIMEOUT_MS,
  stateDir = resolveGenieHome(),
  verifyCodexPayload?: CodexPayloadVerifier,
): IntegrationResult {
  const configPath = join(codexHome ?? getCodexHome(), 'config.toml');
  const migration = migrateDeadGenieOtel(configPath);
  if (migration.status === 'error') throw new Error(`Codex config migration failed: ${migration.error}`);
  const agents = installCodexAgents(bundleRoot, codexHome);
  const plugin = convergeCodexPlugin({
    runner,
    bundleRoot,
    expectedVersion: VERSION,
    installIfAbsent: true,
    configPath,
    statePath: join(stateDir, '.integration-refresh-codex.json'),
    timeoutMs,
    codexHome,
    verifyCodexPayload,
  });
  if (plugin === null) throw new Error('Codex plugin convergence returned no result for explicit install');
  if (!plugin.ok) throw new IntegrationCommandError(plugin.detail, plugin.timedOut);
  const notes = [`${agents.installed} role agents installed`];
  if (agents.removed.length > 0) notes.push(`removed obsolete: ${agents.removed.join(', ')}`);
  if (agents.keptModified.length > 0) notes.push(`kept modified: ${agents.keptModified.join(', ')}`);
  if (agents.skippedUserOwned.length > 0) notes.push(`kept user-owned: ${agents.skippedUserOwned.join(', ')}`);
  return {
    runtime: 'codex',
    ok: true,
    detail: `plugin refreshed; ${notes.join('; ')}`,
    preservedDisabled: plugin.preservedDisabled,
  };
}

function installClaudeIntegration(
  runner: CommandRunner,
  bundleRoot: string,
  timeoutMs = INTEGRATION_TIMEOUT_MS,
  stateDir = resolveGenieHome(),
): IntegrationResult {
  const plugin = convergeClaudePlugin({
    runner,
    bundleRoot,
    expectedVersion: VERSION,
    installIfAbsent: true,
    statePath: join(stateDir, '.integration-refresh-claude.json'),
    timeoutMs,
  });
  if (plugin === null) throw new Error('Claude plugin convergence returned no result for explicit install');
  if (!plugin.ok) throw new IntegrationCommandError(plugin.detail, plugin.timedOut);
  return plugin;
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
  claudeHome?: string;
  /** Explicit state evidence seam for isolated command tests. */
  installedEvidence?: Partial<Record<RuntimeName, boolean>>;
  timeoutMs?: number;
}

export interface RuntimeIntegrationEvidence {
  codex: boolean;
  claude: boolean;
  errors: Record<RuntimeName, string[]>;
}

function readOwnedJson(
  path: string,
  label: string,
  inspect: (value: unknown) => boolean,
): { owned: boolean; error?: string } {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { owned: false };
    return {
      owned: false,
      error: `${label} is unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { owned: false, error: `${label} is not a physical file: ${path}` };
  }
  try {
    return { owned: inspect(JSON.parse(readFileSync(path, 'utf8'))) };
  } catch (error) {
    return {
      owned: false,
      error: `${label} is unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function inspectClaudeSettings(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('settings root must be an object');
  }
  const enabledPlugins = Reflect.get(value, 'enabledPlugins');
  if (enabledPlugins === undefined) return false;
  if (typeof enabledPlugins !== 'object' || enabledPlugins === null || Array.isArray(enabledPlugins)) {
    throw new Error('enabledPlugins must be an object');
  }
  if (!Object.hasOwn(enabledPlugins, 'genie@automagik')) return false;
  if (typeof Reflect.get(enabledPlugins, 'genie@automagik') !== 'boolean') {
    throw new Error('enabledPlugins["genie@automagik"] must be boolean');
  }
  // Both true and false prove an owned registration that uninstall must clear.
  return true;
}

function registryContainsClaudePlugin(value: unknown): boolean {
  if (value === 'genie@automagik') return true;
  if (Array.isArray(value)) return value.some(registryContainsClaudePlugin);
  if (typeof value !== 'object' || value === null) return false;
  if (Object.hasOwn(value, 'genie@automagik')) return true;
  for (const key of ['id', 'pluginId', 'name']) {
    if (Reflect.get(value, key) === 'genie@automagik') return true;
  }
  return Object.values(value).some(registryContainsClaudePlugin);
}

/** Read-only owned-registration/cache evidence used when a client CLI is unavailable. */
export function inspectRuntimeIntegrationEvidence(
  options: {
    codexHome?: string;
    claudeHome?: string;
  } = {},
): RuntimeIntegrationEvidence {
  const codexHome = options.codexHome ?? getCodexHome();
  const claudeHome = options.claudeHome ?? resolveClaudeDir();
  const errors: Record<RuntimeName, string[]> = { codex: [], claude: [] };
  let codexConfig = '';
  try {
    codexConfig = readFileSync(join(codexHome, 'config.toml'), 'utf8');
  } catch {
    // Cache evidence below remains authoritative when config is absent.
  }
  const settings = readOwnedJson(join(claudeHome, 'settings.json'), 'Claude settings', inspectClaudeSettings);
  if (settings.error) errors.claude.push(settings.error);
  let claudeRegistryEvidence = false;
  for (const registryPath of [
    join(claudeHome, 'installed_plugins.json'),
    join(claudeHome, 'plugins', 'installed_plugins.json'),
  ]) {
    const registry = readOwnedJson(registryPath, 'Claude installed-plugin registry', registryContainsClaudePlugin);
    claudeRegistryEvidence ||= registry.owned;
    if (registry.error) errors.claude.push(registry.error);
  }
  return {
    codex:
      codexConfig.includes('genie@automagik') || pathExists(join(codexHome, 'plugins', 'cache', 'automagik', 'genie')),
    claude:
      settings.owned ||
      claudeRegistryEvidence ||
      pathExists(join(claudeHome, 'plugins', 'cache', 'automagik', 'genie')) ||
      pathExists(join(claudeHome, 'plugins', 'marketplaces', 'automagik', 'plugins', 'genie')),
    errors,
  };
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

function unavailableRemovalStep(
  runtime: RuntimeName,
  ownedEvidence: boolean,
  inspectionErrors: string[],
  removeMarketplace: boolean,
): IntegrationRemovalStep | null {
  if (!ownedEvidence && inspectionErrors.length === 0 && !removeMarketplace) return null;
  const displayName = runtime === 'codex' ? 'Codex' : 'Claude';
  let detail: string;
  if (inspectionErrors.length > 0) {
    detail = `${displayName} CLI unavailable and local plugin state is unreadable, so removal cannot be proven; restore the CLI or repair the state and retry: ${inspectionErrors.join('; ')}`;
  } else if (ownedEvidence) {
    detail = `${displayName} CLI unavailable while Genie registration/cache evidence remains; restore the CLI and retry`;
  } else {
    detail = `${displayName} CLI unavailable; requested marketplace removal could not be verified`;
  }
  return { runtime, operation: 'plugin', ok: false, detail };
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
  const inspectedEvidence = inspectRuntimeIntegrationEvidence({
    codexHome: options.codexHome,
    claudeHome: options.claudeHome,
  });
  const evidence = {
    codex: options.installedEvidence?.codex ?? inspectedEvidence.codex,
    claude: options.installedEvidence?.claude ?? inspectedEvidence.claude,
    errors: inspectedEvidence.errors,
  };
  const agents = removeCodexAgents(options.codexHome);
  const steps: IntegrationRemovalStep[] = [];
  if (detected.codex) {
    steps.push(removalStep(runner, 'codex', 'plugin', ['plugin', 'remove', 'genie@automagik'], timeoutMs));
  }
  if (!detected.codex) {
    const unavailable = unavailableRemovalStep(
      'codex',
      evidence.codex,
      evidence.errors.codex,
      options.removeMarketplace === true,
    );
    if (unavailable) steps.push(unavailable);
  }
  if (detected.claude) {
    steps.push(removalStep(runner, 'claude', 'plugin', ['plugin', 'uninstall', 'genie@automagik'], timeoutMs));
  }
  if (!detected.claude) {
    const unavailable = unavailableRemovalStep(
      'claude',
      evidence.claude,
      evidence.errors.claude,
      options.removeMarketplace === true,
    );
    if (unavailable) steps.push(unavailable);
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
