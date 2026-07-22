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
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { z } from 'zod';
import {
  AGENT_SYNC_LOCK_NAME,
  type AgentFileMutationEvent,
  type AgentFilesManifestView,
  type AgentManifestCommitEvent,
  type AgentPathSnapshot,
  CODEX_FALLBACK_RETIREMENT_ROOT,
  type FlatAgentOp,
  type FlatAgentOutcome,
  KEPT_SUFFIX,
  MANIFEST_NAME,
  TARGET_NAME,
  acquireAgentSyncLock,
  acquireLifecycleLease,
  allocateExclusiveBackupRoot,
  captureAgentPathSnapshot,
  codexLegacyCuratedDir,
  inspectManagedSkillTree,
  inspectManagedWorkflow,
  readAgentFilesManifestState,
  recoverManagedSkillTransactions,
  recoverManagedWorkflowTransactions,
  removeManagedSkillTree,
  removeManagedWorkflow,
  resolveAgentsSkillsDir,
  runFlatAgentTransaction,
} from '../lib/agent-sync.js';
import { hookScriptExists } from '../lib/claude-settings.js';
// A's canonical result-trailer serializer (via B's stable facade) + the codex
// lifecycle lease. Uninstall is a deliberately separate destructive authority: it
// acquires the lease after confirmation but before the first removal so it
// serialises against setup/update/rollback/install, and it never mints or accepts
// an activation assertion/permit.
import { serializeActivationResultTrailer } from '../lib/codex-activation-executor.js';
import {
  type AcquireLeaseOptions,
  type LifecycleLeaseKind,
  type LifecycleLeaseResult,
  acquireLifecycleLease as acquireCodexLifecycleLease,
} from '../lib/codex-lifecycle-lease.js';
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
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const physicalModeSchema = z.number().int().min(0).max(0o7777);
const codexRoleNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const agentOwnedDigestSchema = z.string().min(1).max(256);
const physicalRootIdentitySchema = z
  .object({
    dev: z.number().int().nonnegative(),
    ino: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative(),
  })
  .strict();

export type PhysicalRootIdentity = z.infer<typeof physicalRootIdentitySchema>;

const provenV4RulesSchema = z
  .object({
    path: absolutePathSchema,
    digest: digestSchema,
    identity: physicalRootIdentitySchema,
  })
  .strict();

export type ProvenV4Rules = z.infer<typeof provenV4RulesSchema>;

const ownedSourceSymlinkSchema = z
  .object({
    name: z.enum(['genie', 'term']),
    target: z.string().min(1).max(4096),
    identity: physicalRootIdentitySchema,
  })
  .strict();

export type OwnedSourceSymlink = z.infer<typeof ownedSourceSymlinkSchema>;

const agentSnapshotIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent') }).strict(),
  z.object({ kind: z.literal('file'), digest: digestSchema, mode: physicalModeSchema }).strict(),
  z.object({ kind: z.literal('directory'), digest: digestSchema, mode: physicalModeSchema }).strict(),
  z.object({ kind: z.literal('symlink'), target: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal('other'), mode: physicalModeSchema }).strict(),
]);

// Per-kind physical identity the classifier already computed at plan time. Every
// removable managed asset carries the exact identity uninstall is authorized to
// delete; a mismatch at removal proves a distinct object occupies the path.
const agentAssetIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('skill'), contentDigest: digestSchema, manifestDigest: digestSchema }).strict(),
  z
    .object({
      kind: z.literal('workflow'),
      targetDigest: digestSchema,
      manifestDigest: digestSchema,
      targetMode: physicalModeSchema,
      manifestMode: physicalModeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('link'),
      target: z.string().min(1).max(4096),
      identity: physicalRootIdentitySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('agent'),
      ownedDigest: agentOwnedDigestSchema,
      snapshot: agentSnapshotIdentitySchema,
    })
    .strict(),
]);

export type AgentAssetIdentity = z.infer<typeof agentAssetIdentitySchema>;
type AgentSnapshotIdentity = z.infer<typeof agentSnapshotIdentitySchema>;

// A removable asset records its identity; a kept (modified/corrupt) asset records
// none because it holds user data now and is never a deletion candidate.
const agentAssetSchema = z.discriminatedUnion('disposition', [
  z.object({ path: absolutePathSchema, disposition: z.literal('remove'), identity: agentAssetIdentitySchema }).strict(),
  z.object({ path: absolutePathSchema, disposition: z.literal('keep') }).strict(),
]);

const codexRoleAgentSchema = z.discriminatedUnion('disposition', [
  z
    .object({
      name: codexRoleNameSchema,
      disposition: z.literal('remove'),
      identity: z.object({ digest: digestSchema, mode: physicalModeSchema }).strict(),
    })
    .strict(),
  z.object({ name: codexRoleNameSchema, disposition: z.literal('keep') }).strict(),
]);

const uninstallBatchMemberSchema = z.string().regex(/^(asset|rules|runtime|home|symlink):[a-f0-9]{64}$/);
const uninstallBatchProgressSchema = z
  .object({
    active: uninstallBatchMemberSchema.nullable(),
    completed: z.array(uninstallBatchMemberSchema).max(1024),
    // Durable receipts for identity-mismatched members: removal was never
    // authorized, yet the batch may still clear (see UninstallBatchProgressController).
    preserved: z.array(uninstallBatchMemberSchema).max(1024),
  })
  .strict();
const uninstallBatchScopeSchema = z
  .object({
    agentAssets: z.array(agentAssetSchema).max(512),
    codexRoleAgents: z.array(codexRoleAgentSchema).max(128),
    codexRoleInventoryStatus: z.enum(['missing', 'valid', 'corrupt']),
    genieHomeIdentity: physicalRootIdentitySchema.nullable(),
    // SHA-256 commitment to the exact, exclusion-free physical snapshots of
    // every removable GENIE_HOME child at authoritative planning time.
    genieHomeRemovalDigest: digestSchema.nullable(),
    ownedRules: provenV4RulesSchema.nullable(),
    removeMarketplace: z.boolean(),
    runtimeClients: z.object({ codex: z.boolean(), claude: z.boolean() }).strict(),
    runtimePlugins: z.object({ codex: z.boolean(), claude: z.boolean() }).strict(),
    symlinks: z.array(ownedSourceSymlinkSchema).max(2),
  })
  .strict();

export type UninstallBatchScope = z.infer<typeof uninstallBatchScopeSchema>;

const uninstallBatchDecisionSchema = z
  .object({
    schemaVersion: z.literal(3),
    genieHome: absolutePathSchema,
    scope: uninstallBatchScopeSchema,
    progress: uninstallBatchProgressSchema,
    digest: digestSchema,
  })
  .strict();

export type UninstallBatchDecision = z.infer<typeof uninstallBatchDecisionSchema>;

type UninstallBatchPayload = Omit<UninstallBatchDecision, 'digest'>;

// ---------------------------------------------------------------------------
// Legacy read-only shapes. Authentic v1/v2 journals are discarded and
// re-recorded as v3 from current live state (executeUninstallBatch); these
// schemas exist only so migration can authenticate them before discard, never
// to act on stale pathname-only authority. Unauthentic/corrupt journals fail
// closed.
// ---------------------------------------------------------------------------
const uninstallBatchScopeSchemaV1 = z
  .object({
    agentAssets: z
      .array(z.object({ path: absolutePathSchema, disposition: z.enum(['remove', 'keep']) }).strict())
      .max(512),
    codexRoleAgents: z
      .array(z.object({ name: codexRoleNameSchema, disposition: z.enum(['remove', 'keep']) }).strict())
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
const uninstallBatchDecisionSchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    genieHome: absolutePathSchema,
    scope: uninstallBatchScopeSchemaV1,
    progress: z
      .object({
        active: uninstallBatchMemberSchema.nullable(),
        completed: z.array(uninstallBatchMemberSchema).max(1024),
      })
      .strict(),
    digest: digestSchema,
  })
  .strict();

type UninstallBatchDecisionV1 = z.infer<typeof uninstallBatchDecisionSchemaV1>;

const uninstallBatchScopeSchemaV2 = z
  .object({
    agentAssets: z.array(agentAssetSchema).max(512),
    codexRoleAgents: z.array(codexRoleAgentSchema).max(128),
    codexRoleInventoryStatus: z.enum(['missing', 'valid', 'corrupt']),
    genieHomePresent: z.boolean(),
    ownedRulesPath: absolutePathSchema.nullable(),
    removeMarketplace: z.boolean(),
    runtimeClients: z.object({ codex: z.boolean(), claude: z.boolean() }).strict(),
    runtimePlugins: z.object({ codex: z.boolean(), claude: z.boolean() }).strict(),
    symlinks: z.array(z.enum(['genie', 'term'])).max(2),
  })
  .strict();
const uninstallBatchDecisionSchemaV2 = z
  .object({
    schemaVersion: z.literal(2),
    genieHome: absolutePathSchema,
    scope: uninstallBatchScopeSchemaV2,
    progress: uninstallBatchProgressSchema,
    digest: digestSchema,
  })
  .strict();

type UninstallBatchDecisionV2 = z.infer<typeof uninstallBatchDecisionSchemaV2>;

type UninstallBatchReadState =
  | { kind: 'none' }
  | { kind: 'v3'; decision: UninstallBatchDecision; journalIdentity: PhysicalRootIdentity }
  | { kind: 'legacy-v2'; decision: UninstallBatchDecisionV2; journalIdentity: PhysicalRootIdentity }
  | { kind: 'legacy-v1'; decision: UninstallBatchDecisionV1; journalIdentity: PhysicalRootIdentity };

/** Thrown for an authentic legacy journal that must be safely re-planned. */
export class LegacyUninstallBatchJournalError extends Error {
  constructor(
    readonly schemaVersion: 1 | 2,
    readonly interruptedMember: string | null,
  ) {
    super(`uninstall batch journal is an authentic legacy v${schemaVersion} record awaiting migration`);
    this.name = 'LegacyUninstallBatchJournalError';
  }
}

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

function physicalRootIdentity(stat: Stats): PhysicalRootIdentity {
  return physicalRootIdentitySchema.parse({ dev: stat.dev, ino: stat.ino, mode: stat.mode });
}

function capturePhysicalRootIdentity(path: string): PhysicalRootIdentity | null {
  const stat = lstatOrNull(path);
  return stat === null ? null : physicalRootIdentity(stat);
}

function samePhysicalRootIdentity(left: PhysicalRootIdentity | null, right: PhysicalRootIdentity | null): boolean {
  return (
    left === right ||
    (left !== null && right !== null && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode)
  );
}

