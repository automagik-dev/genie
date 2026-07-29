/**
 * genie db sync — thin standalone CLI over the v5 reconciliation and
 * snapshot modules.
 *
 * The command deliberately owns only argument validation, bounded report
 * shaping, human rendering, and exit-code classification. Planning, locking,
 * mutation, recovery, rollback, and retention remain in src/lib/v5.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Command } from 'commander';
import {
  IDENTICAL_HISTORY_ADDITION_LIMITATION,
  type ReconciliationApplyReport,
  type ReconciliationConflict,
  ReconciliationError,
  type ReconciliationInputRole,
  type ReconciliationRequest,
  type ReconciliationTableName,
  type ReconciliationTargetReport,
  planDatabaseReconciliation,
} from '../lib/v5/db-reconciliation.js';
import {
  type SnapshotApplyReport,
  type SnapshotRecoveryReport,
  type SnapshotRollbackReport,
  applyDatabaseReconciliationWithSnapshots,
  rollbackDatabaseReconciliation,
} from '../lib/v5/db-sync-snapshots.js';

const CLI_REPORT_VERSION = 1 as const;
const MAX_BUSY_TIMEOUT_MS = 2_147_483_647;
const GENERATION_ID_PATTERN = /^[a-f0-9]{64}--[0-9]{16}--[a-f0-9-]{36}$/;

export const DATABASE_SYNC_EXIT_CODES = {
  success: 0,
  parserError: 1,
  usage: 2,
  conflict: 3,
  operationalFailure: 4,
  uncertain: 5,
  recoveryHandled: 6,
} as const;

type DatabaseSyncExitCode = (typeof DATABASE_SYNC_EXIT_CODES)[keyof typeof DATABASE_SYNC_EXIT_CODES];
type DatabaseSyncOperation = 'dry-run' | 'apply' | 'rollback';

interface DatabaseSyncOptions {
  source?: string;
  destination?: string;
  dryRun?: boolean;
  rollback?: string;
  snapshotRoot?: string;
  keepSnapshots?: string;
  busyTimeoutMs?: string;
  json?: boolean;
}

interface DatabaseIdentityReport {
  role: ReconciliationInputRole;
  databaseIdentity: string;
  logicalDigest: string | null;
}

interface ConflictCountReport {
  total: number;
  byTable: Record<ReconciliationTableName, number>;
}

interface PlanReport {
  status: 'no-op' | 'changed' | 'conflict' | 'operational-failure';
  sameDatabase: boolean;
  schemaFingerprint: string | null;
  targets: readonly ReconciliationTargetReport[];
  conflicts: ConflictCountReport;
  operationalFailure: {
    code: string;
    guidance?: string;
  } | null;
  historyLimitation: string;
}

interface RecoveryReport {
  status: SnapshotRecoveryReport['status'];
  generationId: string | null;
  restoredDatabaseIdentities: readonly string[];
  failure: SnapshotRecoveryReport['failure'];
  cleanupFailures: SnapshotRecoveryReport['cleanupFailures'];
}

interface ApplyReport {
  status: SnapshotApplyReport['status'];
  generationId: string | null;
  recovery: RecoveryReport;
  apply: ReconciliationApplyReport | null;
  failure: SnapshotApplyReport['failure'];
  cleanupFailures: SnapshotApplyReport['cleanupFailures'];
}

interface RollbackReport {
  status: SnapshotRollbackReport['status'];
  selectedGenerationId: string;
  safetyGenerationId: string | null;
  failure: SnapshotRollbackReport['failure'];
  cleanupFailures: SnapshotRollbackReport['cleanupFailures'];
}

interface DatabaseSyncCliReport {
  reportVersion: typeof CLI_REPORT_VERSION;
  command: 'database-sync';
  operation: DatabaseSyncOperation;
  mode: ReconciliationRequest['mode'];
  status: string;
  inputs: readonly DatabaseIdentityReport[];
  plan: PlanReport | null;
  apply: ApplyReport | null;
  rollback: RollbackReport | null;
}

class DatabaseSyncUsageError extends Error {}

function databaseIdentity(path: string): string {
  const absolute = resolve(path);
  let canonical = absolute;
  try {
    canonical = realpathSync(absolute);
  } catch {
    // Failure reports still need a stable bounded identity for an unavailable
    // input. The reconciliation layer owns the actionable availability code.
  }
  return createHash('sha256').update(`genie-db-sync-cli-identity-v1\0${canonical}`).digest('hex');
}

function requestInputs(request: ReconciliationRequest): Array<{ role: ReconciliationInputRole; path: string }> {
  return request.mode === 'bidirectional'
    ? [
        { role: 'left', path: request.leftPath },
        { role: 'right', path: request.rightPath },
      ]
    : [
        { role: 'source', path: request.sourcePath },
        { role: 'destination', path: request.destinationPath },
      ];
}

function unresolvedInputs(request: ReconciliationRequest): DatabaseIdentityReport[] {
  return requestInputs(request).map((input) => ({
    role: input.role,
    databaseIdentity: databaseIdentity(input.path),
    logicalDigest: null,
  }));
}

function parseRequest(databaseA: string | undefined, databaseB: string | undefined, options: DatabaseSyncOptions) {
  const positionalCount = Number(databaseA !== undefined) + Number(databaseB !== undefined);
  const directionalCount = Number(options.source !== undefined) + Number(options.destination !== undefined);
  if (positionalCount === 2 && directionalCount === 0) {
    return {
      mode: 'bidirectional',
      leftPath: databaseA as string,
      rightPath: databaseB as string,
    } satisfies ReconciliationRequest;
  }
  if (positionalCount === 0 && directionalCount === 2) {
    return {
      mode: 'directional',
      sourcePath: options.source as string,
      destinationPath: options.destination as string,
    } satisfies ReconciliationRequest;
  }
  throw new DatabaseSyncUsageError(
    'Choose exactly one mode: `genie db sync <database-a> <database-b>` or ' +
      '`genie db sync --source <database> --destination <database>`.',
  );
}

function parseNonnegativeInteger(name: string, raw: string | undefined, maximum = Number.MAX_SAFE_INTEGER) {
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new DatabaseSyncUsageError(`${name} must be a nonnegative integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new DatabaseSyncUsageError(`${name} must be at most ${maximum}.`);
  }
  return value;
}

function parseSnapshotRoot(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!isAbsolute(raw) || raw.split('/').some((component) => component === '.' || component === '..')) {
    throw new DatabaseSyncUsageError('--snapshot-root must be a normalized absolute path.');
  }
  return resolve(raw);
}

function parseOperation(options: DatabaseSyncOptions): DatabaseSyncOperation {
  if (options.dryRun && options.rollback !== undefined) {
    throw new DatabaseSyncUsageError('--dry-run and --rollback cannot be used together.');
  }
  if (options.dryRun && (options.snapshotRoot || options.keepSnapshots || options.busyTimeoutMs)) {
    throw new DatabaseSyncUsageError(
      '--dry-run is read-only; omit --snapshot-root, --keep-snapshots, and --busy-timeout-ms.',
    );
  }
  if (options.rollback !== undefined && !GENERATION_ID_PATTERN.test(options.rollback)) {
    throw new DatabaseSyncUsageError('--rollback must be a complete generation ID from an earlier report.');
  }
  return options.dryRun ? 'dry-run' : options.rollback === undefined ? 'apply' : 'rollback';
}

function emptyConflictCounts(): Record<ReconciliationTableName, number> {
  return {
    boards: 0,
    tasks: 0,
    wish_groups: 0,
    hire_roster: 0,
    meta: 0,
    task_dependencies: 0,
    stage_log: 0,
    task_events: 0,
  };
}

function conflictCounts(conflicts: readonly ReconciliationConflict[]): ConflictCountReport {
  const byTable = emptyConflictCounts();
  for (const conflict of conflicts) byTable[conflict.table]++;
  return { total: conflicts.length, byTable };
}

function summarizePlan(plan: ReturnType<typeof planDatabaseReconciliation>): PlanReport {
  return {
    status: plan.report.status,
    sameDatabase: plan.report.sameDatabase,
    schemaFingerprint: plan.report.schemaFingerprint,
    targets: plan.report.targets,
    conflicts: conflictCounts(plan.conflicts),
    operationalFailure: null,
    historyLimitation: plan.report.historyLimitation,
  };
}

function planningFailure(caught: unknown): PlanReport {
  const operationalFailure =
    caught instanceof ReconciliationError
      ? { code: caught.code, ...(caught.guidance === undefined ? {} : { guidance: caught.guidance }) }
      : { code: 'unexpected-failure' };
  return {
    status: 'operational-failure',
    sameDatabase: false,
    schemaFingerprint: null,
    targets: [],
    conflicts: { total: 0, byTable: emptyConflictCounts() },
    operationalFailure,
    historyLimitation: IDENTICAL_HISTORY_ADDITION_LIMITATION,
  };
}

function resolvedInputs(plan: ReturnType<typeof planDatabaseReconciliation>): DatabaseIdentityReport[] {
  return plan.inputs.map((input) => ({
    role: input.role,
    databaseIdentity: databaseIdentity(input.canonicalPath),
    logicalDigest: input.logicalDigest,
  }));
}

function summarizeRecovery(recovery: SnapshotRecoveryReport): RecoveryReport {
  return {
    status: recovery.status,
    generationId: recovery.generationId,
    restoredDatabaseIdentities: recovery.restoredPaths.map(databaseIdentity),
    failure: recovery.failure,
    cleanupFailures: recovery.cleanupFailures,
  };
}

function summarizeApply(report: SnapshotApplyReport): ApplyReport {
  return {
    status: report.status,
    generationId: report.generationId,
    recovery: summarizeRecovery(report.recovery),
    apply: report.apply,
    failure: report.failure,
    cleanupFailures: report.cleanupFailures,
  };
}

function summarizeRollback(report: SnapshotRollbackReport): RollbackReport {
  return {
    status: report.status,
    selectedGenerationId: report.selectedGenerationId,
    safetyGenerationId: report.safetyGenerationId,
    failure: report.failure,
    cleanupFailures: report.cleanupFailures,
  };
}

function reportForPlanningFailure(
  request: ReconciliationRequest,
  operation: DatabaseSyncOperation,
  caught: unknown,
): DatabaseSyncCliReport {
  return {
    reportVersion: CLI_REPORT_VERSION,
    command: 'database-sync',
    operation,
    mode: request.mode,
    status: 'operational-failure',
    inputs: unresolvedInputs(request),
    plan: planningFailure(caught),
    apply: null,
    rollback: null,
  };
}

function execute(
  request: ReconciliationRequest,
  operation: DatabaseSyncOperation,
  options: { snapshotRoot?: string; keepSnapshots?: number; busyTimeoutMs?: number; rollback?: string },
): DatabaseSyncCliReport {
  if (operation === 'rollback') {
    const result = rollbackDatabaseReconciliation(request, options.rollback as string, options);
    return {
      reportVersion: CLI_REPORT_VERSION,
      command: 'database-sync',
      operation,
      mode: request.mode,
      status: result.status,
      inputs: unresolvedInputs(request),
      plan: null,
      apply: null,
      rollback: summarizeRollback(result),
    };
  }

  let plan: ReturnType<typeof planDatabaseReconciliation>;
  try {
    plan = planDatabaseReconciliation(request);
  } catch (caught) {
    return reportForPlanningFailure(request, operation, caught);
  }
  const planReport = summarizePlan(plan);
  if (operation === 'dry-run') {
    return {
      reportVersion: CLI_REPORT_VERSION,
      command: 'database-sync',
      operation,
      mode: request.mode,
      status: planReport.status,
      inputs: resolvedInputs(plan),
      plan: planReport,
      apply: null,
      rollback: null,
    };
  }

  const result = applyDatabaseReconciliationWithSnapshots(plan, options);
  return {
    reportVersion: CLI_REPORT_VERSION,
    command: 'database-sync',
    operation,
    mode: request.mode,
    status: result.status,
    inputs: resolvedInputs(plan),
    plan: planReport,
    apply: summarizeApply(result),
    rollback: null,
  };
}

function cleanupFailureCount(report: DatabaseSyncCliReport): number {
  if (report.apply !== null) return report.apply.cleanupFailures.length;
  return report.rollback?.cleanupFailures.length ?? 0;
}

function exitCode(report: DatabaseSyncCliReport): DatabaseSyncExitCode {
  if (report.status === 'conflict') return DATABASE_SYNC_EXIT_CODES.conflict;
  if (report.status === 'uncertain') return DATABASE_SYNC_EXIT_CODES.uncertain;
  if (report.status === 'converged' || report.status === 'recovered') {
    return DATABASE_SYNC_EXIT_CODES.recoveryHandled;
  }
  if (
    report.status === 'operational-failure' ||
    report.status === 'lock-timeout' ||
    report.status === 'preimage-changed' ||
    (report.status === 'rolled-back' && report.operation !== 'rollback') ||
    report.status === 'expected-postimage' ||
    report.status === 'partial-commit' ||
    report.status === 'unexpected-intervening-write' ||
    cleanupFailureCount(report) > 0
  ) {
    return DATABASE_SYNC_EXIT_CODES.operationalFailure;
  }
  return DATABASE_SYNC_EXIT_CODES.success;
}

function shortDigest(value: string | null): string {
  return value === null ? '-' : value.slice(0, 12);
}

function changesLine(target: ReconciliationTargetReport): string {
  const changed = Object.entries(target.changes)
    .filter(([name, count]) => name !== 'deletions' && count > 0)
    .map(([name, count]) => `${name}=${count}`);
  return `  ${target.role}: ${changed.length === 0 ? 'no changes' : changed.join(', ')}; deletions=0`;
}

function humanLines(report: DatabaseSyncCliReport): string[] {
  const lines = [
    `Database reconciliation ${report.operation}: ${report.status}`,
    `Mode: ${report.mode}`,
    'Inputs:',
    ...report.inputs.map(
      (input) =>
        `  ${input.role}: database=${shortDigest(input.databaseIdentity)} logical=${shortDigest(input.logicalDigest)}`,
    ),
  ];
  if (report.plan !== null) {
    lines.push(`Plan: ${report.plan.status}; conflicts=${report.plan.conflicts.total}`);
    lines.push(...report.plan.targets.map(changesLine));
    if (report.plan.operationalFailure !== null) {
      lines.push(`Failure: ${report.plan.operationalFailure.code}`);
      if (report.plan.operationalFailure.guidance) lines.push(`Guidance: ${report.plan.operationalFailure.guidance}`);
    }
  }
  if (report.apply !== null) {
    lines.push(`Snapshot generation: ${report.apply.generationId ?? '-'}`);
    lines.push(
      `Recovery: ${report.apply.recovery.status}${report.apply.recovery.generationId === null ? '' : ` (${report.apply.recovery.generationId})`}`,
    );
    if (report.apply.failure !== null) lines.push(`Failure: ${report.apply.failure}`);
  }
  if (report.rollback !== null) {
    lines.push(`Selected generation: ${report.rollback.selectedGenerationId}`);
    lines.push(`Safety generation: ${report.rollback.safetyGenerationId ?? '-'}`);
    if (report.rollback.failure !== null) lines.push(`Failure: ${report.rollback.failure}`);
  }
  if (report.status === 'converged' || report.status === 'recovered') {
    lines.push('Recovery was handled before the requested apply; rerun the same command.');
  }
  if (cleanupFailureCount(report) > 0) lines.push(`Cleanup failures: ${cleanupFailureCount(report)}`);
  return lines;
}

function writeReport(report: DatabaseSyncCliReport, json: boolean): void {
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${humanLines(report).join('\n')}\n`);
}

function failUsage(message: string): never {
  process.stderr.write(`Error: ${message}\nRun \`genie db sync --help\` for noninteractive usage.\n`);
  process.exit(DATABASE_SYNC_EXIT_CODES.usage);
}

function handleSync(databaseA: string | undefined, databaseB: string | undefined, options: DatabaseSyncOptions): void {
  try {
    const request = parseRequest(databaseA, databaseB, options);
    const operation = parseOperation(options);
    const snapshotRoot = parseSnapshotRoot(options.snapshotRoot);
    const keepSnapshots = parseNonnegativeInteger('--keep-snapshots', options.keepSnapshots);
    const busyTimeoutMs = parseNonnegativeInteger('--busy-timeout-ms', options.busyTimeoutMs, MAX_BUSY_TIMEOUT_MS);
    const report = execute(request, operation, {
      snapshotRoot,
      keepSnapshots,
      busyTimeoutMs,
      rollback: options.rollback,
    });
    writeReport(report, options.json ?? false);
    process.exitCode = exitCode(report);
  } catch (caught) {
    if (caught instanceof DatabaseSyncUsageError) failUsage(caught.message);
    const report: DatabaseSyncCliReport = {
      reportVersion: CLI_REPORT_VERSION,
      command: 'database-sync',
      operation: options.dryRun ? 'dry-run' : options.rollback === undefined ? 'apply' : 'rollback',
      mode: options.source === undefined ? 'bidirectional' : 'directional',
      status: 'operational-failure',
      inputs: [],
      plan: planningFailure(caught),
      apply: null,
      rollback: null,
    };
    writeReport(report, options.json ?? false);
    process.exitCode = DATABASE_SYNC_EXIT_CODES.operationalFailure;
  }
}

export function registerV5DatabaseSyncCommand(program: Command): void {
  const db = program.command('db').description('Standalone Genie database operations');
  db.command('sync [database-a] [database-b]')
    .description('Reconcile two exact-current Genie databases')
    .option('--source <database>', 'Directional source database (authoritative for shared mutable rows)')
    .option('--destination <database>', 'Directional destination database (requires --source)')
    .option('--dry-run', 'Validate and plan without locks, snapshots, or writes')
    .option('--rollback <generation>', 'Restore a retained generation after snapshotting current state')
    .option('--snapshot-root <absolute-path>', 'Override snapshot discovery and publication root')
    .option('--keep-snapshots <count>', 'Retain newest complete generations (default: 3; 0 is same-process only)')
    .option('--busy-timeout-ms <milliseconds>', 'Bound the total advisory and SQLite lock wait')
    .option('--json', 'Emit the stable bounded JSON report')
    .addHelpText(
      'after',
      '\nModes:\n' +
        '  genie db sync <database-a> <database-b>\n' +
        '  genie db sync --source <database> --destination <database>\n\n' +
        'Exit codes: 0 success, 1 parser error, 2 usage, 3 conflict, ' +
        '4 operational failure, 5 uncertain/manual, 6 recovery handled (rerun).\n',
    )
    .action((databaseA: string | undefined, databaseB: string | undefined, options: DatabaseSyncOptions) =>
      handleSync(databaseA, databaseB, options),
    );
}
