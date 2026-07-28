/**
 * Planning and locked transactional apply for reconciling two current Genie
 * v5 databases.
 *
 * Read-only planning turns two transaction-consistent, structurally exact
 * logical images into an immutable plan. Apply then takes stable advisory and
 * SQLite write locks in canonical order, revalidates that exact plan, and
 * writes only through the live handles. Snapshot publication remains outside
 * this module.
 */

import { FFIType, dlopen } from 'bun:ffi';
import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { linuxLibcCandidates } from '../install-transaction.js';
import { CURRENT_SCHEMA_VERSION } from './genie-db.js';
import { BUSY_TIMEOUT_MS, isBusyError } from './sqlite-open.js';

const PLAN_VERSION = 1 as const;
const REPORT_VERSION = 1 as const;
const READ_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 2_147_483_647;
const ADVISORY_RETRY_MS = 10;
const LOCK_EXCLUSIVE_NONBLOCKING = 2 | 4;
const LOCK_UNLOCK = 8;
export const MAX_RECONCILIATION_DATABASE_BYTES = 256 * 1024 * 1024;
const MAX_ROWS_PER_TABLE = 1_000_000;
const MAX_TOTAL_ROWS = 2_000_000;
const MAX_CONFLICTS = 10_000;
const MAX_SCHEMA_OBJECTS = 64;
const BACKFILL_MARKER = 'stage_log_backfill_v1';
const DIRECT_BACKFILL_KINDS = new Set(['comment', 'move', 'claim', 'release', 'block', 'unblock', 'report']);

/**
 * Without ancestry, byte-identical events independently added on both forks
 * are indistinguishable from one shared event and therefore converge to max,
 * not sum.
 */
export const IDENTICAL_HISTORY_ADDITION_LIMITATION =
  'Independent byte-identical history additions are indistinguishable without ancestry; reconciliation keeps the maximum observed occurrence count.';

export type ReconciliationMode = 'bidirectional' | 'directional';
export type ReconciliationPlanStatus = 'no-op' | 'changed' | 'conflict' | 'same-database';
export type ReconciliationReportStatus = 'no-op' | 'changed' | 'conflict' | 'operational-failure';
export type ReconciliationApplyStatus =
  | 'no-op'
  | 'changed'
  | 'conflict'
  | 'same-database'
  | 'preimage-changed'
  | 'lock-timeout'
  | 'rolled-back'
  | 'expected-postimage'
  | 'partial-commit'
  | 'unexpected-intervening-write'
  | 'uncertain';
export type ReconciliationApplyPhase =
  | 'plan-validation'
  | 'advisory-lock'
  | 'sqlite-lock'
  | 'revalidation'
  | 'locked'
  | 'mutation'
  | 'foreign-key-check'
  | 'integrity-check'
  | 'logical-postimage-check'
  | 'commit'
  | 'rollback'
  | 'cleanup'
  | 'observation';
export type ReconciliationApplyFailureCode =
  | ReconciliationErrorCode
  | 'invalid-plan'
  | 'advisory-lock-timeout'
  | 'sqlite-lock-timeout'
  | 'apply-failed'
  | 'postimage-mismatch'
  | 'commit-failed'
  | 'rollback-failed'
  | 'close-failed'
  | 'advisory-lock-release-failed'
  | 'observation-failed'
  | 'unexpected-failure';
export type ReconciliationTargetObservation =
  | 'not-observed'
  | 'expected-preimage'
  | 'expected-postimage'
  | 'expected-pre-and-postimage'
  | 'unexpected';
export type ReconciliationInputRole = 'left' | 'right' | 'source' | 'destination';
export type ReconciliationTargetRole = 'left' | 'right' | 'destination';
export type KeyedTableName = 'boards' | 'tasks' | 'wish_groups' | 'hire_roster' | 'meta';
export type ReconciliationTableName = KeyedTableName | 'task_dependencies' | 'stage_log' | 'task_events';

export type ReconciliationRequest =
  | {
      readonly mode: 'bidirectional';
      readonly leftPath: string;
      readonly rightPath: string;
    }
  | {
      readonly mode: 'directional';
      readonly sourcePath: string;
      readonly destinationPath: string;
    };

export type ReconciliationErrorCode =
  | 'input-unavailable'
  | 'input-too-large'
  | 'malformed-database'
  | 'stale-current-schema'
  | 'unsupported-schema'
  | 'integrity-failed'
  | 'invalid-data'
  | 'input-changed';

export class ReconciliationError extends Error {
  readonly code: ReconciliationErrorCode;
  readonly guidance?: string;

  constructor(code: ReconciliationErrorCode, message: string, guidance?: string) {
    super(message);
    this.name = 'ReconciliationError';
    this.code = code;
    this.guidance = guidance;
  }
}

export interface BoardReconciliationRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: bigint;
  readonly lanes: string | null;
}

export interface TaskReconciliationRow {
  readonly id: string;
  readonly boardId: string | null;
  readonly title: string;
  readonly status: string;
  readonly claimedBy: string | null;
  readonly claimedAt: bigint | null;
  readonly wish: string | null;
  readonly groupName: string | null;
  readonly createdAt: bigint;
  readonly updatedAt: bigint;
  readonly lane: string | null;
  readonly agentKind: string | null;
  readonly heartbeatAt: bigint | null;
  readonly blockedBy: string | null;
  readonly blockedReason: string | null;
}

export interface WishGroupReconciliationRow {
  readonly wish: string;
  readonly name: string;
  readonly status: string;
  readonly dependsOn: string;
  readonly assignee: string | null;
  readonly startedAt: bigint | null;
  readonly completedAt: bigint | null;
  readonly createdAt: bigint;
  readonly updatedAt: bigint;
}

export interface HireRosterReconciliationRow {
  readonly wish: string;
  readonly agentAdapterId: string;
  readonly profile: string | null;
  readonly worktree: string;
  readonly hiredAt: bigint;
  readonly state: string;
}

export interface MetaReconciliationRow {
  readonly key: string;
  readonly value: string;
}

export interface TaskDependencyReconciliationRow {
  readonly taskId: string;
  readonly dependsOnId: string;
}

export interface StageLogReconciliationValue {
  readonly taskId: string;
  readonly stage: string;
  readonly note: string | null;
  readonly createdAt: bigint;
}

export interface TaskEventReconciliationValue {
  readonly taskId: string;
  readonly kind: string;
  readonly note: string | null;
  readonly authorKind: string | null;
  readonly author: string | null;
  readonly createdAt: bigint;
}

export interface HistoryAddition<T> {
  readonly value: T;
  readonly count: number;
}

export interface ReconciliationTargetChanges {
  readonly boards: readonly BoardReconciliationRow[];
  readonly tasks: readonly TaskReconciliationRow[];
  readonly wishGroups: readonly WishGroupReconciliationRow[];
  readonly hireRoster: readonly HireRosterReconciliationRow[];
  readonly meta: readonly MetaReconciliationRow[];
  readonly taskDependencies: readonly TaskDependencyReconciliationRow[];
  readonly stageLog: readonly HistoryAddition<StageLogReconciliationValue>[];
  readonly taskEvents: readonly HistoryAddition<TaskEventReconciliationValue>[];
}

export interface ReconciliationConflict {
  readonly table: ReconciliationTableName;
  readonly reason:
    | 'same-key-difference'
    | 'invalid-marker'
    | 'marker-invariant-failed'
    | 'planned-marker-invariant-failed'
    | 'planned-integrity-failed';
  readonly keyDigest: string;
  readonly side?: ReconciliationInputRole | ReconciliationTargetRole;
}

export interface ReconciliationPlanInput {
  readonly role: ReconciliationInputRole;
  readonly canonicalPath: string;
  readonly logicalDigest: string;
}

export interface ReconciliationTargetPlan {
  readonly role: ReconciliationTargetRole;
  readonly canonicalPath: string;
  readonly preimageDigest: string;
  readonly postimageDigest: string | null;
  readonly changes: ReconciliationTargetChanges;
}

export interface ReconciliationChangeCounts {
  readonly boards: number;
  readonly tasks: number;
  readonly wishGroups: number;
  readonly hireRoster: number;
  readonly meta: number;
  readonly taskDependencies: number;
  readonly stageLog: number;
  readonly taskEvents: number;
  readonly deletions: 0;
}

export interface ReconciliationTargetReport {
  readonly role: ReconciliationTargetRole;
  readonly preimageDigest: string;
  readonly postimageDigest: string | null;
  readonly changes: ReconciliationChangeCounts;
}

export interface ReconciliationDryRunReport {
  readonly reportVersion: typeof REPORT_VERSION;
  readonly dryRun: true;
  readonly mode: ReconciliationMode;
  readonly status: ReconciliationReportStatus;
  readonly sameDatabase: boolean;
  readonly schemaFingerprint: string | null;
  readonly targets: readonly ReconciliationTargetReport[];
  readonly conflicts: readonly ReconciliationConflict[];
  readonly operationalFailure: {
    readonly code: ReconciliationErrorCode | 'unexpected-failure';
    readonly guidance?: string;
  } | null;
  readonly historyLimitation: typeof IDENTICAL_HISTORY_ADDITION_LIMITATION;
}

export interface ReconciliationPlan {
  readonly planVersion: typeof PLAN_VERSION;
  readonly mode: ReconciliationMode;
  readonly status: ReconciliationPlanStatus;
  readonly sameDatabase: boolean;
  readonly schemaFingerprint: string;
  readonly inputs: readonly ReconciliationPlanInput[];
  readonly targets: readonly ReconciliationTargetPlan[];
  readonly conflicts: readonly ReconciliationConflict[];
  readonly report: ReconciliationDryRunReport;
  readonly historyLimitation: typeof IDENTICAL_HISTORY_ADDITION_LIMITATION;
}

export interface ReconciliationApplyTargetReport {
  readonly role: ReconciliationTargetRole;
  readonly preimageDigest: string;
  readonly postimageDigest: string | null;
  readonly observedDigest: string | null;
  readonly observation: ReconciliationTargetObservation;
  readonly committed: boolean;
}

export interface ReconciliationApplyFailure {
  readonly code: ReconciliationApplyFailureCode;
  readonly phase: ReconciliationApplyPhase;
  readonly role?: ReconciliationInputRole | ReconciliationTargetRole;
}

export interface ReconciliationApplyReport {
  readonly reportVersion: typeof REPORT_VERSION;
  readonly dryRun: false;
  readonly mode: ReconciliationMode;
  readonly status: ReconciliationApplyStatus;
  readonly converged: boolean;
  readonly targets: readonly ReconciliationApplyTargetReport[];
  readonly failure: ReconciliationApplyFailure | null;
  readonly cleanupFailures: readonly ReconciliationApplyFailure[];
}

export type ReconciliationApplyEvent =
  | { readonly phase: 'locked' }
  | {
      readonly phase: 'mutation' | 'foreign-key-check' | 'integrity-check' | 'logical-postimage-check' | 'commit';
      readonly role: ReconciliationTargetRole;
      readonly state: 'before' | 'after';
    };

export interface ReconciliationLockedInput {
  readonly role: ReconciliationInputRole;
  readonly canonicalPath: string;
  readonly target: boolean;
  serialize(): Uint8Array;
}

export interface ReconciliationDatabaseObservation {
  readonly schemaFingerprint: string;
  readonly logicalDigest: string;
}

export interface ReconciliationLockedDatabaseInput {
  readonly role: ReconciliationInputRole;
  readonly canonicalPath: string;
  observe(): ReconciliationDatabaseObservation;
  serialize(): Uint8Array;
  restoreFrom(source: Database): ReconciliationDatabaseObservation;
}

export type ReconciliationLockedOperationEvent = {
  readonly phase: 'commit';
  readonly role: ReconciliationInputRole;
  readonly state: 'before' | 'after';
};

export interface ReconciliationLockedOperationOptions {
  readonly busyTimeoutMs?: number;
  readonly onEvent?: (event: ReconciliationLockedOperationEvent) => void;
  readonly openDatabase?: ReconciliationApplyOptions['openDatabase'];
  readonly advisoryFlock?: ReconciliationAdvisoryFlockDependencies;
  readonly onAdvisoryDescriptorOpened?: (descriptor: number) => void;
  readonly advisoryUnlock?: (descriptor: number) => number;
}

export interface ReconciliationLockedOperationResult<T> {
  readonly value: T;
  readonly afterCommit?: () => void;
}

export class ReconciliationLockedOperationError extends Error {
  readonly failure: ReconciliationApplyFailure;
  readonly cleanupFailures: readonly ReconciliationApplyFailure[];
  readonly operationCause: unknown;

  constructor(
    failure: ReconciliationApplyFailure,
    cause?: unknown,
    cleanupFailures: readonly ReconciliationApplyFailure[] = [],
  ) {
    super(cause instanceof Error ? cause.message : failure.code);
    this.name = 'ReconciliationLockedOperationError';
    this.failure = failure;
    this.cleanupFailures = cleanupFailures;
    this.operationCause = cause;
  }
}

export interface ReconciliationApplyOptions {
  /** Shared total wait bound for all advisory and SQLite lock acquisition. */
  readonly busyTimeoutMs?: number;
  /**
   * Runs after every input has been revalidated while all SQLite write locks
   * remain held. Group 3 uses the read-only serializers to publish snapshots.
   */
  readonly onLocked?: (inputs: readonly ReconciliationLockedInput[]) => void;
  /** Bounded lifecycle observation and deterministic failure injection for tests. */
  readonly onEvent?: (event: ReconciliationApplyEvent) => void;
  /** Deterministic constructor seam for physical-identity regression tests. */
  readonly openDatabase?: (path: string, options: ConstructorParameters<typeof Database>[1]) => Database;
  /** Lazy native advisory-lock resolution seam for libc portability tests. */
  readonly advisoryFlock?: ReconciliationAdvisoryFlockDependencies;
  /** Descriptor ownership observation after open and before object validation. */
  readonly onAdvisoryDescriptorOpened?: (descriptor: number) => void;
  /** Deterministic lifecycle seam; production always calls descriptor-bound flock. */
  readonly advisoryUnlock?: (descriptor: number) => number;
}

export type ReconciliationAdvisoryFlock = (descriptor: number, operation: number) => number;

export interface ReconciliationAdvisoryFlockDependencies {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly linuxCandidates?: readonly string[];
  readonly linuxOpener?: (candidate: string) => ReconciliationAdvisoryFlock | null;
  readonly darwinOpener?: () => ReconciliationAdvisoryFlock | null;
}

type SqliteScalar = string | bigint | number | Uint8Array | null;
type CanonicalScalar = readonly ['null'] | readonly ['string', string] | readonly ['integer', string];

interface PhysicalInput {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly hasSidecars: boolean;
}

interface ColumnFingerprint {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly defaultValue: string | null;
  readonly primaryKeyPosition: number;
  readonly hidden: number;
}

interface ForeignKeyFingerprint {
  readonly table: string;
  readonly from: string;
  readonly to: string;
  readonly onUpdate: string;
  readonly onDelete: string;
  readonly match: string;
}

interface IndexFingerprint {
  readonly name: string | null;
  readonly origin: string;
  readonly unique: boolean;
  readonly partial: boolean;
  readonly columns: readonly {
    readonly name: string;
    readonly descending: boolean;
    readonly collation: string;
  }[];
}

interface TableFingerprint {
  readonly name: string;
  readonly columns: readonly ColumnFingerprint[];
  readonly foreignKeys: readonly (readonly ForeignKeyFingerprint[])[];
  readonly indexes: readonly IndexFingerprint[];
  readonly checks: readonly string[];
  readonly autoIncrement: boolean;
  readonly withoutRowid: boolean;
  readonly strict: boolean;
}

