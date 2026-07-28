import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_RECONCILIATION_DATABASE_BYTES,
  applyDatabaseReconciliation,
  planDatabaseReconciliation,
} from './db-reconciliation.js';
import {
  SnapshotError,
  applyDatabaseReconciliationWithSnapshots,
  databaseSyncSnapshotIdentity,
  deserializeSnapshotBytes,
  normalizeSerializedSqliteForDeserialize,
  recoverDatabaseReconciliation,
  rollbackDatabaseReconciliation,
} from './db-sync-snapshots.js';
import { openDb } from './genie-db.js';

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'genie-db-sync-snapshots-'));
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function currentDb(name: string): string {
  const path = join(fixtureRoot, `${name}.db`);
  openDb({ path }).close();
  const db = new Database(path);
  db.query("UPDATE meta SET value = '100' WHERE key = 'stage_log_backfill_v1'").run();
  db.close();
  return path;
}

function logicalRows(db: Database): unknown {
  return {
    boards: db.query('SELECT id, name, created_at, lanes FROM boards ORDER BY id').all(),
    hireRoster: db
      .query(
        `SELECT wish, agent_adapter_id, profile, worktree, hired_at, state
         FROM hire_roster ORDER BY wish, agent_adapter_id`,
      )
      .all(),
    meta: db.query('SELECT key, value FROM meta ORDER BY key').all(),
    stageLog: db.query('SELECT id, task_id, stage, note, created_at FROM stage_log ORDER BY id').all(),
    taskDependencies: db
      .query('SELECT task_id, depends_on_id FROM task_dependencies ORDER BY task_id, depends_on_id')
      .all(),
    taskEvents: db
      .query(
        `SELECT id, task_id, kind, note, author_kind, author, created_at
         FROM task_events ORDER BY id`,
      )
      .all(),
    tasks: db
      .query(
        `SELECT id, board_id, title, status, claimed_by, claimed_at, wish, group_name,
                created_at, updated_at, lane, agent_kind, heartbeat_at, blocked_by, blocked_reason
         FROM tasks ORDER BY id`,
      )
      .all(),
    wishGroups: db
      .query(
        `SELECT wish, name, status, depends_on, assignee, started_at, completed_at, created_at, updated_at
         FROM wish_groups ORDER BY wish, name`,
      )
      .all(),
  };
}

function insertBoard(path: string, id: string, name = id): void {
  const db = new Database(path);
  db.query('INSERT INTO boards (id, name, created_at, lanes) VALUES (?, ?, 1, NULL)').run(id, name);
  db.close();
}

function boardNames(path: string): string[] {
  const db = new Database(path);
  const values = (db.query('SELECT name FROM boards ORDER BY name').all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
  db.close();
  return values;
}

function generationDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.staging-'))
    .map((entry) => join(root, entry.name))
    .sort();
}

function leaveCompleteGeneration(left: string, right: string): { root: string; directory: string } {
  insertBoard(right, 'planned');
  const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
  let injected = false;
  const report = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
    onEvent: (event) => {
      if (!injected && event.phase === 'recovery-classify' && event.state === 'before') {
        injected = true;
        throw new Error('leave complete');
      }
    },
  });
  expect(report.status).toBe('operational-failure');
  const root = databaseSyncSnapshotIdentity(request).root;
  const directories = generationDirectories(root);
  expect(directories).toHaveLength(1);
  return { root, directory: directories[0] };
}

