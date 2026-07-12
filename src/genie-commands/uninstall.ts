/**
 * Genie Uninstall Command
 *
 * Removes Genie CLI entirely:
 * - Remove hook script from ~/.claude/hooks
 * - Delete ~/.genie directory
 * - Remove symlinks from ~/.local/bin
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type Dirent,
  type Stats,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { z } from 'zod';
import {
  acquireLifecycleLease,
  codexLegacyCuratedDir,
  inspectManagedSkillTree,
  inspectManagedWorkflow,
  recoverManagedSkillTransactions,
  recoverManagedWorkflowTransactions,
  removeManagedSkillTree,
  removeManagedWorkflow,
  resolveAgentsSkillsDir,
} from '../lib/agent-sync.js';
import { hookScriptExists } from '../lib/claude-settings.js';
import { contractPath, getGenieDir } from '../lib/genie-config.js';
import { resolveClaudeDir, resolveCodexDir, resolveGenieHome, resolveHermesHome } from '../lib/genie-home.js';
import {
  inspectCodexAgentOwnership,
  inspectRuntimeIntegrationEvidence,
  recoverCodexAgentTransactions,
  removeRuntimeIntegrations,
  resolveRuntimeExecutable,
} from '../lib/runtime-integrations.js';
import { detectV4Install } from './legacy-v4.js';

const LOCAL_BIN = join(homedir(), '.local', 'bin');

// Symlinks that may have been created by source install
const SYMLINKS = ['genie', 'term'] as const;

export interface PathContainmentApi {
  resolve: (...paths: string[]) => string;
  relative: (from: string, to: string) => string;
  isAbsolute: (path: string) => boolean;
  sep: string;
}

const HOST_PATH_CONTAINMENT_API: PathContainmentApi = { resolve, relative, isAbsolute, sep };

const UNINSTALL_BATCH_MAX_BYTES = 4 * 1024 * 1024;
const SKILL_TRANSACTION_ROOT = '.genie-sync-transactions';
const SKILL_TRANSACTION_PREFIXES = ['.staging-', 'txn-', 'delete-', '.conflict-'];
const SKILL_TRANSACTION_CONFLICT_PREFIX = '.conflict-';
const COUNCIL_TRANSACTION_PREFIXES = ['.council.genie-txn-', '.council.genie-delete-', '.council.genie-conflict-'];
const COUNCIL_TRANSACTION_CONFLICT_PREFIXES = ['.council.genie-delete-conflict-', '.council.genie-conflict-'];
const CODEX_ROLE_TRANSACTION_PREFIXES = ['.genie-role-agents.txn-', '.genie-role-agents.conflict-'];
const CODEX_ROLE_TRANSACTION_CONFLICT_PREFIX = '.genie-role-agents.conflict-';

const absolutePathSchema = z
  .string()
  .max(4096)
  .refine((path) => isAbsolute(path) && resolve(path) === path);
const dispositionSchema = z.enum(['remove', 'keep']);
const uninstallBatchMemberSchema = z.string().regex(/^(asset|rules|runtime|home|symlink):[a-f0-9]{64}$/);
const uninstallBatchProgressSchema = z
  .object({
    active: uninstallBatchMemberSchema.nullable(),
    completed: z.array(uninstallBatchMemberSchema).max(1024),
  })
  .strict();
const uninstallBatchScopeSchema = z
  .object({
    agentAssets: z.array(z.object({ path: absolutePathSchema, disposition: dispositionSchema }).strict()).max(512),
    codexRoleAgents: z
      .array(
        z
          .object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), disposition: dispositionSchema })
          .strict(),
      )
      .max(128),
    codexRoleInventoryStatus: z.enum(['missing', 'valid', 'corrupt']),
    genieHomePresent: z.boolean(),
    ownedRulesPath: absolutePathSchema.nullable(),
    removeMarketplace: z.boolean(),
    runtimeClients: z.object({ codex: z.boolean(), claude: z.boolean() }).strict(),
    runtimePlugins: z.object({ codex: z.boolean(), claude: z.boolean() }).strict(),
    symlinks: z.array(z.enum(['genie', 'term'])).max(2),
  })
  .strict();

export type UninstallBatchScope = z.infer<typeof uninstallBatchScopeSchema>;

const uninstallBatchDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    genieHome: absolutePathSchema,
    scope: uninstallBatchScopeSchema,
    progress: uninstallBatchProgressSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type UninstallBatchDecision = z.infer<typeof uninstallBatchDecisionSchema>;

type UninstallBatchPayload = Omit<UninstallBatchDecision, 'digest'>;

/** Return true only when `candidate` is the same path as `parent` or canonically beneath it. */
export function isSameOrContainedPath(
  parent: string,
  candidate: string,
  pathApi: PathContainmentApi = HOST_PATH_CONTAINMENT_API,
): boolean {
  const relativePath = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(candidate));
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relativePath))
  );
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function fsyncDirectoryBestEffort(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is unavailable on some supported platforms. The file
    // fsync plus exclusive hard-link publication remains the strongest option.
  }
}