interface SchemaFingerprint {
  readonly userVersion: number;
  readonly tables: readonly TableFingerprint[];
}

interface CountedValue<T> {
  readonly value: T;
  count: number;
}

interface LogicalState {
  readonly boards: Map<string, BoardReconciliationRow>;
  readonly tasks: Map<string, TaskReconciliationRow>;
  readonly wishGroups: Map<string, WishGroupReconciliationRow>;
  readonly hireRoster: Map<string, HireRosterReconciliationRow>;
  readonly meta: Map<string, MetaReconciliationRow>;
  readonly taskDependencies: Map<string, TaskDependencyReconciliationRow>;
  readonly stageLog: Map<string, CountedValue<StageLogReconciliationValue>>;
  readonly taskEvents: Map<string, CountedValue<TaskEventReconciliationValue>>;
}

interface DatabaseImage {
  readonly schemaFingerprint: string;
  readonly logicalDigest: string;
  readonly state: LogicalState;
}

interface AdvisoryLock {
  readonly path: string;
  readonly descriptor: number;
  readonly flock: ReconciliationAdvisoryFlock;
}

interface LockedDatabase {
  readonly input: PhysicalInput;
  readonly roles: readonly ReconciliationInputRole[];
  readonly db: Database;
  transactionOpen: boolean;
}

interface ApplyFailureContext {
  readonly code: ReconciliationApplyFailureCode;
  readonly phase: ReconciliationApplyPhase;
  readonly role?: ReconciliationInputRole | ReconciliationTargetRole;
}

class ApplyBoundaryError extends Error {
  readonly context: ApplyFailureContext;
  readonly cleanupFailures: ReconciliationApplyFailure[];

  constructor(
    context: ApplyFailureContext,
    cause?: unknown,
    cleanupFailures: readonly ReconciliationApplyFailure[] = [],
  ) {
    super(cause instanceof Error ? cause.message : context.code);
    this.name = 'ApplyBoundaryError';
    this.context = context;
    this.cleanupFailures = [...cleanupFailures];
  }
}

const NORMAL_OPEN_GUIDANCE =
  'Open the database once with Genie’s normal current open path (for example `genie board`) to normalize supported additive history, then retry reconciliation.';

const EXPECTED_COLUMNS: Readonly<
  Record<Exclude<ReconciliationTableName, 'task_dependencies'> | 'task_dependencies', readonly ColumnFingerprint[]>
> = {
  boards: [
    column('created_at', 'INTEGER', true),
    column('id', 'TEXT', false, null, 1),
    column('lanes', 'TEXT', false),
    column('name', 'TEXT', true),
  ],
  hire_roster: [
    column('agent_adapter_id', 'TEXT', true, null, 2),
    column('hired_at', 'INTEGER', true),
    column('profile', 'TEXT', false),
    column('state', 'TEXT', true),
    column('wish', 'TEXT', true, null, 1),
    column('worktree', 'TEXT', true),
  ],
  meta: [column('key', 'TEXT', false, null, 1), column('value', 'TEXT', true)],
  stage_log: [
    column('created_at', 'INTEGER', true),
    column('id', 'INTEGER', false, null, 1),
    column('note', 'TEXT', false),
    column('stage', 'TEXT', true),
    column('task_id', 'TEXT', true),
  ],
  task_dependencies: [column('depends_on_id', 'TEXT', true, null, 2), column('task_id', 'TEXT', true, null, 1)],
  task_events: [
    column('author', 'TEXT', false),
    column('author_kind', 'TEXT', false),
    column('created_at', 'INTEGER', true),
    column('id', 'INTEGER', false, null, 1),
    column('kind', 'TEXT', true),
    column('note', 'TEXT', false),
    column('task_id', 'TEXT', true),
  ],
  tasks: [
    column('agent_kind', 'TEXT', false),
    column('blocked_by', 'TEXT', false),
    column('blocked_reason', 'TEXT', false),
    column('board_id', 'TEXT', false),
    column('claimed_at', 'INTEGER', false),
    column('claimed_by', 'TEXT', false),
    column('created_at', 'INTEGER', true),
    column('group_name', 'TEXT', false),
    column('heartbeat_at', 'INTEGER', false),
    column('id', 'TEXT', false, null, 1),
    column('lane', 'TEXT', false),
    column('status', 'TEXT', true),
    column('title', 'TEXT', true),
    column('updated_at', 'INTEGER', true),
    column('wish', 'TEXT', false),
  ],
  wish_groups: [
    column('assignee', 'TEXT', false),
    column('completed_at', 'INTEGER', false),
    column('created_at', 'INTEGER', true),
    column('depends_on', 'TEXT', true, "'[]'"),
    column('name', 'TEXT', true, null, 2),
    column('started_at', 'INTEGER', false),
    column('status', 'TEXT', true),
    column('updated_at', 'INTEGER', true),
    column('wish', 'TEXT', true, null, 1),
  ],
};

const EXPECTED_FOREIGN_KEYS: Readonly<Record<ReconciliationTableName, readonly (readonly ForeignKeyFingerprint[])[]>> =
  {
    boards: [],
    hire_roster: [],
    meta: [],
    stage_log: [foreignKey('tasks', 'task_id', 'id', 'NO ACTION', 'CASCADE')],
    task_dependencies: [
      foreignKey('tasks', 'depends_on_id', 'id', 'NO ACTION', 'CASCADE'),
      foreignKey('tasks', 'task_id', 'id', 'NO ACTION', 'CASCADE'),
    ],
    task_events: [foreignKey('tasks', 'task_id', 'id', 'NO ACTION', 'CASCADE')],
    tasks: [foreignKey('boards', 'board_id', 'id', 'NO ACTION', 'SET NULL')],
    wish_groups: [],
  };

const EXPECTED_INDEXES: Readonly<Record<ReconciliationTableName, readonly IndexFingerprint[]>> = {
  boards: [index(null, 'pk', true, ['id']), index(null, 'u', true, ['name'])],
  hire_roster: [index(null, 'pk', true, ['wish', 'agent_adapter_id'])],
  meta: [index(null, 'pk', true, ['key'])],
  stage_log: [index('idx_stage_log_task', 'c', false, ['task_id'])],
  task_dependencies: [
    index('idx_task_deps_dep', 'c', false, ['depends_on_id']),
    index(null, 'pk', true, ['task_id', 'depends_on_id']),
  ],
  task_events: [index('idx_task_events_task', 'c', false, ['task_id'])],
  tasks: [index('idx_tasks_status', 'c', false, ['status']), index(null, 'pk', true, ['id'])],
  wish_groups: [index(null, 'pk', true, ['wish', 'name'])],
};

const EXPECTED_CHECKS: Readonly<Record<ReconciliationTableName, readonly string[]>> = {
  boards: [],
  hire_roster: [],
  meta: [],
  stage_log: [],
  task_dependencies: [],
  task_events: [],
  tasks: ['status-in:blocked,done,in_progress,ready'],
  wish_groups: ['status-in:blocked,done,in_progress,ready'],
};

const TABLE_NAMES = [
  'boards',
  'hire_roster',
  'meta',
  'stage_log',
  'task_dependencies',
  'task_events',
  'tasks',
  'wish_groups',
] as const satisfies readonly ReconciliationTableName[];

const EXPLICIT_INDEX_TO_TABLE = new Map([
  ['idx_stage_log_task', 'stage_log'],
  ['idx_task_deps_dep', 'task_dependencies'],
  ['idx_task_events_task', 'task_events'],
  ['idx_tasks_status', 'tasks'],
]);

function column(
  name: string,
  type: string,
  notNull: boolean,
  defaultValue: string | null = null,
  primaryKeyPosition = 0,
): ColumnFingerprint {
  return { name, type, notNull, defaultValue, primaryKeyPosition, hidden: 0 };
}

function foreignKey(
  table: string,
  from: string,
  to: string,
  onUpdate: string,
  onDelete: string,
): readonly ForeignKeyFingerprint[] {
  return [{ table, from, to, onUpdate, onDelete, match: 'NONE' }];
}

function index(name: string | null, origin: string, unique: boolean, columns: readonly string[]): IndexFingerprint {
  return {
    name,
    origin,
    unique,
    partial: false,
    columns: columns.map((columnName) => ({ name: columnName, descending: false, collation: 'BINARY' })),
  };
}

function error(code: ReconciliationErrorCode, message: string, guidance?: string): ReconciliationError {
  return new ReconciliationError(code, message, guidance);
}

function staleSchema(): never {
  throw error('stale-current-schema', 'The database has a stale same-version additive schema.', NORMAL_OPEN_GUIDANCE);
}

function unsupportedSchema(): never {
  throw error('unsupported-schema', 'The database does not have the exact supported current Genie schema.');
}

function canonicalScalar(value: string | bigint | null): CanonicalScalar {
  if (value === null) return ['null'];
  if (typeof value === 'string') return ['string', value];
  return ['integer', value.toString()];
}

function canonicalTuple(values: readonly (string | bigint | null)[]): string {
  return JSON.stringify(values.map(canonicalScalar));
}

function digestCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function schemaInteger(value: unknown): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric)) unsupportedSchema();
  return numeric;
}

function rowString(row: Record<string, SqliteScalar>, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') throw error('invalid-data', 'A database row contains an invalid value type.');
  return value;
}

function rowNullableString(row: Record<string, SqliteScalar>, name: string): string | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== 'string') throw error('invalid-data', 'A database row contains an invalid value type.');
  return value;
}

function rowInteger(row: Record<string, SqliteScalar>, name: string): bigint {
  const value = row[name];
  if (typeof value !== 'bigint') throw error('invalid-data', 'A database row contains an invalid value type.');
  return value;
}

function rowNullableInteger(row: Record<string, SqliteScalar>, name: string): bigint | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== 'bigint') throw error('invalid-data', 'A database row contains an invalid value type.');
  return value;
}

function resolvePhysicalInput(path: string): PhysicalInput {
  if (path === ':memory:') {
    throw error('input-unavailable', 'Reconciliation requires a physical database file.');
  }
  try {
    const canonicalPath = normalize(realpathSync(path));
    const stats = statSync(canonicalPath);
    if (!stats.isFile()) throw new Error('not a regular file');
    const walPath = `${canonicalPath}-wal`;
    const hasWal = existsSync(walPath);
    let walBytes = 0;
    if (hasWal) {
      const walStats = statSync(walPath);
      if (!walStats.isFile()) throw new Error('WAL is not a regular file');
      walBytes = walStats.size;
    }
    const shmPath = `${canonicalPath}-shm`;
    const hasShm = existsSync(shmPath);
    if (hasShm && !statSync(shmPath).isFile()) {
      throw new Error('SHM is not a regular file');
    }
    const logicalBytes = stats.size + walBytes;
    if (logicalBytes > MAX_RECONCILIATION_DATABASE_BYTES) {
      throw error('input-too-large', 'The database exceeds the bounded reconciliation input size.');
    }
    return {
      requestedPath: path,
      canonicalPath,
      device: String(stats.dev),
      inode: String(stats.ino),
      hasSidecars: hasWal || hasShm,
    };
  } catch (caught) {
    if (caught instanceof ReconciliationError) throw caught;
    throw error('input-unavailable', 'A reconciliation input is unavailable or is not a regular file.');
  }
}

function revalidatePhysicalInput(input: PhysicalInput): void {
  let current: PhysicalInput;
  try {
    current = resolvePhysicalInput(input.requestedPath);
  } catch {
    throw error('input-changed', 'A reconciliation input changed identity while it was being read.');
  }
  if (
    current.canonicalPath !== input.canonicalPath ||
    current.device !== input.device ||
    current.inode !== input.inode
  ) {
    throw error('input-changed', 'A reconciliation input changed identity while it was being read.');
  }
}

function samePhysicalInput(left: PhysicalInput, right: PhysicalInput): boolean {
  if (left.canonicalPath === right.canonicalPath) return true;
  if (left.device !== right.device || left.inode !== right.inode) return false;
  if (left.hasSidecars || right.hasSidecars) {
    throw error('invalid-data', 'Hardlink aliases with path-specific SQLite sidecars are ambiguous.');
  }
  return true;
}

const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));
const FLOCK_SYMBOL = {
  flock: {
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
} as const;
const ADVISORY_LOCK_ROOT_NAME = `genie-reconciliation-locks-${process.getuid?.() ?? 'unknown'}-v1`;
let defaultAdvisoryFlock: ReconciliationAdvisoryFlock | null | undefined;

function sleepMs(ms: number): void {
  Atomics.wait(SLEEP_SIGNAL, 0, 0, ms);
}

function openFlock(candidate: string): ReconciliationAdvisoryFlock | null {
  try {
    const library = dlopen(candidate, FLOCK_SYMBOL);
    return (descriptor, operation) => library.symbols.flock(descriptor, operation);
  } catch {
    return null;
  }
}

function openDarwinFlock(): ReconciliationAdvisoryFlock | null {
  return openFlock('/usr/lib/libSystem.B.dylib');
}

function resolveAdvisoryFlock(
  dependencies?: ReconciliationAdvisoryFlockDependencies,
): ReconciliationAdvisoryFlock | null {
  if (dependencies === undefined && defaultAdvisoryFlock !== undefined) return defaultAdvisoryFlock;
  const platform = dependencies?.platform ?? process.platform;
  const architecture = dependencies?.architecture ?? process.arch;
  let resolved: ReconciliationAdvisoryFlock | null = null;
  if (platform === 'linux') {
    const opener = dependencies?.linuxOpener ?? openFlock;
    const candidates = dependencies?.linuxCandidates ?? linuxLibcCandidates(architecture);
    for (const candidate of candidates) {
      try {
        resolved = opener(candidate);
      } catch {
        resolved = null;
      }
      if (resolved !== null) break;
    }
  } else if (platform === 'darwin') {
    try {
      resolved = (dependencies?.darwinOpener ?? openDarwinFlock)();
    } catch {
      resolved = null;
    }
  }
  if (dependencies === undefined) defaultAdvisoryFlock = resolved;
  return resolved;
}

function advisoryLockRoot(): string {
  const requestedRoot = join(tmpdir(), ADVISORY_LOCK_ROOT_NAME);
  try {
    mkdirSync(requestedRoot, { mode: 0o700 });
  } catch (caught) {
    if (!(caught instanceof Error) || !('code' in caught) || (caught as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw caught;
    }
  }
  const stats = lstatSync(requestedRoot);
  const expectedUid = process.getuid?.();
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    (expectedUid !== undefined && stats.uid !== expectedUid)
  ) {
    throw new Error('Advisory lock root must be a private owned directory.');
  }
  return realpathSync(requestedRoot);
}

export function reconciliationAdvisoryLockPath(canonicalPath: string): string {
  const digest = createHash('sha256')
    .update('genie-reconciliation-advisory-lock-v1\0')
    .update(normalize(canonicalPath))
    .digest('hex');
  return join(advisoryLockRoot(), `${digest}.lock`);
}

function databaseHandleMatchesPath(db: Pick<Database, 'fileControl'>): boolean {
  const moved = new Int32Array(1);
  try {
    return db.fileControl(sqliteConstants.SQLITE_FCNTL_HAS_MOVED, moved) === 0 && moved[0] === 0;
  } catch {
    return false;
  }
}

function requireDatabaseHandleMatchesPath(
  db: Pick<Database, 'fileControl'>,
  role?: ReconciliationInputRole | ReconciliationTargetRole,
): void {
  if (!databaseHandleMatchesPath(db)) {
    throw new ApplyBoundaryError({
      code: 'input-changed',
      phase: 'revalidation',
      ...(role === undefined ? {} : { role }),
    });
  }
}

function acquireAdvisoryLock(
  canonicalPath: string,
  timeoutMs: number,
  options: ReconciliationApplyOptions,
): AdvisoryLock {
  const path = reconciliationAdvisoryLockPath(canonicalPath);
  const flock = resolveAdvisoryFlock(options.advisoryFlock);
  if (flock === null) {
    throw new ApplyBoundaryError({ code: 'unexpected-failure', phase: 'advisory-lock' });
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      0o600,
    );
    options.onAdvisoryDescriptorOpened?.(descriptor);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size !== 0) {
      throw new Error('Advisory lock path must be an empty regular file.');
    }
  } catch (caught) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The validation failure remains primary; descriptor close was still attempted.
      }
    }
    throw new ApplyBoundaryError({ code: 'unexpected-failure', phase: 'advisory-lock' }, caught);
  }

  const deadline = Date.now() + timeoutMs;
  let ownershipTransferred = false;
  try {
    for (;;) {
      if (flock(descriptor, LOCK_EXCLUSIVE_NONBLOCKING) === 0) {
        ownershipTransferred = true;
        return { path, descriptor, flock };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ApplyBoundaryError({ code: 'advisory-lock-timeout', phase: 'advisory-lock' });
      }
      sleepMs(Math.min(ADVISORY_RETRY_MS, remaining));
    }
  } finally {
    if (!ownershipTransferred) closeSync(descriptor);
  }
}