/** Capture only a removable root whose identity stays stable across classification. */
function inspectRemovableGenieRoot(genieDir: string): PhysicalRootIdentity | null {
  const before = capturePhysicalRootIdentity(genieDir);
  const removable = hasRemovableGenieInstallState(genieDir);
  const after = capturePhysicalRootIdentity(genieDir);
  if (!samePhysicalRootIdentity(before, after)) {
    throw new Error(`Genie install root changed while it was being inspected: ${genieDir}`);
  }
  return removable ? after : null;
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

// Accepts a v1 or v2 payload; both authenticate under the same canonical digest.
function uninstallBatchDigest(payload: object): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function assertExactUninstallScope(scope: UninstallBatchScope): void {
  if ((scope.genieHomeIdentity === null) !== (scope.genieHomeRemovalDigest === null)) {
    throw new Error('uninstall batch must bind Genie root identity and exact removal commitment together');
  }
  const assetPaths = scope.agentAssets.map((asset) => asset.path);
  if (new Set(assetPaths).size !== assetPaths.length) {
    throw new Error('uninstall batch journal contains duplicate agent-asset paths');
  }
  const roleNames = scope.codexRoleAgents.map((agent) => agent.name);
  if (new Set(roleNames).size !== roleNames.length) {
    throw new Error('uninstall batch journal contains duplicate Codex role-agent names');
  }
  const symlinkNames = scope.symlinks.map((symlink) => symlink.name);
  if (new Set(symlinkNames).size !== symlinkNames.length) {
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
  if (new Set(progress.preserved).size !== progress.preserved.length) {
    throw new Error('uninstall batch journal contains duplicate preservation receipts');
  }
  const settled = [...progress.completed, ...progress.preserved];
  if (new Set(settled).size !== settled.length) {
    throw new Error('uninstall batch journal marks one member both completed and preserved');
  }
  if (progress.active !== null && settled.includes(progress.active)) {
    throw new Error('uninstall batch journal marks one member active and settled');
  }
  if (scope !== undefined) {
    if (genieHome === undefined) throw new Error('uninstall batch progress validation requires its Genie home');
    const allowed = uninstallBatchMembers(scope, genieHome);
    const unexpected = [...settled, ...(progress.active === null ? [] : [progress.active])].filter(
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
    schemaVersion: 3,
    genieHome: resolve(genieHome),
    scope: parsedScope,
    progress: { active: null, completed: [], preserved: [] },
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

function authenticateUninstallDigest(payload: object, digest: string, journalPath: string): void {
  const expected = Buffer.from(uninstallBatchDigest(payload), 'hex');
  const actual = Buffer.from(digest, 'hex');
  if (!timingSafeEqual(actual, expected)) {
    throw new Error(`uninstall batch journal authentication failed: ${journalPath}`);
  }
}

/**
 * Authenticate a parsed journal as v3 or a legacy v1/v2 record. The current
 * record is fully cross-checked; a legacy record is authenticated only enough
 * to prove it is ours before migration discards its stale authority.
 */
function authenticateUninstallBatch(
  parsed: unknown,
  genieHome: string,
  journalPath: string,
  journalIdentity: PhysicalRootIdentity,
): UninstallBatchReadState {
  const v3 = uninstallBatchDecisionSchema.safeParse(parsed);
  if (v3.success && v3.data.genieHome === resolve(genieHome)) {
    const decision = v3.data;
    assertExactUninstallScope(decision.scope);
    assertExactUninstallProgress(decision.progress, decision.scope, decision.genieHome);
    authenticateUninstallDigest(uninstallBatchPayload(decision), decision.digest, journalPath);
    return { kind: 'v3', decision, journalIdentity };
  }
  const v2 = uninstallBatchDecisionSchemaV2.safeParse(parsed);
  if (v2.success && v2.data.genieHome === resolve(genieHome)) {
    const decision = v2.data;
    authenticateUninstallDigest(
      { schemaVersion: 2, genieHome: decision.genieHome, scope: decision.scope, progress: decision.progress },
      decision.digest,
      journalPath,
    );
    return { kind: 'legacy-v2', decision, journalIdentity };
  }
  const v1 = uninstallBatchDecisionSchemaV1.safeParse(parsed);
  if (v1.success && v1.data.genieHome === resolve(genieHome)) {
    const decision = v1.data;
    // A migrated v1 record is discarded, not executed, so it needs only digest
    // authentication under its own shape — no v2 member cross-check applies.
    authenticateUninstallDigest(
      { schemaVersion: 1, genieHome: decision.genieHome, scope: decision.scope, progress: decision.progress },
      decision.digest,
      journalPath,
    );
    return { kind: 'legacy-v1', decision, journalIdentity };
  }
  throw new Error('uninstall batch journal has an invalid schema or target');
}

/** Shared physical-security checks + parse; returns the authenticated read state. */
function readUninstallBatchState(genieHome: string): UninstallBatchReadState {
  const journalPath = uninstallBatchJournalPath(genieHome);
  assertUninstallBatchLocation(genieHome, journalPath);
  const stat = lstatOrNull(journalPath);
  if (stat === null) return { kind: 'none' };
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
    const bytes = readFileSync(journalPath, 'utf8');
    const after = lstatSync(journalPath);
    if (!samePhysicalRootIdentity(physicalRootIdentity(stat), physicalRootIdentity(after))) {
      throw new Error(`uninstall batch journal changed while it was authenticated: ${journalPath}`);
    }
    return authenticateUninstallBatch(JSON.parse(bytes), genieHome, journalPath, physicalRootIdentity(after));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`uninstall batch journal is unreadable: ${journalPath}`);
    throw error;
  }
}

/**
 * Read and authenticate a durable uninstall decision without mutating it. An
 * authentic legacy journal raises {@link LegacyUninstallBatchJournalError}
 * so the caller can migrate it; unauthentic/corrupt journals still throw.
 */
export function readUninstallBatchDecision(genieHome = getGenieDir()): UninstallBatchDecision | null {
  const state = readUninstallBatchState(genieHome);
  if (state.kind === 'none') return null;
  if (state.kind === 'legacy-v1' || state.kind === 'legacy-v2') {
    throw new LegacyUninstallBatchJournalError(state.decision.schemaVersion, state.decision.progress.active);
  }
  return state.decision;
}

/** Read-only active-member evidence for the preview across v1 and v2 journals; never throws. */
export function pendingUninstallBatchInterruptedMember(genieHome = getGenieDir()): string | null {
  try {
    const state = readUninstallBatchState(genieHome);
    return state.kind === 'none' ? null : state.decision.progress.active;
  } catch {
    return null;
  }
}

/** Re-authenticate the exact legacy journal, then discard it so a fresh v3 decision can be recorded. */
export interface UninstallJournalMutationOptions {
  beforeCapture?: (journalPath: string) => void;
  afterCapture?: (journalPath: string, capturedPath: string) => void;
}

function authenticateCapturedJournal(
  capture: CapturedRemovalPath,
  genieHome: string,
  expectedKind: UninstallBatchReadState['kind'],
  expectedDigest: string,
): void {
  assertCapturedRemovalPath(capture);
  const parsed = JSON.parse(readFileSync(capture.capturedPath, 'utf8')) as unknown;
  const state = authenticateUninstallBatch(parsed, genieHome, capture.capturedPath, capture.capturedIdentity);
  if (state.kind !== expectedKind || state.kind === 'none' || state.decision.digest !== expectedDigest) {
    throw new Error(`captured uninstall journal is not the exact authenticated generation: ${capture.capturedPath}`);
  }
}

export function discardLegacyUninstallBatchDecision(
  genieHome: string,
  options: UninstallJournalMutationOptions = {},
): void {
  const state = readUninstallBatchState(genieHome);
  if (state.kind !== 'legacy-v1' && state.kind !== 'legacy-v2') {
    throw new Error('uninstall batch journal is no longer an authentic legacy record');
  }
  const journalPath = uninstallBatchJournalPath(genieHome);
  const capture = captureExpectedRemovalPath(
    journalPath,
    state.journalIdentity,
    'journal-discard',
    options.beforeCapture,
  );
  options.afterCapture?.(journalPath, capture.capturedPath);
  authenticateCapturedJournal(capture, genieHome, state.kind, state.decision.digest);
  deleteCapturedRemovalPath(capture);
  fsyncDirectoryBestEffort(dirname(journalPath));
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
  // The runtime member id hashes the whole codexRoleAgents array, so recording
  // per-agent identity in v2 changes the id versus a v1 journal. That is fine:
  // v1 journals are migrated (discarded + re-recorded) before any member runs,
  // so no receipt is ever compared across the two schema versions.
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

function flatAgentBatchMember(scope: UninstallBatchScope): string | null {
  const agentPaths = scope.agentAssets
    .filter((asset) => asset.disposition === 'remove' && asset.identity.kind === 'agent')
    .map((asset) => asset.path);
  if (agentPaths.length === 0) return null;
  const roots = new Set(agentPaths.map((path) => dirname(path)));
  if (roots.size !== 1) throw new Error('uninstall batch flat-agent actions span multiple manifest directories');
  return uninstallBatchMemberId(
    'asset',
    `flat-agents:${agentPaths
      .map((path) => resolve(path))
      .sort()
      .join('\n')}`,
  );
}

function uninstallBatchMembers(scope: UninstallBatchScope, genieHome: string): Set<string> {
  const members = new Set(
    scope.agentAssets
      .filter((asset) => asset.disposition === 'remove' && asset.identity.kind !== 'agent')
      .map((asset) => uninstallBatchMemberId('asset', asset.path)),
  );
  const agentMember = flatAgentBatchMember(scope);
  if (agentMember !== null) members.add(agentMember);
  if (scope.ownedRules !== null) members.add(uninstallBatchMemberId('rules', scope.ownedRules.path));
  if (hasRuntimeIntegrationWork(scope)) members.add(uninstallBatchRuntimeMemberId(scope));
  if (scope.genieHomeIdentity !== null) members.add(uninstallBatchMemberId('home', resolve(genieHome)));
  for (const symlink of scope.symlinks) members.add(uninstallBatchMemberId('symlink', symlink.name));
  return members;
}

/** Atomically CAS one authenticated progress generation before or after a member mutation. */
export function updateUninstallBatchProgress(
  genieHome: string,
  expectedDigest: string,
  progress: UninstallBatchDecision['progress'],
  options: UninstallJournalMutationOptions = {},
): UninstallBatchDecision {
  const currentState = readUninstallBatchState(genieHome);
  if (currentState.kind !== 'v3') throw new Error('uninstall batch journal disappeared during progress update');
  const current = currentState.decision;
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
    const capture = captureExpectedRemovalPath(
      journalPath,
      currentState.journalIdentity,
      'journal-progress',
      options.beforeCapture,
    );
    options.afterCapture?.(journalPath, capture.capturedPath);
    authenticateCapturedJournal(capture, genieHome, 'v3', expectedDigest);
    try {
      linkSync(staging, journalPath);
    } catch {
      restoreCapturedNoClobber(capture, 'uninstall journal publication raced with another live generation');
    }
    fsyncDirectoryBestEffort(recoveryRoot);
    const published = readUninstallBatchDecision(genieHome);
    if (published === null || published.digest !== next.digest) {
      throw new Error(
        `uninstall batch progress generation was not published intact; prior generation at ${capture.capturedPath}`,
      );
    }
    deleteCapturedRemovalPath(capture, false);
    return published;
  } finally {
    rmSync(staging, { force: true });
    fsyncDirectoryBestEffort(recoveryRoot);
  }
}

/** Authenticate and remove only the exact completed batch as the final step. */
export function clearUninstallBatchDecision(
  genieHome: string,
  expectedDigest: string,
  options: UninstallJournalMutationOptions = {},
): void {
  const state = readUninstallBatchState(genieHome);
  if (state.kind !== 'v3') throw new Error('uninstall batch journal disappeared before finalization');
  const decision = state.decision;
  if (decision.digest !== expectedDigest) throw new Error('uninstall batch journal changed before finalization');
  const journalPath = uninstallBatchJournalPath(genieHome);
  const capture = captureExpectedRemovalPath(
    journalPath,
    state.journalIdentity,
    'journal-clear',
    options.beforeCapture,
  );
  options.afterCapture?.(journalPath, capture.capturedPath);
  authenticateCapturedJournal(capture, genieHome, 'v3', expectedDigest);
  deleteCapturedRemovalPath(capture);
  fsyncDirectoryBestEffort(dirname(journalPath));
}

/** Prove a named link resolves to the corresponding canonical Genie binary, including dangling links. */
export function isGenieSymlink(path: string, genieDir = getGenieDir()): boolean {
  try {
    return ownedSourceSymlink(path, genieDir) !== null;
  } catch {
    return false;
  }
}

interface CapturedRemovalPath {
  sourcePath: string;
  quarantineRoot: string;
  quarantineIdentity: PhysicalRootIdentity;
  capturedPath: string;
  capturedIdentity: PhysicalRootIdentity;
}

class UninstallIdentityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UninstallIdentityMismatchError';
  }
}

function createRemovalQuarantine(
  sourcePath: string,
  label: string,
): {
  root: string;
  identity: PhysicalRootIdentity;
} {
  const parent = dirname(sourcePath);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const root = join(parent, `.genie-uninstall-${label}-${process.pid}-${randomBytes(12).toString('hex')}`);
    try {
      mkdirSync(root, { mode: 0o700 });
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`uninstall quarantine is not a physical directory: ${root}`);
      }
      assertPrivateRecoveryObject(root, stat, 'uninstall quarantine');
      return { root, identity: physicalRootIdentity(stat) };
    } catch (error) {
      if (isNodeErrorCode(error, 'EEXIST')) continue;
      throw error;
    }
  }
  throw new Error(`could not allocate an exclusive uninstall quarantine beside ${sourcePath}`);
}

function assertCapturedRemovalPath(capture: CapturedRemovalPath): void {
  const quarantineIdentity = capturePhysicalRootIdentity(capture.quarantineRoot);
  const capturedIdentity = capturePhysicalRootIdentity(capture.capturedPath);
  if (!samePhysicalRootIdentity(quarantineIdentity, capture.quarantineIdentity)) {
    throw new Error(`uninstall quarantine identity changed; preserved it for recovery: ${capture.quarantineRoot}`);
  }
  if (!samePhysicalRootIdentity(capturedIdentity, capture.capturedIdentity)) {
    throw new Error(`captured uninstall object identity changed; preserved quarantine: ${capture.quarantineRoot}`);
  }
}

function removeEmptyQuarantineBestEffort(capture: Pick<CapturedRemovalPath, 'quarantineRoot'>): void {
  try {
    rmdirSync(capture.quarantineRoot);
    fsyncDirectoryBestEffort(dirname(capture.quarantineRoot));
  } catch {
    // A non-empty or concurrently changed quarantine is recovery evidence.
  }
}

function restoreCapturedNoClobber(capture: CapturedRemovalPath, reason: string): never {
  let disposition = `preserved replacement visibly in quarantine: ${capture.capturedPath}`;
  try {
    assertCapturedRemovalPath(capture);
    // link(2) is an atomic no-clobber publication for both regular files and
    // symlink inodes. Never use rename here: POSIX rename would overwrite a
    // concurrent user object at the live pathname.
    linkSync(capture.capturedPath, capture.sourcePath);
    unlinkSync(capture.capturedPath);
    fsyncDirectoryBestEffort(dirname(capture.sourcePath));
    removeEmptyQuarantineBestEffort(capture);
    disposition = `restored captured replacement without clobbering ${capture.sourcePath}`;
  } catch (error) {
    if (!isNodeErrorCode(error, 'EEXIST')) {
      disposition += ` (automatic no-clobber restore failed: ${errorMessage(error)})`;
    }
  }
  throw new UninstallIdentityMismatchError(`${reason}; ${disposition}`);
}

function captureExpectedRemovalPath(
  sourcePath: string,
  expectedIdentity: PhysicalRootIdentity,
  label: string,
  beforeCapture?: (path: string) => void,
): CapturedRemovalPath {
  const before = capturePhysicalRootIdentity(sourcePath);
  if (!samePhysicalRootIdentity(before, expectedIdentity)) {
    throw new UninstallIdentityMismatchError(
      `recorded uninstall object identity changed before capture: ${sourcePath}`,
    );
  }
  const quarantine = createRemovalQuarantine(sourcePath, label);
  const capturedPath = join(quarantine.root, 'captured');
  try {
    beforeCapture?.(sourcePath);
    renameSync(sourcePath, capturedPath);
  } catch (error) {
    removeEmptyQuarantineBestEffort({ quarantineRoot: quarantine.root });
    throw error;
  }
  const capturedIdentity = capturePhysicalRootIdentity(capturedPath);
  if (capturedIdentity === null) {
    throw new Error(`captured uninstall object disappeared; preserved quarantine: ${quarantine.root}`);
  }
  const capture: CapturedRemovalPath = {
    sourcePath,
    quarantineRoot: quarantine.root,
    quarantineIdentity: quarantine.identity,
    capturedPath,
    capturedIdentity,
  };
  if (!samePhysicalRootIdentity(capturedIdentity, expectedIdentity)) {
    restoreCapturedNoClobber(
      capture,
      `live uninstall object was replaced at the atomic capture boundary: ${sourcePath}`,
    );
  }
  return capture;
}

function deleteCapturedRemovalPath(capture: CapturedRemovalPath, requireSourceAbsent = true): void {
  assertCapturedRemovalPath(capture);
  if (requireSourceAbsent && lstatOrNull(capture.sourcePath) !== null) {
    restoreCapturedNoClobber(
      capture,
      `a replacement appeared at the live path after atomic capture: ${capture.sourcePath}`,
    );
  }
  unlinkSync(capture.capturedPath);
  fsyncDirectoryBestEffort(capture.quarantineRoot);
  removeEmptyQuarantineBestEffort(capture);
}

function ownedSourceSymlink(path: string, genieDir: string): OwnedSourceSymlink | null {
  const before = lstatOrNull(path);
  if (before === null || !before.isSymbolicLink()) return null;
  const name = basename(path);
  if (!SYMLINKS.some((candidate) => candidate === name)) return null;
  const target = readlinkSync(path);
  const after = lstatOrNull(path);
  if (!samePhysicalRootIdentity(physicalRootIdentity(before), after === null ? null : physicalRootIdentity(after))) {
    throw new Error(`source-install symlink changed while it was inspected: ${path}`);
  }
  if (resolve(dirname(path), target) !== resolve(genieDir, 'bin', name)) return null;
  return {
    name: name as OwnedSourceSymlink['name'],
    target,
    identity: physicalRootIdentity(after as Stats),
  };
}