describe('database sync snapshots', () => {
  test('serialize under the intended held write locks includes committed WAL logical content', () => {
    const left = currentDb('left');
    const right = currentDb('right');
    const writer = new Database(right, { safeIntegers: true });
    writer.exec('PRAGMA foreign_keys = ON');
    writer.exec('PRAGMA journal_mode = WAL');
    writer.exec('PRAGMA wal_autocheckpoint = 0');
    writer.exec('BEGIN IMMEDIATE');
    writer.query("INSERT INTO boards (id, name, created_at, lanes) VALUES ('board', 'Board', 1, NULL)").run();
    writer
      .query(
        `INSERT INTO tasks (
           id, board_id, title, status, claimed_by, claimed_at, wish, group_name,
           created_at, updated_at, lane, agent_kind, heartbeat_at, blocked_by, blocked_reason
         ) VALUES ('first', 'board', 'First', 'ready', NULL, NULL, 'wish', 'group', 2, 2, NULL, NULL, NULL, NULL, NULL),
                  ('second', 'board', 'Second', 'ready', NULL, NULL, 'wish', 'group', 3, 3, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run();
    writer.query("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES ('second', 'first')").run();
    writer
      .query("INSERT INTO stage_log (task_id, stage, note, created_at) VALUES ('first', 'comment', 'legacy', 4)")
      .run();
    writer
      .query(
        `INSERT INTO task_events (task_id, kind, note, author_kind, author, created_at)
         VALUES ('first', 'comment', 'legacy', NULL, NULL, 4),
                ('first', 'comment', 'event', 'worker', 'gate', 5)`,
      )
      .run();
    writer
      .query(
        `INSERT INTO wish_groups (
           wish, name, status, depends_on, assignee, started_at, completed_at, created_at, updated_at
         ) VALUES ('wish', 'group', 'ready', '[]', NULL, NULL, NULL, 6, 6)`,
      )
      .run();
    writer
      .query(
        `INSERT INTO hire_roster (wish, agent_adapter_id, profile, worktree, hired_at, state)
         VALUES ('wish', 'agent', NULL, '/tmp/worktree', 7, 'active')`,
      )
      .run();
    writer.exec('COMMIT');

    expect(existsSync(`${right}-wal`)).toBe(true);
    expect(statSync(`${right}-wal`).size).toBeGreaterThan(0);
    const before = logicalRows(writer);
    let captured: Uint8Array | undefined;
    const plan = planDatabaseReconciliation({ mode: 'bidirectional', leftPath: left, rightPath: right });
    const report = applyDatabaseReconciliation(plan, {
      onLocked: (inputs) => {
        captured = inputs.find((input) => input.canonicalPath === right)?.serialize();
      },
    });
    writer.close();

    expect(report.status).toBe('changed');
    expect(captured).toBeDefined();
    const original = captured ?? new Uint8Array();
    const originalHeaderMode = original.slice(18, 20);
    const normalized = normalizeSerializedSqliteForDeserialize(original);
    expect([...original.slice(18, 20)]).toEqual([...originalHeaderMode]);
    expect([...originalHeaderMode]).toEqual([2, 2]);
    expect([...normalized.slice(18, 20)]).toEqual([1, 1]);
    const restored = deserializeSnapshotBytes(original);
    expect(logicalRows(restored)).toEqual(before);
    expect(restored.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    restored.close();
  });

  test('serialized snapshot normalization rejects short, non-SQLite, and inconsistent format headers', () => {
    expect(() => normalizeSerializedSqliteForDeserialize(new Uint8Array(99))).toThrow(SnapshotError);

    const db = new Database(':memory:');
    db.exec('CREATE TABLE value (id INTEGER PRIMARY KEY)');
    const badMagic = db.serialize();
    badMagic[0] = 0;
    expect(() => normalizeSerializedSqliteForDeserialize(badMagic)).toThrow(
      expect.objectContaining({ code: 'snapshot-invalid-header' }),
    );

    const badMode = db.serialize();
    badMode[18] = 2;
    badMode[19] = 1;
    expect(() => normalizeSerializedSqliteForDeserialize(badMode)).toThrow(
      expect.objectContaining({ code: 'snapshot-unsupported-header-mode' }),
    );
    db.close();
  });

  test('bidirectional identity is argument-order independent while directional authority is role-sensitive', () => {
    const left = currentDb('identity-left');
    const right = currentDb('identity-right');
    const forward = databaseSyncSnapshotIdentity({ mode: 'bidirectional', leftPath: left, rightPath: right });
    const reversed = databaseSyncSnapshotIdentity({ mode: 'bidirectional', leftPath: right, rightPath: left });
    expect(reversed).toEqual(forward);

    const directional = databaseSyncSnapshotIdentity({
      mode: 'directional',
      sourcePath: left,
      destinationPath: right,
    });
    const authorityReversed = databaseSyncSnapshotIdentity({
      mode: 'directional',
      sourcePath: right,
      destinationPath: left,
    });
    expect(authorityReversed.operationId).not.toBe(directional.operationId);
    expect(directional.root).toBe(join(fixtureRoot, 'sync-snapshots'));
  });

  test('directional snapshots stay destination-adjacent, preserve source authority, and reverse independently', () => {
    const source = currentDb('direction-source');
    const destination = currentDb('direction-destination');
    insertBoard(source, 'source-only');
    const request = { mode: 'directional' as const, sourcePath: source, destinationPath: destination };
    const report = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request));
    expect(report.apply?.status).toBe('changed');
    expect(boardNames(source)).toEqual(['source-only']);
    expect(boardNames(destination)).toEqual(['source-only']);
    const identity = databaseSyncSnapshotIdentity(request);
    const manifest = JSON.parse(readFileSync(join(generationDirectories(identity.root)[0], 'manifest.json'), 'utf8'));
    expect(manifest.targets).toEqual([expect.objectContaining({ role: 'destination', path: destination })]);
    expect(
      recoverDatabaseReconciliation({
        mode: 'directional',
        sourcePath: destination,
        destinationPath: source,
      }),
    ).toMatchObject({ status: 'none', generationId: null });
  });

  test('an explicit snapshot root overrides the default without changing manifest roles or pair identity', () => {
    const left = currentDb('override-left');
    const right = currentDb('override-right');
    insertBoard(right, 'override');
    const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
    const override = join(fixtureRoot, 'operator-snapshots');
    const expected = databaseSyncSnapshotIdentity(request, override);
    const report = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
      snapshotRoot: override,
    });
    expect(report.status).toBe('changed');
    expect(generationDirectories(override)).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(join(generationDirectories(override)[0], 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ operation_id: expected.operationId, state: 'converged' });
    expect(manifest.targets.map((target: { role: string }) => target.role).sort()).toEqual(['left', 'right']);
    expect(existsSync(databaseSyncSnapshotIdentity(request).root)).toBe(false);
  });

  test('persistent roots reject root and ancestor symlinks before publication or mutation', () => {
    for (const kind of ['root', 'ancestor'] as const) {
      const left = currentDb(`unsafe-${kind}-left`);
      const right = currentDb(`unsafe-${kind}-right`);
      insertBoard(right, 'planned');
      const physical = join(fixtureRoot, `${kind}-physical`);
      mkdirSync(physical, { mode: 0o700 });
      const linked = join(fixtureRoot, `${kind}-linked`);
      symlinkSync(physical, linked);
      const snapshotRoot = kind === 'root' ? linked : join(linked, 'snapshots');
      const report = applyDatabaseReconciliationWithSnapshots(
        planDatabaseReconciliation({ mode: 'bidirectional', leftPath: left, rightPath: right }),
        { snapshotRoot },
      );
      expect(report).toMatchObject({ status: 'operational-failure', apply: null });
      expect(boardNames(left)).toEqual([]);
      expect(boardNames(right)).toEqual(['planned']);
    }
  });

  test('publishes normalized complete payloads in the durable order and finalizes both-post as converged', () => {
    const left = currentDb('publish-left');
    const right = currentDb('publish-right');
    insertBoard(right, 'right-only');
    const plan = planDatabaseReconciliation({ mode: 'bidirectional', leftPath: left, rightPath: right });
    const events: string[] = [];
    const report = applyDatabaseReconciliationWithSnapshots(plan, {
      onEvent: (event) =>
        events.push(`${event.phase}:${event.state}${event.role === undefined ? '' : `:${event.role}`}`),
      now: () => new Date('2026-07-28T12:00:00.000Z'),
      randomId: () => '00000000-0000-4000-8000-000000000001',
    });

    expect(report.status).toBe('changed');
    expect(report.apply?.status).toBe('changed');
    expect(report.recovery.status).toBe('converged');
    expect(boardNames(left)).toEqual(['right-only']);
    const identity = databaseSyncSnapshotIdentity({ mode: 'bidirectional', leftPath: left, rightPath: right });
    const generations = generationDirectories(identity.root);
    expect(generations).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(join(generations[0], 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      format_version: 1,
      operation_version: 1,
      operation_id: identity.operationId,
      mode: 'bidirectional',
      state: 'converged',
    });
    expect(manifest.targets).toHaveLength(2);
    for (const target of manifest.targets) {
      const bytes = new Uint8Array(readFileSync(join(generations[0], target.snapshot_file)));
      expect([...bytes.slice(18, 20)]).toEqual([1, 1]);
      expect(target.snapshot_sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(events.slice(0, 18)).toEqual([
      'payload-write:before:left',
      'payload-write:after:left',
      'payload-write:before:right',
      'payload-write:after:right',
      'provisional-manifest-write:before',
      'provisional-manifest-write:after',
      'payload-fsync:before:left',
      'payload-fsync:after:left',
      'payload-fsync:before:right',
      'payload-fsync:after:right',
      'complete-manifest-write:before',
      'complete-manifest-write:after',
      'complete-manifest-fsync:before',
      'complete-manifest-fsync:after',
      'staging-fsync:before',
      'staging-fsync:after',
      'generation-rename:before',
      'generation-rename:after',
    ]);
    expect(events).toContain('root-fsync:after');
    expect(events).toContain('state-rewrite-rename:after');
    expect(events).toContain('generation-fsync:after');
  });

  test('a first-commit cut is recovered immediately by restoring the post side to its preimage', () => {
    const left = currentDb('mixed-left');
    const right = currentDb('mixed-right');
    insertBoard(left, 'left-only');
    insertBoard(right, 'right-only');
    const plan = planDatabaseReconciliation({ mode: 'bidirectional', leftPath: left, rightPath: right });
    let committed = 0;
    const report = applyDatabaseReconciliationWithSnapshots(plan, {
      onApplyEvent: (event) => {
        if (event.phase === 'commit' && event.state === 'after' && ++committed === 1) {
          throw new Error('simulated crash after first commit');
        }
      },
    });

    expect(report.status).toBe('recovered');
    expect(report.apply?.status).toBe('partial-commit');
    expect(report.recovery).toMatchObject({ status: 'recovered' });
    expect(report.recovery.restoredPaths).toHaveLength(1);
    expect(boardNames(left)).toEqual(['left-only']);
    expect(boardNames(right)).toEqual(['right-only']);
  });

  test('a pre-commit cut classifies both-pre as recovered without database writes', () => {
    const left = currentDb('pre-left');
    const right = currentDb('pre-right');
    insertBoard(right, 'right-only');
    const plan = planDatabaseReconciliation({ mode: 'bidirectional', leftPath: left, rightPath: right });
    const report = applyDatabaseReconciliationWithSnapshots(plan, {
      onApplyEvent: (event) => {
        if (event.phase === 'mutation' && event.state === 'before') throw new Error('simulated pre-commit crash');
      },
    });

    expect(report.status).toBe('recovered');
    expect(report.recovery).toMatchObject({ status: 'recovered', restoredPaths: [] });
    expect(boardNames(left)).toEqual([]);
    expect(boardNames(right)).toEqual(['right-only']);
  });

  test('unresolved persistent recovery runs before no-op, conflict, and same-database plan statuses', () => {
    {
      const left = currentDb('recovery-first-noop-left');
      const right = currentDb('recovery-first-noop-right');
      leaveCompleteGeneration(left, right);
      const report = applyDatabaseReconciliationWithSnapshots(
        planDatabaseReconciliation({ mode: 'bidirectional', leftPath: left, rightPath: right }),
      );
      expect(report).toMatchObject({ status: 'converged', apply: null, recovery: { status: 'converged' } });
    }
    {
      const left = currentDb('recovery-first-conflict-left');
      const right = currentDb('recovery-first-conflict-right');
      leaveCompleteGeneration(left, right);
      const leftDb = new Database(left);
      const rightDb = new Database(right);
      leftDb.query("UPDATE boards SET name = 'left' WHERE id = 'planned'").run();
      rightDb.query("UPDATE boards SET name = 'right' WHERE id = 'planned'").run();
      leftDb.close();
      rightDb.close();
      const plan = planDatabaseReconciliation({ mode: 'bidirectional', leftPath: left, rightPath: right });
      expect(plan.status).toBe('conflict');
      const report = applyDatabaseReconciliationWithSnapshots(plan);
      expect(report).toMatchObject({ status: 'uncertain', apply: null, recovery: { status: 'uncertain' } });
    }
    {
      const left = currentDb('recovery-first-alias-left');
      const right = currentDb('recovery-first-alias-right');
      leaveCompleteGeneration(left, right);
      for (const path of [left, right]) {
        const db = new Database(path);
        db.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
        db.close();
        rmSync(`${path}-wal`, { force: true });
        rmSync(`${path}-shm`, { force: true });
      }
      rmSync(right);
      linkSync(left, right);
      const plan = planDatabaseReconciliation({ mode: 'bidirectional', leftPath: left, rightPath: right });
      expect(plan.status).toBe('same-database');
      const report = applyDatabaseReconciliationWithSnapshots(plan);
      expect(report).toMatchObject({ status: 'converged', apply: null, recovery: { status: 'converged' } });
    }
  });

  test('zero retention recovers retained generations before changed apply and rollback work', () => {
    const left = currentDb('zero-existing-left');
    const right = currentDb('zero-existing-right');
    const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
    const first = applyDatabaseReconciliationWithSnapshots(
      (() => {
        insertBoard(right, 'first');
        return planDatabaseReconciliation(request);
      })(),
    );
    expect(first.generationId).not.toBeNull();

    insertBoard(right, 'second');
    let leftComplete = false;
    const interrupted = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
      onEvent: (event) => {
        if (!leftComplete && event.phase === 'recovery-classify' && event.state === 'before') {
          leftComplete = true;
          throw new Error('retain unresolved generation');
        }
      },
    });
    expect(interrupted.status).toBe('operational-failure');

    insertBoard(right, 'third');
    const changed = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
      keepSnapshots: 0,
    });
    expect(changed).toMatchObject({ status: 'uncertain', apply: null, recovery: { status: 'uncertain' } });

    const rollbackLeft = currentDb('zero-rollback-left');
    const rollbackRight = currentDb('zero-rollback-right');
    const rollbackRequest = {
      mode: 'bidirectional' as const,
      leftPath: rollbackLeft,
      rightPath: rollbackRight,
    };
    insertBoard(rollbackRight, 'rollback-first');
    const selected = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(rollbackRequest));
    insertBoard(rollbackRight, 'rollback-second');
    let rollbackComplete = false;
    expect(
      applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(rollbackRequest), {
        onEvent: (event) => {
          if (!rollbackComplete && event.phase === 'recovery-classify' && event.state === 'before') {
            rollbackComplete = true;
            throw new Error('retain rollback generation');
          }
        },
      }).status,
    ).toBe('operational-failure');
    const phases: string[] = [];
    const rolledBack = rollbackDatabaseReconciliation(rollbackRequest, selected.generationId ?? '', {
      keepSnapshots: 0,
      onEvent: (event) => {
        if (event.state === 'before') phases.push(event.phase);
      },
    });
    expect(rolledBack.status).toBe('rolled-back');
    expect(phases.indexOf('recovery-classify')).toBeLessThan(phases.indexOf('rollback-restore'));
  });

  test('unexpected current digests persist uncertain and later recovery never overwrites them', () => {
    const left = currentDb('uncertain-left');
    const right = currentDb('uncertain-right');
    insertBoard(right, 'planned');
    const plan = planDatabaseReconciliation({ mode: 'bidirectional', leftPath: left, rightPath: right });
    let injected = false;
    const interrupted = applyDatabaseReconciliationWithSnapshots(plan, {
      onEvent: (event) => {
        if (!injected && event.phase === 'recovery-classify' && event.state === 'before') {
          injected = true;
          throw new Error('simulated recovery crash');
        }
      },
    });
    expect(interrupted.status).toBe('operational-failure');
    insertBoard(left, 'unexpected');

    const request = { mode: 'bidirectional' as const, leftPath: right, rightPath: left };
    const recovery = recoverDatabaseReconciliation(request);
    expect(recovery).toMatchObject({ status: 'uncertain', restoredPaths: [] });
    expect(boardNames(left)).toEqual(['planned', 'unexpected']);
    expect(boardNames(right)).toEqual(['planned']);
    expect(recoverDatabaseReconciliation(request)).toMatchObject({ status: 'uncertain', restoredPaths: [] });
  });

  test('hash, schema, digest, and integrity-invalid recovery inputs are refused without overwrite', () => {
    const left = currentDb('validation-left');
    const right = currentDb('validation-right');
    const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
    const { directory } = leaveCompleteGeneration(left, right);
    const manifestPath = join(directory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const target = manifest.targets[0];
    const payloadPath = join(directory, target.snapshot_file);
    const original = new Uint8Array(readFileSync(payloadPath));
    const originalHash = target.snapshot_sha256;

    const hashCorrupt = original.slice();
    hashCorrupt[hashCorrupt.length - 1] ^= 0xff;
    writeFileSync(payloadPath, hashCorrupt);
    expect(recoverDatabaseReconciliation(request)).toMatchObject({
      status: 'operational-failure',
      failure: 'snapshot-hash-mismatch',
    });
    expect(boardNames(left)).toEqual(['planned']);
    expect(boardNames(right)).toEqual(['planned']);

    const digestDb = Database.deserialize(original, { strict: true });
    digestDb.query("INSERT INTO meta (key, value) VALUES ('tampered', 'yes')").run();
    const digestBytes = normalizeSerializedSqliteForDeserialize(digestDb.serialize());
    digestDb.close();
    writeFileSync(payloadPath, digestBytes);
    manifest.targets[0].snapshot_sha256 = createHash('sha256').update(digestBytes).digest('hex');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(recoverDatabaseReconciliation(request)).toMatchObject({
      status: 'operational-failure',
      failure: 'snapshot-image-mismatch',
    });

    const schemaDb = Database.deserialize(original, { strict: true });
    schemaDb.exec('CREATE TABLE unexpected_schema (value TEXT)');
    const schemaBytes = normalizeSerializedSqliteForDeserialize(schemaDb.serialize());
    schemaDb.close();
    writeFileSync(payloadPath, schemaBytes);
    manifest.targets[0].snapshot_sha256 = createHash('sha256').update(schemaBytes).digest('hex');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(recoverDatabaseReconciliation(request)).toMatchObject({
      status: 'operational-failure',
      failure: 'snapshot-image-mismatch',
    });

    const structurallyCorrupt = original.slice();
    structurallyCorrupt.fill(0xff, 100, Math.min(structurallyCorrupt.length, 512));
    writeFileSync(payloadPath, structurallyCorrupt);
    manifest.targets[0].snapshot_sha256 = createHash('sha256').update(structurallyCorrupt).digest('hex');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(recoverDatabaseReconciliation(request)).toMatchObject({
      status: 'operational-failure',
      failure: 'snapshot-image-mismatch',
    });
    expect(originalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(boardNames(left)).toEqual(['planned']);
    expect(boardNames(right)).toEqual(['planned']);
  });

  test('payload reads reject oversized sparse, symlink, and FIFO inputs without blocking or allocation', () => {
    for (const kind of ['sparse', 'symlink', 'fifo'] as const) {
      const left = currentDb(`bounded-${kind}-left`);
      const right = currentDb(`bounded-${kind}-right`);
      const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
      const { directory } = leaveCompleteGeneration(left, right);
      const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
      const payload = join(directory, manifest.targets[0].snapshot_file);
      rmSync(payload);
      if (kind === 'sparse') {
        writeFileSync(payload, '');
        truncateSync(payload, MAX_RECONCILIATION_DATABASE_BYTES + 1);
      } else if (kind === 'symlink') {
        symlinkSync(left, payload);
      } else {
        expect(Bun.spawnSync(['mkfifo', payload]).exitCode).toBe(0);
      }
      const started = Date.now();
      expect(recoverDatabaseReconciliation(request)).toMatchObject({
        status: 'operational-failure',
        failure: 'manifest-invalid',
      });
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  });

  test('generation and manifest substitutions refuse state rewrite without redirecting it', () => {
    for (const kind of ['generation', 'manifest'] as const) {
      const left = currentDb(`substitute-${kind}-left`);
      const right = currentDb(`substitute-${kind}-right`);
      const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
      const { directory } = leaveCompleteGeneration(left, right);
      let substituted = false;
      const report = recoverDatabaseReconciliation(request, {
        onEvent: (event) => {
          if (substituted || event.phase !== 'recovery-classify' || event.state !== 'before') return;
          substituted = true;
          if (kind === 'generation') {
            renameSync(directory, `${directory}.owned`);
            mkdirSync(directory, { mode: 0o700 });
            writeFileSync(join(directory, 'sentinel'), 'replacement');
          } else {
            const manifest = join(directory, 'manifest.json');
            renameSync(manifest, `${manifest}.owned`);
            symlinkSync('/dev/null', manifest);
          }
        },
      });
      expect(report.status).toBe('operational-failure');
      if (kind === 'generation') expect(readFileSync(join(directory, 'sentinel'), 'utf8')).toBe('replacement');
      else expect(statSync(join(directory, 'manifest.json.owned')).isFile()).toBe(true);
    }
  });

  test('manifest reads are bounded and failed rewrites clean only their exact temporary inode', () => {
    {
      const left = currentDb('manifest-bounded-left');
      const right = currentDb('manifest-bounded-right');
      const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
      const { directory } = leaveCompleteGeneration(left, right);
      truncateSync(join(directory, 'manifest.json'), 1024 * 1024 + 1);
      expect(recoverDatabaseReconciliation(request)).toMatchObject({
        status: 'operational-failure',
        failure: 'manifest-invalid',
      });
    }
    {
      const left = currentDb('manifest-temp-left');
      const right = currentDb('manifest-temp-right');
      const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
      const { directory } = leaveCompleteGeneration(left, right);
      let replacement: string | null = null;
      const recovery = recoverDatabaseReconciliation(request, {
        onEvent: (event) => {
          if (replacement !== null || event.phase !== 'state-rewrite-fsync' || event.state !== 'before') return;
          const temporary = readdirSync(directory).find(
            (name) => name.startsWith('.manifest-') && name.endsWith('.tmp'),
          );
          expect(temporary).toBeDefined();
          replacement = join(directory, temporary ?? '');
          renameSync(replacement, `${replacement}.owned`);
          writeFileSync(replacement, 'replacement');
        },
      });
      expect(recovery.status).toBe('operational-failure');
      expect(recovery.cleanupFailures).toContain('snapshot-cleanup-failed');
      expect(readFileSync(replacement ?? '', 'utf8')).toBe('replacement');
    }
  });

  test('snapshot recovery reports locked close and advisory-release cleanup evidence', () => {
    const openWithFailingClose = (path: string, options: ConstructorParameters<typeof Database>[1]): Database => {
      const db = new Database(path, options);
      return new Proxy(db, {
        get(target, property) {
          if (property === 'close') {
            return () => {
              target.close();
              throw new Error('injected close failure');
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    for (const primaryFailure of [false, true]) {
      const left = currentDb(`snapshot-cleanup-${primaryFailure}-left`);
      const right = currentDb(`snapshot-cleanup-${primaryFailure}-right`);
      const report = recoverDatabaseReconciliation(
        { mode: 'bidirectional', leftPath: left, rightPath: right },
        {
          applyOptions: {
            openDatabase: openWithFailingClose,
            advisoryUnlock: () => -1,
          },
          onLockedOperationEvent: primaryFailure
            ? (event) => {
                if (event.state === 'before') throw new Error('primary commit failure');
              }
            : undefined,
        },
      );
      expect(report.status).toBe('operational-failure');
      expect(report.cleanupFailures).toEqual(['locked-close-failed', 'locked-advisory-release-failed']);
    }
  });

  test('manifest version, shape, digest, identity, and state validation refuse recovery authority', () => {
    const mutations: Array<(manifest: Record<string, any>) => void> = [
      (manifest) => {
        manifest.format_version = 2;
      },
      (manifest) => {
        manifest.unknown = true;
      },
      (manifest) => {
        manifest.targets[0].preimage_digest = 'not-a-digest';
      },
      (manifest) => {
        manifest.targets[0].identity = '0'.repeat(64);
      },
      (manifest) => {
        manifest.state = 'invented';
      },
    ];
    for (const [index, mutateManifest] of mutations.entries()) {
      const left = currentDb(`manifest-${index}-left`);
      const right = currentDb(`manifest-${index}-right`);
      const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
      const { directory } = leaveCompleteGeneration(left, right);
      const manifestPath = join(directory, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      mutateManifest(manifest);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      expect(recoverDatabaseReconciliation(request)).toMatchObject({
        status: 'operational-failure',
        failure: 'manifest-invalid',
      });
      expect(boardNames(left)).toEqual(['planned']);
      expect(boardNames(right)).toEqual(['planned']);
    }
  });

  test('every durable publication cut exposes only staging or a recoverable complete generation', () => {
    const phases = [
      'payload-write',
      'provisional-manifest-write',
      'payload-fsync',
      'complete-manifest-write',
      'complete-manifest-fsync',
      'staging-fsync',
      'generation-rename',
      'root-fsync',
    ] as const;
    for (const [index, phase] of phases.entries()) {
      const left = currentDb(`cut-${index}-left`);
      const right = currentDb(`cut-${index}-right`);
      insertBoard(right, `planned-${index}`);
      const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
      let injected = false;
      const report = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
        onEvent: (event) => {
          if (!injected && event.phase === phase && event.state === 'after') {
            injected = true;
            throw new Error(`cut after ${phase}`);
          }
        },
      });
      expect(report.apply?.converged ?? false).toBe(false);
      expect(boardNames(left)).toEqual([]);
      expect(boardNames(right)).toEqual([`planned-${index}`]);
      const recovery = recoverDatabaseReconciliation(request);
      expect(['none', 'recovered']).toContain(recovery.status);
      expect(recovery.status).not.toBe('converged');
    }
  });

  test('state-rewrite cuts remain safely reclassifiable and never claim a false database restore', () => {
    const phases = ['state-rewrite-write', 'state-rewrite-fsync', 'state-rewrite-rename', 'generation-fsync'] as const;
    for (const [index, phase] of phases.entries()) {
      const left = currentDb(`state-cut-${index}-left`);
      const right = currentDb(`state-cut-${index}-right`);
      insertBoard(right, `planned-${index}`);
      const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
      let injected = false;
      const report = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
        onEvent: (event) => {
          if (!injected && event.phase === phase && event.state === 'after') {
            injected = true;
            throw new Error(`cut after ${phase}`);
          }
        },
      });
      expect(report.status).toBe('operational-failure');
      expect(boardNames(left)).toEqual([`planned-${index}`]);
      expect(boardNames(right)).toEqual([`planned-${index}`]);
      const recovery = recoverDatabaseReconciliation(request);
      expect(['none', 'converged']).toContain(recovery.status);
      expect(recovery.status).not.toBe('recovered');
    }
  });

  test('a recovery-restore cut rolls back the live transaction and the next invocation restores safely', () => {
    const left = currentDb('recovery-cut-left');
    const right = currentDb('recovery-cut-right');
    insertBoard(left, 'left-only');
    insertBoard(right, 'right-only');
    const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
    let leaveComplete = false;
    applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
      onEvent: (event) => {
        if (!leaveComplete && event.phase === 'recovery-classify' && event.state === 'before') {
          leaveComplete = true;
          throw new Error('leave complete');
        }
      },
    });
    const writer = new Database(left);
    writer.query("DELETE FROM boards WHERE id = 'right-only'").run();
    writer.close();
    let cut = false;
    const interrupted = recoverDatabaseReconciliation(request, {
      onEvent: (event) => {
        if (!cut && event.phase === 'recovery-restore' && event.state === 'after') {
          cut = true;
          throw new Error('recovery restore cut');
        }
      },
    });
    expect(interrupted.status).toBe('operational-failure');
    expect(boardNames(left)).toEqual(['left-only']);
    expect(boardNames(right)).toEqual(['left-only', 'right-only']);
    expect(recoverDatabaseReconciliation(request).status).toBe('recovered');
    expect(boardNames(left)).toEqual(['left-only']);
    expect(boardNames(right)).toEqual(['right-only']);
  });

  test('a recovery commit cut leaves the complete generation authoritative for the next invocation', () => {
    const left = currentDb('recovery-commit-left');
    const right = currentDb('recovery-commit-right');
    insertBoard(left, 'left-only');
    insertBoard(right, 'right-only');
    const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
    let leaveComplete = false;
    applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
      onEvent: (event) => {
        if (!leaveComplete && event.phase === 'recovery-classify' && event.state === 'before') {
          leaveComplete = true;
          throw new Error('leave complete');
        }
      },
    });
    const writer = new Database(left);
    writer.query("DELETE FROM boards WHERE id = 'right-only'").run();
    writer.close();
    let committed = false;
    const interrupted = recoverDatabaseReconciliation(request, {
      onLockedOperationEvent: (event) => {
        if (!committed && event.state === 'after') {
          committed = true;
          throw new Error('recovery commit cut');
        }
      },
    });
    expect(interrupted.status).toBe('operational-failure');
    expect(recoverDatabaseReconciliation(request).status).toBe('recovered');
    expect(boardNames(left)).toEqual(['left-only']);
    expect(boardNames(right)).toEqual(['right-only']);
  });

  test('explicit rollback snapshots arbitrary current state before restoring the selected preimages', () => {
    const left = currentDb('rollback-left');
    const right = currentDb('rollback-right');
    insertBoard(right, 'planned');
    const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
    const applied = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request));
    expect(applied.recovery.status).toBe('converged');
    const selected = applied.generationId;
    expect(selected).not.toBeNull();
    insertBoard(left, 'arbitrary-left');
    insertBoard(right, 'arbitrary-right');

    const rolledBack = rollbackDatabaseReconciliation(
      { mode: 'bidirectional', leftPath: right, rightPath: left },
      selected ?? '',
    );
    expect(rolledBack).toMatchObject({ status: 'rolled-back', selectedGenerationId: selected });
    expect(rolledBack.safetyGenerationId).not.toBeNull();
    expect(rolledBack.safetyGenerationId).not.toBe(selected);
    expect(boardNames(left)).toEqual([]);
    expect(boardNames(right)).toEqual(['planned']);
  });

  test('older writers are bounded by SQLite locks during recovery restore and explicit rollback', () => {
    const left = currentDb('writer-left');
    const right = currentDb('writer-right');
    insertBoard(left, 'left-only');
    insertBoard(right, 'right-only');
    const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
    let interrupted = false;
    const applied = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
      onEvent: (event) => {
        if (!interrupted && event.phase === 'recovery-classify' && event.state === 'before') {
          interrupted = true;
          throw new Error('leave complete pair');
        }
      },
    });
    expect(applied.status).toBe('operational-failure');
    const leftWriter = new Database(left);
    leftWriter.exec('PRAGMA foreign_keys = ON');
    leftWriter.query("DELETE FROM boards WHERE id = 'right-only'").run();
    leftWriter.close();

    let recoveryBusy = false;
    const recovered = recoverDatabaseReconciliation(request, {
      onEvent: (event) => {
        if (event.phase !== 'recovery-restore' || event.state !== 'before') return;
        const older = new Database(event.role === 'left' ? left : right);
        older.exec('PRAGMA busy_timeout = 20');
        try {
          older.query("INSERT INTO meta (key, value) VALUES ('older-recovery', 'unexpected')").run();
        } catch (caught) {
          recoveryBusy = caught instanceof Error && /locked/i.test(caught.message);
        } finally {
          older.close();
        }
      },
    });
    expect(recovered.status).toBe('recovered');
    expect(recoveryBusy).toBe(true);
    expect(boardNames(left)).toEqual(['left-only']);
    expect(boardNames(right)).toEqual(['right-only']);

    insertBoard(left, 'arbitrary-left');
    insertBoard(right, 'arbitrary-right');
    let rollbackBusy = false;
    const rollback = rollbackDatabaseReconciliation(request, applied.generationId ?? '', {
      onEvent: (event) => {
        if (event.phase !== 'rollback-restore' || event.state !== 'before' || rollbackBusy) return;
        const older = new Database(event.role === 'left' ? left : right);
        older.exec('PRAGMA busy_timeout = 20');
        try {
          older.query("INSERT INTO meta (key, value) VALUES ('older-rollback', 'unexpected')").run();
        } catch (caught) {
          rollbackBusy = caught instanceof Error && /locked/i.test(caught.message);
        } finally {
          older.close();
        }
      },
    });
    expect(rollback.status).toBe('rolled-back');
    expect(rollbackBusy).toBe(true);
  });

  test('a rollback restore cut rolls live transactions back and leaves its safety generation recoverable', () => {
    const left = currentDb('rollback-cut-left');
    const right = currentDb('rollback-cut-right');
    insertBoard(right, 'planned');
    const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
    const applied = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request));
    insertBoard(left, 'arbitrary-left');
    insertBoard(right, 'arbitrary-right');
    let injected = false;
    const rollback = rollbackDatabaseReconciliation(request, applied.generationId ?? '', {
      onEvent: (event) => {
        if (!injected && event.phase === 'rollback-restore' && event.state === 'after') {
          injected = true;
          throw new Error('rollback cut');
        }
      },
    });
    expect(rollback.status).toBe('operational-failure');
    expect(rollback.safetyGenerationId).not.toBeNull();
    expect(boardNames(left)).toEqual(['arbitrary-left', 'planned']);
    expect(boardNames(right)).toEqual(['arbitrary-right', 'planned']);
    expect(recoverDatabaseReconciliation(request).status).toBe('recovered');
    expect(boardNames(left)).toEqual(['arbitrary-left', 'planned']);
    expect(boardNames(right)).toEqual(['arbitrary-right', 'planned']);
  });

  test('a rollback commit cut is reversed from the new safety generation on the next recovery', () => {
    const left = currentDb('rollback-commit-left');
    const right = currentDb('rollback-commit-right');
    insertBoard(right, 'planned');
    const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
    const applied = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request));
    insertBoard(left, 'arbitrary-left');
    insertBoard(right, 'arbitrary-right');
    let committed = false;
    let rollbackStarted = false;
    const rollback = rollbackDatabaseReconciliation(request, applied.generationId ?? '', {
      onEvent: (event) => {
        if (event.phase === 'rollback-restore') rollbackStarted = true;
      },
      onLockedOperationEvent: (event) => {
        if (rollbackStarted && !committed && event.state === 'after') {
          committed = true;
          throw new Error('rollback commit cut');
        }
      },
    });
    expect(rollback.status).toBe('operational-failure');
    expect(rollback.safetyGenerationId).not.toBeNull();
    expect(recoverDatabaseReconciliation(request).status).toBe('recovered');
    expect(boardNames(left)).toEqual(['arbitrary-left', 'planned']);
    expect(boardNames(right)).toEqual(['arbitrary-right', 'planned']);
  });

  test('retention keeps the newest arbitrary count and stale staging is removed after success', () => {
    const left = currentDb('retain-left');
    const right = currentDb('retain-right');
    const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
    const identity = databaseSyncSnapshotIdentity(request);
    mkdirSync(join(identity.root, '.staging-abandoned'), { recursive: true });
    writeFileSync(join(identity.root, '.staging-abandoned', 'partial'), 'incomplete');
    for (let index = 0; index < 4; index++) {
      insertBoard(right, `board-${index}`);
      const report = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
        keepSnapshots: 2,
        now: () => new Date(1_700_000_000_000 + index),
      });
      expect(report.recovery.status).toBe('converged');
    }
    expect(generationDirectories(identity.root)).toHaveLength(2);
    expect(existsSync(join(identity.root, '.staging-abandoned'))).toBe(false);
  });

  test('default retention keeps three complete generations', () => {
    const left = currentDb('default-retain-left');
    const right = currentDb('default-retain-right');
    const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
    for (let index = 0; index < 4; index++) {
      insertBoard(right, `default-${index}`);
      expect(
        applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
          now: () => new Date(1_710_000_000_000 + index),
        }).recovery.status,
      ).toBe('converged');
    }
    expect(generationDirectories(databaseSyncSnapshotIdentity(request).root)).toHaveLength(3);
  });

  test('pruning cuts are reported, never affect the committed databases, and retry on the next success', () => {
    for (const state of ['before', 'after'] as const) {
      const left = currentDb(`prune-${state}-left`);
      const right = currentDb(`prune-${state}-right`);
      const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
      insertBoard(right, 'first');
      expect(
        applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
          keepSnapshots: 1,
          now: () => new Date(1_720_000_000_000),
        }).status,
      ).toBe('changed');
      insertBoard(right, 'second');
      let injected = false;
      const cut = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
        keepSnapshots: 1,
        now: () => new Date(1_720_000_000_001),
        onEvent: (event) => {
          if (!injected && event.phase === 'prune' && event.state === state) {
            injected = true;
            throw new Error(`prune ${state} cut`);
          }
        },
      });
      expect(cut.status).toBe('changed');
      expect(cut.cleanupFailures).toContain('snapshot-cleanup-failed');
      expect(boardNames(left)).toEqual(['first', 'second']);
      expect(boardNames(right)).toEqual(['first', 'second']);
      insertBoard(right, 'third');
      expect(
        applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
          keepSnapshots: 1,
          now: () => new Date(1_720_000_000_002),
        }).status,
      ).toBe('changed');
      expect(generationDirectories(databaseSyncSnapshotIdentity(request).root)).toHaveLength(1);
    }
  });

  test('staging cleanup and pruning refuse directory substitutions instead of deleting replacements', () => {
    {
      const left = currentDb('cleanup-race-left');
      const right = currentDb('cleanup-race-right');
      const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
      const root = databaseSyncSnapshotIdentity(request).root;
      const staging = join(root, '.staging-owned');
      const victim = join(fixtureRoot, 'cleanup-victim');
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(staging, 'owned'), 'owned');
      mkdirSync(victim);
      writeFileSync(join(victim, 'sentinel'), 'victim');
      let raced = false;
      const recovery = recoverDatabaseReconciliation(request, {
        onEvent: (event) => {
          if (!raced && event.phase === 'staging-cleanup' && event.state === 'before') {
            raced = true;
            renameSync(staging, `${staging}.original`);
            renameSync(victim, staging);
          }
        },
      });
      expect(recovery.cleanupFailures).toContain('snapshot-cleanup-failed');
      expect(readFileSync(join(staging, 'sentinel'), 'utf8')).toBe('victim');
    }
    {
      const left = currentDb('prune-race-left');
      const right = currentDb('prune-race-right');
      const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
      for (const id of ['one', 'two']) {
        insertBoard(right, id);
        expect(
          applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), { keepSnapshots: 3 }).status,
        ).toBe('changed');
      }
      const victim = join(fixtureRoot, 'prune-victim');
      mkdirSync(victim);
      writeFileSync(join(victim, 'sentinel'), 'victim');
      insertBoard(right, 'three');
      let replacement: string | null = null;
      const report = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
        keepSnapshots: 1,
        onEvent: (event) => {
          if (replacement !== null || event.phase !== 'prune' || event.state !== 'before' || event.path === undefined)
            return;
          replacement = event.path;
          renameSync(event.path, `${event.path}.original`);
          renameSync(victim, event.path);
        },
      });
      expect(report.cleanupFailures).toContain('snapshot-cleanup-failed');
      expect(replacement).not.toBeNull();
      expect(readFileSync(join(replacement ?? '', 'sentinel'), 'utf8')).toBe('victim');
    }
  });

  test('zero retention uses private 0700 state, never publishes, cleans on success, and cannot recover later', () => {
    const left = currentDb('private-left');
    const right = currentDb('private-right');
    insertBoard(right, 'private');
    const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
    const identity = databaseSyncSnapshotIdentity(request);
    let privateRoot: string | undefined;
    let privateMode: number | undefined;
    const report = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
      keepSnapshots: 0,
      onEvent: (event) => {
        if (event.phase === 'payload-write' && event.path === undefined && privateRoot === undefined) {
          // The generation ID is intentionally not sufficient to discover the OS-private root.
          privateRoot = readdirSync(tmpdir())
            .filter((name) => name.startsWith('genie-db-sync-private-'))
            .map((name) => join(tmpdir(), name))
            .find((path) => statSync(path).isDirectory());
          privateMode = privateRoot === undefined ? undefined : statSync(privateRoot).mode & 0o777;
        }
      },
    });
    expect(report.recovery.status).toBe('converged');
    expect(existsSync(identity.root)).toBe(false);
    expect(privateRoot).toBeDefined();
    expect(privateMode).toBe(0o700);
    expect(privateRoot === undefined ? true : existsSync(privateRoot)).toBe(false);
    expect(recoverDatabaseReconciliation(request, { keepSnapshots: 0 })).toMatchObject({
      status: 'none',
      generationId: null,
    });
  });

  test('zero-retention cleanup failure is reported and leaked private state is never discoverable', () => {
    const left = currentDb('private-failure-left');
    const right = currentDb('private-failure-right');
    insertBoard(right, 'private');
    const request = { mode: 'bidirectional' as const, leftPath: left, rightPath: right };
    let leakedRoot: string | undefined;
    const report = applyDatabaseReconciliationWithSnapshots(planDatabaseReconciliation(request), {
      keepSnapshots: 0,
      onEvent: (event) => {
        if (event.phase === 'payload-write' && leakedRoot === undefined) {
          leakedRoot = readdirSync(tmpdir())
            .filter((name) => name.startsWith('genie-db-sync-private-'))
            .map((name) => join(tmpdir(), name))
            .find((path) => statSync(path).isDirectory());
        }
      },
      removeTree: () => {
        throw new Error('cleanup denied');
      },
    });
    expect(report.cleanupFailures).toContain('snapshot-cleanup-failed');
    expect(leakedRoot).toBeDefined();
    expect(leakedRoot === undefined ? false : existsSync(leakedRoot)).toBe(true);
    expect(recoverDatabaseReconciliation(request)).toMatchObject({ status: 'none', generationId: null });
    if (leakedRoot !== undefined) rmSync(leakedRoot, { recursive: true, force: true });
  });

  test('negative, fractional, and unsafe retention fail before snapshots or writes', () => {
    for (const [index, retention] of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1].entries()) {
      const left = currentDb(`invalid-retention-${index}-left`);
      const right = currentDb(`invalid-retention-${index}-right`);
      insertBoard(right, 'planned');
      const report = applyDatabaseReconciliationWithSnapshots(
        planDatabaseReconciliation({ mode: 'bidirectional', leftPath: left, rightPath: right }),
        { keepSnapshots: retention },
      );
      expect(report).toMatchObject({
        status: 'operational-failure',
        failure: 'invalid-snapshot-option',
        apply: null,
      });
      expect(boardNames(left)).toEqual([]);
      expect(boardNames(right)).toEqual(['planned']);
    }
  });
});