function releaseAdvisoryLock(lock: AdvisoryLock, options?: ReconciliationApplyOptions): void {
  let result = -1;
  try {
    result = options?.advisoryUnlock?.(lock.descriptor) ?? lock.flock(lock.descriptor, LOCK_UNLOCK);
  } finally {
    closeSync(lock.descriptor);
  }
  if (result !== 0) throw new Error('Advisory descriptor unlock failed.');
}

function readInventory(db: Database): Array<{ type: string; name: string; tableName: string; sql: string | null }> {
  const rows = db
    .query('SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema ORDER BY type, name LIMIT ?')
    .all(MAX_SCHEMA_OBJECTS + 1) as Array<Record<string, SqliteScalar>>;
  if (rows.length > MAX_SCHEMA_OBJECTS) unsupportedSchema();
  return rows.map((row) => {
    const type = rowString(row, 'type');
    const name = rowString(row, 'name');
    const tableName = rowString(row, 'tableName');
    const sqlValue = row.sql;
    if (sqlValue !== null && typeof sqlValue !== 'string') unsupportedSchema();
    return { type, name, tableName, sql: sqlValue };
  });
}

function collectInventoryObject(
  object: { type: string; name: string; tableName: string; sql: string | null },
  expectedTables: ReadonlySet<string>,
  actualTables: Set<string>,
  actualExplicitIndexes: Set<string>,
  tableSql: Map<string, string>,
): void {
  if (object.type === 'table') {
    if (object.name === 'sqlite_sequence' && object.tableName === 'sqlite_sequence') return;
    if (!expectedTables.has(object.name) || object.tableName !== object.name || object.sql === null) {
      unsupportedSchema();
    }
    actualTables.add(object.name);
    tableSql.set(object.name, object.sql);
    return;
  }
  if (object.type === 'index') {
    if (object.sql === null) {
      if (!object.name.startsWith('sqlite_autoindex_') || !expectedTables.has(object.tableName)) {
        unsupportedSchema();
      }
      return;
    }
    const expectedTable = EXPLICIT_INDEX_TO_TABLE.get(object.name);
    if (expectedTable === undefined || expectedTable !== object.tableName) unsupportedSchema();
    actualExplicitIndexes.add(object.name);
    return;
  }
  // Views, triggers, and every other non-internal schema object are rejected
  // before integrity checks or logical row reads can grant planning authority.
  unsupportedSchema();
}

function validateInventory(
  inventory: readonly { type: string; name: string; tableName: string; sql: string | null }[],
): Map<string, string> {
  const expectedTables = new Set<string>(TABLE_NAMES);
  const actualTables = new Set<string>();
  const actualExplicitIndexes = new Set<string>();
  const tableSql = new Map<string, string>();

  for (const object of inventory) {
    collectInventoryObject(object, expectedTables, actualTables, actualExplicitIndexes, tableSql);
  }

  for (const table of TABLE_NAMES) {
    if (!actualTables.has(table)) staleSchema();
  }
  for (const indexName of EXPLICIT_INDEX_TO_TABLE.keys()) {
    if (!actualExplicitIndexes.has(indexName)) staleSchema();
  }
  if (!inventory.some((object) => object.type === 'table' && object.name === 'sqlite_sequence')) {
    unsupportedSchema();
  }
  return tableSql;
}

function tableColumns(db: Database, table: ReconciliationTableName): readonly ColumnFingerprint[] {
  const rows = db.query(`PRAGMA table_xinfo(${table})`).all() as Array<Record<string, SqliteScalar>>;
  const observed = rows
    .map((row) => ({
      name: rowString(row, 'name'),
      type: rowString(row, 'type').toUpperCase(),
      notNull: schemaInteger(row.notnull) === 1,
      defaultValue: row.dflt_value === null ? null : rowString(row, 'dflt_value'),
      primaryKeyPosition: schemaInteger(row.pk),
      hidden: schemaInteger(row.hidden),
    }))
    .sort((left, right) => compareCanonical(left.name, right.name));

  const expected = EXPECTED_COLUMNS[table];
  const observedNames = new Set(observed.map((item) => item.name));
  if (observed.some((item) => !expected.some((candidate) => candidate.name === item.name))) unsupportedSchema();
  if (expected.some((item) => !observedNames.has(item.name))) staleSchema();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) unsupportedSchema();
  return observed;
}

function tableForeignKeys(db: Database, table: ReconciliationTableName): readonly (readonly ForeignKeyFingerprint[])[] {
  const rows = db.query(`PRAGMA foreign_key_list(${table})`).all() as Array<Record<string, SqliteScalar>>;
  const rawGroups = new Map<number, Array<{ sequence: number; fingerprint: ForeignKeyFingerprint }>>();
  for (const row of rows) {
    const id = schemaInteger(row.id);
    const group = rawGroups.get(id) ?? [];
    group.push({
      sequence: schemaInteger(row.seq),
      fingerprint: {
        table: rowString(row, 'table'),
        from: rowString(row, 'from'),
        to: rowString(row, 'to'),
        onUpdate: rowString(row, 'on_update'),
        onDelete: rowString(row, 'on_delete'),
        match: rowString(row, 'match'),
      },
    });
    rawGroups.set(id, group);
  }
  const observed = [...rawGroups.values()]
    .map((group) => {
      group.sort((left, right) => left.sequence - right.sequence);
      if (group.some((item, index) => item.sequence !== index)) unsupportedSchema();
      return group.map((item) => item.fingerprint);
    })
    .map((group) => ({ group, key: JSON.stringify(group) }))
    .sort((left, right) => compareCanonical(left.key, right.key))
    .map((item) => item.group);
  if (JSON.stringify(observed) !== JSON.stringify(EXPECTED_FOREIGN_KEYS[table])) unsupportedSchema();
  return observed;
}

function indexColumns(db: Database, name: string): IndexFingerprint['columns'] {
  const rows = db
    .query('SELECT seqno, cid, name, desc, coll, key FROM pragma_index_xinfo(?) ORDER BY seqno')
    .all(name) as Array<Record<string, SqliteScalar>>;
  const keyRows = rows.filter((row) => schemaInteger(row.key) === 1);
  return keyRows.map((row) => {
    if (schemaInteger(row.cid) < 0) unsupportedSchema();
    return {
      name: rowString(row, 'name'),
      descending: schemaInteger(row.desc) === 1,
      collation: rowString(row, 'coll'),
    };
  });
}

function tableIndexes(db: Database, table: ReconciliationTableName): readonly IndexFingerprint[] {
  const rows = db.query(`PRAGMA index_list(${table})`).all() as Array<Record<string, SqliteScalar>>;
  const observed = rows
    .map((row) => {
      const name = rowString(row, 'name');
      const origin = rowString(row, 'origin');
      return {
        name: origin === 'c' ? name : null,
        origin,
        unique: schemaInteger(row.unique) === 1,
        partial: schemaInteger(row.partial) === 1,
        columns: indexColumns(db, name),
      };
    })
    .sort((left, right) => compareCanonical(JSON.stringify(left), JSON.stringify(right)));
  const expected = [...EXPECTED_INDEXES[table]].sort((left, right) =>
    compareCanonical(JSON.stringify(left), JSON.stringify(right)),
  );
  if (JSON.stringify(observed) !== JSON.stringify(expected)) unsupportedSchema();
  return observed;
}

interface SqlToken {
  readonly kind: 'word' | 'string' | 'punctuation';
  readonly value: string;
}

function skipSqlTrivia(sql: string, start: number): number {
  let index = start;
  for (;;) {
    while (index < sql.length && /\s/.test(sql[index])) index++;
    if (sql[index] === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index++;
      continue;
    }
    if (sql[index] === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) unsupportedSchema();
      index = end + 2;
      continue;
    }
    return index;
  }
}

function readQuotedSqlToken(
  sql: string,
  start: number,
  closing: string,
  kind: SqlToken['kind'],
): { token: SqlToken; nextIndex: number } {
  let value = '';
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== closing) {
      value += sql[index];
      index++;
      continue;
    }
    if (closing !== ']' && sql[index + 1] === closing) {
      value += closing;
      index += 2;
      continue;
    }
    return {
      token: { kind, value: kind === 'word' ? value.toLowerCase() : value },
      nextIndex: index + 1,
    };
  }
  unsupportedSchema();
}

function readSqlToken(sql: string, index: number): { token: SqlToken; nextIndex: number } {
  const char = sql[index];
  if (char === "'") return readQuotedSqlToken(sql, index, "'", 'string');
  if (char === '"') return readQuotedSqlToken(sql, index, '"', 'word');
  if (char === '`') return readQuotedSqlToken(sql, index, '`', 'word');
  if (char === '[') return readQuotedSqlToken(sql, index, ']', 'word');
  if (/[A-Za-z_]/.test(char)) {
    const start = index;
    let cursor = index + 1;
    while (cursor < sql.length && /[A-Za-z0-9_$]/.test(sql[cursor])) cursor++;
    return { token: { kind: 'word', value: sql.slice(start, cursor).toLowerCase() }, nextIndex: cursor };
  }
  if ('(),'.includes(char)) {
    return { token: { kind: 'punctuation', value: char }, nextIndex: index + 1 };
  }
  return { token: { kind: 'word', value: char.toLowerCase() }, nextIndex: index + 1 };
}

function sqlTokens(sql: string): readonly SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    index = skipSqlTrivia(sql, index);
    if (index >= sql.length) break;
    const parsed = readSqlToken(sql, index);
    tokens.push(parsed.token);
    index = parsed.nextIndex;
  }
  return tokens;
}

function readCheckExpression(
  tokens: readonly SqlToken[],
  openingIndex: number,
): { expression: readonly SqlToken[]; closingIndex: number } {
  if (tokens[openingIndex]?.value !== '(') unsupportedSchema();
  let depth = 1;
  const expression: SqlToken[] = [];
  let index = openingIndex + 1;
  while (index < tokens.length && depth > 0) {
    const current = tokens[index];
    if (current.value === '(') depth++;
    if (current.value === ')') depth--;
    if (depth > 0) expression.push(current);
    index++;
  }
  if (depth !== 0) unsupportedSchema();
  return { expression, closingIndex: index - 1 };
}

function normalizeStatusCheck(expression: readonly SqlToken[]): string {
  if (
    expression.length !== 11 ||
    expression[0].kind !== 'word' ||
    expression[0].value !== 'status' ||
    expression[1].kind !== 'word' ||
    expression[1].value !== 'in' ||
    expression[2].value !== '(' ||
    expression[10].value !== ')'
  ) {
    unsupportedSchema();
  }
  const values: string[] = [];
  for (let valueIndex = 3; valueIndex < 10; valueIndex += 2) {
    const value = expression[valueIndex];
    if (value.kind !== 'string') unsupportedSchema();
    values.push(value.value);
    if (valueIndex < 9 && expression[valueIndex + 1]?.value !== ',') unsupportedSchema();
  }
  return `status-in:${values.sort(compareCanonical).join(',')}`;
}

function normalizeChecks(sql: string): readonly string[] {
  const tokens = sqlTokens(sql);
  const checks: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'word' || token.value !== 'check') continue;
    const parsed = readCheckExpression(tokens, index + 1);
    checks.push(normalizeStatusCheck(parsed.expression));
    index = parsed.closingIndex;
  }
  return checks.sort(compareCanonical);
}

/*
 * Keep keyword recognition on the same comment/string-aware token stream as
 * CHECK extraction so hostile DDL text cannot smuggle a false match.
 */
function hasKeyword(sql: string, keyword: string): boolean {
  return sqlTokens(sql).some((token) => token.kind === 'word' && token.value === keyword);
}

function readSchemaFingerprint(db: Database): SchemaFingerprint {
  const versionRow = db.query('PRAGMA user_version').get() as Record<string, SqliteScalar> | null;
  if (versionRow === null || schemaInteger(versionRow.user_version) !== CURRENT_SCHEMA_VERSION) unsupportedSchema();

  const tableSql = validateInventory(readInventory(db));
  const tableList = db.query('PRAGMA table_list').all() as Array<Record<string, SqliteScalar>>;
  const mainTables = new Map<string, Record<string, SqliteScalar>>();
  for (const row of tableList) {
    if (rowString(row, 'schema') !== 'main') continue;
    mainTables.set(rowString(row, 'name'), row);
  }

  const tables = TABLE_NAMES.map((name): TableFingerprint => {
    const listRow = mainTables.get(name);
    if (listRow === undefined) staleSchema();
    if (
      rowString(listRow, 'type') !== 'table' ||
      schemaInteger(listRow.wr) !== 0 ||
      schemaInteger(listRow.strict) !== 0
    ) {
      unsupportedSchema();
    }
    const sql = tableSql.get(name);
    if (sql === undefined) staleSchema();
    if (
      ['collate', 'conflict', 'deferrable', 'generated', 'initially', 'match'].some((keyword) =>
        hasKeyword(sql, keyword),
      )
    ) {
      unsupportedSchema();
    }
    const checks = normalizeChecks(sql);
    if (JSON.stringify(checks) !== JSON.stringify(EXPECTED_CHECKS[name])) unsupportedSchema();
    const autoIncrement = hasKeyword(sql, 'autoincrement');
    if (autoIncrement !== (name === 'stage_log' || name === 'task_events')) unsupportedSchema();
    return {
      name,
      columns: tableColumns(db, name),
      foreignKeys: tableForeignKeys(db, name),
      indexes: tableIndexes(db, name),
      checks,
      autoIncrement,
      withoutRowid: false,
      strict: false,
    };
  });
  return { userVersion: CURRENT_SCHEMA_VERSION, tables };
}

function checkSqliteIntegrity(db: Database): void {
  const integrity = db.query('PRAGMA integrity_check(1)').get() as Record<string, SqliteScalar> | null;
  const result = integrity === null ? null : Object.values(integrity)[0];
  if (result !== 'ok') throw error('integrity-failed', 'A reconciliation input failed SQLite integrity validation.');
}

function checkForeignKeys(db: Database): void {
  const foreignKeyFailure = db.query('PRAGMA foreign_key_check').get();
  if (foreignKeyFailure !== null) {
    throw error('integrity-failed', 'A reconciliation input failed SQLite foreign-key validation.');
  }
}

function checkIntegrity(db: Database): void {
  checkSqliteIntegrity(db);
  checkForeignKeys(db);
}