export interface SourceSymlinkRemovalOptions {
  planned?: ReadonlyMap<OwnedSourceSymlink['name'], OwnedSourceSymlink>;
  beforeCapture?: (path: string) => void;
}

/**
 * Remove genie symlinks from ~/.local/bin
 */
export function removeSymlinks(
  localBin = LOCAL_BIN,
  genieDir = getGenieDir(),
  plannedNames: readonly (typeof SYMLINKS)[number][] = SYMLINKS,
  options: SourceSymlinkRemovalOptions = {},
): { removed: string[]; preserved: string[]; failures: Array<{ path: string; detail: string }> } {
  const removed: string[] = [];
  const preserved: string[] = [];
  const failures: Array<{ path: string; detail: string }> = [];

  for (const name of plannedNames) {
    const symlinkPath = join(localBin, name);
    try {
      const planned = options.planned?.get(name);
      const live = ownedSourceSymlink(symlinkPath, genieDir);
      if (live === null) {
        if (planned !== undefined && lstatOrNull(symlinkPath) !== null) {
          throw new UninstallIdentityMismatchError(
            `recorded source-install symlink was replaced before capture: ${symlinkPath}`,
          );
        }
        continue;
      }
      if (
        planned !== undefined &&
        (planned.target !== live.target || !samePhysicalRootIdentity(planned.identity, live.identity))
      ) {
        throw new UninstallIdentityMismatchError(
          `recorded source-install symlink identity changed before capture: ${symlinkPath}`,
        );
      }
      const capture = captureExpectedRemovalPath(
        symlinkPath,
        planned?.identity ?? live.identity,
        'source-link',
        options.beforeCapture,
      );
      const capturedTarget = readlinkSync(capture.capturedPath);
      if (!lstatSync(capture.capturedPath).isSymbolicLink() || capturedTarget !== (planned?.target ?? live.target)) {
        restoreCapturedNoClobber(capture, `captured source-install link content changed: ${symlinkPath}`);
      }
      deleteCapturedRemovalPath(capture);
      removed.push(name);
    } catch (error) {
      if (error instanceof UninstallIdentityMismatchError) preserved.push(name);
      failures.push({ path: symlinkPath, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  return { removed, preserved, failures };
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
  /** Injectable clock for deterministic state-backup and kept-aside paths in tests. */
  now?: () => Date;
  /** Deterministic race barrier after classification/capture and before a flat-agent mutation. */
  beforeAgentFileMutation?: (event: AgentSyncRemovalMutationEvent) => void;
  /** Deterministic barrier inside the single manifest commit of the flat-agent transaction. */
  beforeAgentManifestCommit?: (event: AgentManifestCommitEvent) => void;
}

/** Uninstall shares the transaction core's mutation event verbatim. */
export type AgentSyncRemovalMutationEvent = AgentFileMutationEvent;

function directoryHasMatchingEntry(path: string, matches: (name: string) => boolean): boolean {
  try {
    return readdirSync(path).some(matches);
  } catch (error) {
    // An existing but unreadable/non-directory transaction root is still work:
    // authoritative recovery will surface the fail-closed error under the lease.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

const REMOVAL_QUARANTINE_PREFIX = '.genie-uninstall-';

function retainedRemovalQuarantines(targets: AgentSyncRemovalTargets = {}): string[] {
  const claudeDir = targets.claudeDir ?? resolveClaudeDir();
  const hermesHome = targets.hermesHome ?? resolveHermesHome();
  const genieHome = targets.genieHome ?? resolveGenieHome();
  const genieCaptureParent = dirname(genieHome);
  const genieCapturePrefix = `.${basename(genieHome)}.uninstall-capture-`;
  const parents = new Set<string>([
    LOCAL_BIN,
    join(claudeDir, 'rules'),
    join(hermesHome, 'plugins'),
    dirname(uninstallBatchJournalPath(genieHome)),
    genieCaptureParent,
  ]);
  try {
    for (const profile of readdirSync(join(hermesHome, 'profiles'), { withFileTypes: true })) {
      if (profile.isDirectory() && !profile.isSymbolicLink()) {
        parents.add(join(hermesHome, 'profiles', profile.name, 'plugins'));
      }
    }
  } catch {
    // Missing profiles are normal; unreadable parents are surfaced elsewhere.
  }
  const retained: string[] = [];
  for (const parent of parents) {
    try {
      for (const name of readdirSync(parent)) {
        if (
          name.startsWith(REMOVAL_QUARANTINE_PREFIX) ||
          (resolve(parent) === resolve(genieCaptureParent) && name.startsWith(genieCapturePrefix))
        ) {
          retained.push(join(parent, name));
        }
      }
    } catch {
      // A missing parent has no retained capture. Existing unreadable ownership
      // roots are caught by their authoritative inspectors.
    }
  }
  return retained.sort();
}

/** Pure pending-transaction evidence for the pre-confirmation preview. */
export function hasPendingUninstallTransactions(targets: AgentSyncRemovalTargets = {}): boolean {
  if (retainedRemovalQuarantines(targets).length > 0) return true;
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
  const retained = retainedRemovalQuarantines(targets);
  if (retained.length > 0) {
    failures.push(`retained uninstall capture requires no-clobber recovery review: ${retained.join(', ')}`);
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
}

/** Legacy suffix used by older uninstalls; those relinquished dirs remain invisible. */
const LEGACY_KEPT_MARKER = '.genie-kept';

interface AgentSyncAsset {
  agent: 'claude' | 'codex' | 'hermes';
  kind: 'skill' | 'agent' | 'workflow' | 'link';
  path: string;
  /** True when content diverged or ownership metadata is corrupt; uninstall preserves it. */
  modified?: boolean;
  /** Workflow-only digest ownership sidecar removed together with a clean target. */
  metadataPath?: string;
  /**
   * The exact physical identity captured by this classification. Present only for
   * a removable (clean) asset; the uninstall batch records it so a later retry can
   * refuse a replacement occupying the same path (F43).
   */
  identity?: AgentAssetIdentity;
  /** Flat Claude agents only: the shared manifest entry that owns this path. */
  manifestEntry?: { dir: string; name: string; digest: string };
  /** Flat Claude agents only: ownership exists but the live file is already absent. */
  missing?: boolean;
  /** Flat Claude agents only: exact snapshot captured at classification — the removal CAS target. */
  agentSnapshot?: AgentPathSnapshot;
}

function collectManagedSkillDirs(
  parent: string,
  agent: AgentSyncAsset['agent'],
  out: AgentSyncAsset[],
  restrictToPaths?: ReadonlySet<string>,
): void {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    // Dirs a previous uninstall already relinquished are the user's now — never re-collect.
    if (name.includes(LEGACY_KEPT_MARKER)) continue;
    // The Codex fallback-retirement quarantine is retained evidence (R6): uninstall
    // classifies but never deletes it, so it is invisible to managed-skill collection.
    if (name === CODEX_FALLBACK_RETIREMENT_ROOT) continue;
    const dir = join(parent, name);
    // Batch removal re-collects once per planned member; skip the full-tree digest
    // of any dir outside this call's allowlist BEFORE inspecting it, so a batch of
    // N members costs N single-dir digests instead of N × (every managed dir).
    if (restrictToPaths !== undefined && !restrictToPaths.has(resolve(dir))) continue;
    let isDir = false;
    try {
      isDir = lstatSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    // One inspection yields both the disposition and the identity, so the batch
    // records exactly what classification observed. No manifest → invisible;
    // manifest but diverged/corrupt → modified (user data), no identity.
    const report = inspectManagedSkillTree(dir);
    if (report.state === 'unmanaged') continue;
    if (report.state === 'managed-clean' && report.contentDigest !== undefined && report.manifestDigest !== undefined) {
      out.push({
        agent,
        kind: 'skill',
        path: dir,
        modified: false,
        identity: { kind: 'skill', contentDigest: report.contentDigest, manifestDigest: report.manifestDigest },
      });
    } else {
      out.push({ agent, kind: 'skill', path: dir, modified: true });
    }
  }
}

function agentSnapshotIdentity(snapshot: AgentPathSnapshot): AgentSnapshotIdentity {
  if (snapshot.kind === 'absent') return { kind: 'absent' };
  if (snapshot.kind === 'file') {
    return { kind: 'file', digest: snapshot.digest, mode: snapshot.stat.mode & 0o7777 };
  }
  if (snapshot.kind === 'directory') {
    return { kind: 'directory', digest: snapshot.digest, mode: snapshot.stat.mode & 0o7777 };
  }
  if (snapshot.kind === 'symlink') return { kind: 'symlink', target: snapshot.target };
  return { kind: 'other', mode: snapshot.stat.mode & 0o7777 };
}

function agentIdentityMatches(expected: AgentAssetIdentity, asset: AgentSyncAsset): boolean {
  if (expected.kind !== 'agent' || asset.identity?.kind !== 'agent') return false;
  return (
    expected.ownedDigest === asset.identity.ownedDigest &&
    JSON.stringify(expected.snapshot) === JSON.stringify(asset.identity.snapshot)
  );
}

/** Collect only flat Claude-agent names explicitly owned by the shared per-file manifest. */
function collectManagedAgentFiles(
  parent: string,
  manifest: AgentFilesManifestView,
  out: AgentSyncAsset[],
  restrictToPaths?: ReadonlySet<string>,
): void {
  if (manifest.kind !== 'managed') return;
  for (const [name, entry] of Object.entries(manifest.files).sort(([left], [right]) => left.localeCompare(right))) {
    const path = join(parent, name);
    if (restrictToPaths !== undefined && !restrictToPaths.has(resolve(path))) continue;
    let snapshot: AgentPathSnapshot | undefined;
    try {
      snapshot = captureAgentPathSnapshot(path);
    } catch {
      // Uninspectable manifest-owned data is never a deletion/action candidate.
      out.push({
        agent: 'claude',
        kind: 'agent',
        path,
        modified: true,
        manifestEntry: { dir: parent, name, digest: entry.digest },
      });
      continue;
    }
    const missing = snapshot.kind === 'absent';
    const clean = snapshot.kind === 'file' && snapshot.digest === entry.digest;
    out.push({
      agent: 'claude',
      kind: 'agent',
      path,
      modified: !missing && !clean,
      missing,
      agentSnapshot: snapshot,
      manifestEntry: { dir: parent, name, digest: entry.digest },
      identity: { kind: 'agent', ownedDigest: entry.digest, snapshot: agentSnapshotIdentity(snapshot) },
    });
  }
}

function collectManagedCouncil(claudeDir: string, out: AgentSyncAsset[], restrictToPaths?: ReadonlySet<string>): void {
  if (restrictToPaths !== undefined && !restrictToPaths.has(resolve(join(claudeDir, 'workflows', TARGET_NAME)))) return;
  const workflow = inspectManagedWorkflow(join(claudeDir, 'workflows'));
  if (workflow.state === 'unmanaged') return;
  if (
    workflow.state === 'managed-clean' &&
    workflow.targetDigest !== undefined &&
    workflow.manifestDigest !== undefined &&
    workflow.targetMode !== undefined &&
    workflow.manifestMode !== undefined
  ) {
    out.push({
      agent: 'claude',
      kind: 'workflow',
      path: workflow.targetPath,
      metadataPath: workflow.manifestPath,
      modified: false,
      identity: {
        kind: 'workflow',
        targetDigest: workflow.targetDigest,
        manifestDigest: workflow.manifestDigest,
        targetMode: workflow.targetMode,
        manifestMode: workflow.manifestMode,
      },
    });
    return;
  }
  out.push({
    agent: 'claude',
    kind: 'workflow',
    path: workflow.targetPath,
    metadataPath: workflow.manifestPath,
    modified: true,
  });
}

/** The hermes plugin link is ours only when the symlink resolves into the genie home. */
function collectHermesLinkPath(
  linkPath: string,
  genieHome: string,
  out: AgentSyncAsset[],
  restrictToPaths?: ReadonlySet<string>,
): void {
  if (restrictToPaths !== undefined && !restrictToPaths.has(resolve(linkPath))) return;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return;
  }
  if (!stat.isSymbolicLink()) return;
  try {
    const target = readlinkSync(linkPath);
    const after = lstatSync(linkPath);
    if (!after.isSymbolicLink() || !samePhysicalRootIdentity(physicalRootIdentity(stat), physicalRootIdentity(after))) {
      return;
    }
    const resolved = resolve(dirname(linkPath), target);
    const home = resolve(genieHome);
    // Record the raw link target as identity so removal re-verifies the exact
    // pointer before unlinking a symlink the user may have repointed since.
    if (isSameOrContainedPath(home, resolved)) {
      out.push({
        agent: 'hermes',
        kind: 'link',
        path: linkPath,
        identity: { kind: 'link', target, identity: physicalRootIdentity(after) },
      });
    }
  } catch {
    /* unreadable symlink → leave it */
  }
}

function collectHermesLinks(
  hermesHome: string,
  genieHome: string,
  out: AgentSyncAsset[],
  restrictToPaths?: ReadonlySet<string>,
): void {
  collectHermesLinkPath(join(hermesHome, 'plugins', 'genie'), genieHome, out, restrictToPaths);
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
    collectHermesLinkPath(join(profileRoot, 'plugins', 'genie'), genieHome, out, restrictToPaths);
  }
}

/**
 * Read-only scan for genie-managed agent assets (skills, stamped council.js, hermes link).
 * `restrictToPaths` (resolved paths) bounds the scan to those exact objects, so a
 * batch removing N members re-inspects only each planned path instead of digesting
 * every managed dir once per member. Classification of each returned path is
 * unchanged — it is still freshly inspected on every call.
 */
export function collectAgentSyncAssets(
  targets: AgentSyncRemovalTargets = {},
  restrictToPaths?: ReadonlySet<string>,
): AgentSyncAsset[] {
  return inspectAgentSyncAssets(targets, restrictToPaths).assets;
}

export interface AgentSyncAssetInspection {
  assets: AgentSyncAsset[];
  claudeAgentManifest: AgentFilesManifestView;
}

/** Preserve strict manifest state alongside the asset list for fail-closed callers. */
export function inspectAgentSyncAssets(
  targets: AgentSyncRemovalTargets = {},
  restrictToPaths?: ReadonlySet<string>,
): AgentSyncAssetInspection {
  const claudeDir = targets.claudeDir ?? resolveClaudeDir();
  const codexDir = targets.codexDir ?? resolveCodexDir();
  const hermesHome = targets.hermesHome ?? resolveHermesHome();
  const genieHome = targets.genieHome ?? resolveGenieHome();
  const out: AgentSyncAsset[] = [];
  const claudeAgentManifest = readAgentFilesManifestState(join(claudeDir, 'agents'));
  collectManagedSkillDirs(join(claudeDir, 'skills'), 'claude', out, restrictToPaths);
  collectManagedAgentFiles(join(claudeDir, 'agents'), claudeAgentManifest, out, restrictToPaths);
  // Live codex tier + the retired `.curated` lane (machines that never synced
  // post-migration still carry managed dirs there). Manifest-gated either way —
  // unmanaged siblings in the shared ~/.agents/skills tier are invisible.
  collectManagedSkillDirs(targets.agentsSkillsDir ?? resolveAgentsSkillsDir(), 'codex', out, restrictToPaths);
  collectManagedSkillDirs(codexLegacyCuratedDir(codexDir), 'codex', out, restrictToPaths);
  collectManagedCouncil(claudeDir, out, restrictToPaths);
  collectHermesLinks(hermesHome, genieHome, out, restrictToPaths);
  return { assets: out, claudeAgentManifest };
}

export interface AgentSyncRemovalResult {
  /** Assets deleted outright (digest-clean skills, stamped council.js, hermes link). */
  removed: string[];
  /** User-modified/corrupt-metadata/identity-mismatched assets preserved byte-identically at their paths. */
  kept: string[];
  /** Subset of `kept` whose live identity diverged from a recorded batch identity (vs. a plain user edit). */
  identityMismatch: string[];
  /** Per-asset failures. Callers keep Genie installed so cleanup can be retried. */
  failures: Array<{ path: string; detail: string }>;
  /** Non-fatal transaction/concurrency details for paths left safe and visible. */
  advisories?: string[];
  /** Set when the shared sync/uninstall lock was held by another process. */
  skipped?: string;
}

export interface AgentSyncRemovalOptions {
  beforeManagedDirRemoval?: (destDir: string, stage: 'before-park' | 'before-delete') => void;
  beforeWorkflowRemoval?: (stage: 'before-park' | 'before-delete') => void;
  /** Deterministic boundary after a Hermes link is proven and before atomic capture. */
  beforeManagedLinkCapture?: (path: string) => void;
  /**
   * Durable uninstall-batch allowlist with the recorded identity per planned path.
   * Membership filters which assets are candidates; identity binds removal so a
   * replacement at the same path is preserved, not deleted under path authority.
   */
  plannedAssets?: readonly { path: string; identity: AgentAssetIdentity }[];
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
  const genieHome = targets.genieHome ?? resolveGenieHome();
  let lock: { release: () => void } | null;
  try {
    lock = acquireAgentSyncLock(genieHome);
  } catch (error) {
    const skipped = `agent-sync lock acquisition failed closed; uninstall left synced assets untouched: ${errorMessage(error)}`;
    return {
      removed: [],
      kept: [],
      identityMismatch: [],
      failures: [{ path: genieHome, detail: skipped }],
      advisories: [skipped],
      skipped,
    };
  }
  if (lock === null) {
    const skipped = 'another agent-sync mutation holds the lock; uninstall left synced assets untouched';
    return {
      removed: [],
      kept: [],
      identityMismatch: [],
      failures: [{ path: genieHome, detail: skipped }],
      advisories: [skipped],
      skipped,
    };
  }
  try {
    return removeAgentSyncAssetsLocked(targets, options);
  } finally {
    lock.release();
  }
}

function removeAgentSyncAssetsLocked(
  targets: AgentSyncRemovalTargets = {},
  options: AgentSyncRemovalOptions = {},
): AgentSyncRemovalResult {
  const result: AgentSyncRemovalResult = { removed: [], kept: [], identityMismatch: [], failures: [] };
  const recoveryFailure = recoverTransactionsBeforeRemoval(targets);
  if (recoveryFailure) {
    result.failures.push(recoveryFailure);
    return result;
  }
  const plannedByPath =
    options.plannedAssets === undefined
      ? null
      : new Map(options.plannedAssets.map((planned) => [resolve(planned.path), planned.identity]));
  // Scope the (expensive, full-tree-digesting) collection to exactly the planned
  // paths. The resulting membership is identical to collecting everything then
  // filtering, but a per-member batch call no longer digests every sibling.
  const restrictToPaths = plannedByPath === null ? undefined : new Set(plannedByPath.keys());
  const inspection = inspectAgentSyncAssets(targets, restrictToPaths);
  if (inspection.claudeAgentManifest.kind === 'unsafe') {
    const manifestPath = join(targets.claudeDir ?? resolveClaudeDir(), 'agents', MANIFEST_NAME);
    result.failures.push({
      path: manifestPath,
      detail: `Claude agent ownership manifest is unsafe: ${inspection.claudeAgentManifest.reason}`,
    });
    return result;
  }
  const assets = inspection.assets.filter((asset) => plannedByPath === null || plannedByPath.has(resolve(asset.path)));
  removeCollectedAgentAssets(assets, targets, options, plannedByPath, result);
  return result;
}

function recordAgentAssetDisposition(
  disposition: 'removed' | 'unmanaged' | 'kept-modified' | 'kept-identity-mismatch',
  path: string,
  result: AgentSyncRemovalResult,
): void {
  if (disposition === 'removed') {
    result.removed.push(path);
    return;
  }
  result.kept.push(path);
  if (disposition === 'kept-identity-mismatch') result.identityMismatch.push(path);
}

/** Atomically capture and remove only the exact recorded Hermes link inode. */
function removeManagedLink(
  linkPath: string,
  expected: Extract<AgentAssetIdentity, { kind: 'link' }> | undefined,
  result: AgentSyncRemovalResult,
  beforeCapture?: (path: string) => void,
): void {
  let liveTarget: string;
  let liveIdentity: PhysicalRootIdentity;
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      // A real object now occupies the recorded link path; never delete it.
      result.kept.push(linkPath);
      result.identityMismatch.push(linkPath);
      return;
    }
    liveIdentity = physicalRootIdentity(stat);
    liveTarget = readlinkSync(linkPath);
  } catch (error) {
    // Already gone before we reached it: an idempotent no-op, not a failure.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    expected !== undefined &&
    (liveTarget !== expected.target || !samePhysicalRootIdentity(liveIdentity, expected.identity))
  ) {
    result.kept.push(linkPath);
    result.identityMismatch.push(linkPath);
    return;
  }
  const capture = captureExpectedRemovalPath(
    linkPath,
    expected?.identity ?? liveIdentity,
    'hermes-link',
    beforeCapture,
  );
  const capturedStat = lstatSync(capture.capturedPath);
  const capturedTarget = capturedStat.isSymbolicLink() ? readlinkSync(capture.capturedPath) : null;
  if (!capturedStat.isSymbolicLink() || capturedTarget !== (expected?.target ?? liveTarget)) {
    restoreCapturedNoClobber(capture, `captured Hermes link content changed: ${linkPath}`);
  }
  deleteCapturedRemovalPath(capture);
  result.removed.push(linkPath);
}

function pushAgentAdvisory(result: AgentSyncRemovalResult, advisory: string): void {
  if (result.advisories === undefined) result.advisories = [];
  result.advisories.push(advisory);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lazily allocate one exclusive backup generation and persist the exact validated bytes. */
function createAgentFileBackup(targets: AgentSyncRemovalTargets): (name: string, bytes: Buffer) => string {
  const genieHome = targets.genieHome ?? resolveGenieHome();
  const stamp = (targets.now ?? (() => new Date()))().toISOString();
  let backupRoot: string | null = null;
  return (name, bytes) => {
    if (backupRoot === null) backupRoot = allocateExclusiveBackupRoot(genieHome, `agent-sync-uninstall-${stamp}`);
    const destination = join(backupRoot, 'claude', 'agents', name);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: 'wx' });
    return destination;
  };
}

function planAgentRemoval(
  asset: AgentSyncAsset,
  backupAgentBytes: (name: string, bytes: Buffer) => string,
  result: AgentSyncRemovalResult,
): FlatAgentOp | null {
  const entry = asset.manifestEntry;
  if (entry === undefined) return null;
  if (asset.missing) return { kind: 'disown', name: entry.name, ownedDigest: entry.digest, prune: true };
  const snapshot = asset.agentSnapshot;
  if (snapshot === undefined || snapshot.kind === 'absent') {
    result.failures.push({ path: asset.path, detail: 'could not inspect the manifest-owned agent during removal' });
    return null;
  }
  if (asset.modified !== true && snapshot.kind === 'file') {
    let backupPath: string;
    try {
      backupPath = backupAgentBytes(entry.name, snapshot.bytes);
    } catch (error) {
      result.failures.push({ path: asset.path, detail: `durable backup failed: ${errorMessage(error)}` });
      return null;
    }
    return {
      kind: 'retire',
      name: entry.name,
      expected: snapshot,
      ownedDigest: entry.digest,
      disposal: 'discard',
      operation: 'remove',
      backupPath,
    };
  }
  return {
    kind: 'retire',
    name: entry.name,
    expected: snapshot,
    ownedDigest: entry.digest,
    disposal: 'keep-aside',
    operation: 'keep',
  };
}

function reportAgentRemovalOutcome(
  outcome: FlatAgentOutcome,
  committed: boolean,
  dir: string,
  result: AgentSyncRemovalResult,
): void {
  const operation = outcome.op;
  const path = join(dir, operation.name);
  if (outcome.status === 'failed' || outcome.status === 'stale') {
    const detail = outcome.reason ?? 'flat-agent transaction did not settle this path';
    result.failures.push({ path, detail });
    pushAgentAdvisory(result, `kept ${path}: ${detail}`);
    return;
  }
  if (!committed) return;
  if (operation.kind === 'disown') return;
  if (operation.kind === 'publish') return;
  if (outcome.status === 'applied') {
    if (outcome.keptPath !== undefined) result.kept.push(outcome.keptPath);
    if (operation.disposal === 'discard') result.removed.push(path);
    if (operation.disposal === 'keep-aside' && outcome.keptPath === undefined) {
      result.failures.push({ path, detail: 'modified agent was disowned without a visible kept-aside path' });
    }
    return;
  }
  if (outcome.conflict === 'changed-before-capture') {
    pushAgentAdvisory(result, `left concurrently changed agent ${path} live and unowned`);
    return;
  }
  if (outcome.keptPath !== undefined) {
    result.kept.push(outcome.keptPath);
    pushAgentAdvisory(
      result,
      `left concurrently appeared agent ${path} live and unowned; preserved prior bytes at ${outcome.keptPath}`,
    );
    return;
  }
  pushAgentAdvisory(result, `left concurrently appeared agent ${path} live and unowned`);
}

/** Execute all selected flat-agent actions in one shared manifest transaction. */
function removeManagedAgentAssets(
  assets: AgentSyncAsset[],
  targets: AgentSyncRemovalTargets,
  result: AgentSyncRemovalResult,
): void {
  const dir = assets[0]?.manifestEntry?.dir;
  if (dir === undefined) return;
  const backupAgentBytes = createAgentFileBackup(targets);
  const operations: FlatAgentOp[] = [];
  for (const asset of assets) {
    const operation = planAgentRemoval(asset, backupAgentBytes, result);
    if (operation !== null) operations.push(operation);
  }
  if (operations.length === 0) return;
  try {
    const transaction = runFlatAgentTransaction(dir, operations, {
      now: targets.now ?? (() => new Date()),
      beforeFileMutation: targets.beforeAgentFileMutation,
      beforeManifestCommit: targets.beforeAgentManifestCommit,
    });
    for (const advisory of transaction.advisories) pushAgentAdvisory(result, advisory);
    for (const outcome of transaction.outcomes) {
      reportAgentRemovalOutcome(outcome, transaction.committed, dir, result);
    }
    if (!transaction.committed && !transaction.outcomes.some((outcome) => outcome.status === 'failed')) {
      result.failures.push({
        path: dir,
        detail: transaction.advisories.join('; ') || 'flat-agent manifest transaction did not commit',
      });
    }
  } catch (error) {
    const detail = `flat-agent removal transaction failed: ${errorMessage(error)}`;
    result.failures.push({ path: dir, detail });
    pushAgentAdvisory(result, detail);
  }
}

function recordAgentAssetIdentityMismatch(path: string, result: AgentSyncRemovalResult, advisory?: string): void {
  result.kept.push(path);
  result.identityMismatch.push(path);
  if (advisory !== undefined) pushAgentAdvisory(result, advisory);
}

/** Reconcile and mutate one collected non-agent asset against its recorded authority. */
function removeCollectedManagedAsset(
  asset: AgentSyncAsset,
  expectedIdentity: AgentAssetIdentity | undefined,
  targets: AgentSyncRemovalTargets,
  options: AgentSyncRemovalOptions,
  result: AgentSyncRemovalResult,
): void {
  try {
    if (asset.kind === 'workflow' && asset.metadataPath) {
      const disposition = removeManagedWorkflow(join(targets.claudeDir ?? resolveClaudeDir(), 'workflows'), {
        beforeRemoval: options.beforeWorkflowRemoval,
        expectedIdentity: expectedIdentity?.kind === 'workflow' ? expectedIdentity : undefined,
      });
      recordAgentAssetDisposition(disposition, asset.path, result);
      return;
    }
    if (asset.kind === 'skill') {
      const disposition = removeManagedSkillTree(asset.path, {
        genieHome: targets.genieHome,
        agent: asset.agent,
        beforeManagedDirRemoval: options.beforeManagedDirRemoval,
        expectedIdentity: expectedIdentity?.kind === 'skill' ? expectedIdentity : undefined,
      });
      recordAgentAssetDisposition(disposition, asset.path, result);
      return;
    }
    removeManagedLink(
      asset.path,
      expectedIdentity?.kind === 'link' ? expectedIdentity : undefined,
      result,
      options.beforeManagedLinkCapture,
    );
  } catch (error) {
    if (error instanceof UninstallIdentityMismatchError) {
      recordAgentAssetIdentityMismatch(asset.path, result, error.message);
      return;
    }
    result.failures.push({ path: asset.path, detail: errorMessage(error) });
  }
}

/** Settle recorded links that disappeared from live collection without widening the plan. */
function removeUncollectedPlannedLinks(
  assets: AgentSyncAsset[],
  plannedByPath: Map<string, AgentAssetIdentity> | null,
  options: AgentSyncRemovalOptions,
  result: AgentSyncRemovalResult,
): void {
  if (plannedByPath === null) return;
  const collectedPaths = new Set(assets.map((asset) => resolve(asset.path)));
  for (const [path, identity] of plannedByPath) {
    if (identity.kind !== 'link' || collectedPaths.has(path)) continue;
    try {
      removeManagedLink(path, identity, result, options.beforeManagedLinkCapture);
    } catch (error) {
      if (error instanceof UninstallIdentityMismatchError) {
        recordAgentAssetIdentityMismatch(path, result, error.message);
      } else {
        result.failures.push({ path, detail: errorMessage(error) });
      }
    }
  }
}

function removeCollectedAgentAssets(
  assets: AgentSyncAsset[],
  targets: AgentSyncRemovalTargets,
  options: AgentSyncRemovalOptions,
  plannedByPath: Map<string, AgentAssetIdentity> | null,
  result: AgentSyncRemovalResult,
): void {
  const agentAssets: AgentSyncAsset[] = [];
  for (const asset of assets) {
    const expectedIdentity = plannedByPath?.get(resolve(asset.path));
    // Defense in depth: a recorded identity whose kind does not match the object
    // now occupying the path is a physical replacement of a different kind. Refuse
    // it as an identity mismatch rather than degrading to an unbound removal.
    if (expectedIdentity !== undefined && expectedIdentity.kind !== asset.kind) {
      recordAgentAssetIdentityMismatch(asset.path, result);
      continue;
    }
    if (asset.kind === 'agent') {
      if (expectedIdentity !== undefined && !agentIdentityMatches(expectedIdentity, asset)) {
        recordAgentAssetIdentityMismatch(asset.path, result);
      } else {
        agentAssets.push(asset);
      }
      continue;
    }
    removeCollectedManagedAsset(asset, expectedIdentity, targets, options, result);
  }
  removeUncollectedPlannedLinks(assets, plannedByPath, options, result);
  removeManagedAgentAssets(agentAssets, targets, result);
}

export interface UninstallFailure {
  step: string;
  detail: string;
}

/** A recorded-removable item left byte-identical because its identity diverged from the batch record. */
export interface UninstallPreservation {
  step: string;
  detail: string;
}

export interface UninstallResult {
  failures: UninstallFailure[];
  /** Identity-mismatched items preserved byte-identical; surfaced prominently, never silently. */
  preserved?: UninstallPreservation[];
  /** Non-failure advisories (e.g. a legacy batch re-planned from current live state). */
  notes?: string[];
}

function recordPreservation(result: UninstallResult, item: UninstallPreservation): void {
  if (result.preserved === undefined) result.preserved = [];
  result.preserved.push(item);
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
  discardLegacyDecision?: (genieHome: string) => void;
}

export interface UninstallBatchProgressController {
  abort(member: string): void;
  begin(member: string): void;
  complete(member: string): void;
  /** Durably record that an identity-mismatched member was preserved, not removed. */
  preserve(member: string): void;
  isCompleted(member: string): boolean;
  isPreserved(member: string): boolean;
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
  const discardLegacyDecision = operations.discardLegacyDecision ?? discardLegacyUninstallBatchDecision;
  let decision: UninstallBatchDecision;
  let legacyMigrationNote: string | null = null;
  try {
    decision = readDecision(genieHome) ?? recordDecision(genieHome, requestedScope);
  } catch (error) {
    if (!(error instanceof LegacyUninstallBatchJournalError)) throw error;
    // Authentic legacy journal from a prior release: discard it and re-record a
    // fresh v3 decision from the CURRENT live scope. In particular, v2 carried
    // only a pathname-presence boolean for GENIE_HOME and can never authorize a
    // deletion. Safe because every published
    // external transaction was recovered before this ran and each member removal
    // is independently idempotent/transactional; an in-flight v1 member is only
    // noted (recovered transactionally), never replayed from stale authority.
    if (error.interruptedMember !== null) {
      legacyMigrationNote = `Re-planned a legacy v${error.schemaVersion} uninstall batch from current live state; its interrupted member ${error.interruptedMember} was recovered transactionally, not replayed.`;
    }
    discardLegacyDecision(genieHome);
    decision = recordDecision(genieHome, requestedScope);
  }
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
    isPreserved(member) {
      return decision.progress.preserved.includes(assertMember(member));
    },
    begin(member) {
      const exactMember = assertMember(member);
      if (decision.progress.active !== null) throw new Error('another uninstall batch member is already active');
      if (decision.progress.completed.includes(exactMember)) {
        throw new Error(`uninstall batch member is already completed: ${exactMember}`);
      }
      if (decision.progress.preserved.includes(exactMember)) {
        throw new Error(`uninstall batch member is already preserved: ${exactMember}`);
      }
      persist({ active: exactMember, completed: decision.progress.completed, preserved: decision.progress.preserved });
    },
    complete(member) {
      const exactMember = assertMember(member);
      if (decision.progress.active !== exactMember) {
        throw new Error(`uninstall batch completion receipt does not match the active member: ${exactMember}`);
      }
      persist({
        active: null,
        completed: [...decision.progress.completed, exactMember].sort(),
        preserved: decision.progress.preserved,
      });
    },
    preserve(member) {
      const exactMember = assertMember(member);
      if (decision.progress.active !== exactMember) {
        throw new Error(`uninstall batch preserve receipt does not match the active member: ${exactMember}`);
      }
      // A mismatched member can never regain removal authority (its live identity
      // can no longer equal the record), so a durable preserve receipt lets the
      // batch clear instead of stranding the journal forever on an object we must
      // not touch.
      persist({
        active: null,
        completed: decision.progress.completed,
        preserved: [...decision.progress.preserved, exactMember].sort(),
      });
    },
    abort(member) {
      const exactMember = assertMember(member);
      if (decision.progress.active !== exactMember) {
        throw new Error(`uninstall batch abort receipt does not match the active member: ${exactMember}`);
      }
      persist({ active: null, completed: decision.progress.completed, preserved: decision.progress.preserved });
    },
  };
  const result = cleanup(decision.scope, progress);
  if (legacyMigrationNote !== null) {
    if (result.notes === undefined) result.notes = [];
    result.notes.push(legacyMigrationNote);
  }
  if (result.failures.length > 0) return { decision, result };
  if (decision.progress.active !== null) {
    result.failures.push({
      step: 'Finalizing uninstall batch journal',
      detail: `member ${decision.progress.active} has no durable completion receipt`,
    });
    return { decision, result };
  }
  // A member settles when it is completed OR durably preserved; the batch clears
  // once completed ∪ preserved covers every recorded member.
  const incomplete = [...uninstallBatchMembers(decision.scope, decision.genieHome)].filter(
    (member) => !decision.progress.completed.includes(member) && !decision.progress.preserved.includes(member),
  );
  if (incomplete.length > 0) {
    result.failures.push({
      step: 'Finalizing uninstall batch journal',
      detail: `requested members lack durable completion or preservation receipts: ${incomplete.join(', ')}`,
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
  genieHomeIdentity: PhysicalRootIdentity | null;
  genieHomeRemovalDigest: string | null;
  hasUnprovenHookScript: boolean;
  legacyReport: ReturnType<typeof detectV4Install>;
  hasOwnedRules: boolean;
  ownedRules: ProvenV4Rules | null;
  existingSymlinks: string[];
  ownedSourceSymlinks: OwnedSourceSymlink[];
  agentAssets: AgentSyncAsset[];
  claudeAgentManifest: AgentFilesManifestView;
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
  captureGenieHomeIdentity?: (path: string) => PhysicalRootIdentity | null;
  captureGenieHomeRemovalDigest?: (path: string, identity: PhysicalRootIdentity) => string;
  hookScriptExists?: () => boolean;
  detectV4Install?: typeof detectV4Install;
  existingSymlinks?: (genieDir: string) => string[];
  collectAgentSyncAssets?: typeof collectAgentSyncAssets;
  inspectAgentFilesManifestState?: (dir: string) => AgentFilesManifestView;
  inspectCodexAgentOwnership?: typeof inspectCodexAgentOwnership;
  inspectRuntimeClientAvailability?: typeof inspectRuntimeClientAvailability;
  inspectRuntimeIntegrationEvidence?: typeof inspectRuntimeIntegrationEvidence;
  hasPendingBatch?: (genieDir: string) => boolean;
  hasPendingTransactions?: typeof hasPendingUninstallTransactions;
}

function captureProvenV4RulesIdentity(path: string): ProvenV4Rules {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`marker-proven v4 rules are not a physical regular file: ${path}`);
  }
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  const after = lstatSync(path);
  if (!samePhysicalRootIdentity(physicalRootIdentity(before), physicalRootIdentity(after))) {
    throw new Error(`marker-proven v4 rules changed while their identity was captured: ${path}`);
  }
  return { path: resolve(path), digest, identity: physicalRootIdentity(after) };
}

function sameProvenV4Rules(left: ProvenV4Rules, right: ProvenV4Rules): boolean {
  return (
    left.path === right.path && left.digest === right.digest && samePhysicalRootIdentity(left.identity, right.identity)
  );
}

/** Build a complete read-only uninstall plan. Call again under the lease before mutation. */
export function inspectUninstallPlan(
  genieDir = getGenieDir(),
  removeMarketplace = false,
  inspectors: UninstallPlanInspectors = {},
): UninstallPlan {
  const detectLegacy = inspectors.detectV4Install ?? detectV4Install;
  const legacyReport = detectLegacy();
  let ownedRules: ProvenV4Rules | null = null;
  if (legacyReport.rulesFile.status === 'v4-markers') {
    const before = captureProvenV4RulesIdentity(legacyReport.rulesFile.path);
    const confirmed = detectLegacy();
    if (confirmed.rulesFile.status !== 'v4-markers' || resolve(confirmed.rulesFile.path) !== before.path) {
      throw new Error('marker-proven v4 rules changed while the uninstall plan was inspected');
    }
    const after = captureProvenV4RulesIdentity(confirmed.rulesFile.path);
    if (!sameProvenV4Rules(before, after)) {
      throw new Error('marker-proven v4 rules changed while the uninstall plan was inspected');
    }
    ownedRules = after;
  }
  // Production consumes one manifest inspection for both the asset allowlist
  // and source-retirement gate. Test-only legacy injectors remain paired with
  // an explicit manifest seam instead of causing a second production read.
  const agentInspection =
    inspectors.collectAgentSyncAssets === undefined && inspectors.inspectAgentFilesManifestState === undefined
      ? inspectAgentSyncAssets()
      : {
          assets: (inspectors.collectAgentSyncAssets ?? collectAgentSyncAssets)(),
          claudeAgentManifest:
            inspectors.inspectAgentFilesManifestState?.(join(resolveClaudeDir(), 'agents')) ??
            ({ kind: 'absent' } as const),
        };
  const agentAssets = agentInspection.assets;
  const claudeAgentManifest = agentInspection.claudeAgentManifest;
  const codexRoleAgents = (inspectors.inspectCodexAgentOwnership ?? inspectCodexAgentOwnership)();
  const runtimeClients = (inspectors.inspectRuntimeClientAvailability ?? inspectRuntimeClientAvailability)();
  const genieHomeIdentity =
    inspectors.captureGenieHomeIdentity !== undefined || inspectors.hasGenieDir !== undefined
      ? (inspectors.captureGenieHomeIdentity?.(genieDir) ?? null)
      : inspectRemovableGenieRoot(genieDir);
  const hasGenieDir = inspectors.hasGenieDir?.(genieDir) ?? genieHomeIdentity !== null;
  if (hasGenieDir !== (genieHomeIdentity !== null)) {
    throw new Error('uninstall plan must bind every removable Genie root to its physical identity');
  }
  const genieHomeRemovalDigest =
    genieHomeIdentity === null
      ? null
      : (inspectors.captureGenieHomeRemovalDigest ?? captureGenieHomeRemovalDigest)(genieDir, genieHomeIdentity);
  const existingSymlinks =
    inspectors.existingSymlinks?.(genieDir) ??
    SYMLINKS.filter((name) => isGenieSymlink(join(LOCAL_BIN, name), genieDir));
  const ownedSourceSymlinks = existingSymlinks.map((name) => {
    if (!SYMLINKS.some((candidate) => candidate === name)) {
      throw new Error(`uninstall plan contains an unsupported source symlink name: ${name}`);
    }
    const owned = ownedSourceSymlink(join(LOCAL_BIN, name), genieDir);
    if (owned === null)
      throw new Error(`source-install symlink changed while the uninstall plan was recorded: ${name}`);
    return owned;
  });
  return {
    genieDir,
    hasGenieDir,
    genieHomeIdentity,
    genieHomeRemovalDigest,
    hasUnprovenHookScript: (inspectors.hookScriptExists ?? hookScriptExists)(),
    legacyReport,
    hasOwnedRules: ownedRules !== null,
    ownedRules,
    existingSymlinks,
    ownedSourceSymlinks,
    agentAssets,
    claudeAgentManifest,
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

interface PlannedRemovalAsset {
  path: string;
  identity: AgentAssetIdentity;
}

interface PlannedFlatAgent extends PlannedRemovalAsset {
  identity: Extract<AgentAssetIdentity, { kind: 'agent' }>;
}

function recordRemovalFailures(removal: AgentSyncRemovalResult, label: string, result: UninstallResult): void {
  for (const failure of removal.failures) {
    result.failures.push({ step: `${label} ${contractPath(failure.path)}`, detail: failure.detail });
  }
}

function removeOneNonAgentAsset(
  asset: PlannedRemovalAsset,
  result: UninstallResult,
  progress: UninstallBatchProgressController,
): void {
  const member = uninstallBatchMemberId('asset', asset.path);
  if (progress.isCompleted(member) || progress.isPreserved(member)) return;
  progress.begin(member);
  const removal = removeAgentSyncAssetsLocked({}, { plannedAssets: [{ path: asset.path, identity: asset.identity }] });
  if (removal.failures.length > 0) {
    if (removal.removed.length === 0) progress.abort(member);
    recordRemovalFailures(removal, 'Removing synced asset', result);
    return;
  }
  if (removal.kept.length === 0) {
    progress.complete(member);
    if (removal.removed.length > 0) {
      console.log(`  \x1b[32m+\x1b[0m Removed managed asset: ${contractPath(asset.path)}`);
    }
    return;
  }
  const detail =
    removal.identityMismatch.length > 0
      ? 'recorded removable asset was replaced by a different managed object after the uninstall batch; preserved it byte-identical'
      : 'recorded removable asset was modified after the uninstall batch; preserved it byte-identical';
  console.log(`  \x1b[33m!\x1b[0m Preserved managed asset byte-identical: ${contractPath(asset.path)}`);
  recordPreservation(result, { step: `Preserving synced asset ${contractPath(asset.path)}`, detail });
  progress.preserve(member);
}

function appendRemovalAdvisories(removal: AgentSyncRemovalResult, result: UninstallResult): void {
  if (removal.advisories === undefined || removal.advisories.length === 0) return;
  if (result.notes === undefined) result.notes = [];
  result.notes.push(...removal.advisories);
}

function settleFlatAgentProgress(
  member: string,
  removal: AgentSyncRemovalResult,
  result: UninstallResult,
  progress: UninstallBatchProgressController,
): void {
  if (removal.identityMismatch.length === 0) {
    progress.complete(member);
    return;
  }
  for (const path of removal.identityMismatch) {
    recordPreservation(result, {
      step: `Preserving flat agent ${contractPath(path)}`,
      detail: 'recorded flat-agent identity changed after the uninstall batch; preserved it byte-identical',
    });
  }
  progress.preserve(member);
}

function reportFlatAgentRemoval(removal: AgentSyncRemovalResult): void {
  for (const path of removal.removed) {
    console.log(`  \x1b[32m+\x1b[0m Removed managed flat agent: ${contractPath(path)}`);
  }
  for (const path of removal.kept.filter((path) => !removal.identityMismatch.includes(path))) {
    console.log(`  \x1b[33m!\x1b[0m Preserved modified flat agent at ${contractPath(path)}`);
  }
}

function removeFlatAgentBatch(
  plannedAgents: PlannedFlatAgent[],
  result: UninstallResult,
  progress: UninstallBatchProgressController,
): void {
  if (plannedAgents.length === 0) return;
  const member = uninstallBatchMemberId(
    'asset',
    `flat-agents:${plannedAgents
      .map((asset) => resolve(asset.path))
      .sort()
      .join('\n')}`,
  );
  if (progress.isCompleted(member) || progress.isPreserved(member)) return;
  progress.begin(member);
  const removal = removeAgentSyncAssetsLocked(
    {},
    { plannedAssets: plannedAgents.map((asset) => ({ path: asset.path, identity: asset.identity })) },
  );
  appendRemovalAdvisories(removal, result);
  if (removal.failures.length > 0) {
    // removeAgentSyncAssetsLocked has returned, so there is no ambiguous in-flight
    // mutation left behind. Any successful per-file outcomes are idempotent and
    // the immutable batch scope can safely retry the still-present members.
    // Clear the active receipt on every structured failure; retaining it here
    // permanently strands the batch after a partial success.
    progress.abort(member);
    recordRemovalFailures(removal, 'Removing flat agent', result);
    return;
  }
  settleFlatAgentProgress(member, removal, result, progress);
  reportFlatAgentRemoval(removal);
}

function removeSyncedAgentAssets(
  agentAssets: UninstallBatchScope['agentAssets'],
  result: UninstallResult,
  progress: UninstallBatchProgressController,
): void {
  if (!agentAssets.some((asset) => asset.disposition === 'remove')) return;
  console.log('\x1b[2mRemoving synced agent assets...\x1b[0m');
  for (const asset of agentAssets) {
    if (asset.disposition !== 'remove' || asset.identity.kind === 'agent') continue;
    removeOneNonAgentAsset({ path: asset.path, identity: asset.identity }, result, progress);
    if (result.failures.length > 0) return;
  }
  const flatAgents: PlannedFlatAgent[] = [];
  for (const asset of agentAssets) {
    if (asset.disposition === 'remove' && asset.identity.kind === 'agent') {
      flatAgents.push({ path: asset.path, identity: asset.identity });
    }
  }
  removeFlatAgentBatch(flatAgents, result, progress);
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
  result: UninstallResult,
  progress: UninstallBatchProgressController,
): void {
  const member = uninstallBatchRuntimeMemberId(scope);
  if (progress.isCompleted(member)) return;
  const current = inspectCodexAgentOwnership();
  const runtimeEvidence = inspectRuntimeIntegrationEvidence();
  const violations = uninstallBatchIntegrationViolations(scope, current, runtimeEvidence);
  if (violations.length > 0) {
    result.failures.push({
      step: 'Validating runtime integration uninstall allowlist',
      detail: violations.join('; '),
    });
    return;
  }
  progress.begin(member);
  const failureCount = result.failures.length;
  // Restrict role-agent removal to the recorded plan and bind it to the recorded
  // identity, so a role TOML swapped for a different clean file is preserved.
  const plannedRoleAgents = new Map<string, { digest: string; mode: number }>();
  for (const agent of scope.codexRoleAgents) {
    if (agent.disposition === 'remove') {
      plannedRoleAgents.set(agent.name, { digest: agent.identity.digest, mode: agent.identity.mode });
    }
  }
  const integrations = removeRuntimeIntegrations({
    removeMarketplace: scope.removeMarketplace,
    installedEvidence: scope.runtimePlugins,
    detected: uninstallBatchRuntimeTargets(scope),
    plannedRoleAgents,
  });
  for (const name of integrations.agents.keptModified) {
    console.log(`  \x1b[33m!\x1b[0m Preserved Codex role agent byte-identical: ${name}`);
    if (plannedRoleAgents.has(name)) {
      recordPreservation(result, {
        step: `Preserving Codex role agent ${name}`,
        detail: 'recorded removable role agent was modified after the uninstall batch; preserved it byte-identical',
      });
    }
  }
  for (const name of integrations.agents.keptIdentityMismatch) {
    console.log(`  \x1b[33m!\x1b[0m Preserved Codex role agent byte-identical (identity mismatch): ${name}`);
    recordPreservation(result, {
      step: `Preserving Codex role agent ${name}`,
      detail:
        'recorded removable role agent was replaced after the uninstall batch; preserved the replacement byte-identical',
    });
  }
  for (const failure of integrations.agents.failures) {
    result.failures.push({ step: `Removing Codex role agent ${failure.name}`, detail: failure.detail });
  }
  for (const step of integrations.steps) {
    if (!step.ok) result.failures.push({ step: `Removing ${step.runtime} ${step.operation}`, detail: step.detail });
  }
  settleRuntimeIntegrationProgress(member, result.failures.length !== failureCount, progress);
}

/**
 * Settle the runtime-integration member's durable receipt once
 * removeRuntimeIntegrations has returned. At that point there is no ambiguous
 * in-flight mutation left behind and successful per-step outcomes are
 * idempotent, so a structured failure must clear the active receipt; retaining
 * it permanently strands the batch behind the interrupted-slot replay guard.
 */
export function settleRuntimeIntegrationProgress(
  member: string,
  hadFailures: boolean,
  progress: UninstallBatchProgressController,
): void {
  if (hadFailures) progress.abort(member);
  else progress.complete(member);
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

export interface V4RulesRemovalOptions {
  /** Runs after the exact inode is proven and before it is atomically captured. */
  beforeCapture?: (path: string) => void;
  /** Runs after the captured bytes are durably backed up but before disposal. */
  afterBackup?: (path: string, backupPath: string) => void;
}

/** Atomically capture and remove only the exact marker-proven v4 rules object. */
export function removeProvenV4Rules(
  genieDir: string,
  rules: ProvenV4Rules,
  options: V4RulesRemovalOptions = {},
): string | null {
  const initialStat = lstatOrNull(rules.path);
  // A user or a prior idempotent attempt may remove the recorded object before
  // this member begins. There is then no live pathname authority to exercise.
  if (initialStat === null) return null;
  if (!initialStat.isFile() || initialStat.isSymbolicLink()) {
    throw new UninstallIdentityMismatchError(
      `recorded marker-proven v4 rules were replaced before capture: ${rules.path}`,
    );
  }
  let live: ProvenV4Rules;
  try {
    live = captureProvenV4RulesIdentity(rules.path);
  } catch (error) {
    const after = lstatOrNull(rules.path);
    if (after === null) return null;
    if (!samePhysicalRootIdentity(physicalRootIdentity(initialStat), physicalRootIdentity(after))) {
      throw new UninstallIdentityMismatchError(
        `recorded marker-proven v4 rules were replaced while being inspected: ${rules.path}`,
      );
    }
    throw error;
  }
  if (!sameProvenV4Rules(live, rules)) {
    throw new UninstallIdentityMismatchError(`recorded marker-proven v4 rules changed before capture: ${rules.path}`);
  }
  const capture = captureExpectedRemovalPath(rules.path, rules.identity, 'v4-rules', options.beforeCapture);
  const capturedStat = lstatSync(capture.capturedPath);
  const capturedBytes =
    capturedStat.isFile() && !capturedStat.isSymbolicLink() ? readFileSync(capture.capturedPath) : null;
  const capturedDigest = capturedBytes === null ? null : createHash('sha256').update(capturedBytes).digest('hex');
  if (capturedBytes === null || capturedDigest !== rules.digest) {
    restoreCapturedNoClobber(capture, `captured marker-proven v4 rules content changed: ${rules.path}`);
  }
  const recoveryRoot = join(dirname(resolve(genieDir)), '.genie-recovery', 'uninstall-v4');
  ensurePhysicalRecoveryRoot(recoveryRoot);
  const backup = join(recoveryRoot, `${basename(rules.path)}.${randomBytes(12).toString('hex')}`);
  writeFileSync(backup, capturedBytes, { flag: 'wx', mode: capturedStat.mode & 0o777 });
  const backupFd = openSync(backup, 'r');
  try {
    fsyncSync(backupFd);
  } finally {
    closeSync(backupFd);
  }
  fsyncDirectoryBestEffort(recoveryRoot);
  options.afterBackup?.(rules.path, backup);
  const finalStat = lstatSync(capture.capturedPath);
  const finalDigest = finalStat.isFile()
    ? createHash('sha256').update(readFileSync(capture.capturedPath)).digest('hex')
    : null;
  if (
    !samePhysicalRootIdentity(physicalRootIdentity(finalStat), capture.capturedIdentity) ||
    finalDigest !== rules.digest
  ) {
    throw new UninstallIdentityMismatchError(
      `captured v4 rules changed after backup; preserved quarantine: ${capture.quarantineRoot}`,
    );
  }
  deleteCapturedRemovalPath(capture);
  return backup;
}

export function removeRulesMember(
  genieDir: string,
  ownedRules: ProvenV4Rules | null,
  result: UninstallResult,
  progress: UninstallBatchProgressController,
  options: V4RulesRemovalOptions = {},
): UninstallFailure | null {
  if (ownedRules === null) return null;
  const member = uninstallBatchMemberId('rules', ownedRules.path);
  if (progress.isCompleted(member) || progress.isPreserved(member)) return null;
  progress.begin(member);
  console.log('\x1b[2mBacking up and removing marker-proven v4 orchestration rules...\x1b[0m');
  try {
    removeProvenV4Rules(genieDir, ownedRules, options);
    progress.complete(member);
    console.log(`  \x1b[32m+\x1b[0m Marker-proven orchestration rules removed (${contractPath(ownedRules.path)})`);
    return null;
  } catch (error) {
    const detail = errorMessage(error);
    if (error instanceof UninstallIdentityMismatchError) {
      progress.preserve(member);
      recordPreservation(result, {
        step: `Preserving v4 rules ${contractPath(ownedRules.path)}`,
        detail,
      });
      return null;
    }
    progress.abort(member);
    return { step: 'Backing up and removing marker-proven v4 orchestration rules', detail };
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function preservedGenieDirEntry(name: string): boolean {
  return name === 'state-backups' || name === AGENT_SYNC_LOCK_NAME;
}

export interface GenieHomeRemovalOptions {
  /** Deterministic barrier after authenticated planning but before the live-tree commitment check. */
  beforeRemovalSnapshot?: (genieDir: string) => void;
  /** Deterministic race barrier used by destructive-path fixtures. */
  beforeEntryCapture?: (entryPath: string) => void;
  /** Runs after the live name is captured but before root identity is revalidated. */
  afterEntryCapture?: (entryPath: string, capturedPath: string) => void;
  /** Runs after expected children are removed but before a validated directory is removed. */
  beforeDirectoryRemoval?: (directoryPath: string) => void;
}

interface GenieRemovalSnapshotBase {
  identity: PhysicalRootIdentity;
  nlink: number;
}

type GenieRemovalSnapshot =
  | (GenieRemovalSnapshotBase & {
      kind: 'directory';
      entries: Array<{ name: string; snapshot: GenieRemovalSnapshot }>;
    })
  | (GenieRemovalSnapshotBase & { kind: 'file'; digest: string })
  | (GenieRemovalSnapshotBase & { kind: 'symlink'; target: string })
  | (GenieRemovalSnapshotBase & { kind: 'other'; physicalKind: string });

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRemovalSnapshotBase(expected: GenieRemovalSnapshotBase, current: GenieRemovalSnapshotBase): boolean {
  return expected.nlink === current.nlink && samePhysicalRootIdentity(expected.identity, current.identity);
}

function specialPhysicalKind(stat: Stats): string {
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  if (stat.isBlockDevice()) return 'block-device';
  if (stat.isCharacterDevice()) return 'character-device';
  return 'other';
}

function assertStableRemovalNode(path: string, before: Stats, after: Stats): void {
  if (
    !samePhysicalRootIdentity(physicalRootIdentity(before), physicalRootIdentity(after)) ||
    before.nlink !== after.nlink
  ) {
    throw new Error(`Genie install entry changed while its exact removal snapshot was captured: ${path}`);
  }
}

/**
 * Capture an exact physical tree. Unlike managed-skill digests this intentionally
 * has no manifest exclusions: every descendant name, physical identity, mode,
 * file byte, and symlink target is part of source-removal authority.
 */
function captureGenieRemovalSnapshot(path: string): GenieRemovalSnapshot {
  const before = lstatSync(path);
  const base = { identity: physicalRootIdentity(before), nlink: before.nlink };
  if (before.isDirectory() && !before.isSymbolicLink()) {
    const names = readdirSync(path).sort();
    const entries = names.map((name) => ({ name, snapshot: captureGenieRemovalSnapshot(join(path, name)) }));
    const afterNames = readdirSync(path).sort();
    const after = lstatSync(path);
    assertStableRemovalNode(path, before, after);
    if (!sameStringList(names, afterNames)) {
      throw new Error(`Genie install directory changed while its exact removal snapshot was captured: ${path}`);
    }
    return { ...base, kind: 'directory', entries };
  }
  if (before.isFile()) {
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    assertStableRemovalNode(path, before, lstatSync(path));
    return { ...base, kind: 'file', digest };
  }
  if (before.isSymbolicLink()) {
    const target = readlinkSync(path);
    assertStableRemovalNode(path, before, lstatSync(path));
    return { ...base, kind: 'symlink', target };
  }
  assertStableRemovalNode(path, before, lstatSync(path));
  return { ...base, kind: 'other', physicalKind: specialPhysicalKind(before) };
}

function sameGenieRemovalSnapshot(expected: GenieRemovalSnapshot, current: GenieRemovalSnapshot): boolean {
  if (expected.kind !== current.kind || !sameRemovalSnapshotBase(expected, current)) return false;
  if (expected.kind === 'file') return current.kind === 'file' && expected.digest === current.digest;
  if (expected.kind === 'symlink') return current.kind === 'symlink' && expected.target === current.target;
  if (expected.kind === 'other') {
    return current.kind === 'other' && expected.physicalKind === current.physicalKind;
  }
  if (current.kind !== 'directory' || expected.entries.length !== current.entries.length) return false;
  return expected.entries.every((entry, index) => {
    const currentEntry = current.entries[index];
    return (
      currentEntry !== undefined &&
      entry.name === currentEntry.name &&
      sameGenieRemovalSnapshot(entry.snapshot, currentEntry.snapshot)
    );
  });
}

function assertGenieRemovalSnapshot(path: string, expected: GenieRemovalSnapshot): void {
  let current: GenieRemovalSnapshot;
  try {
    current = captureGenieRemovalSnapshot(path);
  } catch (error) {
    throw new Error(`captured Genie install tree could not be revalidated: ${errorMessage(error)}`);
  }
  if (!sameGenieRemovalSnapshot(expected, current)) {
    throw new Error('captured Genie install tree changed from its exact root-bound snapshot');
  }
}

interface GenieRemovalEntrySnapshot {
  name: string;
  snapshot: GenieRemovalSnapshot;
}

function removalSnapshotDigest(entries: readonly GenieRemovalEntrySnapshot[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function captureGenieRemovalEntries(
  genieDir: string,
  expectedIdentity: PhysicalRootIdentity,
): GenieRemovalEntrySnapshot[] {
  if (assertExpectedGenieRoot(genieDir, expectedIdentity) !== 'present') return [];
  const names = readdirSync(genieDir)
    .filter((name) => !preservedGenieDirEntry(name))
    .sort();
  const entries = names.map((name) => ({ name, snapshot: captureGenieRemovalSnapshot(join(genieDir, name)) }));
  if (assertExpectedGenieRoot(genieDir, expectedIdentity) !== 'present') return [];
  const afterNames = readdirSync(genieDir)
    .filter((name) => !preservedGenieDirEntry(name))
    .sort();
  if (!sameStringList(names, afterNames)) {
    throw new Error('Genie install root changed while its exact removal commitment was captured');
  }
  return entries;
}

function captureGenieHomeRemovalDigest(genieDir: string, expectedIdentity: PhysicalRootIdentity): string {
  return removalSnapshotDigest(captureGenieRemovalEntries(genieDir, expectedIdentity));
}

/**
 * Delete a preflight-matched tree without a recursive pathname removal. Every
 * subtree is revalidated immediately before it is touched, and rmdir is the
 * final fail-closed check: a late foreign descendant makes it fail and survive.
 */
function removeValidatedGenieTree(
  path: string,
  expected: GenieRemovalSnapshot,
  options: GenieHomeRemovalOptions,
): void {
  assertGenieRemovalSnapshot(path, expected);
  if (expected.kind !== 'directory') {
    unlinkSync(path);
    return;
  }
  for (const entry of expected.entries) {
    removeValidatedGenieTree(join(path, entry.name), entry.snapshot, options);
  }
  options.beforeDirectoryRemoval?.(path);
  rmdirSync(path);
}

function removeEmptyCaptureDir(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    if (!isNodeErrorCode(error, 'ENOENT') && !isNodeErrorCode(error, 'ENOTEMPTY')) throw error;
  }
}

function assertExpectedGenieRoot(genieDir: string, expectedIdentity: PhysicalRootIdentity): 'present' | 'absent' {
  const current = lstatOrNull(genieDir);
  if (current === null) return 'absent';
  if (!samePhysicalRootIdentity(expectedIdentity, physicalRootIdentity(current))) {
    throw new Error(`recorded Genie install root was replaced; preserved the replacement at ${genieDir}`);
  }
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new Error(`recorded Genie install root is no longer a physical directory: ${genieDir}`);
  }
  return 'present';
}

/**
 * Remove only attempt-owned captures, never the live GENIE_HOME pathname.
 *
 * Each removable child is atomically parked outside the root. The root's
 * physical identity is then revalidated before that captured object may be
 * deleted. A pathname replacement therefore survives (at its live name or at
 * the reported capture path), while state-backups and the active lock never
 * leave the original root.
 */
function removeOneCommittedGenieEntry(
  genieDir: string,
  expectedIdentity: PhysicalRootIdentity,
  entry: GenieRemovalEntrySnapshot,
  options: GenieHomeRemovalOptions,
): 'removed' | 'root-absent' {
  const entryPath = join(genieDir, entry.name);
  const captureDir = mkdtempSync(join(dirname(genieDir), `.${basename(genieDir)}.uninstall-capture-`));
  const capturedPath = join(captureDir, 'object');
  let captured = false;
  let capturedFromExpectedRoot = false;
  try {
    options.beforeEntryCapture?.(entryPath);
    try {
      renameSync(entryPath, capturedPath);
      captured = true;
      capturedFromExpectedRoot = samePhysicalRootIdentity(expectedIdentity, capturePhysicalRootIdentity(genieDir));
      fsyncDirectoryBestEffort(dirname(genieDir));
      fsyncDirectoryBestEffort(captureDir);
    } catch (error) {
      if (!isNodeErrorCode(error, 'ENOENT')) throw error;
      const state = assertExpectedGenieRoot(genieDir, expectedIdentity);
      if (state === 'absent') return 'root-absent';
      throw new Error(`Genie install entry changed before capture; preserved live state at ${entryPath}`);
    }
    options.afterEntryCapture?.(entryPath, capturedPath);
    if (assertExpectedGenieRoot(genieDir, expectedIdentity) !== 'present') {
      throw new Error('Genie install root disappeared after capture');
    }
    // Compare the entire parked tree before consulting the root observation.
    // This makes nested-ABA regressions exercise the full-tree boundary rather
    // than passing only because the replacement root happened to be observed.
    assertGenieRemovalSnapshot(capturedPath, entry.snapshot);
    if (!capturedFromExpectedRoot) throw new Error('Genie install entry was captured from a replacement root');
    removeValidatedGenieTree(capturedPath, entry.snapshot, options);
    captured = false;
    fsyncDirectoryBestEffort(captureDir);
    fsyncDirectoryBestEffort(dirname(genieDir));
    return 'removed';
  } catch (error) {
    if (captured) throw new Error(`${errorMessage(error)}; captured bytes preserved at ${capturedPath}`);
    throw error;
  } finally {
    if (!captured) removeEmptyCaptureDir(captureDir);
  }
}

function removeGenieDirPreservingStateBackups(
  genieDir: string,
  expectedIdentity: PhysicalRootIdentity,
  expectedRemovalDigest: string,
  options: GenieHomeRemovalOptions = {},
): void {
  if (assertExpectedGenieRoot(genieDir, expectedIdentity) === 'absent') return;
  options.beforeRemovalSnapshot?.(genieDir);
  const entries = captureGenieRemovalEntries(genieDir, expectedIdentity);
  if (removalSnapshotDigest(entries) !== expectedRemovalDigest) {
    throw new Error('Genie install tree changed after its authenticated removal commitment; preserved live bytes');
  }
  if (assertExpectedGenieRoot(genieDir, expectedIdentity) !== 'present') return;
  for (const entry of entries) {
    if (removeOneCommittedGenieEntry(genieDir, expectedIdentity, entry, options) === 'root-absent') return;
  }
  if (assertExpectedGenieRoot(genieDir, expectedIdentity) === 'absent') return;
  const unexpected = readdirSync(genieDir).filter((name) => !preservedGenieDirEntry(name));
  if (unexpected.length > 0) {
    throw new Error(`new Genie install state appeared during removal and was preserved: ${unexpected.join(', ')}`);
  }
}

/** A durable-backups/active-lock-only root is recovery state, not an installed Genie tree. */
export function hasRemovableGenieInstallState(genieDir: string): boolean {
  try {
    const stat = lstatSync(genieDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
    return readdirSync(genieDir).some((name) => !preservedGenieDirEntry(name));
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return false;
    return true;
  }
}

function removeGenieHomeMember(
  genieDir: string,
  expectedIdentity: PhysicalRootIdentity | null,
  expectedRemovalDigest: string | null,
  progress: UninstallBatchProgressController,
  options: GenieHomeRemovalOptions = {},
): UninstallFailure | null {
  if (expectedIdentity === null && expectedRemovalDigest === null) return null;
  if (expectedIdentity === null || expectedRemovalDigest === null) {
    throw new Error('Genie root removal authority is incomplete; identity and exact commitment are both required');
  }
  const member = uninstallBatchMemberId('home', resolve(genieDir));
  if (progress.isCompleted(member) || progress.isPreserved(member)) return null;
  const manifest = readAgentFilesManifestState(join(resolveClaudeDir(), 'agents'));
  if (manifest.kind === 'unsafe' || (manifest.kind === 'managed' && Object.keys(manifest.files).length > 0)) {
    return {
      step: 'Validating Claude agent ownership manifest before source removal',
      detail:
        manifest.kind === 'unsafe'
          ? `manifest is unsafe: ${manifest.reason}`
          : `manifest still owns ${Object.keys(manifest.files).length} role-agent file(s)`,
    };
  }
  progress.begin(member);
  const failure = tryRemoveStep('Removing genie directory...', 'Install state removed (state backups preserved)', () =>
    removeGenieDirPreservingStateBackups(genieDir, expectedIdentity, expectedRemovalDigest, options),
  );
  if (failure === null) progress.complete(member);
  else progress.abort(member);
  return failure;
}

export function removeSymlinkMembers(
  genieDir: string,
  names: UninstallBatchScope['symlinks'],
  result: UninstallResult,
  progress: UninstallBatchProgressController,
  localBin = LOCAL_BIN,
  options: Pick<SourceSymlinkRemovalOptions, 'beforeCapture'> = {},
): UninstallFailure[] {
  const failures: UninstallFailure[] = [];
  if (names.length === 0) return failures;
  console.log('\x1b[2mRemoving symlinks...\x1b[0m');
  for (const symlink of names) {
    const member = uninstallBatchMemberId('symlink', symlink.name);
    if (progress.isCompleted(member) || progress.isPreserved(member)) continue;
    progress.begin(member);
    const symlinks = removeSymlinks(localBin, genieDir, [symlink.name], {
      planned: new Map([[symlink.name, symlink]]),
      beforeCapture: options.beforeCapture,
    });
    if (symlinks.preserved.includes(symlink.name)) {
      progress.preserve(member);
      recordPreservation(result, {
        step: `Preserving source symlink ${symlink.name}`,
        detail: symlinks.failures.map((failure) => failure.detail).join('; '),
      });
      continue;
    }
    if (symlinks.failures.length > 0) {
      progress.abort(member);
      for (const failure of symlinks.failures) {
        failures.push({ step: `Removing symlink ${contractPath(failure.path)}`, detail: failure.detail });
      }
      return failures;
    }
    progress.complete(member);
    if (symlinks.removed.length > 0) console.log(`  \x1b[32m+\x1b[0m Removed: ${symlink.name}`);
  }
  return failures;
}

/**
 * Uninstall Genie CLI entirely
 */
function performUninstallScope(
  genieDir: string,
  scope: UninstallBatchScope,
  progress: UninstallBatchProgressController,
  homeRemovalOptions: GenieHomeRemovalOptions = {},
): UninstallResult {
  const result: UninstallResult = { failures: [], preserved: [], notes: [] };
  const rulesFailure = removeRulesMember(genieDir, scope.ownedRules, result, progress);
  if (rulesFailure) {
    result.failures.push(rulesFailure);
    return result;
  }

  // Managed assets live outside GENIE_HOME, so remove them before deleting it.
  removeSyncedAgentAssets(scope.agentAssets, result, progress);
  if (result.failures.length > 0) return result;
  if (hasRuntimeIntegrationWork(scope)) {
    removeIntegrationState(scope, result, progress);
    if (result.failures.length > 0) return result;
  }

  // Preserve the CLI and external recovery root while any requested removal is
  // incomplete, otherwise the user loses the easiest retry path.
  const homeFailure = removeGenieHomeMember(
    genieDir,
    scope.genieHomeIdentity,
    scope.genieHomeRemovalDigest,
    progress,
    homeRemovalOptions,
  );
  if (homeFailure) {
    result.failures.push(homeFailure);
    return result;
  }
  // Keep the normal command path available whenever any failure-prone cleanup
  // or GENIE_HOME removal failed. Once the home is gone, only dangling source-
  // install links remain and can be removed as the final commit step.
  result.failures.push(...removeSymlinkMembers(genieDir, scope.symlinks, result, progress));
  return result;
}

export interface PerformUninstallDependencies {
  /** Fully injected external agent roots for noninteractive full-flow tests. */
  agentSyncTargets?: AgentSyncRemovalTargets;
  /** Avoid consulting process-global legacy rules state in isolated tests. */
  orchestrationRulesPath?: string;
  /** Deterministic capture/backup boundaries for injected v4 rules fixtures. */
  v4RulesRemoval?: V4RulesRemovalOptions;
  /** Injected source-link directory and capture boundary for compatibility fixtures. */
  sourceSymlinkLocalBin?: string;
  sourceSymlinkRemoval?: Pick<SourceSymlinkRemovalOptions, 'beforeCapture'>;
  /** Avoid process-global runtime integration mutation in isolated tests. */
  removeRuntimeIntegrations?: (removeMarketplace: boolean) => void;
  /** Deterministic barriers for source-root replacement fixtures. */
  genieHomeRemoval?: GenieHomeRemovalOptions;
}

interface CompatibilityUninstallPlan {
  targets: AgentSyncRemovalTargets;
  genieHome: string;
  genieHomeIdentity: PhysicalRootIdentity | null;
  genieHomeRemovalDigest: string | null;
  hasCurrentAgentAssets: boolean;
  injectedRules: ProvenV4Rules | null;
  removeMarketplace: boolean;
  sourceSymlinkLocalBin: string;
  sourceSymlinks: Map<OwnedSourceSymlink['name'], OwnedSourceSymlink>;
}

/** Build the immutable authority used by the legacy injected test seam. */
function planCompatibilityUninstall(
  existingSymlinks: string[],
  genieDir: string,
  hasGenieDir: boolean,
  hasAgentAssets: boolean,
  removeMarketplace: boolean,
  dependencies: PerformUninstallDependencies,
): CompatibilityUninstallPlan | null {
  const targets = dependencies.agentSyncTargets ?? {};
  const genieHome = targets.genieHome ?? resolveGenieHome();
  const agentInspection = inspectAgentSyncAssets(targets);
  if (agentInspection.claudeAgentManifest.kind === 'unsafe') return null;
  const hasCurrentAgentAssets = hasAgentAssets && agentInspection.assets.length > 0;
  const genieHomeIdentity = hasGenieDir ? inspectRemovableGenieRoot(genieDir) : null;
  const genieHomeRemovalDigest =
    genieHomeIdentity === null ? null : captureGenieHomeRemovalDigest(genieDir, genieHomeIdentity);
  const injectedRules =
    dependencies.orchestrationRulesPath !== undefined && existsSync(dependencies.orchestrationRulesPath)
      ? captureProvenV4RulesIdentity(dependencies.orchestrationRulesPath)
      : null;
  const sourceSymlinkLocalBin = dependencies.sourceSymlinkLocalBin ?? LOCAL_BIN;
  const plannedNames = existingSymlinks.filter((name): name is (typeof SYMLINKS)[number] =>
    SYMLINKS.some((candidate) => candidate === name),
  );
  const sourceSymlinks = new Map<OwnedSourceSymlink['name'], OwnedSourceSymlink>();
  for (const name of plannedNames) {
    const owned = ownedSourceSymlink(join(sourceSymlinkLocalBin, name), genieDir);
    if (owned !== null) sourceSymlinks.set(name, owned);
  }
  if (
    !hasCurrentAgentAssets &&
    genieHomeIdentity === null &&
    injectedRules === null &&
    existingSymlinks.length === 0 &&
    !removeMarketplace
  ) {
    return null;
  }
  return {
    targets,
    genieHome,
    genieHomeIdentity,
    genieHomeRemovalDigest,
    hasCurrentAgentAssets,
    injectedRules,
    removeMarketplace,
    sourceSymlinkLocalBin,
    sourceSymlinks,
  };
}

/** Execute a compatibility plan while its lifecycle lock remains held. */
function executeCompatibilityUninstall(
  genieDir: string,
  plan: CompatibilityUninstallPlan,
  dependencies: PerformUninstallDependencies,
): void {
  if (plan.hasCurrentAgentAssets) {
    const removal = removeAgentSyncAssetsLocked(plan.targets);
    if (removal.failures.length > 0) return;
  }
  if (plan.injectedRules !== null) {
    try {
      removeProvenV4Rules(genieDir, plan.injectedRules, dependencies.v4RulesRemoval);
    } catch (error) {
      console.log(`  \x1b[33m!\x1b[0m Preserved v4 rules: ${errorMessage(error)}`);
      return;
    }
  }
  (dependencies.removeRuntimeIntegrations ?? removeRuntimeIntegrations)(plan.removeMarketplace);
  const manifest = readAgentFilesManifestState(join(plan.targets.claudeDir ?? resolveClaudeDir(), 'agents'));
  if (manifest.kind === 'unsafe' || (manifest.kind === 'managed' && Object.keys(manifest.files).length > 0)) return;
  if (plan.genieHomeIdentity !== null && plan.genieHomeRemovalDigest !== null) {
    try {
      removeGenieDirPreservingStateBackups(
        genieDir,
        plan.genieHomeIdentity,
        plan.genieHomeRemovalDigest,
        dependencies.genieHomeRemoval,
      );
    } catch (error) {
      console.log(`  \x1b[33m!\x1b[0m Preserved Genie install state: ${errorMessage(error)}`);
      return;
    }
  }
  if (plan.sourceSymlinks.size > 0) {
    removeSymlinks(plan.sourceSymlinkLocalBin, genieDir, [...plan.sourceSymlinks.keys()], {
      planned: plan.sourceSymlinks,
      beforeCapture: dependencies.sourceSymlinkRemoval?.beforeCapture,
    });
  }
}

/**
 * Fully injected compatibility seam retained for noninteractive uninstall-flow
 * tests. Production uses the authenticated batch path below; both paths hold the
 * same sync lock through flat-agent removal, runtime cleanup, and source deletion.
 */
export function performUninstall(
  _hasHookScript: boolean,
  existingSymlinks: string[],
  genieDir: string,
  hasGenieDir: boolean,
  hasAgentAssets: boolean,
  removeMarketplace: boolean,
  dependencies: PerformUninstallDependencies = {},
): void {
  const plan = planCompatibilityUninstall(
    existingSymlinks,
    genieDir,
    hasGenieDir,
    hasAgentAssets,
    removeMarketplace,
    dependencies,
  );
  if (plan === null) return;

  let lock: { release: () => void } | null;
  try {
    lock = acquireAgentSyncLock(plan.genieHome);
  } catch {
    return;
  }
  if (lock === null) return;
  try {
    executeCompatibilityUninstall(genieDir, plan, dependencies);
  } finally {
    lock.release();
  }
}

function uninstallBatchScope(plan: UninstallPlan): UninstallBatchScope {
  return {
    agentAssets: plan.agentAssets
      .map((asset): UninstallBatchScope['agentAssets'][number] =>
        // Flat agents carry an identity for clean deletion, missing-entry pruning,
        // and modified-content keep-aside. Other modified/corrupt assets stay put.
        asset.identity !== undefined && (asset.kind === 'agent' || !asset.modified)
          ? { path: resolve(asset.path), disposition: 'remove', identity: asset.identity }
          : { path: resolve(asset.path), disposition: 'keep' },
      )
      .sort((left, right) => left.path.localeCompare(right.path)),
    codexRoleAgents: plan.managedRoleAgents
      .map((agent): UninstallBatchScope['codexRoleAgents'][number] =>
        agent.ownership === 'managed-clean' && agent.identity !== undefined
          ? {
              name: agent.name,
              disposition: 'remove',
              identity: { digest: agent.identity.digest, mode: agent.identity.mode },
            }
          : { name: agent.name, disposition: 'keep' },
      )
      .sort((left, right) => left.name.localeCompare(right.name)),
    codexRoleInventoryStatus: plan.codexRoleAgents.status,
    genieHomeIdentity: plan.genieHomeIdentity,
    genieHomeRemovalDigest: plan.genieHomeRemovalDigest,
    ownedRules: plan.ownedRules,
    removeMarketplace: plan.removeMarketplace,
    runtimeClients: { codex: plan.runtimeClients.codex, claude: plan.runtimeClients.claude },
    runtimePlugins: { codex: plan.runtimeEvidence.codex, claude: plan.runtimeEvidence.claude },
    symlinks: plan.ownedSourceSymlinks,
  };
}

export function performFreshUninstallPlan(
  genieDir: string,
  removeMarketplace: boolean,
  homeRemovalOptions: GenieHomeRemovalOptions = {},
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
    ...(execution.claudeAgentManifest.kind === 'unsafe'
      ? [`Claude agent ownership manifest is unsafe: ${execution.claudeAgentManifest.reason}`]
      : []),
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
    performUninstallScope(genieDir, scope, progress, homeRemovalOptions),
  );
  return {
    execution,
    result: batch.result,
  };
}

function reportUninstallResult(execution: UninstallPlan, result: UninstallResult, genieDir: string): void {
  console.log();
  for (const note of result.notes ?? []) {
    console.log(`\x1b[36mi\x1b[0m ${note}`);
  }
  const preserved = result.preserved ?? [];
  if (preserved.length > 0) {
    // Surface identity-mismatched preservations prominently; a recorded-removable
    // object was replaced or edited after the batch and was kept byte-identical.
    console.log(
      '\x1b[33m!\x1b[0m Preserved recorded-removable items whose identity changed after the batch (kept byte-identical):',
    );
    for (const item of preserved) console.log(`  \x1b[33m~\x1b[0m ${item.step}: ${item.detail}`);
    console.log();
  }
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

/** Preview line for a retained batch, noting any interrupted member (recovered, not replayed). */
function reportPendingBatchPreview(genieDir: string): void {
  console.log('  \x1b[31m-\x1b[0m Resume the authenticated pending uninstall batch');
  const interrupted = pendingUninstallBatchInterruptedMember(genieDir);
  if (interrupted !== null) {
    console.log(
      `  \x1b[33m!\x1b[0m A prior batch member (${interrupted}) was interrupted; it will be recovered transactionally, not replayed`,
    );
  }
}

function reportAgentSyncLockFailure(error?: unknown): void {
  process.exitCode = 1;
  const suffix =
    error === undefined ? 'another agent-sync mutation is active.' : 'the shared agent-sync lock is unsafe.';
  console.log(`\x1b[31m!\x1b[0m Genie CLI uninstall is incomplete; ${suffix}`);
  if (error !== undefined) console.log(`  \x1b[31m-\x1b[0m ${errorMessage(error)}`);
  console.log();
}

function executeFreshUninstall(genieDir: string, removeMarketplace: boolean): void {
  console.log();
  // The prompt may remain open while another lifecycle process finishes.
  // Discard every preview decision and rebuild the complete plan under both
  // locks; destructive helpers still perform their per-artifact CAS checks.
  let execution: UninstallPlan;
  let result: UninstallResult;
  try {
    ({ execution, result } = performFreshUninstallPlan(genieDir, removeMarketplace));
  } catch (error) {
    process.exitCode = 1;
    console.log('\x1b[31m!\x1b[0m Genie CLI uninstall is incomplete; recovery or batch validation failed.');
    console.log(`  \x1b[31m-\x1b[0m ${errorMessage(error)}`);
    console.log();
    return;
  }
  reportUninstallResult(execution, result, genieDir);
}

function executeConfirmedUninstall(genieDir: string, removeMarketplace: boolean): void {
  let agentSyncLock: { release: () => void } | null;
  try {
    agentSyncLock = acquireAgentSyncLock(genieDir);
  } catch (error) {
    reportAgentSyncLockFailure(error);
    return;
  }
  if (agentSyncLock === null) {
    reportAgentSyncLockFailure();
    return;
  }
  try {
    executeFreshUninstall(genieDir, removeMarketplace);
  } finally {
    agentSyncLock.release();
  }
}

/** Deterministic seams for the destructive uninstall path; production uses the real dependencies. */
export interface UninstallDeps {
  /** Interactive confirmation seam; production uses @inquirer/prompts. */
  confirm?: typeof confirm;
  /**
   * Codex lifecycle-lease acquisition seam. Uninstall serialises against
   * setup/update/rollback/install through the SAME lease (`resolveGenieHome`),
   * so a busy holder makes uninstall a `codex-lifecycle-busy` loser.
   */
  acquireCodexLifecycleLease?: (kind: LifecycleLeaseKind, options?: AcquireLeaseOptions) => LifecycleLeaseResult;
}

/**
 * The stable, ANSI-free single-line exit-2 trailer for a lifecycle-lease loser
 * (D9). Built with A's canonical serializer — uninstall never redefines the
 * trailer type. `deliveryComplete:false` because nothing was removed: another
 * lifecycle command held the lease.
 */
function codexLifecycleBusyTrailer(holderKind: string | null): string {
  return serializeActivationResultTrailer({
    schemaVersion: 1,
    code: 'codex-lifecycle-busy',
    deliveryComplete: false,
    retry: true,
    nextAction: holderKind
      ? `retry after the current ${holderKind} lifecycle command releases the lease`
      : 'retry after the current lifecycle command releases the lease',
  });
}

export async function uninstallCommand(
  options: { removeMarketplace?: boolean } = {},
  deps: UninstallDeps = {},
): Promise<void> {
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
  const keptAssets = agentAssets.filter(
    (asset) => asset.modified && (asset.kind !== 'agent' || asset.identity === undefined),
  );
  const keptAsideAgents = agentAssets.filter(
    (asset) => asset.kind === 'agent' && asset.modified && asset.identity?.kind === 'agent',
  );
  const removableAssets = agentAssets.length - keptAssets.length;
  if (removableAssets > 0)
    console.log(
      `  \x1b[31m-\x1b[0m Synced agent assets: ${removableAssets} managed skill dir(s)/agent file(s)/council.js/hermes link across claude/codex/hermes`,
    );
  if (keptAssets.length > 0) {
    console.log(
      `  \x1b[33m~\x1b[0m KEPT byte-identical (modified or ownership metadata needs review): ${keptAssets.length} managed asset(s):`,
    );
    for (const asset of keptAssets) console.log(`      \x1b[33m${contractPath(asset.path)}\x1b[0m`);
  }
  if (keptAsideAgents.length > 0) {
    console.log(
      `  \x1b[33m~\x1b[0m Modified flat agents will be preserved under *${KEPT_SUFFIX} and disowned: ${keptAsideAgents.length} file(s):`,
    );
    for (const asset of keptAsideAgents) console.log(`      \x1b[33m${contractPath(asset.path)}\x1b[0m`);
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
  if (hasPendingBatch) reportPendingBatchPreview(genieDir);
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

  // Deliberate destructive authority: warn BEFORE confirmation that removing the
  // active plugin generation can break any currently active or resumable Codex
  // task pinned to it. This is not the activation protocol — uninstall never
  // mints or accepts an assertion/permit.
  console.log(
    '\x1b[1m\x1b[33m⚠ Warning:\x1b[0m removing Genie can break current or resumable tasks. A Codex task pinned to the',
  );
  console.log(
    '\x1b[33m  active plugin generation may fail to resume after uninstall; retire such tasks first if they matter.\x1b[0m',
  );
  console.log();

  const askConfirm = deps.confirm ?? confirm;
  const proceed = await askConfirm({ message: 'Are you sure you want to uninstall Genie CLI?', default: false });
  if (!proceed) {
    console.log();
    console.log('\x1b[2mUninstall cancelled.\x1b[0m');
    console.log();
    return;
  }

  // Existing agent-sync safeguard lock (unchanged). Acquired after confirmation.
  const lifecycleLease = acquireLifecycleLease(genieDir);
  if ('skipped' in lifecycleLease)
    throw new Error(`Another Genie lifecycle command is active: ${lifecycleLease.skipped}`);
  try {
    // Ratified acquisition point: the exclusive Codex lifecycle lease, after
    // destructive confirmation but before the first removal, so uninstall
    // serialises against setup/update/rollback/install on the shared GENIE_HOME.
    const acquire = deps.acquireCodexLifecycleLease ?? acquireCodexLifecycleLease;
    const codexLease = acquire('uninstall');
    if (!codexLease.ok) {
      // Loser: zero mutation. Emit the machine-readable trailer and exit 2.
      process.stdout.write(`${codexLifecycleBusyTrailer(codexLease.holderKind)}\n`);
      console.error(
        `\x1b[33mcodex-lifecycle-busy:\x1b[0m ${codexLease.detail}. No files were removed; retry once it completes.`,
      );
      process.exitCode = 2;
      return;
    }
    try {
      executeConfirmedUninstall(genieDir, options.removeMarketplace ?? false);
    } finally {
      codexLease.release();
    }
  } finally {
    lifecycleLease.release();
  }
}
