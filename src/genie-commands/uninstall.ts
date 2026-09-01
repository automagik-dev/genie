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
import { hookScriptExists } from '../lib/claude-settings.js';
import { contractPath, getGenieDir } from '../lib/genie-config.js';
import { resolveClaudeDir, resolveCodexDir, resolveHermesHome, resolvePiExtensionsDir } from '../lib/genie-home.js';
import { runLegacyIntegrationRetirement } from '../lib/legacy-integration-retirement.js';
import {
  type LifecycleLease,
  type LifecycleLeaseSkip,
  acquireLifecycleLease,
  acquireLifecycleLeaseWithWait,
} from '../lib/lifecycle-lease.js';
import {
  type HeldOrderedLifecycleLeases,
  acquireOrderedLifecycleLeases,
  lifecycleBusyMessage,
  releaseOrderedLifecycleLeases,
} from '../lib/ordered-lifecycle-leases.js';
import {
  inspectRuntimeIntegrationEvidence,
  removeRuntimeIntegrations,
  resolveRuntimeExecutable,
} from '../lib/runtime-integrations.js';
import {
  type SkillsInstallRecord,
  computeSkillDirDigest,
  deleteSkillsInstallRecord,
  isSafeSkillName,
  readSkillsInstallRecord,
} from '../lib/skills-installer.js';
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
    schemaVersion: z.literal(4),
    genieHome: absolutePathSchema,
    scope: uninstallBatchScopeSchema,
    progress: uninstallBatchProgressSchema,
    digest: digestSchema,
  })
  .strict();

export type UninstallBatchDecision = z.infer<typeof uninstallBatchDecisionSchema>;

type UninstallBatchPayload = Omit<UninstallBatchDecision, 'digest'>;

// ---------------------------------------------------------------------------
// Legacy read-only shapes. Authentic v1/v2/v3 journals are discarded and
// re-recorded as v4 from current live state (executeUninstallBatch); these
// schemas exist only so migration can authenticate them before discard, never
// to act on stale pathname-only authority. Unauthentic/corrupt journals fail
// closed. v3 became legacy when the synced managed-asset and Codex role-agent
// members left the batch with their removal engines.
// ---------------------------------------------------------------------------
// Managed-asset shapes that only ever appear in a legacy journal now: the
// per-agent convergence engine that produced them is gone, so nothing plans or
// removes them. They stay here verbatim because a legacy record must parse under its
// EXACT original key set before its digest can be authenticated and discarded.
const legacyAgentSnapshotIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent') }).strict(),
  z.object({ kind: z.literal('file'), digest: digestSchema, mode: physicalModeSchema }).strict(),
  z.object({ kind: z.literal('directory'), digest: digestSchema, mode: physicalModeSchema }).strict(),
  z.object({ kind: z.literal('symlink'), target: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal('other'), mode: physicalModeSchema }).strict(),
]);

const legacyAgentAssetIdentitySchema = z.discriminatedUnion('kind', [
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
      snapshot: legacyAgentSnapshotIdentitySchema,
    })
    .strict(),
]);

const legacyAgentAssetSchema = z.discriminatedUnion('disposition', [
  z
    .object({ path: absolutePathSchema, disposition: z.literal('remove'), identity: legacyAgentAssetIdentitySchema })
    .strict(),
  z.object({ path: absolutePathSchema, disposition: z.literal('keep') }).strict(),
]);

const legacyCodexRoleAgentSchema = z.discriminatedUnion('disposition', [
  z
    .object({
      name: codexRoleNameSchema,
      disposition: z.literal('remove'),
      identity: z.object({ digest: digestSchema, mode: physicalModeSchema }).strict(),
    })
    .strict(),
  z.object({ name: codexRoleNameSchema, disposition: z.literal('keep') }).strict(),
]);

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
    agentAssets: z.array(legacyAgentAssetSchema).max(512),
    codexRoleAgents: z.array(legacyCodexRoleAgentSchema).max(128),
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

const uninstallBatchScopeSchemaV3 = z
  .object({
    agentAssets: z.array(legacyAgentAssetSchema).max(512),
    codexRoleAgents: z.array(legacyCodexRoleAgentSchema).max(128),
    codexRoleInventoryStatus: z.enum(['missing', 'valid', 'corrupt']),
    genieHomeIdentity: physicalRootIdentitySchema.nullable(),
    genieHomeRemovalDigest: digestSchema.nullable(),
    ownedRules: provenV4RulesSchema.nullable(),
    removeMarketplace: z.boolean(),
    runtimeClients: z.object({ codex: z.boolean(), claude: z.boolean() }).strict(),
    runtimePlugins: z.object({ codex: z.boolean(), claude: z.boolean() }).strict(),
    symlinks: z.array(ownedSourceSymlinkSchema).max(2),
  })
  .strict();