function boundedTableRows(
  db: Database,
  _table: ReconciliationTableName,
  sql: string,
): Array<Record<string, SqliteScalar>> {
  return db.query(sql).all() as Array<Record<string, SqliteScalar>>;
}

function preflightRowCounts(db: Database): void {
  let total = 0n;
  for (const table of TABLE_NAMES) {
    const countRow = db.query(`SELECT count(*) AS rowCount FROM ${table}`).get() as Record<string, SqliteScalar>;
    const count = rowInteger(countRow, 'rowCount');
    if (count > BigInt(MAX_ROWS_PER_TABLE)) {
      throw error('invalid-data', 'A reconciliation input exceeds the bounded row-count limit.');
    }
    total += count;
    if (total > BigInt(MAX_TOTAL_ROWS)) {
      throw error('invalid-data', 'A reconciliation input exceeds the bounded total row-count limit.');
    }
  }
}

function countValues<T>(values: readonly T[], key: (value: T) => string): Map<string, CountedValue<T>> {
  const counts = new Map<string, CountedValue<T>>();
  for (const value of values) {
    const identity = key(value);
    const existing = counts.get(identity);
    if (existing === undefined) counts.set(identity, { value, count: 1 });
    else existing.count++;
  }
  return counts;
}

function keyedValues<T>(values: readonly T[], key: (value: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    if (result.has(identity)) throw error('invalid-data', 'A database table contains a duplicate logical key.');
    result.set(identity, value);
  }
  return result;
}

function dependencyGraphIsAcyclic(dependencies: ReadonlyMap<string, TaskDependencyReconciliationRow>): boolean {
  const outgoing = new Map<string, string[]>();
  const incomingCount = new Map<string, number>();
  for (const dependency of dependencies.values()) {
    if (dependency.taskId === dependency.dependsOnId) return false;
    const outgoingEdges = outgoing.get(dependency.taskId);
    if (outgoingEdges === undefined) outgoing.set(dependency.taskId, [dependency.dependsOnId]);
    else outgoingEdges.push(dependency.dependsOnId);
    incomingCount.set(dependency.taskId, incomingCount.get(dependency.taskId) ?? 0);
    incomingCount.set(dependency.dependsOnId, (incomingCount.get(dependency.dependsOnId) ?? 0) + 1);
  }

  const ready = [...incomingCount].filter(([, count]) => count === 0).map(([taskId]) => taskId);
  let visited = 0;
  while (ready.length > 0) {
    const taskId = ready.pop() as string;
    visited++;
    for (const dependsOnId of outgoing.get(taskId) ?? []) {
      const nextCount = (incomingCount.get(dependsOnId) as number) - 1;
      incomingCount.set(dependsOnId, nextCount);
      if (nextCount === 0) ready.push(dependsOnId);
    }
  }
  return visited === incomingCount.size;
}

interface ParsedWishGroup {
  readonly name: string;
  readonly dependencies: readonly string[] | null;
}

function parseWishGroupDependencies(value: string): readonly string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((dependency) => typeof dependency === 'string')
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
}

function wishGroupGraphIsValid(groups: readonly ParsedWishGroup[]): boolean {
  const names = new Set(groups.map((group) => group.name));
  const incomingCount = new Map(groups.map((group) => [group.name, 0]));
  const dependents = new Map<string, string[]>();
  for (const group of groups) {
    if (
      group.dependencies === null ||
      group.dependencies.includes(group.name) ||
      group.dependencies.some((dependency) => !names.has(dependency))
    ) {
      return false;
    }
    incomingCount.set(group.name, group.dependencies.length);
    for (const dependency of group.dependencies) {
      const rows = dependents.get(dependency) ?? [];
      rows.push(group.name);
      dependents.set(dependency, rows);
    }
  }

  const ready = [...incomingCount].filter(([, count]) => count === 0).map(([name]) => name);
  let visited = 0;
  while (ready.length > 0) {
    const name = ready.pop() as string;
    visited++;
    for (const dependent of dependents.get(name) ?? []) {
      const count = (incomingCount.get(dependent) as number) - 1;
      incomingCount.set(dependent, count);
      if (count === 0) ready.push(dependent);
    }
  }
  return visited === groups.length;
}

function invalidWishGroupGraphs(groups: ReadonlyMap<string, WishGroupReconciliationRow>): Set<string> {
  const byWish = new Map<string, ParsedWishGroup[]>();
  for (const group of groups.values()) {
    const wishKey = canonicalTuple([group.wish]);
    const wishGroups = byWish.get(wishKey) ?? [];
    wishGroups.push({ name: group.name, dependencies: parseWishGroupDependencies(group.dependsOn) });
    byWish.set(wishKey, wishGroups);
  }

  const invalid = new Set<string>();
  for (const [wishKey, wishGroups] of byWish) {
    if (!wishGroupGraphIsValid(wishGroups)) invalid.add(wishKey);
  }
  return invalid;
}

function readLogicalState(db: Database): LogicalState {
  const boards = boundedTableRows(db, 'boards', 'SELECT id, name, created_at, lanes FROM boards').map(
    (row): BoardReconciliationRow => ({
      id: rowString(row, 'id'),
      name: rowString(row, 'name'),
      createdAt: rowInteger(row, 'created_at'),
      lanes: rowNullableString(row, 'lanes'),
    }),
  );
  const tasks = boundedTableRows(
    db,
    'tasks',
    `SELECT id, board_id, title, status, claimed_by, claimed_at, wish, group_name,
            created_at, updated_at, lane, agent_kind, heartbeat_at, blocked_by, blocked_reason
       FROM tasks`,
  ).map(
    (row): TaskReconciliationRow => ({
      id: rowString(row, 'id'),
      boardId: rowNullableString(row, 'board_id'),
      title: rowString(row, 'title'),
      status: rowString(row, 'status'),
      claimedBy: rowNullableString(row, 'claimed_by'),
      claimedAt: rowNullableInteger(row, 'claimed_at'),
      wish: rowNullableString(row, 'wish'),
      groupName: rowNullableString(row, 'group_name'),
      createdAt: rowInteger(row, 'created_at'),
      updatedAt: rowInteger(row, 'updated_at'),
      lane: rowNullableString(row, 'lane'),
      agentKind: rowNullableString(row, 'agent_kind'),
      heartbeatAt: rowNullableInteger(row, 'heartbeat_at'),
      blockedBy: rowNullableString(row, 'blocked_by'),
      blockedReason: rowNullableString(row, 'blocked_reason'),
    }),
  );
  const wishGroups = boundedTableRows(
    db,
    'wish_groups',
    `SELECT wish, name, status, depends_on, assignee, started_at, completed_at, created_at, updated_at
       FROM wish_groups`,
  ).map(
    (row): WishGroupReconciliationRow => ({
      wish: rowString(row, 'wish'),
      name: rowString(row, 'name'),
      status: rowString(row, 'status'),
      dependsOn: rowString(row, 'depends_on'),
      assignee: rowNullableString(row, 'assignee'),
      startedAt: rowNullableInteger(row, 'started_at'),
      completedAt: rowNullableInteger(row, 'completed_at'),
      createdAt: rowInteger(row, 'created_at'),
      updatedAt: rowInteger(row, 'updated_at'),
    }),
  );
  const hireRoster = boundedTableRows(
    db,
    'hire_roster',
    'SELECT wish, agent_adapter_id, profile, worktree, hired_at, state FROM hire_roster',
  ).map(
    (row): HireRosterReconciliationRow => ({
      wish: rowString(row, 'wish'),
      agentAdapterId: rowString(row, 'agent_adapter_id'),
      profile: rowNullableString(row, 'profile'),
      worktree: rowString(row, 'worktree'),
      hiredAt: rowInteger(row, 'hired_at'),
      state: rowString(row, 'state'),
    }),
  );
  const meta = boundedTableRows(db, 'meta', 'SELECT key, value FROM meta').map(
    (row): MetaReconciliationRow => ({
      key: rowString(row, 'key'),
      value: rowString(row, 'value'),
    }),
  );
  const dependencies = boundedTableRows(
    db,
    'task_dependencies',
    'SELECT task_id, depends_on_id FROM task_dependencies',
  ).map(
    (row): TaskDependencyReconciliationRow => ({
      taskId: rowString(row, 'task_id'),
      dependsOnId: rowString(row, 'depends_on_id'),
    }),
  );
  const stages = boundedTableRows(db, 'stage_log', 'SELECT id, task_id, stage, note, created_at FROM stage_log').map(
    (row): StageLogReconciliationValue => {
      rowInteger(row, 'id');
      return {
        taskId: rowString(row, 'task_id'),
        stage: rowString(row, 'stage'),
        note: rowNullableString(row, 'note'),
        createdAt: rowInteger(row, 'created_at'),
      };
    },
  );
  const events = boundedTableRows(
    db,
    'task_events',
    'SELECT id, task_id, kind, note, author_kind, author, created_at FROM task_events',
  ).map((row): TaskEventReconciliationValue => {
    rowInteger(row, 'id');
    return {
      taskId: rowString(row, 'task_id'),
      kind: rowString(row, 'kind'),
      note: rowNullableString(row, 'note'),
      authorKind: rowNullableString(row, 'author_kind'),
      author: rowNullableString(row, 'author'),
      createdAt: rowInteger(row, 'created_at'),
    };
  });

  const totalRows =
    boards.length +
    tasks.length +
    wishGroups.length +
    hireRoster.length +
    meta.length +
    dependencies.length +
    stages.length +
    events.length;
  if (totalRows > MAX_TOTAL_ROWS) {
    throw error('invalid-data', 'A reconciliation input exceeds the bounded total row-count limit.');
  }

  const state = {
    boards: keyedValues(boards, boardKey),
    tasks: keyedValues(tasks, taskKey),
    wishGroups: keyedValues(wishGroups, wishGroupKey),
    hireRoster: keyedValues(hireRoster, hireRosterKey),
    meta: keyedValues(meta, metaKey),
    taskDependencies: keyedValues(dependencies, dependencyKey),
    stageLog: countValues(stages, stageLogKey),
    taskEvents: countValues(events, taskEventKey),
  };
  if (!dependencyGraphIsAcyclic(state.taskDependencies)) {
    throw error('invalid-data', 'A reconciliation input contains an invalid task dependency graph.');
  }
  if (invalidWishGroupGraphs(state.wishGroups).size > 0) {
    throw error('invalid-data', 'A reconciliation input contains an invalid wish-group dependency graph.');
  }
  return state;
}

function readDatabaseImage(db: Database): DatabaseImage {
  const schema = readSchemaFingerprint(db);
  // Integrity is intentionally after the closed inventory: a guest trigger or
  // virtual object is rejected before any logical data receives authority.
  checkIntegrity(db);
  preflightRowCounts(db);
  const state = readLogicalState(db);
  const schemaFingerprint = digestCanonical(['genie-schema-v1', schema]);
  const logicalDigest = logicalStateDigest(schemaFingerprint, state);
  return { schemaFingerprint, logicalDigest, state };
}

/** Validate and identify an already-open exact-current reconciliation image. */
export function inspectReconciliationDatabase(db: Database): ReconciliationDatabaseObservation {
  const image = readDatabaseImage(db);
  return { schemaFingerprint: image.schemaFingerprint, logicalDigest: image.logicalDigest };
}

function loadDatabaseImage(input: PhysicalInput, busyTimeoutMs = READ_BUSY_TIMEOUT_MS): DatabaseImage {
  let db: Database;
  try {
    db = new Database(input.canonicalPath, { readonly: true, strict: true, safeIntegers: true });
  } catch {
    throw error('malformed-database', 'A reconciliation input is not a readable SQLite database.');
  }
  let transactionOpen = false;
  try {
    if (!databaseHandleMatchesPath(db)) {
      throw error('input-changed', 'A reconciliation input changed identity while it was being opened.');
    }
    revalidatePhysicalInput(input);
    if (!databaseHandleMatchesPath(db)) {
      throw error('input-changed', 'A reconciliation input changed identity while it was being opened.');
    }
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    db.exec('PRAGMA query_only = ON');
    db.exec('PRAGMA trusted_schema = OFF');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN');
    transactionOpen = true;
    if (!databaseHandleMatchesPath(db)) {
      throw error('input-changed', 'A reconciliation input changed identity while it was being read.');
    }
    const image = readDatabaseImage(db);
    db.exec('COMMIT');
    transactionOpen = false;
    return image;
  } catch (caught) {
    if (transactionOpen) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The original bounded failure is authoritative.
      }
    }
    if (caught instanceof ReconciliationError) throw caught;
    throw error('malformed-database', 'A reconciliation input could not be validated as SQLite.');
  } finally {
    db.close();
  }
}

function boardKey(row: BoardReconciliationRow): string {
  return canonicalTuple([row.id]);
}

function taskKey(row: TaskReconciliationRow): string {
  return canonicalTuple([row.id]);
}

function wishGroupKey(row: WishGroupReconciliationRow): string {
  return canonicalTuple([row.wish, row.name]);
}

function hireRosterKey(row: HireRosterReconciliationRow): string {
  return canonicalTuple([row.wish, row.agentAdapterId]);
}

function metaKey(row: MetaReconciliationRow): string {
  return canonicalTuple([row.key]);
}

function dependencyKey(row: TaskDependencyReconciliationRow): string {
  return canonicalTuple([row.taskId, row.dependsOnId]);
}

function stageLogKey(row: StageLogReconciliationValue): string {
  return canonicalTuple([row.taskId, row.stage, row.note, row.createdAt]);
}

function taskEventKey(row: TaskEventReconciliationValue): string {
  return canonicalTuple([row.taskId, row.kind, row.note, row.authorKind, row.author, row.createdAt]);
}

function boardValues(row: BoardReconciliationRow): readonly (string | bigint | null)[] {
  return [row.id, row.name, row.createdAt, row.lanes];
}

function taskValues(row: TaskReconciliationRow): readonly (string | bigint | null)[] {
  return [
    row.id,
    row.boardId,
    row.title,
    row.status,
    row.claimedBy,
    row.claimedAt,
    row.wish,
    row.groupName,
    row.createdAt,
    row.updatedAt,
    row.lane,
    row.agentKind,
    row.heartbeatAt,
    row.blockedBy,
    row.blockedReason,
  ];
}

function wishGroupValues(row: WishGroupReconciliationRow): readonly (string | bigint | null)[] {
  return [
    row.wish,
    row.name,
    row.status,
    row.dependsOn,
    row.assignee,
    row.startedAt,
    row.completedAt,
    row.createdAt,
    row.updatedAt,
  ];
}

function hireRosterValues(row: HireRosterReconciliationRow): readonly (string | bigint | null)[] {
  return [row.wish, row.agentAdapterId, row.profile, row.worktree, row.hiredAt, row.state];
}

function metaValues(row: MetaReconciliationRow): readonly (string | bigint | null)[] {
  return [row.key, row.value];
}

function dependencyValues(row: TaskDependencyReconciliationRow): readonly (string | bigint | null)[] {
  return [row.taskId, row.dependsOnId];
}

function stageValues(row: StageLogReconciliationValue): readonly (string | bigint | null)[] {
  return [row.taskId, row.stage, row.note, row.createdAt];
}

function eventValues(row: TaskEventReconciliationValue): readonly (string | bigint | null)[] {
  return [row.taskId, row.kind, row.note, row.authorKind, row.author, row.createdAt];
}

function mapDigestRows<T>(map: ReadonlyMap<string, T>, values: (row: T) => readonly (string | bigint | null)[]) {
  return [...map.values()]
    .map((row) => values(row).map(canonicalScalar))
    .map((row) => ({ row, key: JSON.stringify(row) }))
    .sort((left, right) => compareCanonical(left.key, right.key))
    .map((item) => item.row);
}