function assertPrivateRecoveryObject(path: string, stat: Stats, label: string): void {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(`${label} is not owned by the current user: ${path}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`${label} is group/world-writable: ${path}`);
  }
}

function uninstallBatchPayload(decision: UninstallBatchDecision): UninstallBatchPayload {
  return {
    schemaVersion: decision.schemaVersion,
    genieHome: decision.genieHome,
    scope: decision.scope,
    progress: decision.progress,
  };
}

function uninstallBatchDigest(payload: UninstallBatchPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function assertExactUninstallScope(scope: UninstallBatchScope): void {
  const assetPaths = scope.agentAssets.map((asset) => asset.path);
  if (new Set(assetPaths).size !== assetPaths.length) {
    throw new Error('uninstall batch journal contains duplicate agent-asset paths');
  }
  const roleNames = scope.codexRoleAgents.map((agent) => agent.name);
  if (new Set(roleNames).size !== roleNames.length) {
    throw new Error('uninstall batch journal contains duplicate Codex role-agent names');
  }
  if (new Set(scope.symlinks).size !== scope.symlinks.length) {
    throw new Error('uninstall batch journal contains duplicate symlink names');
  }
}

function assertExactUninstallProgress(
  progress: UninstallBatchDecision['progress'],
  scope?: UninstallBatchScope,
  genieHome?: string,
): void {
  if (new Set(progress.completed).size !== progress.completed.length) {
    throw new Error('uninstall batch journal contains duplicate completion receipts');
  }
  if (progress.active !== null && progress.completed.includes(progress.active)) {
    throw new Error('uninstall batch journal marks one member active and completed');
  }
  if (scope !== undefined) {
    if (genieHome === undefined) throw new Error('uninstall batch progress validation requires its Genie home');
    const allowed = uninstallBatchMembers(scope, genieHome);
    const unexpected = [...progress.completed, ...(progress.active === null ? [] : [progress.active])].filter(
      (member) => !allowed.has(member),
    );
    if (unexpected.length > 0) {
      throw new Error(`uninstall batch journal contains receipts outside its exact scope: ${unexpected.join(', ')}`);
    }
  }
}

function authenticatedUninstallBatch(genieHome: string, scope: UninstallBatchScope): UninstallBatchDecision {
  const parsedScope = uninstallBatchScopeSchema.parse(scope);
  assertExactUninstallScope(parsedScope);
  const payload: UninstallBatchPayload = {
    schemaVersion: 1,
    genieHome: resolve(genieHome),
    scope: parsedScope,
    progress: { active: null, completed: [] },
  };
  return { ...payload, digest: uninstallBatchDigest(payload) };
}

/** Stable sibling-of-GENIE_HOME journal path, disjoint from every removed tree. */
export function uninstallBatchJournalPath(genieHome = getGenieDir()): string {
  const canonicalHome = resolve(genieHome);
  const homeToken = createHash('sha256').update(canonicalHome).digest('hex').slice(0, 16);
  return join(dirname(canonicalHome), '.genie-recovery', `uninstall-batch-${homeToken}.json`);
}

function assertUninstallBatchLocation(genieHome: string, journalPath: string): void {
  const canonicalHome = resolve(genieHome);
  const canonicalJournal = resolve(journalPath);
  if (canonicalJournal !== uninstallBatchJournalPath(canonicalHome)) {
    throw new Error(`uninstall batch journal is outside its canonical recovery path: ${journalPath}`);
  }
  const recoveryRoot = dirname(canonicalJournal);
  const cleanupRoots = [
    canonicalHome,
    join(resolveClaudeDir(), 'skills'),
    join(resolveClaudeDir(), 'workflows'),
    resolveAgentsSkillsDir(),
    codexLegacyCuratedDir(resolveCodexDir()),
    join(resolveCodexDir(), 'agents'),
    join(resolveHermesHome(), 'plugins'),
    LOCAL_BIN,
    join(recoveryRoot, 'uninstall-v4'),
  ];
  if (cleanupRoots.some((root) => isSameOrContainedPath(root, canonicalJournal))) {
    throw new Error(`uninstall batch journal overlaps a cleanup subtree: ${canonicalJournal}`);
  }
}

/** Read-only evidence used by preview so a retained batch remains retryable. */
export function hasPendingUninstallBatch(genieHome = getGenieDir()): boolean {
  try {
    lstatSync(uninstallBatchJournalPath(genieHome));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function validateUninstallBatch(parsed: unknown, genieHome: string, journalPath: string): UninstallBatchDecision {
  const result = uninstallBatchDecisionSchema.safeParse(parsed);
  if (!result.success || result.data.genieHome !== resolve(genieHome)) {
    throw new Error('uninstall batch journal has an invalid schema or target');
  }
  const decision = result.data;
  assertExactUninstallScope(decision.scope);
  assertExactUninstallProgress(decision.progress, decision.scope, decision.genieHome);
  const expected = Buffer.from(uninstallBatchDigest(uninstallBatchPayload(decision)), 'hex');
  const actual = Buffer.from(decision.digest, 'hex');
  if (!timingSafeEqual(actual, expected)) {
    throw new Error(`uninstall batch journal authentication failed: ${journalPath}`);
  }
  return decision;
}

/** Read and authenticate a durable uninstall decision without mutating it. */
export function readUninstallBatchDecision(genieHome = getGenieDir()): UninstallBatchDecision | null {
  const journalPath = uninstallBatchJournalPath(genieHome);
  assertUninstallBatchLocation(genieHome, journalPath);
  const stat = lstatOrNull(journalPath);
  if (stat === null) return null;
  const recoveryStat = lstatOrNull(dirname(journalPath));
  if (recoveryStat === null || !recoveryStat.isDirectory() || recoveryStat.isSymbolicLink()) {
    throw new Error(`uninstall recovery root is not a physical directory: ${dirname(journalPath)}`);
  }
  assertPrivateRecoveryObject(dirname(journalPath), recoveryStat, 'uninstall recovery root');
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > UNINSTALL_BATCH_MAX_BYTES) {
    throw new Error(`uninstall batch journal is not a bounded physical file: ${journalPath}`);
  }
  assertPrivateRecoveryObject(journalPath, stat, 'uninstall batch journal');
  try {
    return validateUninstallBatch(JSON.parse(readFileSync(journalPath, 'utf8')), genieHome, journalPath);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`uninstall batch journal is unreadable: ${journalPath}`);
    throw error;
  }
}

function ensurePhysicalRecoveryRoot(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`uninstall recovery root is not a physical directory: ${path}`);
  }
  assertPrivateRecoveryObject(path, stat, 'uninstall recovery root');
}

/** Publish a complete, fsynced decision without replacing an existing batch. */
export function recordUninstallBatchDecision(genieHome: string, scope: UninstallBatchScope): UninstallBatchDecision {
  const existing = readUninstallBatchDecision(genieHome);
  if (existing !== null) return existing;
  const journalPath = uninstallBatchJournalPath(genieHome);
  const recoveryRoot = dirname(journalPath);
  assertUninstallBatchLocation(genieHome, journalPath);
  ensurePhysicalRecoveryRoot(recoveryRoot);
  const decision = authenticatedUninstallBatch(genieHome, scope);
  const staging = join(recoveryRoot, `.uninstall-batch.prepare-${process.pid}-${randomBytes(8).toString('hex')}`);
  try {
    writeFileSync(staging, `${JSON.stringify(decision, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const fd = openSync(staging, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(staging, journalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const concurrent = readUninstallBatchDecision(genieHome);
        if (concurrent === null) throw new Error('uninstall batch journal publication raced with removal');
        return concurrent;
      }
      throw error;
    }
    fsyncDirectoryBestEffort(recoveryRoot);
    const published = readUninstallBatchDecision(genieHome);
    if (published === null) throw new Error('uninstall batch journal disappeared after publication');
    return published;
  } finally {
    rmSync(staging, { force: true });
    fsyncDirectoryBestEffort(recoveryRoot);
  }
}

export type UninstallBatchMemberKind = 'asset' | 'rules' | 'runtime' | 'home' | 'symlink';

export function uninstallBatchMemberId(kind: UninstallBatchMemberKind, key: string): string {
  return `${kind}:${createHash('sha256').update(key).digest('hex')}`;
}

export function uninstallBatchRuntimeMemberId(scope: UninstallBatchScope): string {
  return uninstallBatchMemberId(
    'runtime',
    JSON.stringify({
      codexRoleAgents: scope.codexRoleAgents,
      codexRoleInventoryStatus: scope.codexRoleInventoryStatus,
      removeMarketplace: scope.removeMarketplace,
      runtimeClients: scope.runtimeClients,
      runtimePlugins: scope.runtimePlugins,
    }),
  );
}

function hasRuntimeIntegrationWork(scope: UninstallBatchScope): boolean {
  return (
    scope.codexRoleInventoryStatus !== 'missing' ||
    scope.codexRoleAgents.length > 0 ||
    scope.runtimePlugins.codex ||
    scope.runtimePlugins.claude ||
    scope.removeMarketplace
  );
}

function uninstallBatchMembers(scope: UninstallBatchScope, genieHome: string): Set<string> {
  const members = new Set(
    scope.agentAssets
      .filter((asset) => asset.disposition === 'remove')
      .map((asset) => uninstallBatchMemberId('asset', asset.path)),
  );
  if (scope.ownedRulesPath !== null) members.add(uninstallBatchMemberId('rules', scope.ownedRulesPath));
  if (hasRuntimeIntegrationWork(scope)) members.add(uninstallBatchRuntimeMemberId(scope));
  if (scope.genieHomePresent) members.add(uninstallBatchMemberId('home', resolve(genieHome)));
  for (const name of scope.symlinks) members.add(uninstallBatchMemberId('symlink', name));
  return members;
}

/** Atomically CAS one authenticated progress generation before or after a member mutation. */
export function updateUninstallBatchProgress(
  genieHome: string,
  expectedDigest: string,
  progress: UninstallBatchDecision['progress'],
): UninstallBatchDecision {
  const current = readUninstallBatchDecision(genieHome);
  if (current === null) throw new Error('uninstall batch journal disappeared during progress update');
  if (current.digest !== expectedDigest) throw new Error('uninstall batch journal changed during progress update');
  const parsedProgress = uninstallBatchProgressSchema.parse(progress);
  assertExactUninstallProgress(parsedProgress, current.scope, current.genieHome);
  const payload: UninstallBatchPayload = { ...uninstallBatchPayload(current), progress: parsedProgress };
  const next: UninstallBatchDecision = { ...payload, digest: uninstallBatchDigest(payload) };
  const journalPath = uninstallBatchJournalPath(genieHome);
  const recoveryRoot = dirname(journalPath);
  const staging = join(recoveryRoot, `.uninstall-batch.progress-${process.pid}-${randomBytes(8).toString('hex')}`);
  try {
    writeFileSync(staging, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const fd = openSync(staging, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(staging, journalPath);
    fsyncDirectoryBestEffort(recoveryRoot);
    const published = readUninstallBatchDecision(genieHome);
    if (published === null || published.digest !== next.digest) {
      throw new Error('uninstall batch progress generation was not published intact');
    }
    return published;
  } finally {
    rmSync(staging, { force: true });
    fsyncDirectoryBestEffort(recoveryRoot);
  }
}

/** Authenticate and remove only the exact completed batch as the final step. */
export function clearUninstallBatchDecision(genieHome: string, expectedDigest: string): void {
  const decision = readUninstallBatchDecision(genieHome);
  if (decision === null) throw new Error('uninstall batch journal disappeared before finalization');
  if (decision.digest !== expectedDigest) throw new Error('uninstall batch journal changed before finalization');
  const journalPath = uninstallBatchJournalPath(genieHome);
  unlinkSync(journalPath);
  fsyncDirectoryBestEffort(dirname(journalPath));
}

/** Prove a named link resolves to the corresponding canonical Genie binary, including dangling links. */
export function isGenieSymlink(path: string, genieDir = getGenieDir()): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) return false;
    const name = path.slice(path.lastIndexOf(sep) + 1);
    if (!SYMLINKS.some((candidate) => candidate === name)) return false;
    const resolvedTarget = resolve(dirname(path), readlinkSync(path));
    return resolvedTarget === resolve(genieDir, 'bin', name);
  } catch {
    return false;
  }
}

/**
 * Remove genie symlinks from ~/.local/bin
 */
export function removeSymlinks(
  localBin = LOCAL_BIN,
  genieDir = getGenieDir(),
  plannedNames: readonly (typeof SYMLINKS)[number][] = SYMLINKS,
): { removed: string[]; failures: Array<{ path: string; detail: string }> } {
  const removed: string[] = [];
  const failures: Array<{ path: string; detail: string }> = [];

  for (const name of plannedNames) {
    const symlinkPath = join(localBin, name);
    if (isGenieSymlink(symlinkPath, genieDir)) {
      try {
        unlinkSync(symlinkPath);
        removed.push(name);
      } catch (error) {
        failures.push({ path: symlinkPath, detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return { removed, failures };
}

// ============================================================================
// agent-sync managed assets (wish agent-sync) — removed only when provably ours
// ============================================================================

export interface AgentSyncRemovalTargets {
  claudeDir?: string;
  codexDir?: string;
  /** Shared `~/.agents/skills` tier codex skills are synced into (detection root stays `codexDir`). */
  agentsSkillsDir?: string;
  hermesHome?: string;
  genieHome?: string;
}

function directoryHasMatchingEntry(path: string, matches: (name: string) => boolean): boolean {
  try {
    return readdirSync(path).some(matches);
  } catch (error) {
    // An existing but unreadable/non-directory transaction root is still work:
    // authoritative recovery will surface the fail-closed error under the lease.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Pure pending-transaction evidence for the pre-confirmation preview. */
export function hasPendingUninstallTransactions(targets: AgentSyncRemovalTargets = {}): boolean {
  const claudeDir = targets.claudeDir ?? resolveClaudeDir();
  const codexDir = targets.codexDir ?? resolveCodexDir();
  const skillParents = [
    join(claudeDir, 'skills'),
    targets.agentsSkillsDir ?? resolveAgentsSkillsDir(),
    codexLegacyCuratedDir(codexDir),
  ];
  if (
    skillParents.some((parent) =>
      directoryHasMatchingEntry(join(parent, SKILL_TRANSACTION_ROOT), (name) =>
        SKILL_TRANSACTION_PREFIXES.some((prefix) => name.startsWith(prefix)),
      ),
    )
  ) {
    return true;
  }
  if (
    directoryHasMatchingEntry(join(claudeDir, 'workflows'), (name) =>
      COUNCIL_TRANSACTION_PREFIXES.some((prefix) => name.startsWith(prefix)),
    )
  ) {
    return true;
  }
  return directoryHasMatchingEntry(join(codexDir, 'agents'), (name) =>
    CODEX_ROLE_TRANSACTION_PREFIXES.some((prefix) => name.startsWith(prefix)),
  );
}

function unresolvedTransactionConflictFailures(claudeDir: string, codexDir: string, agentsSkillsDir: string): string[] {
  const failures: string[] = [];
  for (const root of [join(claudeDir, 'skills'), agentsSkillsDir, codexLegacyCuratedDir(codexDir)]) {
    const transactionRoot = join(root, SKILL_TRANSACTION_ROOT);
    if (directoryHasMatchingEntry(transactionRoot, (name) => name.startsWith(SKILL_TRANSACTION_CONFLICT_PREFIX))) {
      failures.push(`unresolved managed-skill transaction conflict requires review at ${transactionRoot}`);
    }
  }
  const workflows = join(claudeDir, 'workflows');
  if (
    directoryHasMatchingEntry(workflows, (name) =>
      COUNCIL_TRANSACTION_CONFLICT_PREFIXES.some((prefix) => name.startsWith(prefix)),
    )
  ) {
    failures.push(`unresolved council workflow transaction conflict requires review at ${workflows}`);
  }
  const agentsDir = join(codexDir, 'agents');
  if (directoryHasMatchingEntry(agentsDir, (name) => name.startsWith(CODEX_ROLE_TRANSACTION_CONFLICT_PREFIX))) {
    failures.push(`unresolved Codex role-agent transaction conflict requires review at ${agentsDir}`);
  }
  return failures;
}

/**
 * Recover every published external-asset transaction before authoritative
 * ownership enumeration. All roots are attempted so one failure cannot hide a
 * second parked object; any failure blocks the whole uninstall batch.
 */
export function recoverUninstallTransactions(targets: AgentSyncRemovalTargets = {}): void {
  const claudeDir = targets.claudeDir ?? resolveClaudeDir();
  const codexDir = targets.codexDir ?? resolveCodexDir();
  const agentsSkillsDir = targets.agentsSkillsDir ?? resolveAgentsSkillsDir();
  const attempts: Array<{ label: string; path: string; recover: () => void }> = [
    {
      label: 'Claude managed skill',
      path: join(claudeDir, 'skills'),
      recover: () => recoverManagedSkillTransactions(join(claudeDir, 'skills')),
    },
    {
      label: 'shared Codex managed skill',
      path: agentsSkillsDir,
      recover: () => recoverManagedSkillTransactions(agentsSkillsDir),
    },
    {
      label: 'legacy Codex managed skill',
      path: codexLegacyCuratedDir(codexDir),
      recover: () => recoverManagedSkillTransactions(codexLegacyCuratedDir(codexDir)),
    },
    {
      label: 'council workflow',
      path: join(claudeDir, 'workflows'),
      recover: () => recoverManagedWorkflowTransactions(join(claudeDir, 'workflows')),
    },
    {
      label: 'Codex role-agent',
      path: join(codexDir, 'agents'),
      recover: () => recoverCodexAgentTransactions(codexDir),
    },
  ];
  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      attempt.recover();
    } catch (error) {
      failures.push(
        `pending ${attempt.label} transaction could not be recovered at ${attempt.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  failures.push(...unresolvedTransactionConflictFailures(claudeDir, codexDir, agentsSkillsDir));
  if (failures.length > 0) throw new Error(failures.join('; '));
}

/** Legacy suffix used by older uninstalls; those relinquished dirs remain invisible. */
const LEGACY_KEPT_MARKER = '.genie-kept';

interface AgentSyncAsset {
  agent: 'claude' | 'codex' | 'hermes';
  kind: 'skill' | 'workflow' | 'link';
  path: string;
  /** True when content diverged or ownership metadata is corrupt; uninstall preserves it. */
  modified?: boolean;
  /** Workflow-only digest ownership sidecar removed together with a clean target. */
  metadataPath?: string;
}

/**
 * Classify a skill dir against the agent-sync ownership contract:
 * - `null` — no genie-agent-sync manifest → not ours, invisible to uninstall.
 * - `'clean'` — manifest present AND `computeDirDigest(dir)` matches its digest → provably shipped by genie.
 * - `'modified'` — manifest present but content diverged (or digest missing/uncomputable) → user data lives here.
 */
function classifyManagedSkillDir(dir: string): 'clean' | 'modified' | null {
  const state = inspectManagedSkillTree(dir).state;
  if (state === 'unmanaged') return null;
  return state === 'managed-clean' ? 'clean' : 'modified';
}

function collectManagedSkillDirs(parent: string, agent: AgentSyncAsset['agent'], out: AgentSyncAsset[]): void {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    // Dirs a previous uninstall already relinquished are the user's now — never re-collect.
    if (name.includes(LEGACY_KEPT_MARKER)) continue;
    const dir = join(parent, name);
    let isDir = false;
    try {
      isDir = lstatSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const disposition = classifyManagedSkillDir(dir);
    if (disposition) out.push({ agent, kind: 'skill', path: dir, modified: disposition === 'modified' });
  }
}

function collectManagedCouncil(claudeDir: string, out: AgentSyncAsset[]): void {
  const workflow = inspectManagedWorkflow(join(claudeDir, 'workflows'));
  if (workflow.state === 'unmanaged') return;
  out.push({
    agent: 'claude',
    kind: 'workflow',
    path: workflow.targetPath,
    metadataPath: workflow.manifestPath,
    modified: workflow.state !== 'managed-clean',
  });
}

/** The hermes plugin link is ours only when the symlink resolves into the genie home. */
function collectHermesLinkPath(linkPath: string, genieHome: string, out: AgentSyncAsset[]): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return;
  }
  if (!stat.isSymbolicLink()) return;
  try {
    const resolved = resolve(dirname(linkPath), readlinkSync(linkPath));
    const home = resolve(genieHome);
    if (isSameOrContainedPath(home, resolved)) out.push({ agent: 'hermes', kind: 'link', path: linkPath });
  } catch {
    /* unreadable symlink → leave it */
  }
}

function collectHermesLinks(hermesHome: string, genieHome: string, out: AgentSyncAsset[]): void {
  collectHermesLinkPath(join(hermesHome, 'plugins', 'genie'), genieHome, out);
  const profilesRoot = join(hermesHome, 'profiles');
  let entries: Dirent[];
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name) || entry.name === '.' || entry.name === '..') continue;
    const profileRoot = resolve(profilesRoot, entry.name);
    if (!isSameOrContainedPath(profilesRoot, profileRoot)) continue;
    collectHermesLinkPath(join(profileRoot, 'plugins', 'genie'), genieHome, out);
  }
}

/** Read-only scan for genie-managed agent assets (skills, stamped council.js, hermes link). */
export function collectAgentSyncAssets(targets: AgentSyncRemovalTargets = {}): AgentSyncAsset[] {
  const claudeDir = targets.claudeDir ?? resolveClaudeDir();
  const codexDir = targets.codexDir ?? resolveCodexDir();
  const hermesHome = targets.hermesHome ?? resolveHermesHome();
  const genieHome = targets.genieHome ?? resolveGenieHome();
  const out: AgentSyncAsset[] = [];
  collectManagedSkillDirs(join(claudeDir, 'skills'), 'claude', out);
  // Live codex tier + the retired `.curated` lane (machines that never synced
  // post-migration still carry managed dirs there). Manifest-gated either way —
  // unmanaged siblings in the shared ~/.agents/skills tier are invisible.
  collectManagedSkillDirs(targets.agentsSkillsDir ?? resolveAgentsSkillsDir(), 'codex', out);
  collectManagedSkillDirs(codexLegacyCuratedDir(codexDir), 'codex', out);
  collectManagedCouncil(claudeDir, out);
  collectHermesLinks(hermesHome, genieHome, out);
  return out;
}

export interface AgentSyncRemovalResult {
  /** Assets deleted outright (digest-clean skills, stamped council.js, hermes link). */
  removed: string[];
  /** User-modified/corrupt-metadata assets preserved byte-identically at their current paths. */
  kept: string[];
  /** Per-asset failures. Callers keep Genie installed so cleanup can be retried. */
  failures: Array<{ path: string; detail: string }>;
}

export interface AgentSyncRemovalOptions {
  beforeManagedDirRemoval?: (destDir: string, stage: 'before-park' | 'before-delete') => void;
  beforeWorkflowRemoval?: (stage: 'before-park' | 'before-delete') => void;
  /** Durable uninstall-batch allowlist; live ownership is still re-inspected. */
  plannedAssetPaths?: readonly string[];
}

function recoverTransactionsBeforeRemoval(targets: AgentSyncRemovalTargets): { path: string; detail: string } | null {
  const recoveryPath = join(targets.claudeDir ?? resolveClaudeDir(), 'skills');
  try {
    recoverUninstallTransactions(targets);
    return null;
  } catch (error) {
    return {
      path: recoveryPath,
      detail: `pending external asset transaction could not be recovered; no agent assets were removed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Remove every asset {@link collectAgentSyncAssets} finds — except managed skill
 * dirs whose digest diverged from their manifest: those hold user edits and are
 * left byte-identical at the same path. Uninstall does not get to rename,
 * disable, rewrite, or relinquish ownership of a user-modified artifact.
 */
export function removeAgentSyncAssets(
  targets: AgentSyncRemovalTargets = {},
  options: AgentSyncRemovalOptions = {},
): AgentSyncRemovalResult {
  const removed: string[] = [];
  const kept: string[] = [];
  const failures: AgentSyncRemovalResult['failures'] = [];
  const recoveryFailure = recoverTransactionsBeforeRemoval(targets);
  if (recoveryFailure) return { removed, kept, failures: [recoveryFailure] };
  const plannedPaths =
    options.plannedAssetPaths === undefined ? null : new Set(options.plannedAssetPaths.map((path) => resolve(path)));
  const assets = collectAgentSyncAssets(targets).filter(
    (asset) => plannedPaths === null || plannedPaths.has(resolve(asset.path)),
  );
  removeCollectedAgentAssets(assets, targets, options, { removed, kept, failures });
  if (plannedPaths !== null) {
    for (const path of kept) {
      if (!plannedPaths.has(resolve(path))) continue;
      failures.push({
        path,
        detail: 'recorded removable asset changed after the uninstall batch was created; kept it byte-identical',
      });
    }
  }
  return { removed, kept, failures };
}

function removeCollectedAgentAssets(
  assets: AgentSyncAsset[],
  targets: AgentSyncRemovalTargets,
  options: AgentSyncRemovalOptions,
  result: AgentSyncRemovalResult,
): void {
  for (const asset of assets) {
    try {
      if (asset.modified) {
        result.kept.push(asset.path);
      } else if (asset.kind === 'workflow' && asset.metadataPath) {
        const disposition = removeManagedWorkflow(join(targets.claudeDir ?? resolveClaudeDir(), 'workflows'), {
          beforeRemoval: options.beforeWorkflowRemoval,
        });
        if (disposition !== 'removed') {
          result.kept.push(asset.path);
          continue;
        }
        result.removed.push(asset.path);
      } else {
        if (asset.kind === 'skill') {
          const disposition = removeManagedSkillTree(asset.path, {
            genieHome: targets.genieHome,
            agent: asset.agent,
            beforeManagedDirRemoval: options.beforeManagedDirRemoval,
          });
          if (disposition !== 'removed') {
            result.kept.push(asset.path);
            continue;
          }
        } else unlinkSync(asset.path);
        result.removed.push(asset.path);
      }
    } catch (error) {
      result.failures.push({ path: asset.path, detail: error instanceof Error ? error.message : String(error) });
    }
  }
}

export interface UninstallFailure {
  step: string;
  detail: string;
}

export interface UninstallResult {
  failures: UninstallFailure[];
}

export interface UninstallBatchExecutionOperations {
  readDecision?: (genieHome: string) => UninstallBatchDecision | null;
  recordDecision?: (genieHome: string, scope: UninstallBatchScope) => UninstallBatchDecision;
  updateDecision?: (
    genieHome: string,
    digest: string,
    progress: UninstallBatchDecision['progress'],
  ) => UninstallBatchDecision;
  clearDecision?: (genieHome: string, digest: string) => void;
}

export interface UninstallBatchProgressController {
  abort(member: string): void;
  begin(member: string): void;
  complete(member: string): void;
  isCompleted(member: string): boolean;
}

/**
 * Execute one authenticated, exact preflight decision. Inner cleanup journals
 * are recovered before the decision is read; their completed members remain in
 * this allowlist, so a retry cannot silently widen or forget the batch. Journal
 * deletion is attempted only after every cleanup step succeeds.
 */
export function executeUninstallBatch(
  genieHome: string,
  requestedScope: UninstallBatchScope,
  cleanup: (scope: UninstallBatchScope, progress: UninstallBatchProgressController) => UninstallResult,
  operations: UninstallBatchExecutionOperations = {},
): { decision: UninstallBatchDecision; result: UninstallResult } {
  const readDecision = operations.readDecision ?? readUninstallBatchDecision;
  const recordDecision = operations.recordDecision ?? recordUninstallBatchDecision;
  const updateDecision = operations.updateDecision ?? updateUninstallBatchProgress;
  const clearDecision = operations.clearDecision ?? clearUninstallBatchDecision;
  let decision = readDecision(genieHome) ?? recordDecision(genieHome, requestedScope);
  if (decision.progress.active !== null) {
    return {
      decision,
      result: {
        failures: [
          {
            step: 'Resuming uninstall batch',
            detail: `member ${decision.progress.active} was interrupted after its durable start receipt; preserved the batch and refused to replay that slot`,
          },
        ],
      },
    };
  }
  const persist = (progress: UninstallBatchDecision['progress']): void => {
    decision = updateDecision(genieHome, decision.digest, progress);
  };
  const assertMember = (member: string): string => {
    const exactMember = uninstallBatchMemberSchema.parse(member);
    if (!uninstallBatchMembers(decision.scope, decision.genieHome).has(exactMember)) {
      throw new Error(`uninstall batch member is outside the exact recorded scope: ${exactMember}`);
    }
    return exactMember;
  };
  const progress: UninstallBatchProgressController = {
    isCompleted(member) {
      return decision.progress.completed.includes(assertMember(member));
    },
    begin(member) {
      const exactMember = assertMember(member);
      if (decision.progress.active !== null) throw new Error('another uninstall batch member is already active');
      if (decision.progress.completed.includes(exactMember)) {
        throw new Error(`uninstall batch member is already completed: ${exactMember}`);
      }
      persist({ active: exactMember, completed: decision.progress.completed });
    },
    complete(member) {
      const exactMember = assertMember(member);
      if (decision.progress.active !== exactMember) {
        throw new Error(`uninstall batch completion receipt does not match the active member: ${exactMember}`);
      }
      persist({ active: null, completed: [...decision.progress.completed, exactMember].sort() });
    },
    abort(member) {
      const exactMember = assertMember(member);
      if (decision.progress.active !== exactMember) {
        throw new Error(`uninstall batch abort receipt does not match the active member: ${exactMember}`);
      }
      persist({ active: null, completed: decision.progress.completed });
    },
  };
  const result = cleanup(decision.scope, progress);
  if (result.failures.length > 0) return { decision, result };
  if (decision.progress.active !== null) {
    result.failures.push({
      step: 'Finalizing uninstall batch journal',
      detail: `member ${decision.progress.active} has no durable completion receipt`,
    });
    return { decision, result };
  }
  const incomplete = [...uninstallBatchMembers(decision.scope, decision.genieHome)].filter(
    (member) => !decision.progress.completed.includes(member),
  );
  if (incomplete.length > 0) {
    result.failures.push({
      step: 'Finalizing uninstall batch journal',
      detail: `requested members lack durable completion receipts: ${incomplete.join(', ')}`,
    });
    return { decision, result };
  }
  try {
    clearDecision(genieHome, decision.digest);
  } catch (error) {
    result.failures.push({
      step: 'Finalizing uninstall batch journal',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return { decision, result };
}

export interface UninstallWorkSnapshot {
  hasGenieDir: boolean;
  hasHookScript: boolean;
  hasOrchestrationRules: boolean;
  hasPendingBatch?: boolean;
  hasPendingTransactions?: boolean;
  symlinkCount: number;
  hasAgentAssets: boolean;
  codexRoleInventoryStatus: 'missing' | 'valid' | 'corrupt';
  runtimeEvidence: { codex: boolean; claude: boolean };
  removeMarketplace: boolean;
}

export function hasUninstallWork(snapshot: UninstallWorkSnapshot): boolean {
  return (
    snapshot.hasGenieDir ||
    snapshot.hasHookScript ||
    snapshot.hasOrchestrationRules ||
    snapshot.hasPendingBatch === true ||
    snapshot.hasPendingTransactions === true ||
    snapshot.symlinkCount > 0 ||
    snapshot.hasAgentAssets ||
    snapshot.codexRoleInventoryStatus !== 'missing' ||
    snapshot.runtimeEvidence.codex ||
    snapshot.runtimeEvidence.claude ||
    snapshot.removeMarketplace
  );
}

export interface RuntimeClientAvailability {
  codex: boolean;
  claude: boolean;
  errors: Record<'codex' | 'claude', string[]>;
}

/** Resolve the exact trusted client set that an uninstall batch may invoke. */
export function inspectRuntimeClientAvailability(cwd = process.cwd()): RuntimeClientAvailability {
  const availability: RuntimeClientAvailability = {
    codex: false,
    claude: false,
    errors: { codex: [], claude: [] },
  };
  for (const runtime of ['codex', 'claude'] as const) {
    try {
      availability[runtime] = resolveRuntimeExecutable(runtime, cwd) !== null;
    } catch (error) {
      availability.errors[runtime].push(error instanceof Error ? error.message : String(error));
    }
  }
  return availability;
}

export interface UninstallPlan {
  genieDir: string;
  hasGenieDir: boolean;
  hasUnprovenHookScript: boolean;
  legacyReport: ReturnType<typeof detectV4Install>;
  hasOwnedRules: boolean;
  existingSymlinks: string[];
  agentAssets: AgentSyncAsset[];
  hasAgentAssets: boolean;
  codexRoleAgents: ReturnType<typeof inspectCodexAgentOwnership>;
  managedRoleAgents: ReturnType<typeof inspectCodexAgentOwnership>['entries'];
  runtimeClients: RuntimeClientAvailability;
  runtimeEvidence: ReturnType<typeof inspectRuntimeIntegrationEvidence>;
  removeMarketplace: boolean;
  hasPendingBatch: boolean;
  hasPendingTransactions: boolean;
}

export interface UninstallPlanInspectors {
  hasGenieDir?: (path: string) => boolean;
  hookScriptExists?: () => boolean;
  detectV4Install?: typeof detectV4Install;
  existingSymlinks?: (genieDir: string) => string[];
  collectAgentSyncAssets?: typeof collectAgentSyncAssets;
  inspectCodexAgentOwnership?: typeof inspectCodexAgentOwnership;
  inspectRuntimeClientAvailability?: typeof inspectRuntimeClientAvailability;
  inspectRuntimeIntegrationEvidence?: typeof inspectRuntimeIntegrationEvidence;
  hasPendingBatch?: (genieDir: string) => boolean;
  hasPendingTransactions?: typeof hasPendingUninstallTransactions;
}

/** Build a complete read-only uninstall plan. Call again under the lease before mutation. */
export function inspectUninstallPlan(
  genieDir = getGenieDir(),
  removeMarketplace = false,
  inspectors: UninstallPlanInspectors = {},
): UninstallPlan {
  const legacyReport = (inspectors.detectV4Install ?? detectV4Install)();
  const agentAssets = (inspectors.collectAgentSyncAssets ?? collectAgentSyncAssets)();
  const codexRoleAgents = (inspectors.inspectCodexAgentOwnership ?? inspectCodexAgentOwnership)();
  const runtimeClients = (inspectors.inspectRuntimeClientAvailability ?? inspectRuntimeClientAvailability)();
  return {
    genieDir,
    hasGenieDir: (inspectors.hasGenieDir ?? existsSync)(genieDir),
    hasUnprovenHookScript: (inspectors.hookScriptExists ?? hookScriptExists)(),
    legacyReport,
    hasOwnedRules: legacyReport.rulesFile.status === 'v4-markers',
    existingSymlinks:
      inspectors.existingSymlinks?.(genieDir) ??
      SYMLINKS.filter((name) => isGenieSymlink(join(LOCAL_BIN, name), genieDir)),
    agentAssets,
    hasAgentAssets: agentAssets.length > 0,
    codexRoleAgents,
    managedRoleAgents: codexRoleAgents.entries.filter((entry) => entry.ownership.startsWith('managed-')),
    runtimeClients,
    runtimeEvidence: (inspectors.inspectRuntimeIntegrationEvidence ?? inspectRuntimeIntegrationEvidence)(),
    removeMarketplace,
    hasPendingBatch: (inspectors.hasPendingBatch ?? hasPendingUninstallBatch)(genieDir),
    hasPendingTransactions: (inspectors.hasPendingTransactions ?? hasPendingUninstallTransactions)(),
  };
}

function removeSyncedAgentAssets(
  agentAssets: UninstallBatchScope['agentAssets'],
  failures: UninstallFailure[],
  progress: UninstallBatchProgressController,
): void {
  const removableAssets = agentAssets.filter((asset) => asset.disposition === 'remove');
  if (removableAssets.length === 0) return;
  console.log('\x1b[2mRemoving synced agent assets...\x1b[0m');
  for (const asset of removableAssets) {
    const member = uninstallBatchMemberId('asset', asset.path);
    if (progress.isCompleted(member)) continue;
    progress.begin(member);
    const result = removeAgentSyncAssets({}, { plannedAssetPaths: [asset.path] });
    if (result.kept.length > 0) {
      console.log(`  \x1b[33m!\x1b[0m Kept managed asset byte-identical: ${contractPath(asset.path)}`);
    }
    if (result.failures.length > 0) {
      if (result.removed.length === 0) progress.abort(member);
      for (const failure of result.failures) {
        failures.push({ step: `Removing synced asset ${contractPath(failure.path)}`, detail: failure.detail });
      }
      return;
    }
    progress.complete(member);
    if (result.removed.length > 0) {
      console.log(`  \x1b[32m+\x1b[0m Removed managed asset: ${contractPath(asset.path)}`);
    }
  }
}

export function uninstallBatchIntegrationViolations(
  scope: UninstallBatchScope,
  currentRoles: Pick<ReturnType<typeof inspectCodexAgentOwnership>, 'status' | 'entries'>,
  currentRuntime: ReturnType<typeof inspectRuntimeIntegrationEvidence>,
): string[] {
  const violations: string[] = [];
  if (currentRoles.status === 'corrupt') {
    violations.push('Codex role-agent ownership inventory is corrupt');
  } else if (currentRoles.status !== scope.codexRoleInventoryStatus && currentRoles.status !== 'missing') {
    violations.push(
      `Codex role-agent inventory status changed (${scope.codexRoleInventoryStatus} -> ${currentRoles.status})`,
    );
  }
  const planned = new Map(scope.codexRoleAgents.map((agent) => [agent.name, agent.disposition]));
  const widenedOrReclassified = currentRoles.entries
    .filter((entry) => entry.ownership.startsWith('managed-'))
    .filter(
      (entry) =>
        !planned.has(entry.name) || (planned.get(entry.name) === 'keep' && entry.ownership === 'managed-clean'),
    );
  if (widenedOrReclassified.length > 0) {
    violations.push(`unexpected Codex role agents: ${widenedOrReclassified.map((entry) => entry.name).join(', ')}`);
  }
  for (const runtime of ['codex', 'claude'] as const) {
    if (currentRuntime.errors[runtime].length > 0) {
      violations.push(`${runtime} integration state is unreadable: ${currentRuntime.errors[runtime].join('; ')}`);
    }
    if (!scope.runtimePlugins[runtime] && currentRuntime[runtime] && scope.runtimeClients[runtime]) {
      violations.push(`${runtime} Genie plugin appeared after the uninstall batch was recorded`);
    }
  }
  return violations;
}

export function uninstallBatchRuntimeTargets(
  scope: UninstallBatchScope,
): Pick<UninstallBatchScope['runtimeClients'], 'codex' | 'claude'> {
  return {
    codex: scope.runtimePlugins.codex || (scope.removeMarketplace && scope.runtimeClients.codex),
    claude: scope.runtimePlugins.claude || (scope.removeMarketplace && scope.runtimeClients.claude),
  };
}

function removeIntegrationState(
  scope: UninstallBatchScope,
  failures: UninstallFailure[],
  progress: UninstallBatchProgressController,
): void {
  const member = uninstallBatchRuntimeMemberId(scope);
  if (progress.isCompleted(member)) return;
  const current = inspectCodexAgentOwnership();
  const runtimeEvidence = inspectRuntimeIntegrationEvidence();
  const violations = uninstallBatchIntegrationViolations(scope, current, runtimeEvidence);
  if (violations.length > 0) {
    failures.push({
      step: 'Validating runtime integration uninstall allowlist',
      detail: violations.join('; '),
    });
    return;
  }
  progress.begin(member);
  const failureCount = failures.length;
  const integrations = removeRuntimeIntegrations({
    removeMarketplace: scope.removeMarketplace,
    installedEvidence: scope.runtimePlugins,
    detected: uninstallBatchRuntimeTargets(scope),
  });
  for (const name of integrations.agents.keptModified) {
    console.log(`  \x1b[33m!\x1b[0m Kept modified Codex role agent byte-identical: ${name}`);
    if (scope.codexRoleAgents.some((agent) => agent.name === name && agent.disposition === 'remove')) {
      failures.push({
        step: `Removing Codex role agent ${name}`,
        detail: 'recorded removable role agent changed after the uninstall batch was created; kept it byte-identical',
      });
    }
  }
  for (const failure of integrations.agents.failures) {
    failures.push({ step: `Removing Codex role agent ${failure.name}`, detail: failure.detail });
  }
  for (const step of integrations.steps) {
    if (!step.ok) failures.push({ step: `Removing ${step.runtime} ${step.operation}`, detail: step.detail });
  }
  if (failures.length === failureCount) progress.complete(member);
}

/** Try an uninstall step, logging success or warning and returning structured failure. */
function tryRemoveStep(label: string, successMsg: string, fn: () => void): UninstallFailure | null {
  console.log(`\x1b[2m${label}\x1b[0m`);
  try {
    fn();
    console.log(`  \x1b[32m+\x1b[0m ${successMsg}`);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  \x1b[33m!\x1b[0m ${label.replace('...', '')} failed: ${message}`);
    return { step: label.replace('...', ''), detail: message };
  }
}

/** Remove only marker-proven v4 rules, with recovery outside the deleted Genie home. */
function removeProvenV4Rules(genieDir: string): void {
  const report = detectV4Install();
  if (report.rulesFile.status !== 'v4-markers') return;
  const recoveryRoot = join(dirname(resolve(genieDir)), '.genie-recovery', 'uninstall-v4');
  mkdirSync(recoveryRoot, { recursive: true });
  const backup = join(recoveryRoot, `${basename(report.rulesFile.path)}.${Date.now()}`);
  copyFileSync(report.rulesFile.path, backup);
  unlinkSync(report.rulesFile.path);
}

function removeRulesMember(
  genieDir: string,
  ownedRulesPath: string | null,
  progress: UninstallBatchProgressController,
): UninstallFailure | null {
  if (ownedRulesPath === null) return null;
  const member = uninstallBatchMemberId('rules', ownedRulesPath);
  if (progress.isCompleted(member)) return null;
  progress.begin(member);
  const failure = tryRemoveStep(
    'Backing up and removing marker-proven v4 orchestration rules...',
    `Marker-proven orchestration rules removed (${contractPath(ownedRulesPath)})`,
    () => removeProvenV4Rules(genieDir),
  );
  if (failure) progress.abort(member);
  else progress.complete(member);
  return failure;
}

function removeGenieHomeMember(
  genieDir: string,
  genieHomePresent: boolean,
  progress: UninstallBatchProgressController,
): UninstallFailure | null {
  if (!genieHomePresent) return null;
  const member = uninstallBatchMemberId('home', resolve(genieDir));
  if (progress.isCompleted(member)) return null;
  progress.begin(member);
  const failure = tryRemoveStep('Removing genie directory...', 'Directory removed', () =>
    rmSync(genieDir, { recursive: true, force: true }),
  );
  if (failure === null) progress.complete(member);
  return failure;
}

function removeSymlinkMembers(
  genieDir: string,
  names: UninstallBatchScope['symlinks'],
  progress: UninstallBatchProgressController,
): UninstallFailure[] {
  const failures: UninstallFailure[] = [];
  if (names.length === 0) return failures;
  console.log('\x1b[2mRemoving symlinks...\x1b[0m');
  for (const name of names) {
    const member = uninstallBatchMemberId('symlink', name);
    if (progress.isCompleted(member)) continue;
    progress.begin(member);
    const symlinks = removeSymlinks(LOCAL_BIN, genieDir, [name]);
    if (symlinks.failures.length > 0) {
      progress.abort(member);
      for (const failure of symlinks.failures) {
        failures.push({ step: `Removing symlink ${contractPath(failure.path)}`, detail: failure.detail });
      }
      return failures;
    }
    progress.complete(member);
    if (symlinks.removed.length > 0) console.log(`  \x1b[32m+\x1b[0m Removed: ${name}`);
  }
  return failures;
}

/**
 * Uninstall Genie CLI entirely
 */
function performUninstall(
  genieDir: string,
  scope: UninstallBatchScope,
  progress: UninstallBatchProgressController,
): UninstallResult {
  const failures: UninstallFailure[] = [];
  const rulesFailure = removeRulesMember(genieDir, scope.ownedRulesPath, progress);
  if (rulesFailure) return { failures: [rulesFailure] };

  // Managed assets live outside GENIE_HOME, so remove them before deleting it.
  removeSyncedAgentAssets(scope.agentAssets, failures, progress);
  if (failures.length > 0) return { failures };
  if (hasRuntimeIntegrationWork(scope)) {
    removeIntegrationState(scope, failures, progress);
    if (failures.length > 0) return { failures };
  }

  // Preserve the CLI and external recovery root while any requested removal is
  // incomplete, otherwise the user loses the easiest retry path.
  const homeFailure = removeGenieHomeMember(genieDir, scope.genieHomePresent, progress);
  if (homeFailure) return { failures: [homeFailure] };
  // Keep the normal command path available whenever any failure-prone cleanup
  // or GENIE_HOME removal failed. Once the home is gone, only dangling source-
  // install links remain and can be removed as the final commit step.
  return { failures: removeSymlinkMembers(genieDir, scope.symlinks, progress) };
}

function uninstallBatchScope(plan: UninstallPlan): UninstallBatchScope {
  return {
    agentAssets: plan.agentAssets
      .map((asset) => ({
        path: resolve(asset.path),
        disposition: asset.modified ? ('keep' as const) : ('remove' as const),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    codexRoleAgents: plan.managedRoleAgents
      .map((agent) => ({
        name: agent.name,
        disposition: agent.ownership === 'managed-clean' ? ('remove' as const) : ('keep' as const),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    codexRoleInventoryStatus: plan.codexRoleAgents.status,
    genieHomePresent: plan.hasGenieDir,
    ownedRulesPath: plan.hasOwnedRules ? resolve(plan.legacyReport.rulesFile.path) : null,
    removeMarketplace: plan.removeMarketplace,
    runtimeClients: { codex: plan.runtimeClients.codex, claude: plan.runtimeClients.claude },
    runtimePlugins: { codex: plan.runtimeEvidence.codex, claude: plan.runtimeEvidence.claude },
    symlinks: SYMLINKS.filter((name) => plan.existingSymlinks.includes(name)),
  };
}

export function performFreshUninstallPlan(
  genieDir: string,
  removeMarketplace: boolean,
): {
  execution: UninstallPlan;
  result: UninstallResult;
} {
  // The confirmation preview is intentionally pure and may not see a live
  // sibling while an owned object is parked. Recover all published transaction
  // roots under the lifecycle lease before this authoritative enumeration.
  recoverUninstallTransactions();
  const execution = inspectUninstallPlan(genieDir, removeMarketplace);
  const unsafeState = [
    ...(execution.codexRoleAgents.status === 'corrupt'
      ? [
          `Codex role-agent ownership inventory is corrupt: ${execution.codexRoleAgents.error ?? execution.codexRoleAgents.inventoryPath}`,
        ]
      : []),
    ...execution.runtimeEvidence.errors.codex,
    ...execution.runtimeEvidence.errors.claude,
    ...execution.runtimeClients.errors.codex,
    ...execution.runtimeClients.errors.claude,
  ];
  if (unsafeState.length > 0) {
    throw new Error(`uninstall preflight found unreadable or corrupt integration state: ${unsafeState.join('; ')}`);
  }
  const batch = executeUninstallBatch(genieDir, uninstallBatchScope(execution), (scope, progress) =>
    performUninstall(genieDir, scope, progress),
  );
  return {
    execution,
    result: batch.result,
  };
}

function reportUninstallResult(execution: UninstallPlan, result: UninstallResult, genieDir: string): void {
  console.log();
  if (result.failures.length > 0) {
    process.exitCode = 1;
    console.log('\x1b[31m!\x1b[0m Genie CLI uninstall is incomplete; no success was reported.');
    for (const failure of result.failures) {
      console.log(`  \x1b[31m-\x1b[0m ${failure.step}: ${failure.detail}`);
    }
    if (execution.hasGenieDir && existsSync(genieDir)) {
      console.log(`  \x1b[33m!\x1b[0m Kept ${contractPath(genieDir)} so you can retry \`genie uninstall\`.`);
    }
    console.log();
    return;
  }
  console.log('\x1b[32m+\x1b[0m Genie CLI uninstalled.');
  console.log();
  console.log('\x1b[2mNote: If you installed via npm/bun, also run:\x1b[0m');
  console.log('  \x1b[36mbun remove -g @automagik/genie\x1b[0m');
  console.log('  \x1b[2mor\x1b[0m');
  console.log('  \x1b[36mnpm uninstall -g @automagik/genie\x1b[0m');
  console.log();
}

export async function uninstallCommand(options: { removeMarketplace?: boolean } = {}): Promise<void> {
  console.log();
  console.log('\x1b[1m\x1b[33m Uninstall Genie CLI\x1b[0m');
  console.log();

  // Preview is strictly read-only. Recovery and the lifecycle lease begin only
  // after confirmation, and destructive helpers revalidate ownership again.
  const preview = inspectUninstallPlan(getGenieDir(), options.removeMarketplace ?? false);
  const {
    genieDir,
    hasGenieDir,
    hasUnprovenHookScript,
    legacyReport,
    hasOwnedRules,
    existingSymlinks,
    agentAssets,
    hasAgentAssets,
    codexRoleAgents,
    managedRoleAgents,
    runtimeEvidence,
    hasPendingBatch,
    hasPendingTransactions,
  } = preview;
  const rulesStatus = legacyReport.rulesFile.status;
  const rulesPath = legacyReport.rulesFile.path;

  console.log('\x1b[2mThis will remove:\x1b[0m');
  console.log('  \x1b[31m-\x1b[0m Genie plugins and digest-owned Codex role agents');
  if (options.removeMarketplace) console.log('  \x1b[31m-\x1b[0m Automagik client marketplace registrations');
  if (hasOwnedRules)
    console.log(`  \x1b[31m-\x1b[0m Marker-proven v4 orchestration rules (${contractPath(rulesPath)})`);
  if (hasUnprovenHookScript)
    console.log('  \x1b[33m~\x1b[0m KEPT unproven hook script (~/.claude/hooks/genie-bash-hook.sh)');
  if (rulesStatus === 'user-modified')
    console.log(`  \x1b[33m~\x1b[0m KEPT unproven orchestration rules (${contractPath(rulesPath)})`);
  if (hasGenieDir) console.log(`  \x1b[31m-\x1b[0m Genie directory (${contractPath(genieDir)})`);
  if (existingSymlinks.length > 0)
    console.log(`  \x1b[31m-\x1b[0m Symlinks from ~/.local/bin: ${existingSymlinks.join(', ')}`);
  const keptAssets = agentAssets.filter((asset) => asset.modified);
  const removableAssets = agentAssets.length - keptAssets.length;
  if (removableAssets > 0)
    console.log(
      `  \x1b[31m-\x1b[0m Synced agent assets: ${removableAssets} unmodified managed skill dir(s)/council.js/hermes link across claude/codex/hermes`,
    );
  if (keptAssets.length > 0) {
    console.log(
      `  \x1b[33m~\x1b[0m KEPT byte-identical (modified or ownership metadata needs review): ${keptAssets.length} managed asset(s):`,
    );
    for (const asset of keptAssets) console.log(`      \x1b[33m${contractPath(asset.path)}\x1b[0m`);
  }
  if (managedRoleAgents.length > 0) {
    const modified = managedRoleAgents.filter((entry) => entry.ownership === 'managed-modified').length;
    console.log(
      `  \x1b[31m-\x1b[0m Codex role agents: ${managedRoleAgents.length - modified} clean; ${modified} modified will be kept byte-identical`,
    );
  }
  if (codexRoleAgents.status === 'corrupt') {
    console.log('  \x1b[33m!\x1b[0m Codex role-agent ownership inventory is corrupt and requires review');
  }
  if (hasPendingTransactions) {
    console.log('  \x1b[31m-\x1b[0m Recover and re-evaluate pending managed asset transactions');
  }
  if (hasPendingBatch) console.log('  \x1b[31m-\x1b[0m Resume the authenticated pending uninstall batch');
  console.log();

  if (
    !hasUninstallWork({
      hasGenieDir,
      hasHookScript: false,
      hasOrchestrationRules: hasOwnedRules,
      hasPendingBatch,
      hasPendingTransactions,
      symlinkCount: existingSymlinks.length,
      hasAgentAssets,
      codexRoleInventoryStatus: codexRoleAgents.status,
      runtimeEvidence,
      removeMarketplace: options.removeMarketplace ?? false,
    })
  ) {
    console.log('\x1b[33mNothing to uninstall.\x1b[0m');
    console.log();
    return;
  }

  const proceed = await confirm({ message: 'Are you sure you want to uninstall Genie CLI?', default: false });
  if (!proceed) {
    console.log();
    console.log('\x1b[2mUninstall cancelled.\x1b[0m');
    console.log();
    return;
  }

  const lifecycleLease = acquireLifecycleLease(genieDir);
  if ('skipped' in lifecycleLease)
    throw new Error(`Another Genie lifecycle command is active: ${lifecycleLease.skipped}`);
  try {
    console.log();
    // The prompt may remain open while another lifecycle process finishes.
    // Discard every preview decision and rebuild the complete plan under the
    // lease; destructive helpers still perform their per-artifact CAS checks.
    let execution: UninstallPlan;
    let result: UninstallResult;
    try {
      ({ execution, result } = performFreshUninstallPlan(genieDir, options.removeMarketplace ?? false));
    } catch (error) {
      process.exitCode = 1;
      console.log('\x1b[31m!\x1b[0m Genie CLI uninstall is incomplete; recovery or batch validation failed.');
      console.log(`  \x1b[31m-\x1b[0m ${error instanceof Error ? error.message : String(error)}`);
      console.log();
      return;
    }

    reportUninstallResult(execution, result, genieDir);
  } finally {
    lifecycleLease.release();
  }
}