const uninstallBatchDecisionSchemaV3 = z
  .object({
    schemaVersion: z.literal(3),
    genieHome: absolutePathSchema,
    scope: uninstallBatchScopeSchemaV3,
    progress: uninstallBatchProgressSchema,
    digest: digestSchema,
  })
  .strict();

type UninstallBatchDecisionV3 = z.infer<typeof uninstallBatchDecisionSchemaV3>;

type UninstallBatchReadState =
  | { kind: 'none' }
  | { kind: 'v4'; decision: UninstallBatchDecision; journalIdentity: PhysicalRootIdentity }
  | { kind: 'legacy-v3'; decision: UninstallBatchDecisionV3; journalIdentity: PhysicalRootIdentity }
  | { kind: 'legacy-v2'; decision: UninstallBatchDecisionV2; journalIdentity: PhysicalRootIdentity }
  | { kind: 'legacy-v1'; decision: UninstallBatchDecisionV1; journalIdentity: PhysicalRootIdentity };

/** Thrown for an authentic legacy journal that must be safely re-planned. */
export class LegacyUninstallBatchJournalError extends Error {
  constructor(
    readonly schemaVersion: 1 | 2 | 3,
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

// Accepts any journal generation's payload; all authenticate under the same canonical digest.
function uninstallBatchDigest(payload: object): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function assertExactUninstallScope(scope: UninstallBatchScope): void {
  if ((scope.genieHomeIdentity === null) !== (scope.genieHomeRemovalDigest === null)) {
    throw new Error('uninstall batch must bind Genie root identity and exact removal commitment together');
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
    schemaVersion: 4,
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
    join(resolveCodexDir(), 'agents'),
    join(resolveHermesHome(), 'plugins'),
    resolvePiExtensionsDir(),
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
 * Authenticate a parsed journal as v4 or a legacy v1/v2/v3 record. The current
 * record is fully cross-checked; a legacy record is authenticated only enough
 * to prove it is ours before migration discards its stale authority.
 */
function authenticateUninstallBatch(
  parsed: unknown,
  genieHome: string,
  journalPath: string,
  journalIdentity: PhysicalRootIdentity,
): UninstallBatchReadState {
  const v4 = uninstallBatchDecisionSchema.safeParse(parsed);
  if (v4.success && v4.data.genieHome === resolve(genieHome)) {
    const decision = v4.data;
    assertExactUninstallScope(decision.scope);
    assertExactUninstallProgress(decision.progress, decision.scope, decision.genieHome);
    authenticateUninstallDigest(uninstallBatchPayload(decision), decision.digest, journalPath);
    return { kind: 'v4', decision, journalIdentity };
  }
  const v3 = uninstallBatchDecisionSchemaV3.safeParse(parsed);
  if (v3.success && v3.data.genieHome === resolve(genieHome)) {
    const decision = v3.data;
    authenticateUninstallDigest(
      { schemaVersion: 3, genieHome: decision.genieHome, scope: decision.scope, progress: decision.progress },
      decision.digest,
      journalPath,
    );
    return { kind: 'legacy-v3', decision, journalIdentity };
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
  if (state.kind === 'legacy-v1' || state.kind === 'legacy-v2' || state.kind === 'legacy-v3') {
    throw new LegacyUninstallBatchJournalError(state.decision.schemaVersion, state.decision.progress.active);
  }
  return state.decision;
}

/** Read-only active-member evidence for the preview across v1, v2 and v3 journals; never throws. */
export function pendingUninstallBatchInterruptedMember(genieHome = getGenieDir()): string | null {
  try {
    const state = readUninstallBatchState(genieHome);
    return state.kind === 'none' ? null : state.decision.progress.active;
  } catch {
    return null;
  }
}

/** Re-authenticate the exact legacy journal, then discard it so a fresh v4 decision can be recorded. */
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
  if (state.kind !== 'legacy-v1' && state.kind !== 'legacy-v2' && state.kind !== 'legacy-v3') {
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
  // Role-agent removal left the batch with its transaction engine, so the
  // runtime member id now hashes only the client-plugin/marketplace scope. A
  // legacy journal that hashed the role-agent array is migrated (discarded +
  // re-recorded) before any member runs, so no receipt is ever compared across
  // schema versions.
  return uninstallBatchMemberId(
    'runtime',
    JSON.stringify({
      removeMarketplace: scope.removeMarketplace,
      runtimeClients: scope.runtimeClients,
      runtimePlugins: scope.runtimePlugins,
    }),
  );
}

function hasRuntimeIntegrationWork(scope: UninstallBatchScope): boolean {
  return scope.runtimePlugins.codex || scope.runtimePlugins.claude || scope.removeMarketplace;
}

function uninstallBatchMembers(scope: UninstallBatchScope, genieHome: string): Set<string> {
  const members = new Set<string>();
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
  if (currentState.kind !== 'v4') throw new Error('uninstall batch journal disappeared during progress update');
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
    authenticateCapturedJournal(capture, genieHome, 'v4', expectedDigest);
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
  if (state.kind !== 'v4') throw new Error('uninstall batch journal disappeared before finalization');
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
  authenticateCapturedJournal(capture, genieHome, 'v4', expectedDigest);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lazily allocate one exclusive backup generation and persist the exact validated bytes. */
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
    // fresh v4 decision from the CURRENT live scope. In particular, v2 carried
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
  symlinkCount: number;
  runtimeEvidence: { codex: boolean; claude: boolean };
  removeMarketplace: boolean;
}

export function hasUninstallWork(snapshot: UninstallWorkSnapshot): boolean {
  return (
    snapshot.hasGenieDir ||
    snapshot.hasHookScript ||
    snapshot.hasOrchestrationRules ||
    snapshot.hasPendingBatch === true ||
    snapshot.symlinkCount > 0 ||
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
  runtimeClients: RuntimeClientAvailability;
  runtimeEvidence: ReturnType<typeof inspectRuntimeIntegrationEvidence>;
  removeMarketplace: boolean;
  hasPendingBatch: boolean;
}

export interface UninstallPlanInspectors {
  hasGenieDir?: (path: string) => boolean;
  captureGenieHomeIdentity?: (path: string) => PhysicalRootIdentity | null;
  captureGenieHomeRemovalDigest?: (path: string, identity: PhysicalRootIdentity) => string;
  hookScriptExists?: () => boolean;
  detectV4Install?: typeof detectV4Install;
  existingSymlinks?: (genieDir: string) => string[];
  inspectRuntimeClientAvailability?: typeof inspectRuntimeClientAvailability;
  inspectRuntimeIntegrationEvidence?: typeof inspectRuntimeIntegrationEvidence;
  hasPendingBatch?: (genieDir: string) => boolean;
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
    runtimeClients,
    runtimeEvidence: (inspectors.inspectRuntimeIntegrationEvidence ?? inspectRuntimeIntegrationEvidence)(),
    removeMarketplace,
    hasPendingBatch: (inspectors.hasPendingBatch ?? hasPendingUninstallBatch)(genieDir),
  };
}

export function uninstallBatchIntegrationViolations(
  scope: UninstallBatchScope,
  currentRuntime: ReturnType<typeof inspectRuntimeIntegrationEvidence>,
): string[] {
  const violations: string[] = [];
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
  const runtimeEvidence = inspectRuntimeIntegrationEvidence();
  const violations = uninstallBatchIntegrationViolations(scope, runtimeEvidence);
  if (violations.length > 0) {
    result.failures.push({
      step: 'Validating runtime integration uninstall allowlist',
      detail: violations.join('; '),
    });
    return;
  }
  progress.begin(member);
  const failureCount = result.failures.length;
  const integrations = removeRuntimeIntegrations({
    removeMarketplace: scope.removeMarketplace,
    installedEvidence: scope.runtimePlugins,
    detected: uninstallBatchRuntimeTargets(scope),
  });
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

/**
 * The only GENIE_HOME child uninstall preserves. The lifecycle lease this
 * command holds is a SIBLING of GENIE_HOME, so no live lock file is inside the
 * tree being removed; the historical in-home mutation lock left with the engine
 * that created it and is now ordinary residue the removal clears.
 */
function preservedGenieDirEntry(name: string): boolean {
  return name === 'state-backups';
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

function uninstallBatchScope(plan: UninstallPlan): UninstallBatchScope {
  return {
    genieHomeIdentity: plan.genieHomeIdentity,
    genieHomeRemovalDigest: plan.genieHomeRemovalDigest,
    ownedRules: plan.ownedRules,
    removeMarketplace: plan.removeMarketplace,
    runtimeClients: { codex: plan.runtimeClients.codex, claude: plan.runtimeClients.claude },
    runtimePlugins: { codex: plan.runtimeEvidence.codex, claude: plan.runtimeEvidence.claude },
    symlinks: plan.ownedSourceSymlinks,
  };
}

/**
 * What `genie uninstall` removed from the skills.sh channel.
 *
 * Removal is record-driven AND digest-verified: only a `<agentDir>/<inventory
 * name>` directory named by `<GENIE_HOME>/skills-install.json` whose recomputed
 * content digest still matches the recorded one is deleted, so a user-replaced
 * or foreign same-name directory (generic names like `fix` or `docs` in shared
 * homes) is preserved and reported rather than recursively destroyed. A foreign
 * skill the record never named is structurally out of reach, and no record at
 * all (never installed through the channel, or already uninstalled) is a no-op.
 */
export interface SkillsChannelRemoval {
  record: SkillsInstallRecord | null;
  removed: string[];
  failures: string[];
  /**
   * Real directories at recorded paths that were NOT deleted because genie
   * cannot prove they are still its own install: the record predates content
   * digests (5.260830.x) or the content changed since. Data safety beats
   * cleanliness — they stay in place and are reported, never removed.
   */
  preserved: string[];
  recordRemoved: boolean;
}

export function removeSkillsChannelInstall(genieHome: string): SkillsChannelRemoval {
  const record = readSkillsInstallRecord(genieHome);
  if (record === null) return { record: null, removed: [], failures: [], preserved: [], recordRemoved: false };
  const removed: string[] = [];
  const failures: string[] = [];
  const preserved: string[] = [];
  for (const agentDir of record.agentDirs) {
    if (!isAbsolute(agentDir)) continue;
    for (const name of record.inventory) {
      // One traversal guard, owned by the module that also writes the record.
      if (!isSafeSkillName(name)) continue;
      const target = join(agentDir, name);
      const stat = lstatOrNull(target);
      // Only real directories genie recorded; a symlink or file at that name
      // was not written by `--copy` and stays untouched.
      if (stat === null || !stat.isDirectory()) continue;
      // Delete only what the record can prove is still genie's byte-identical
      // install. No digest entry (a legacy record, or a directory that appeared
      // after the install) or a digest mismatch (user-modified/foreign content)
      // preserves the directory instead — never delete unverified directories.
      const recordedDigest = record.dirDigests?.[target];
      const currentDigest = computeSkillDirDigest(target);
      if (recordedDigest === undefined || currentDigest === null || currentDigest !== recordedDigest) {
        preserved.push(target);
        continue;
      }
      try {
        rmSync(target, { recursive: true, force: true });
        removed.push(target);
      } catch (error) {
        failures.push(`${target}: ${errorMessage(error)}`);
      }
    }
  }
  // The record is the receipt for retrying an incomplete removal, so it is
  // deleted only after a fully clean sweep of every recorded directory.
  if (failures.length > 0 || preserved.length > 0) {
    return { record, removed, failures, preserved, recordRemoved: false };
  }
  return { record, removed, failures, preserved, recordRemoved: deleteSkillsInstallRecord(genieHome) };
}

function reportSkillsChannelRemoval(removal: SkillsChannelRemoval): void {
  if (removal.record === null) {
    console.log('\x1b[36mi\x1b[0m skills.sh channel: no install record; nothing to remove.');
    return;
  }
  console.log(
    `  \x1b[32m+\x1b[0m skills.sh channel: removed ${removal.removed.length} recorded skill dir(s) (${removal.record.ref})`,
  );
  for (const failure of removal.failures) console.log(`  \x1b[33m!\x1b[0m skills.sh channel: ${failure}`);
  for (const dir of removal.preserved) {
    console.log(
      `  \x1b[33m~\x1b[0m skills.sh channel: preserved ${dir} (unverified: content differs from the recorded install or the record predates digests)`,
    );
  }
}

export function performFreshUninstallPlan(
  genieDir: string,
  removeMarketplace: boolean,
  homeRemovalOptions: GenieHomeRemovalOptions = {},
): {
  execution: UninstallPlan;
  result: UninstallResult;
} {
  // Record-driven and outside GENIE_HOME, so it must run before the batch
  // deletes the home that holds the record.
  const skillsRemoval = removeSkillsChannelInstall(genieDir);
  reportSkillsChannelRemoval(skillsRemoval);
  if (skillsRemoval.failures.length > 0 || skillsRemoval.preserved.length > 0) {
    // Anything not cleanly removed keeps its receipt: the skills install record
    // lives inside GENIE_HOME, so the plan must stop before the batch deletes
    // the home. The failures surface through the ordinary incomplete-uninstall
    // report (exit 1, GENIE_HOME kept), and the user retries `genie uninstall`
    // after removing the preserved directories manually.
    return {
      execution: inspectUninstallPlan(genieDir, removeMarketplace),
      result: {
        failures: [
          ...skillsRemoval.failures.map((detail): UninstallFailure => ({ step: 'skills.sh channel', detail })),
          ...skillsRemoval.preserved.map(
            (dir): UninstallFailure => ({
              step: 'skills.sh channel',
              detail: `${dir} preserved (unverified: content differs from the recorded install or the record predates digests); remove it manually, then rerun \`genie uninstall\``,
            }),
          ),
        ],
        notes: [
          'skills.sh channel removal was incomplete; kept GENIE_HOME and the install record so the uninstall stays retryable.',
        ],
      },
    };
  }
  // Plugin-era leftovers the batch below does not enumerate (marketplace caches,
  // role-agent inventories, Hermes/pi links, historical curated lanes) are
  // retired backup-first before the home itself is removed. Never fatal: a
  // retirement failure leaves an operator-owned asset in place, and the ordinary
  // uninstall report still runs.
  try {
    runLegacyIntegrationRetirement({
      homes: { home: homedir(), genieHome: genieDir },
      log: (line) => console.log(`  \x1b[2m${line}\x1b[0m`),
    });
  } catch (error) {
    console.log(`  \x1b[33m~\x1b[0m legacy integration retirement skipped: ${errorMessage(error)}`);
  }
  const execution = inspectUninstallPlan(genieDir, removeMarketplace);
  const unsafeState = [
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

function reportUninstallLeaseFailure(detail: string): void {
  process.exitCode = 1;
  console.log('\x1b[31m!\x1b[0m Genie CLI uninstall is incomplete; the lifecycle lease was not acquired.');
  console.log(`  \x1b[31m-\x1b[0m ${detail}`);
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
  const lease = acquireLifecycleLease(genieDir);
  if ('skipped' in lease) {
    reportUninstallLeaseFailure(lease.skipped);
    return;
  }
  try {
    executeFreshUninstall(genieDir, removeMarketplace);
  } finally {
    lease.release();
  }
}

/** Deterministic seams for the destructive uninstall path; production uses the real dependencies. */
export interface UninstallDeps {
  /** Interactive confirmation seam; production uses @inquirer/prompts. */
  confirm?: typeof confirm;
  /**
   * Lifecycle-lease seam, mirroring install's `acquireLease`.
   * Tests can drive a busy/held holder without a real lock file, and the bounded
   * wait wraps whatever is injected here.
   */
  acquireLease?: () => LifecycleLease | LifecycleLeaseSkip;
}

function acquireUninstallLifecycleLeasesOrProject(
  genieDir: string,
  deps: UninstallDeps,
): HeldOrderedLifecycleLeases | null {
  const acquireLease = deps.acquireLease ?? (() => acquireLifecycleLease(genieDir));
  const acquired = acquireOrderedLifecycleLeases(() => acquireLifecycleLeaseWithWait(acquireLease));
  if (acquired.ok) return acquired;
  // One stderr line, exit 2: nothing was removed.
  console.error(lifecycleBusyMessage(acquired.detail, '. No files were removed; retry once it completes.'));
  process.exitCode = 2;
  return null;
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
    runtimeEvidence,
    hasPendingBatch,
  } = preview;
  const rulesStatus = legacyReport.rulesFile.status;
  const rulesPath = legacyReport.rulesFile.path;

  console.log('\x1b[2mThis will remove:\x1b[0m');
  console.log('  \x1b[31m-\x1b[0m Genie client plugin registrations');
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
  if (hasPendingBatch) reportPendingBatchPreview(genieDir);
  console.log();

  if (
    !hasUninstallWork({
      hasGenieDir,
      hasHookScript: false,
      hasOrchestrationRules: hasOwnedRules,
      hasPendingBatch,
      symlinkCount: existingSymlinks.length,
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

  // Existing lifecycle safeguard lock. Acquired after destructive confirmation
  // but before the first removal.
  const acquired = acquireUninstallLifecycleLeasesOrProject(genieDir, deps);
  if (acquired === null) return;
  try {
    executeConfirmedUninstall(genieDir, options.removeMarketplace ?? false);
  } finally {
    releaseOrderedLifecycleLeases(acquired.lifecycleLease);
  }
}