function mapDigestCounts<T>(
  map: ReadonlyMap<string, CountedValue<T>>,
  values: (row: T) => readonly (string | bigint | null)[],
) {
  return [...map.values()]
    .map((entry) => [values(entry.value).map(canonicalScalar), entry.count] as const)
    .map((row) => ({ row, key: JSON.stringify(row[0]) }))
    .sort((left, right) => compareCanonical(left.key, right.key))
    .map((item) => item.row);
}

function logicalStateDigest(schemaFingerprint: string, state: LogicalState): string {
  return digestCanonical([
    'genie-logical-image-v1',
    schemaFingerprint,
    {
      boards: mapDigestRows(state.boards, boardValues),
      hireRoster: mapDigestRows(state.hireRoster, hireRosterValues),
      meta: mapDigestRows(state.meta, metaValues),
      stageLog: mapDigestCounts(state.stageLog, stageValues),
      taskDependencies: mapDigestRows(state.taskDependencies, dependencyValues),
      taskEvents: mapDigestCounts(state.taskEvents, eventValues),
      tasks: mapDigestRows(state.tasks, taskValues),
      wishGroups: mapDigestRows(state.wishGroups, wishGroupValues),
    },
  ]);
}

function cloneCountMap<T>(source: ReadonlyMap<string, CountedValue<T>>): Map<string, CountedValue<T>> {
  return new Map([...source].map(([key, entry]) => [key, { value: entry.value, count: entry.count }]));
}

function cloneState(source: LogicalState): LogicalState {
  return {
    boards: new Map(source.boards),
    tasks: new Map(source.tasks),
    wishGroups: new Map(source.wishGroups),
    hireRoster: new Map(source.hireRoster),
    meta: new Map(source.meta),
    taskDependencies: new Map(source.taskDependencies),
    stageLog: cloneCountMap(source.stageLog),
    taskEvents: cloneCountMap(source.taskEvents),
  };
}

function conflictKeyDigest(table: ReconciliationTableName, key: string): string {
  return digestCanonical(['genie-reconciliation-conflict-key-v1', table, key]);
}

function addConflict(
  conflicts: ReconciliationConflict[],
  table: ReconciliationTableName,
  reason: ReconciliationConflict['reason'],
  key: string,
  side?: ReconciliationConflict['side'],
): void {
  if (conflicts.length >= MAX_CONFLICTS) {
    throw error('invalid-data', 'Reconciliation exceeds the bounded conflict diagnostic limit.');
  }
  conflicts.push({ table, reason, keyDigest: conflictKeyDigest(table, key), ...(side === undefined ? {} : { side }) });
}

function rowEqual<T>(left: T, right: T, values: (row: T) => readonly (string | bigint | null)[]): boolean {
  return canonicalTuple(values(left)) === canonicalTuple(values(right));
}

function reconcileBidirectionalKeyed<T>(
  table: KeyedTableName,
  left: Map<string, T>,
  right: Map<string, T>,
  values: (row: T) => readonly (string | bigint | null)[],
  conflicts: ReconciliationConflict[],
  excludedKey?: string,
): void {
  const keys = new Set([...left.keys(), ...right.keys()]);
  for (const key of [...keys].sort(compareCanonical)) {
    if (key === excludedKey) continue;
    const leftRow = left.get(key);
    const rightRow = right.get(key);
    if (leftRow === undefined && rightRow !== undefined) left.set(key, rightRow);
    else if (rightRow === undefined && leftRow !== undefined) right.set(key, leftRow);
    else if (leftRow !== undefined && rightRow !== undefined && !rowEqual(leftRow, rightRow, values)) {
      addConflict(conflicts, table, 'same-key-difference', key);
    }
  }
}

function reconcileDirectionalKeyed<T>(
  source: ReadonlyMap<string, T>,
  destination: Map<string, T>,
  values: (row: T) => readonly (string | bigint | null)[],
  excludedKey?: string,
): void {
  for (const key of [...source.keys()].sort(compareCanonical)) {
    if (key === excludedKey) continue;
    const sourceRow = source.get(key);
    if (sourceRow === undefined) continue;
    const destinationRow = destination.get(key);
    if (destinationRow === undefined || !rowEqual(sourceRow, destinationRow, values)) {
      destination.set(key, sourceRow);
    }
  }
}

function reconcileBidirectionalSet<T>(left: Map<string, T>, right: Map<string, T>): void {
  for (const [key, value] of left) if (!right.has(key)) right.set(key, value);
  for (const [key, value] of right) if (!left.has(key)) left.set(key, value);
}

function reconcileDirectionalSet<T>(source: ReadonlyMap<string, T>, destination: Map<string, T>): void {
  for (const [key, value] of source) if (!destination.has(key)) destination.set(key, value);
}

function reconcileBidirectionalCounts<T>(
  left: Map<string, CountedValue<T>>,
  right: Map<string, CountedValue<T>>,
): void {
  const keys = new Set([...left.keys(), ...right.keys()]);
  for (const key of keys) {
    const leftEntry = left.get(key);
    const rightEntry = right.get(key);
    const count = Math.max(leftEntry?.count ?? 0, rightEntry?.count ?? 0);
    const value = leftEntry?.value ?? rightEntry?.value;
    if (value === undefined) continue;
    left.set(key, { value, count });
    right.set(key, { value, count });
  }
}

function reconcileDirectionalCounts<T>(
  source: ReadonlyMap<string, CountedValue<T>>,
  destination: Map<string, CountedValue<T>>,
): void {
  for (const [key, sourceEntry] of source) {
    const destinationEntry = destination.get(key);
    const count = Math.max(sourceEntry.count, destinationEntry?.count ?? 0);
    destination.set(key, { value: destinationEntry?.value ?? sourceEntry.value, count });
  }
}

function mappedStageEvent(stage: StageLogReconciliationValue): TaskEventReconciliationValue {
  const direct = DIRECT_BACKFILL_KINDS.has(stage.stage);
  return {
    taskId: stage.taskId,
    kind: direct ? stage.stage : 'comment',
    note: direct ? stage.note : stage.note === null ? stage.stage : `${stage.stage}: ${stage.note}`,
    authorKind: null,
    author: null,
    createdAt: stage.createdAt,
  };
}

function markerInvariant(state: LogicalState): boolean {
  const required = new Map<string, number>();
  for (const entry of state.stageLog.values()) {
    const mapped = mappedStageEvent(entry.value);
    const key = taskEventKey(mapped);
    required.set(key, (required.get(key) ?? 0) + entry.count);
  }
  for (const [key, count] of required) {
    if ((state.taskEvents.get(key)?.count ?? 0) < count) return false;
  }
  return true;
}

function parseMarker(value: string): bigint | null {
  if (value.length > 128 || !/^[0-9]+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function markerRow(state: LogicalState): MetaReconciliationRow | undefined {
  return state.meta.get(canonicalTuple([BACKFILL_MARKER]));
}

function validateExistingMarker(
  state: LogicalState,
  side: ReconciliationInputRole,
  conflicts: ReconciliationConflict[],
): bigint | null | undefined {
  const marker = markerRow(state);
  if (marker === undefined) return undefined;
  const parsed = parseMarker(marker.value);
  if (parsed === null) {
    addConflict(conflicts, 'meta', 'invalid-marker', canonicalTuple([BACKFILL_MARKER]), side);
    return null;
  }
  if (!markerInvariant(state)) {
    addConflict(conflicts, 'meta', 'marker-invariant-failed', canonicalTuple([BACKFILL_MARKER]), side);
    return null;
  }
  return parsed;
}

function reconcileMarker(
  mode: ReconciliationMode,
  leftInput: LogicalState,
  rightInput: LogicalState,
  leftTarget: LogicalState,
  rightTarget: LogicalState,
  leftRole: ReconciliationInputRole,
  rightRole: ReconciliationInputRole,
  conflicts: ReconciliationConflict[],
): void {
  const leftValue = validateExistingMarker(leftInput, leftRole, conflicts);
  const rightValue = validateExistingMarker(rightInput, rightRole, conflicts);
  if (leftValue === null || rightValue === null) return;

  let selected: bigint | undefined;
  if (mode === 'directional') {
    selected = leftValue ?? rightValue;
  } else {
    const values = [leftValue, rightValue].filter((value): value is bigint => value !== undefined);
    selected = values.reduce<bigint | undefined>(
      (smallest, value) => (smallest === undefined || value < smallest ? value : smallest),
      undefined,
    );
  }
  if (selected === undefined) return;
  const key = canonicalTuple([BACKFILL_MARKER]);
  const row = { key: BACKFILL_MARKER, value: selected.toString() };
  if (mode === 'bidirectional') {
    leftTarget.meta.set(key, row);
    rightTarget.meta.set(key, row);
  } else {
    rightTarget.meta.set(key, row);
  }

  const targets: Array<[LogicalState, ReconciliationTargetRole]> =
    mode === 'bidirectional'
      ? [
          [leftTarget, 'left'],
          [rightTarget, 'right'],
        ]
      : [[rightTarget, 'destination']];
  for (const [target, role] of targets) {
    if (!markerInvariant(target)) {
      addConflict(conflicts, 'meta', 'planned-marker-invariant-failed', key, role);
    }
  }
}

function validatePlannedTargetIntegrity(
  state: LogicalState,
  side: ReconciliationTargetRole,
  conflicts: ReconciliationConflict[],
): void {
  const boardNames = new Set<string>();
  for (const board of state.boards.values()) {
    const nameKey = canonicalTuple([board.name]);
    if (boardNames.has(nameKey)) {
      addConflict(conflicts, 'boards', 'planned-integrity-failed', nameKey, side);
    }
    boardNames.add(nameKey);
  }
  for (const [key, task] of state.tasks) {
    if (task.boardId !== null && !state.boards.has(canonicalTuple([task.boardId]))) {
      addConflict(conflicts, 'tasks', 'planned-integrity-failed', key, side);
    }
  }
  for (const [key, dependency] of state.taskDependencies) {
    if (
      !state.tasks.has(canonicalTuple([dependency.taskId])) ||
      !state.tasks.has(canonicalTuple([dependency.dependsOnId]))
    ) {
      addConflict(conflicts, 'task_dependencies', 'planned-integrity-failed', key, side);
    }
  }
  if (!dependencyGraphIsAcyclic(state.taskDependencies)) {
    addConflict(conflicts, 'task_dependencies', 'planned-integrity-failed', canonicalTuple(['dependency-cycle']), side);
  }
  for (const wishKey of invalidWishGroupGraphs(state.wishGroups)) {
    addConflict(conflicts, 'wish_groups', 'planned-integrity-failed', wishKey, side);
  }
  for (const [key, stage] of state.stageLog) {
    if (!state.tasks.has(canonicalTuple([stage.value.taskId]))) {
      addConflict(conflicts, 'stage_log', 'planned-integrity-failed', key, side);
    }
  }
  for (const [key, event] of state.taskEvents) {
    if (!state.tasks.has(canonicalTuple([event.value.taskId]))) {
      addConflict(conflicts, 'task_events', 'planned-integrity-failed', key, side);
    }
  }
}

function sortConflicts(conflicts: readonly ReconciliationConflict[]): ReconciliationConflict[] {
  return conflicts
    .map((conflict) => ({ conflict, key: JSON.stringify(conflict) }))
    .sort((leftConflict, rightConflict) => compareCanonical(leftConflict.key, rightConflict.key))
    .map((item) => item.conflict);
}

function validateSameDatabase(
  mode: ReconciliationMode,
  state: LogicalState,
): { left: LogicalState; right: LogicalState; conflicts: ReconciliationConflict[] } {
  const conflicts: ReconciliationConflict[] = [];
  const firstRole: ReconciliationInputRole = mode === 'bidirectional' ? 'left' : 'source';
  const secondRole: ReconciliationInputRole = mode === 'bidirectional' ? 'right' : 'destination';
  validateExistingMarker(state, firstRole, conflicts);
  validateExistingMarker(state, secondRole, conflicts);
  return {
    left: cloneState(state),
    right: cloneState(state),
    conflicts: sortConflicts(conflicts),
  };
}

function reconcileStates(
  mode: ReconciliationMode,
  leftInput: LogicalState,
  rightInput: LogicalState,
): { left: LogicalState; right: LogicalState; conflicts: ReconciliationConflict[] } {
  const left = cloneState(leftInput);
  const right = cloneState(rightInput);
  const conflicts: ReconciliationConflict[] = [];
  const markerKey = canonicalTuple([BACKFILL_MARKER]);

  if (mode === 'bidirectional') {
    reconcileBidirectionalKeyed('boards', left.boards, right.boards, boardValues, conflicts);
    reconcileBidirectionalKeyed('tasks', left.tasks, right.tasks, taskValues, conflicts);
    reconcileBidirectionalKeyed('wish_groups', left.wishGroups, right.wishGroups, wishGroupValues, conflicts);
    reconcileBidirectionalKeyed('hire_roster', left.hireRoster, right.hireRoster, hireRosterValues, conflicts);
    reconcileBidirectionalKeyed('meta', left.meta, right.meta, metaValues, conflicts, markerKey);
    reconcileBidirectionalSet(left.taskDependencies, right.taskDependencies);
    reconcileBidirectionalCounts(left.stageLog, right.stageLog);
    reconcileBidirectionalCounts(left.taskEvents, right.taskEvents);
    reconcileMarker('bidirectional', leftInput, rightInput, left, right, 'left', 'right', conflicts);
  } else {
    reconcileDirectionalKeyed(left.boards, right.boards, boardValues);
    reconcileDirectionalKeyed(left.tasks, right.tasks, taskValues);
    reconcileDirectionalKeyed(left.wishGroups, right.wishGroups, wishGroupValues);
    reconcileDirectionalKeyed(left.hireRoster, right.hireRoster, hireRosterValues);
    reconcileDirectionalKeyed(left.meta, right.meta, metaValues, markerKey);
    reconcileDirectionalSet(left.taskDependencies, right.taskDependencies);
    reconcileDirectionalCounts(left.stageLog, right.stageLog);
    reconcileDirectionalCounts(left.taskEvents, right.taskEvents);
    reconcileMarker('directional', leftInput, rightInput, left, right, 'source', 'destination', conflicts);
  }

  if (conflicts.length === 0) {
    if (mode === 'bidirectional') validatePlannedTargetIntegrity(left, 'left', conflicts);
    validatePlannedTargetIntegrity(right, mode === 'bidirectional' ? 'right' : 'destination', conflicts);
  }
  return { left, right, conflicts: sortConflicts(conflicts) };
}

function changedRows<T>(
  current: ReadonlyMap<string, T>,
  target: ReadonlyMap<string, T>,
  values: (row: T) => readonly (string | bigint | null)[],
): readonly T[] {
  return [...target.entries()]
    .filter(([key, row]) => {
      const existing = current.get(key);
      return existing === undefined || !rowEqual(existing, row, values);
    })
    .sort(([left], [right]) => compareCanonical(left, right))
    .map(([, row]) => row);
}

function addedSetRows<T>(current: ReadonlyMap<string, T>, target: ReadonlyMap<string, T>): readonly T[] {
  return [...target.entries()]
    .filter(([key]) => !current.has(key))
    .sort(([left], [right]) => compareCanonical(left, right))
    .map(([, row]) => row);
}

function historyAdditions<T>(
  current: ReadonlyMap<string, CountedValue<T>>,
  target: ReadonlyMap<string, CountedValue<T>>,
): readonly HistoryAddition<T>[] {
  return [...target.entries()]
    .map(([key, entry]) => ({ key, value: entry.value, count: entry.count - (current.get(key)?.count ?? 0) }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => compareCanonical(left.key, right.key))
    .map(({ value, count }) => ({ value, count }));
}

function targetChanges(current: LogicalState, target: LogicalState): ReconciliationTargetChanges {
  return {
    boards: changedRows(current.boards, target.boards, boardValues),
    tasks: changedRows(current.tasks, target.tasks, taskValues),
    wishGroups: changedRows(current.wishGroups, target.wishGroups, wishGroupValues),
    hireRoster: changedRows(current.hireRoster, target.hireRoster, hireRosterValues),
    meta: changedRows(current.meta, target.meta, metaValues),
    taskDependencies: addedSetRows(current.taskDependencies, target.taskDependencies),
    stageLog: historyAdditions(current.stageLog, target.stageLog),
    taskEvents: historyAdditions(current.taskEvents, target.taskEvents),
  };
}

function emptyChanges(): ReconciliationTargetChanges {
  return {
    boards: [],
    tasks: [],
    wishGroups: [],
    hireRoster: [],
    meta: [],
    taskDependencies: [],
    stageLog: [],
    taskEvents: [],
  };
}

function changeCounts(changes: ReconciliationTargetChanges): ReconciliationChangeCounts {
  return {
    boards: changes.boards.length,
    tasks: changes.tasks.length,
    wishGroups: changes.wishGroups.length,
    hireRoster: changes.hireRoster.length,
    meta: changes.meta.length,
    taskDependencies: changes.taskDependencies.length,
    stageLog: changes.stageLog.reduce((total, addition) => total + addition.count, 0),
    taskEvents: changes.taskEvents.reduce((total, addition) => total + addition.count, 0),
    deletions: 0,
  };
}

function hasChanges(changes: ReconciliationTargetChanges): boolean {
  return Object.entries(changeCounts(changes)).some(([name, count]) => name !== 'deletions' && count > 0);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function makeReport(
  mode: ReconciliationMode,
  status: ReconciliationReportStatus,
  sameDatabase: boolean,
  schemaFingerprint: string | null,
  targets: readonly ReconciliationTargetPlan[],
  conflicts: readonly ReconciliationConflict[],
  operationalFailure: ReconciliationDryRunReport['operationalFailure'] = null,
): ReconciliationDryRunReport {
  return {
    reportVersion: REPORT_VERSION,
    dryRun: true,
    mode,
    status,
    sameDatabase,
    schemaFingerprint,
    targets: targets.map((target) => ({
      role: target.role,
      preimageDigest: target.preimageDigest,
      postimageDigest: target.postimageDigest,
      changes: changeCounts(target.changes),
    })),
    conflicts,
    operationalFailure,
    historyLimitation: IDENTICAL_HISTORY_ADDITION_LIMITATION,
  };
}

function makeTargetPlan(
  role: ReconciliationTargetRole,
  input: PhysicalInput,
  image: DatabaseImage,
  target: LogicalState,
  conflict: boolean,
): ReconciliationTargetPlan {
  return {
    role,
    canonicalPath: input.canonicalPath,
    preimageDigest: image.logicalDigest,
    postimageDigest: conflict ? null : logicalStateDigest(image.schemaFingerprint, target),
    changes: conflict ? emptyChanges() : targetChanges(image.state, target),
  };
}

function buildTargetPlans(
  mode: ReconciliationMode,
  first: PhysicalInput,
  second: PhysicalInput,
  firstImage: DatabaseImage,
  secondImage: DatabaseImage,
  reconciled: { left: LogicalState; right: LogicalState; conflicts: readonly ReconciliationConflict[] },
): readonly ReconciliationTargetPlan[] {
  const conflict = reconciled.conflicts.length > 0;
  if (mode === 'directional') {
    return [makeTargetPlan('destination', second, secondImage, reconciled.right, conflict)];
  }
  return [
    makeTargetPlan('left', first, firstImage, reconciled.left, conflict),
    makeTargetPlan('right', second, secondImage, reconciled.right, conflict),
  ];
}

function planStatus(conflict: boolean, sameDatabase: boolean, anyChanges: boolean): ReconciliationPlanStatus {
  if (conflict) return 'conflict';
  if (sameDatabase) return 'same-database';
  return anyChanges ? 'changed' : 'no-op';
}

/**
 * Load two exact current schemas read-only and produce a deeply frozen logical
 * reconciliation plan. No schema normalization, snapshot, lock, or write is
 * attempted here.
 */
export function planDatabaseReconciliation(request: ReconciliationRequest): ReconciliationPlan {
  const mode = request.mode;
  const firstRole: ReconciliationInputRole = mode === 'bidirectional' ? 'left' : 'source';
  const secondRole: ReconciliationInputRole = mode === 'bidirectional' ? 'right' : 'destination';
  const first = resolvePhysicalInput(mode === 'bidirectional' ? request.leftPath : request.sourcePath);
  const second = resolvePhysicalInput(mode === 'bidirectional' ? request.rightPath : request.destinationPath);
  const sameDatabase = samePhysicalInput(first, second);

  const firstImage = loadDatabaseImage(first);
  const secondImage = sameDatabase ? firstImage : loadDatabaseImage(second);
  revalidatePhysicalInput(first);
  revalidatePhysicalInput(second);
  if (firstImage.schemaFingerprint !== secondImage.schemaFingerprint) unsupportedSchema();

  const reconciled = sameDatabase
    ? validateSameDatabase(mode, firstImage.state)
    : reconcileStates(mode, firstImage.state, secondImage.state);
  const inputs: ReconciliationPlanInput[] = [
    {
      role: firstRole,
      canonicalPath: first.canonicalPath,
      logicalDigest: firstImage.logicalDigest,
    },
    {
      role: secondRole,
      canonicalPath: second.canonicalPath,
      logicalDigest: secondImage.logicalDigest,
    },
  ];
  const conflict = reconciled.conflicts.length > 0;
  const targets = buildTargetPlans(mode, first, second, firstImage, secondImage, reconciled);
  const anyChanges = targets.some((target) => hasChanges(target.changes));
  const status = planStatus(conflict, sameDatabase, anyChanges);
  const reportStatus: ReconciliationReportStatus = conflict ? 'conflict' : anyChanges ? 'changed' : 'no-op';
  const report = makeReport(
    mode,
    reportStatus,
    sameDatabase,
    firstImage.schemaFingerprint,
    targets,
    reconciled.conflicts,
  );
  return deepFreeze({
    planVersion: PLAN_VERSION,
    mode,
    status,
    sameDatabase,
    schemaFingerprint: firstImage.schemaFingerprint,
    inputs,
    targets,
    conflicts: reconciled.conflicts,
    report,
    historyLimitation: IDENTICAL_HISTORY_ADDITION_LIMITATION,
  });
}

/**
 * Safe reporting wrapper for dry-run surfaces. Operational failures are
 * reduced to bounded codes/guidance and never include guest titles or notes.
 */
export function dryRunDatabaseReconciliation(request: ReconciliationRequest): ReconciliationDryRunReport {
  try {
    return planDatabaseReconciliation(request).report;
  } catch (caught) {
    const failure =
      caught instanceof ReconciliationError
        ? { code: caught.code, ...(caught.guidance === undefined ? {} : { guidance: caught.guidance }) }
        : { code: 'unexpected-failure' as const };
    return deepFreeze(makeReport(request.mode, 'operational-failure', false, null, [], [], failure));
  }
}

function validateBusyTimeout(value: number | undefined): number {
  const timeout = value ?? BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > MAX_BUSY_TIMEOUT_MS) {
    throw new ApplyBoundaryError({ code: 'invalid-plan', phase: 'plan-validation' });
  }
  return timeout;
}

function inputForTarget(plan: ReconciliationPlan, role: ReconciliationTargetRole): ReconciliationPlanInput | undefined {
  const inputRole: ReconciliationInputRole = role === 'destination' ? 'destination' : role;
  return plan.inputs.find((input) => input.role === inputRole);
}

function expectedRoles(mode: ReconciliationMode): {
  readonly inputs: readonly ReconciliationInputRole[];
  readonly targets: readonly ReconciliationTargetRole[];
} {
  return mode === 'bidirectional'
    ? { inputs: ['left', 'right'], targets: ['left', 'right'] }
    : { inputs: ['source', 'destination'], targets: ['destination'] };
}

function validateApplicablePlan(plan: ReconciliationPlan): void {
  if (plan.planVersion !== PLAN_VERSION || (plan.mode !== 'bidirectional' && plan.mode !== 'directional')) {
    throw new ApplyBoundaryError({ code: 'invalid-plan', phase: 'plan-validation' });
  }
  const expected = expectedRoles(plan.mode);
  if (
    plan.inputs.length !== expected.inputs.length ||
    plan.targets.length !== expected.targets.length ||
    plan.inputs.some((input, index) => input.role !== expected.inputs[index]) ||
    plan.targets.some((target, index) => target.role !== expected.targets[index])
  ) {
    throw new ApplyBoundaryError({ code: 'invalid-plan', phase: 'plan-validation' });
  }
  for (const target of plan.targets) {
    const input = inputForTarget(plan, target.role);
    if (
      input === undefined ||
      input.canonicalPath !== target.canonicalPath ||
      input.logicalDigest !== target.preimageDigest ||
      (plan.status === 'conflict') !== (target.postimageDigest === null)
    ) {
      throw new ApplyBoundaryError({ code: 'invalid-plan', phase: 'plan-validation', role: target.role });
    }
  }
  const conflict = plan.conflicts.length > 0;
  const invalidSameDatabaseStatus =
    plan.status === 'conflict' ? false : plan.sameDatabase !== (plan.status === 'same-database');
  if (conflict !== (plan.status === 'conflict') || invalidSameDatabaseStatus) {
    throw new ApplyBoundaryError({ code: 'invalid-plan', phase: 'plan-validation' });
  }
}

function initialApplyTargets(plan: ReconciliationPlan): ReconciliationApplyTargetReport[] {
  return plan.targets.map((target) => ({
    role: target.role,
    preimageDigest: target.preimageDigest,
    postimageDigest: target.postimageDigest,
    observedDigest: null,
    observation: 'not-observed',
    committed: false,
  }));
}

function makeApplyReport(
  plan: ReconciliationPlan,
  status: ReconciliationApplyStatus,
  converged: boolean,
  targets: readonly ReconciliationApplyTargetReport[],
  failure: ReconciliationApplyFailure | null,
  cleanupFailures: readonly ReconciliationApplyFailure[] = [],
): ReconciliationApplyReport {
  return deepFreeze({
    reportVersion: REPORT_VERSION,
    dryRun: false,
    mode: plan.mode,
    status,
    converged,
    targets,
    failure,
    cleanupFailures,
  });
}

function failureFrom(caught: unknown, fallback: ApplyFailureContext): ReconciliationApplyFailure {
  if (caught instanceof ApplyBoundaryError) return caught.context;
  if (caught instanceof ReconciliationError) {
    return {
      code: caught.code,
      phase: fallback.phase,
      ...(fallback.role === undefined ? {} : { role: fallback.role }),
    };
  }
  return {
    ...fallback,
    code: fallback.code === 'unexpected-failure' ? fallback.code : 'unexpected-failure',
  };
}

function emitApplyEvent(options: ReconciliationApplyOptions, event: ReconciliationApplyEvent): void {
  try {
    options.onEvent?.(event);
  } catch (caught) {
    const role = 'role' in event ? event.role : undefined;
    throw new ApplyBoundaryError(
      {
        code: event.phase === 'commit' ? 'commit-failed' : 'apply-failed',
        phase: event.phase,
        ...(role === undefined ? {} : { role }),
      },
      caught,
    );
  }
}

function resolvePlannedInputs(plan: ReconciliationPlan): Array<{
  readonly planned: ReconciliationPlanInput;
  readonly physical: PhysicalInput;
}> {
  const resolved = plan.inputs.map((planned) => {
    let physical: PhysicalInput;
    try {
      physical = resolvePhysicalInput(planned.canonicalPath);
    } catch (caught) {
      throw new ApplyBoundaryError(
        {
          code: caught instanceof ReconciliationError ? caught.code : 'input-changed',
          phase: 'revalidation',
          role: planned.role,
        },
        caught,
      );
    }
    if (physical.canonicalPath !== planned.canonicalPath) {
      throw new ApplyBoundaryError({ code: 'input-changed', phase: 'revalidation', role: planned.role });
    }
    return { planned, physical };
  });
  let sameNow: boolean;
  try {
    sameNow = samePhysicalInput(resolved[0].physical, resolved[1].physical);
  } catch (caught) {
    throw new ApplyBoundaryError(
      {
        code: caught instanceof ReconciliationError ? caught.code : 'input-changed',
        phase: 'revalidation',
      },
      caught,
    );
  }
  if (sameNow !== plan.sameDatabase) {
    throw new ApplyBoundaryError({ code: 'input-changed', phase: 'revalidation' });
  }
  return resolved;
}

function acquirePlannedAdvisoryLocks(
  inputs: readonly { readonly physical: PhysicalInput }[],
  deadline: number,
  options: ReconciliationApplyOptions,
): AdvisoryLock[] {
  const locks: AdvisoryLock[] = [];
  const paths = [...new Set(inputs.map((input) => input.physical.canonicalPath))].sort(compareCanonical);
  try {
    for (const path of paths) locks.push(acquireAdvisoryLock(path, remainingLockWait(deadline), options));
    return locks;
  } catch (caught) {
    const cleanupFailures: ReconciliationApplyFailure[] = [];
    for (const lock of locks.reverse()) {
      try {
        releaseAdvisoryLock(lock);
      } catch {
        cleanupFailures.push({ code: 'advisory-lock-release-failed', phase: 'cleanup' });
      }
    }
    if (cleanupFailures.length > 0) {
      if (caught instanceof ApplyBoundaryError) caught.cleanupFailures.push(...cleanupFailures);
      else {
        throw new ApplyBoundaryError({ code: 'unexpected-failure', phase: 'advisory-lock' }, caught, cleanupFailures);
      }
    }
    throw caught;
  }
}

function remainingLockWait(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function physicalIdentity(input: PhysicalInput): string {
  return `${input.device}:${input.inode}`;
}

function revalidateApplyInput(input: PhysicalInput, role: ReconciliationInputRole): void {
  try {
    revalidatePhysicalInput(input);
  } catch (caught) {
    throw new ApplyBoundaryError({ code: 'input-changed', phase: 'revalidation', role }, caught);
  }
}

function openLockedDatabases(
  inputs: readonly { readonly planned: ReconciliationPlanInput; readonly physical: PhysicalInput }[],
  deadline: number,
  options: ReconciliationApplyOptions,
): LockedDatabase[] {
  for (const input of inputs) revalidateApplyInput(input.physical, input.planned.role);
  const grouped = new Map<string, { input: PhysicalInput; roles: ReconciliationInputRole[]; paths: PhysicalInput[] }>();
  for (const { planned, physical } of inputs) {
    const key = physicalIdentity(physical);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, { input: physical, roles: [planned.role], paths: [physical] });
    } else {
      existing.roles.push(planned.role);
      existing.paths.push(physical);
      if (compareCanonical(physical.canonicalPath, existing.input.canonicalPath) < 0) {
        existing.input = physical;
      }
    }
  }

  const locked: LockedDatabase[] = [];
  const ordered = [...grouped.values()].sort((left, right) =>
    compareCanonical(left.input.canonicalPath, right.input.canonicalPath),
  );
  try {
    for (const group of ordered) {
      let db: Database | null = null;
      try {
        const databaseOptions = {
          readwrite: true,
          create: false,
          strict: true,
          safeIntegers: true,
        } as const;
        db =
          options.openDatabase?.(group.input.canonicalPath, databaseOptions) ??
          new Database(group.input.canonicalPath, databaseOptions);
        requireDatabaseHandleMatchesPath(db, group.roles[0]);
        for (const path of group.paths) revalidateApplyInput(path, group.roles[0]);
        requireDatabaseHandleMatchesPath(db, group.roles[0]);
        db.exec(`PRAGMA busy_timeout = ${remainingLockWait(deadline)}`);
        db.exec('PRAGMA trusted_schema = OFF');
        db.exec('PRAGMA foreign_keys = ON');
        db.exec('BEGIN IMMEDIATE');
        requireDatabaseHandleMatchesPath(db, group.roles[0]);
      } catch (caught) {
        db?.close();
        throw new ApplyBoundaryError(
          {
            code: isBusyError(caught) ? 'sqlite-lock-timeout' : 'input-changed',
            phase: isBusyError(caught) ? 'sqlite-lock' : 'revalidation',
            role: group.roles[0],
          },
          caught,
        );
      }
      locked.push({ input: group.input, roles: group.roles, db, transactionOpen: true });
    }
    return locked;
  } catch (caught) {
    throwWithLockedCleanup(caught, locked);
  }
}

function lockedDatabaseForRole(
  locked: readonly LockedDatabase[],
  role: ReconciliationInputRole | ReconciliationTargetRole,
): LockedDatabase {
  const inputRole: ReconciliationInputRole = role === 'destination' ? 'destination' : role;
  const found = locked.find((item) => item.roles.includes(inputRole));
  if (found === undefined) {
    throw new ApplyBoundaryError({ code: 'invalid-plan', phase: 'plan-validation', role });
  }
  return found;
}

function rollbackOpenTransactions(locked: readonly LockedDatabase[]): boolean {
  let complete = true;
  for (const item of [...locked].reverse()) {
    if (!item.transactionOpen) continue;
    try {
      item.db.exec('ROLLBACK');
      item.transactionOpen = false;
    } catch {
      complete = false;
    }
  }
  return complete;
}

function closeLockedDatabases(locked: readonly LockedDatabase[]): boolean {
  let complete = true;
  for (const item of [...locked].reverse()) {
    try {
      item.db.close();
    } catch {
      complete = false;
    }
  }
  return complete;
}

function throwWithLockedCleanup(caught: unknown, locked: readonly LockedDatabase[]): never {
  const cleanupFailures: ReconciliationApplyFailure[] = [];
  if (!rollbackOpenTransactions(locked)) {
    cleanupFailures.push({ code: 'rollback-failed', phase: 'rollback' });
  }
  if (!closeLockedDatabases(locked)) {
    cleanupFailures.push({ code: 'close-failed', phase: 'cleanup' });
  }
  if (caught instanceof ApplyBoundaryError) {
    caught.cleanupFailures.push(...cleanupFailures);
    throw caught;
  }
  throw new ApplyBoundaryError({ code: 'unexpected-failure', phase: 'sqlite-lock' }, caught, cleanupFailures);
}

function releaseAdvisoryLocks(locks: readonly AdvisoryLock[], options?: ReconciliationApplyOptions): boolean {
  let complete = true;
  for (const lock of [...locks].reverse()) {
    try {
      releaseAdvisoryLock(lock, options);
    } catch {
      complete = false;
    }
  }
  return complete;
}

function revalidateLockedPlan(
  plan: ReconciliationPlan,
  locked: readonly LockedDatabase[],
): ReadonlyMap<ReconciliationInputRole, DatabaseImage> {
  const images = new Map<ReconciliationInputRole, DatabaseImage>();
  for (const item of locked) {
    let image: DatabaseImage;
    try {
      requireDatabaseHandleMatchesPath(item.db, item.roles[0]);
      revalidateApplyInput(item.input, item.roles[0]);
      requireDatabaseHandleMatchesPath(item.db, item.roles[0]);
      image = readDatabaseImage(item.db);
    } catch (caught) {
      throw new ApplyBoundaryError(
        {
          code: caught instanceof ReconciliationError ? caught.code : 'input-changed',
          phase: 'revalidation',
          role: item.roles[0],
        },
        caught,
      );
    }
    if (image.schemaFingerprint !== plan.schemaFingerprint) {
      throw new ApplyBoundaryError({ code: 'input-changed', phase: 'revalidation', role: item.roles[0] });
    }
    for (const role of item.roles) {
      const expected = plan.inputs.find((input) => input.role === role);
      if (expected === undefined || image.logicalDigest !== expected.logicalDigest) {
        throw new ApplyBoundaryError({ code: 'input-changed', phase: 'revalidation', role });
      }
      images.set(role, image);
    }
  }
  return images;
}

function lockedInputsForHook(
  plan: ReconciliationPlan,
  locked: readonly LockedDatabase[],
): readonly ReconciliationLockedInput[] {
  return plan.inputs.map((input) => {
    const item = lockedDatabaseForRole(locked, input.role);
    const targetRole: ReconciliationTargetRole =
      input.role === 'destination'
        ? 'destination'
        : input.role === 'left' || input.role === 'right'
          ? input.role
          : 'destination';
    const target = plan.targets.some((candidate) => candidate.role === targetRole && input.role !== 'source');
    return Object.freeze({
      role: input.role,
      canonicalPath: input.canonicalPath,
      target,
      serialize: () => {
        requireDatabaseHandleMatchesPath(item.db, input.role);
        revalidateApplyInput(item.input, input.role);
        requireDatabaseHandleMatchesPath(item.db, input.role);
        const bytes = new Uint8Array(item.db.serialize());
        requireDatabaseHandleMatchesPath(item.db, input.role);
        revalidateApplyInput(item.input, input.role);
        requireDatabaseHandleMatchesPath(item.db, input.role);
        return bytes;
      },
    });
  });
}

function runLockedHook(
  plan: ReconciliationPlan,
  locked: readonly LockedDatabase[],
  options: ReconciliationApplyOptions,
): void {
  emitApplyEvent(options, { phase: 'locked' });
  try {
    options.onLocked?.(lockedInputsForHook(plan, locked));
  } catch (caught) {
    if (caught instanceof ApplyBoundaryError) throw caught;
    throw new ApplyBoundaryError({ code: 'apply-failed', phase: 'locked' }, caught);
  }
}

function temporaryBoardName(db: Database, nonce: string, index: number): string {
  let attempt = 0;
  for (;;) {
    const value = `__genie_reconciliation_${nonce}_${index}_${attempt}`;
    const found = db.query('SELECT 1 AS present FROM boards WHERE name = ?').get(value);
    if (found === null) return value;
    attempt++;
  }
}

function applyBoards(db: Database, rows: readonly BoardReconciliationRow[]): void {
  const changing: BoardReconciliationRow[] = [];
  for (const row of rows) {
    const current = db.query('SELECT name FROM boards WHERE id = ?').get(row.id) as Record<string, SqliteScalar> | null;
    if (current !== null && rowString(current, 'name') !== row.name) changing.push(row);
  }
  const nonce = randomUUID().replaceAll('-', '');
  const park = db.query('UPDATE boards SET name = ? WHERE id = ?');
  for (const [index, row] of changing.entries()) {
    park.run(temporaryBoardName(db, nonce, index), row.id);
  }
  const upsert = db.query(
    `INSERT INTO boards (id, name, created_at, lanes)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       created_at = excluded.created_at,
       lanes = excluded.lanes`,
  );
  for (const row of rows) upsert.run(...boardValues(row));
}

function applyTasks(db: Database, rows: readonly TaskReconciliationRow[]): void {
  const upsert = db.query(
    `INSERT INTO tasks (
       id, board_id, title, status, claimed_by, claimed_at, wish, group_name,
       created_at, updated_at, lane, agent_kind, heartbeat_at, blocked_by, blocked_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       board_id = excluded.board_id,
       title = excluded.title,
       status = excluded.status,
       claimed_by = excluded.claimed_by,
       claimed_at = excluded.claimed_at,
       wish = excluded.wish,
       group_name = excluded.group_name,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       lane = excluded.lane,
       agent_kind = excluded.agent_kind,
       heartbeat_at = excluded.heartbeat_at,
       blocked_by = excluded.blocked_by,
       blocked_reason = excluded.blocked_reason`,
  );
  for (const row of rows) upsert.run(...taskValues(row));
}

function applyWishGroups(db: Database, rows: readonly WishGroupReconciliationRow[]): void {
  const upsert = db.query(
    `INSERT INTO wish_groups (
       wish, name, status, depends_on, assignee, started_at, completed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wish, name) DO UPDATE SET
       status = excluded.status,
       depends_on = excluded.depends_on,
       assignee = excluded.assignee,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
  );
  for (const row of rows) upsert.run(...wishGroupValues(row));
}

function applyHireRoster(db: Database, rows: readonly HireRosterReconciliationRow[]): void {
  const upsert = db.query(
    `INSERT INTO hire_roster (wish, agent_adapter_id, profile, worktree, hired_at, state)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(wish, agent_adapter_id) DO UPDATE SET
       profile = excluded.profile,
       worktree = excluded.worktree,
       hired_at = excluded.hired_at,
       state = excluded.state`,
  );
  for (const row of rows) upsert.run(...hireRosterValues(row));
}

function applyTaskDependencies(db: Database, rows: readonly TaskDependencyReconciliationRow[]): void {
  const insert = db.query(
    `INSERT INTO task_dependencies (task_id, depends_on_id)
     VALUES (?, ?)
     ON CONFLICT(task_id, depends_on_id) DO NOTHING`,
  );
  for (const row of rows) insert.run(...dependencyValues(row));
}

function applyStageLog(db: Database, additions: readonly HistoryAddition<StageLogReconciliationValue>[]): void {
  const insert = db.query('INSERT INTO stage_log (task_id, stage, note, created_at) VALUES (?, ?, ?, ?)');
  for (const addition of additions) {
    for (let count = 0; count < addition.count; count++) insert.run(...stageValues(addition.value));
  }
}

function applyTaskEvents(db: Database, additions: readonly HistoryAddition<TaskEventReconciliationValue>[]): void {
  const insert = db.query(
    'INSERT INTO task_events (task_id, kind, note, author_kind, author, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const addition of additions) {
    for (let count = 0; count < addition.count; count++) insert.run(...eventValues(addition.value));
  }
}

function applyMeta(db: Database, rows: readonly MetaReconciliationRow[]): void {
  const upsert = db.query(
    `INSERT INTO meta (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  for (const row of rows) upsert.run(...metaValues(row));
}

function applyTargetChanges(db: Database, changes: ReconciliationTargetChanges): void {
  // Parent rows precede dependents. The backfill marker is written last so its
  // logical coverage invariant is never transiently asserted ahead of history.
  applyBoards(db, changes.boards);
  applyTasks(db, changes.tasks);
  applyWishGroups(db, changes.wishGroups);
  applyHireRoster(db, changes.hireRoster);
  applyTaskDependencies(db, changes.taskDependencies);
  applyStageLog(db, changes.stageLog);
  applyTaskEvents(db, changes.taskEvents);
  applyMeta(db, changes.meta);
}

function completeStateChanges(state: LogicalState): ReconciliationTargetChanges {
  return {
    boards: [...state.boards.values()],
    tasks: [...state.tasks.values()],
    wishGroups: [...state.wishGroups.values()],
    hireRoster: [...state.hireRoster.values()],
    meta: [...state.meta.values()],
    taskDependencies: [...state.taskDependencies.values()],
    stageLog: [...state.stageLog.values()].map(({ value, count }) => ({ value, count })),
    taskEvents: [...state.taskEvents.values()].map(({ value, count }) => ({ value, count })),
  };
}

function replaceLogicalState(db: Database, source: DatabaseImage): DatabaseImage {
  db.exec(`
    DELETE FROM task_dependencies;
    DELETE FROM stage_log;
    DELETE FROM task_events;
    DELETE FROM hire_roster;
    DELETE FROM wish_groups;
    DELETE FROM tasks;
    DELETE FROM boards;
    DELETE FROM meta;
  `);
  applyTargetChanges(db, completeStateChanges(source.state));
  const restored = readDatabaseImage(db);
  if (restored.schemaFingerprint !== source.schemaFingerprint || restored.logicalDigest !== source.logicalDigest) {
    throw new ReconciliationError(
      'integrity-failed',
      'A logical snapshot restore did not reproduce its validated image.',
    );
  }
  return restored;
}

function runPostimageCheck(
  phase: 'foreign-key-check' | 'integrity-check' | 'logical-postimage-check',
  role: ReconciliationTargetRole,
  check: () => void,
): void {
  try {
    check();
  } catch (caught) {
    if (caught instanceof ApplyBoundaryError) throw caught;
    throw new ApplyBoundaryError(
      {
        code: caught instanceof ReconciliationError ? caught.code : 'postimage-mismatch',
        phase,
        role,
      },
      caught,
    );
  }
}

function validateTargetPostimage(
  plan: ReconciliationPlan,
  target: ReconciliationTargetPlan,
  db: Database,
  options: ReconciliationApplyOptions,
): void {
  let schemaFingerprint = '';
  runPostimageCheck('logical-postimage-check', target.role, () => {
    schemaFingerprint = digestCanonical(['genie-schema-v1', readSchemaFingerprint(db)]);
    if (schemaFingerprint !== plan.schemaFingerprint) {
      throw new ApplyBoundaryError({
        code: 'postimage-mismatch',
        phase: 'logical-postimage-check',
        role: target.role,
      });
    }
  });

  emitApplyEvent(options, { phase: 'foreign-key-check', role: target.role, state: 'before' });
  runPostimageCheck('foreign-key-check', target.role, () => checkForeignKeys(db));
  emitApplyEvent(options, { phase: 'foreign-key-check', role: target.role, state: 'after' });

  emitApplyEvent(options, { phase: 'integrity-check', role: target.role, state: 'before' });
  runPostimageCheck('integrity-check', target.role, () => checkSqliteIntegrity(db));
  emitApplyEvent(options, { phase: 'integrity-check', role: target.role, state: 'after' });

  emitApplyEvent(options, { phase: 'logical-postimage-check', role: target.role, state: 'before' });
  runPostimageCheck('logical-postimage-check', target.role, () => {
    preflightRowCounts(db);
    const state = readLogicalState(db);
    const logicalDigest = logicalStateDigest(schemaFingerprint, state);
    if (target.postimageDigest === null || logicalDigest !== target.postimageDigest) {
      throw new ApplyBoundaryError({
        code: 'postimage-mismatch',
        phase: 'logical-postimage-check',
        role: target.role,
      });
    }
  });
  emitApplyEvent(options, { phase: 'logical-postimage-check', role: target.role, state: 'after' });
}

function ensureDirectionalSourceUnchanged(plan: ReconciliationPlan, locked: readonly LockedDatabase[]): void {
  if (plan.mode !== 'directional') return;
  const source = plan.inputs.find((input) => input.role === 'source');
  if (source === undefined) {
    throw new ApplyBoundaryError({ code: 'invalid-plan', phase: 'plan-validation', role: 'source' });
  }
  let image: DatabaseImage;
  try {
    image = readDatabaseImage(lockedDatabaseForRole(locked, 'source').db);
  } catch (caught) {
    throw new ApplyBoundaryError(
      {
        code: caught instanceof ReconciliationError ? caught.code : 'input-changed',
        phase: 'revalidation',
        role: 'source',
      },
      caught,
    );
  }
  if (image.schemaFingerprint !== plan.schemaFingerprint || image.logicalDigest !== source.logicalDigest) {
    throw new ApplyBoundaryError({ code: 'input-changed', phase: 'revalidation', role: 'source' });
  }
}

function orderedTargets(plan: ReconciliationPlan): ReconciliationTargetPlan[] {
  return [...plan.targets].sort((left, right) => {
    const pathOrder = compareCanonical(left.canonicalPath, right.canonicalPath);
    return pathOrder === 0 ? compareCanonical(left.role, right.role) : pathOrder;
  });
}

function commitTarget(
  target: ReconciliationTargetPlan,
  item: LockedDatabase,
  options: ReconciliationApplyOptions,
  committed: Set<ReconciliationTargetRole>,
): void {
  emitApplyEvent(options, { phase: 'commit', role: target.role, state: 'before' });
  requireDatabaseHandleMatchesPath(item.db, target.role);
  revalidateApplyInput(item.input, target.role);
  requireDatabaseHandleMatchesPath(item.db, target.role);
  try {
    item.db.exec('COMMIT');
    item.transactionOpen = false;
    committed.add(target.role);
  } catch (caught) {
    throw new ApplyBoundaryError({ code: 'commit-failed', phase: 'commit', role: target.role }, caught);
  }
  emitApplyEvent(options, { phase: 'commit', role: target.role, state: 'after' });
}

function commitNonTargetTransactions(
  plan: ReconciliationPlan,
  locked: readonly LockedDatabase[],
  committed: Set<ReconciliationTargetRole>,
): void {
  for (const item of locked) {
    if (!item.transactionOpen) continue;
    try {
      requireDatabaseHandleMatchesPath(item.db, item.roles[0]);
      revalidateApplyInput(item.input, item.roles[0]);
      requireDatabaseHandleMatchesPath(item.db, item.roles[0]);
      item.db.exec('COMMIT');
      item.transactionOpen = false;
    } catch (caught) {
      throw new ApplyBoundaryError({ code: 'commit-failed', phase: 'commit', role: item.roles[0] }, caught);
    }
    for (const target of plan.targets) {
      if (item.roles.includes(target.role === 'destination' ? 'destination' : target.role)) {
        committed.add(target.role);
      }
    }
  }
}

function mutateValidateAndCommit(
  plan: ReconciliationPlan,
  locked: readonly LockedDatabase[],
  options: ReconciliationApplyOptions,
  committed: Set<ReconciliationTargetRole>,
): void {
  if (plan.status === 'same-database') {
    commitNonTargetTransactions(plan, locked, committed);
    return;
  }

  const targets = orderedTargets(plan);
  for (const target of targets) {
    const item = lockedDatabaseForRole(locked, target.role);
    emitApplyEvent(options, { phase: 'mutation', role: target.role, state: 'before' });
    requireDatabaseHandleMatchesPath(item.db, target.role);
    revalidateApplyInput(item.input, target.role);
    requireDatabaseHandleMatchesPath(item.db, target.role);
    applyTargetChanges(item.db, target.changes);
    emitApplyEvent(options, { phase: 'mutation', role: target.role, state: 'after' });
  }
  for (const target of targets) {
    validateTargetPostimage(plan, target, lockedDatabaseForRole(locked, target.role).db, options);
  }
  ensureDirectionalSourceUnchanged(plan, locked);

  for (const target of targets) {
    commitTarget(target, lockedDatabaseForRole(locked, target.role), options, committed);
  }
  commitNonTargetTransactions(plan, locked, committed);
}

function observeTarget(
  target: ReconciliationTargetPlan,
  committed: ReadonlySet<ReconciliationTargetRole>,
  timeoutMs: number,
): ReconciliationApplyTargetReport {
  let observedDigest: string | null = null;
  try {
    observedDigest = loadDatabaseImage(resolvePhysicalInput(target.canonicalPath), timeoutMs).logicalDigest;
  } catch {
    return {
      role: target.role,
      preimageDigest: target.preimageDigest,
      postimageDigest: target.postimageDigest,
      observedDigest: null,
      observation: 'not-observed',
      committed: committed.has(target.role),
    };
  }
  const equalsPreimage = observedDigest === target.preimageDigest;
  const equalsPostimage = target.postimageDigest !== null && observedDigest === target.postimageDigest;
  const observation: ReconciliationTargetObservation =
    equalsPreimage && equalsPostimage
      ? 'expected-pre-and-postimage'
      : equalsPostimage
        ? 'expected-postimage'
        : equalsPreimage
          ? 'expected-preimage'
          : 'unexpected';
  return {
    role: target.role,
    preimageDigest: target.preimageDigest,
    postimageDigest: target.postimageDigest,
    observedDigest,
    observation,
    committed: committed.has(target.role),
  };
}

function observeTargets(
  plan: ReconciliationPlan,
  committed: ReadonlySet<ReconciliationTargetRole>,
  timeoutMs: number,
): ReconciliationApplyTargetReport[] {
  return plan.targets.map((target) => observeTarget(target, committed, timeoutMs));
}

function classifyApplyStatus(
  plan: ReconciliationPlan,
  targets: readonly ReconciliationApplyTargetReport[],
  failure: ReconciliationApplyFailure | null,
): { status: ReconciliationApplyStatus; converged: boolean } {
  if (failure?.code === 'advisory-lock-timeout' || failure?.code === 'sqlite-lock-timeout') {
    return { status: 'lock-timeout', converged: false };
  }
  if (failure?.phase === 'revalidation' || failure?.code === 'input-changed') {
    return { status: 'preimage-changed', converged: false };
  }
  if (targets.some((target) => target.observation === 'unexpected')) {
    return { status: 'unexpected-intervening-write', converged: false };
  }
  if (targets.some((target) => target.observation === 'not-observed')) {
    return { status: 'uncertain', converged: false };
  }
  if (failure === null) {
    if (plan.status === 'same-database') return { status: 'same-database', converged: true };
    if (plan.status === 'no-op') return { status: 'no-op', converged: true };
    if (
      targets.every(
        (target) => target.observation === 'expected-postimage' || target.observation === 'expected-pre-and-postimage',
      )
    ) {
      return { status: 'changed', converged: true };
    }
    return { status: 'uncertain', converged: false };
  }
  const hasPostCommitEvidence = targets.some(
    (target) => target.committed || target.observation === 'expected-postimage',
  );
  if (
    hasPostCommitEvidence &&
    targets.every(
      (target) => target.observation === 'expected-postimage' || target.observation === 'expected-pre-and-postimage',
    )
  ) {
    return { status: 'expected-postimage', converged: false };
  }
  if (
    hasPostCommitEvidence &&
    targets.every(
      (target) =>
        target.observation === 'expected-postimage' ||
        target.observation === 'expected-preimage' ||
        target.observation === 'expected-pre-and-postimage',
    )
  ) {
    return { status: 'partial-commit', converged: false };
  }
  if (
    targets.every((target) => !target.committed) &&
    targets.every(
      (target) => target.observation === 'expected-preimage' || target.observation === 'expected-pre-and-postimage',
    )
  ) {
    return { status: 'rolled-back', converged: false };
  }
  return { status: 'uncertain', converged: false };
}

/**
 * Apply an immutable plan through live SQLite handles only.
 *
 * Advisory locks coordinate reconciliation-aware writers. `BEGIN IMMEDIATE`
 * on every input remains authoritative for older Genie writers that do not
 * know those locks. All acquisition, rollback, commit, and post-failure
 * observation paths return a bounded state report rather than claiming pair
 * convergence after an ambiguous boundary.
 */
export function applyDatabaseReconciliation(
  plan: ReconciliationPlan,
  options: ReconciliationApplyOptions = {},
): ReconciliationApplyReport {
  let timeoutMs = BUSY_TIMEOUT_MS;
  let failure: ReconciliationApplyFailure | null = null;
  let advisoryLocks: AdvisoryLock[] = [];
  let locked: LockedDatabase[] = [];
  const committed = new Set<ReconciliationTargetRole>();
  const cleanupFailures: ReconciliationApplyFailure[] = [];

  try {
    timeoutMs = validateBusyTimeout(options.busyTimeoutMs);
    validateApplicablePlan(plan);
  } catch (caught) {
    failure = failureFrom(caught, { code: 'invalid-plan', phase: 'plan-validation' });
    return makeApplyReport(plan, 'uncertain', false, initialApplyTargets(plan), failure);
  }

  if (plan.status === 'conflict') {
    return makeApplyReport(plan, 'conflict', false, initialApplyTargets(plan), null);
  }

  try {
    const inputs = resolvePlannedInputs(plan);
    const lockDeadline = Date.now() + timeoutMs;
    advisoryLocks = acquirePlannedAdvisoryLocks(inputs, lockDeadline, options);
    locked = openLockedDatabases(inputs, lockDeadline, options);
    revalidateLockedPlan(plan, locked);
    runLockedHook(plan, locked, options);
    mutateValidateAndCommit(plan, locked, options, committed);
  } catch (caught) {
    if (caught instanceof ApplyBoundaryError) cleanupFailures.push(...caught.cleanupFailures);
    failure = failureFrom(caught, { code: 'apply-failed', phase: 'mutation' });
    if (!rollbackOpenTransactions(locked)) {
      cleanupFailures.push({ code: 'rollback-failed', phase: 'rollback' });
    }
  } finally {
    if (!closeLockedDatabases(locked)) {
      cleanupFailures.push({ code: 'close-failed', phase: 'cleanup' });
    }
  }

  const targets = advisoryLocks.length > 0 ? observeTargets(plan, committed, timeoutMs) : initialApplyTargets(plan);
  if (!releaseAdvisoryLocks(advisoryLocks, options)) {
    cleanupFailures.push({ code: 'advisory-lock-release-failed', phase: 'cleanup' });
  }
  const classified = classifyApplyStatus(plan, targets, failure);
  return makeApplyReport(plan, classified.status, classified.converged, targets, failure, cleanupFailures);
}

function lockedOperationInputs(
  requested: readonly { readonly planned: ReconciliationPlanInput }[],
  locked: readonly LockedDatabase[],
): readonly ReconciliationLockedDatabaseInput[] {
  return requested.map(({ planned }) => {
    const item = lockedDatabaseForRole(locked, planned.role);
    const guarded = <T>(operation: () => T): T => {
      requireDatabaseHandleMatchesPath(item.db, planned.role);
      revalidateApplyInput(item.input, planned.role);
      requireDatabaseHandleMatchesPath(item.db, planned.role);
      const value = operation();
      requireDatabaseHandleMatchesPath(item.db, planned.role);
      revalidateApplyInput(item.input, planned.role);
      requireDatabaseHandleMatchesPath(item.db, planned.role);
      return value;
    };
    return Object.freeze({
      role: planned.role,
      canonicalPath: planned.canonicalPath,
      observe: () =>
        guarded(() => {
          const image = readDatabaseImage(item.db);
          return { schemaFingerprint: image.schemaFingerprint, logicalDigest: image.logicalDigest };
        }),
      serialize: () => guarded(() => new Uint8Array(item.db.serialize())),
      restoreFrom: (source: Database) =>
        guarded(() => {
          const restored = replaceLogicalState(item.db, readDatabaseImage(source));
          return { schemaFingerprint: restored.schemaFingerprint, logicalDigest: restored.logicalDigest };
        }),
    });
  });
}

function emitLockedOperationEvent(
  options: ReconciliationLockedOperationOptions,
  event: ReconciliationLockedOperationEvent,
): void {
  try {
    options.onEvent?.(event);
  } catch (caught) {
    throw new ApplyBoundaryError({ code: 'commit-failed', phase: 'commit', role: event.role }, caught);
  }
}

/**
 * Run a bounded operation while both reconciliation inputs are held by the
 * same canonical advisory and SQLite write-lock contract as normal apply.
 *
 * The callback may restore logical contents only through the provided live
 * handles. Its optional afterCommit callback runs while advisory locks remain
 * held, after every SQLite transaction committed, which is the safe boundary
 * for durable snapshot-state transitions.
 */
export function withLockedReconciliationDatabases<T>(
  request: ReconciliationRequest,
  operation: (inputs: readonly ReconciliationLockedDatabaseInput[]) => ReconciliationLockedOperationResult<T>,
  options: ReconciliationLockedOperationOptions = {},
): T {
  let advisoryLocks: AdvisoryLock[] = [];
  let locked: LockedDatabase[] = [];
  const cleanupFailures: ReconciliationApplyFailure[] = [];
  let result: ReconciliationLockedOperationResult<T> | undefined;
  let operationFailure: { readonly failure: ReconciliationApplyFailure; readonly cause: unknown } | undefined;
  const lockOptions: ReconciliationApplyOptions = {
    busyTimeoutMs: options.busyTimeoutMs,
    openDatabase: options.openDatabase,
    advisoryFlock: options.advisoryFlock,
    onAdvisoryDescriptorOpened: options.onAdvisoryDescriptorOpened,
    advisoryUnlock: options.advisoryUnlock,
  };
  try {
    const timeoutMs = validateBusyTimeout(options.busyTimeoutMs);
    const roles: readonly [ReconciliationInputRole, ReconciliationInputRole] =
      request.mode === 'bidirectional' ? ['left', 'right'] : ['source', 'destination'];
    const paths: readonly [string, string] =
      request.mode === 'bidirectional'
        ? [request.leftPath, request.rightPath]
        : [request.sourcePath, request.destinationPath];
    const requested = paths.map((path, index) => {
      const physical = resolvePhysicalInput(path);
      return {
        planned: {
          role: roles[index],
          canonicalPath: physical.canonicalPath,
          logicalDigest: '',
        },
        physical,
      };
    });
    const deadline = Date.now() + timeoutMs;
    advisoryLocks = acquirePlannedAdvisoryLocks(requested, deadline, lockOptions);
    locked = openLockedDatabases(requested, deadline, lockOptions);
    const inputs = lockedOperationInputs(requested, locked);
    const initial = inputs.map((input) => input.observe());
    if (initial[0].schemaFingerprint !== initial[1].schemaFingerprint) unsupportedSchema();
    result = operation(inputs);
    const final = inputs.map((input) => input.observe());
    if (final.some((image) => image.schemaFingerprint !== initial[0].schemaFingerprint)) unsupportedSchema();
    for (const item of locked) {
      const role = item.roles[0];
      emitLockedOperationEvent(options, { phase: 'commit', role, state: 'before' });
      requireDatabaseHandleMatchesPath(item.db, role);
      revalidateApplyInput(item.input, role);
      requireDatabaseHandleMatchesPath(item.db, role);
      item.db.exec('COMMIT');
      item.transactionOpen = false;
      emitLockedOperationEvent(options, { phase: 'commit', role, state: 'after' });
    }
    result.afterCommit?.();
  } catch (caught) {
    if (caught instanceof ApplyBoundaryError) cleanupFailures.push(...caught.cleanupFailures);
    if (!rollbackOpenTransactions(locked)) {
      cleanupFailures.push({ code: 'rollback-failed', phase: 'rollback' });
    }
    const failure = failureFrom(caught, { code: 'apply-failed', phase: 'mutation' });
    operationFailure = { failure, cause: caught };
  } finally {
    if (!closeLockedDatabases(locked)) {
      cleanupFailures.push({ code: 'close-failed', phase: 'cleanup' });
    }
    if (!releaseAdvisoryLocks(advisoryLocks, lockOptions)) {
      cleanupFailures.push({ code: 'advisory-lock-release-failed', phase: 'cleanup' });
    }
  }
  if (operationFailure !== undefined) {
    throw new ReconciliationLockedOperationError(operationFailure.failure, operationFailure.cause, cleanupFailures);
  }
  if (cleanupFailures.length > 0) {
    throw new ReconciliationLockedOperationError(cleanupFailures[0], undefined, cleanupFailures);
  }
  if (result === undefined) {
    throw new ReconciliationLockedOperationError({ code: 'apply-failed', phase: 'mutation' });
  }
  return result.value;
}
