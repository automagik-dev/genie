import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  IDENTICAL_HISTORY_ADDITION_LIMITATION,
  type ReconciliationApplyEvent,
  ReconciliationError,
  type ReconciliationRequest,
  type TaskEventReconciliationValue,
  applyDatabaseReconciliation,
  dryRunDatabaseReconciliation,
  planDatabaseReconciliation,
} from './db-reconciliation.js';
import { openDb } from './genie-db.js';

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'genie-db-reconciliation-'));
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function pathFor(name: string): string {
  return join(fixtureRoot, `${name}.db`);
}

function currentDb(name: string, marker: string | null = '100'): string {
  const path = pathFor(name);
  openDb({ path }).close();
  const db = new Database(path);
  if (marker === null) db.query("DELETE FROM meta WHERE key = 'stage_log_backfill_v1'").run();
  else {
    db.query("UPDATE meta SET value = ? WHERE key = 'stage_log_backfill_v1'").run(marker);
  }
  db.close();
  return path;
}

async function spawnFlockHolder(lockPath: string, holdMs: number): Promise<ReturnType<typeof Bun.spawn>> {
  const readyPath = `${lockPath}.ready`;
  writeFileSync(lockPath, '');
  const code = `
    import { dlopen, FFIType } from 'bun:ffi';
    import { openSync } from 'node:fs';
    const libc = dlopen('libc.so.6', {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    const fd = openSync(Bun.argv[1], 'r+');
    if (libc.symbols.flock(fd, 2) !== 0) process.exit(9);
    await Bun.write(Bun.argv[2], 'ready');
    await Bun.sleep(Number(Bun.argv[3]));
  `;
  const child = Bun.spawn({
    cmd: [process.execPath, '-e', code, lockPath, readyPath, String(holdMs)],
    stderr: 'pipe',
    stdout: 'pipe',
  });
  for (let attempt = 0; attempt < 400 && !existsSync(readyPath); attempt++) await Bun.sleep(5);
  expect(existsSync(readyPath)).toBe(true);
  return child;
}

function mutate(path: string, callback: (db: Database) => void): void {
  const db = new Database(path);
  db.exec('PRAGMA foreign_keys = ON');
  callback(db);
  db.close();
}

function insertBoard(db: Database, row: { id: string; name: string; createdAt?: number; lanes?: string | null }): void {
  db.query('INSERT INTO boards (id, name, created_at, lanes) VALUES (?, ?, ?, ?)').run(
    row.id,
    row.name,
    row.createdAt ?? 1,
    row.lanes ?? null,
  );
}

function insertTask(
  db: Database,
  row: {
    id: string;
    boardId?: string | null;
    title?: string;
    status?: string;
    claimedBy?: string | null;
    claimedAt?: number | null;
    wish?: string | null;
    groupName?: string | null;
    createdAt?: number;
    updatedAt?: number;
    lane?: string | null;
    agentKind?: string | null;
    heartbeatAt?: number | null;
    blockedBy?: string | null;
    blockedReason?: string | null;
  },
): void {
  db.query(
    `INSERT INTO tasks (
       id, board_id, title, status, claimed_by, claimed_at, wish, group_name,
       created_at, updated_at, lane, agent_kind, heartbeat_at, blocked_by, blocked_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.boardId ?? null,
    row.title ?? row.id,
    row.status ?? 'ready',
    row.claimedBy ?? null,
    row.claimedAt ?? null,
    row.wish ?? null,
    row.groupName ?? null,
    row.createdAt ?? 1,
    row.updatedAt ?? 1,
    row.lane ?? null,
    row.agentKind ?? null,
    row.heartbeatAt ?? null,
    row.blockedBy ?? null,
    row.blockedReason ?? null,
  );
}

function insertStage(
  db: Database,
  id: number,
  row: { taskId: string; stage: string; note: string | null; createdAt: number },
): void {
  db.query('INSERT INTO stage_log (id, task_id, stage, note, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    row.taskId,
    row.stage,
    row.note,
    row.createdAt,
  );
}

function insertEvent(
  db: Database,
  id: number,
  row: {
    taskId: string;
    kind: string;
    note: string | null;
    authorKind?: string | null;
    author?: string | null;
    createdAt: number;
  },
): void {
  db.query(
    'INSERT INTO task_events (id, task_id, kind, note, author_kind, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, row.taskId, row.kind, row.note, row.authorKind ?? null, row.author ?? null, row.createdAt);
}

function bidirectional(leftPath: string, rightPath: string): ReconciliationRequest {
  return { mode: 'bidirectional', leftPath, rightPath };
}

function directional(sourcePath: string, destinationPath: string): ReconciliationRequest {
  return { mode: 'directional', sourcePath, destinationPath };
}

function target(plan: ReturnType<typeof planDatabaseReconciliation>, role: 'left' | 'right' | 'destination') {
  const found = plan.targets.find((candidate) => candidate.role === role);
  if (found === undefined) throw new Error(`missing ${role} target`);
  return found;
}

function scalarCount(path: string, table: string): number {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function metaValue(path: string, key: string): string | null {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | null;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

function taskTitle(path: string, id: string): string | null {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query('SELECT title FROM tasks WHERE id = ?').get(id) as { title: string } | null;
    return row?.title ?? null;
  } finally {
    db.close();
  }
}

function seedBidirectionalApplyPair(): { left: string; right: string } {
  const left = currentDb('apply-left', null);
  const right = currentDb('apply-right', null);
  for (const [path, side] of [
    [left, 'left'],
    [right, 'right'],
  ] as const) {
    mutate(path, (db) => {
      insertBoard(db, { id: `board-${side}`, name: `Board ${side}` });
      insertTask(db, { id: `task-${side}`, boardId: `board-${side}` });
      insertTask(db, { id: `dependency-${side}` });
      db.query('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run(
        `task-${side}`,
        `dependency-${side}`,
      );
      db.query(
        `INSERT INTO wish_groups
           (wish, name, status, depends_on, assignee, started_at, completed_at, created_at, updated_at)
         VALUES (?, ?, 'ready', '[]', NULL, NULL, NULL, 1, 1)`,
      ).run(`wish-${side}`, 'group');
      db.query(
        `INSERT INTO hire_roster (wish, agent_adapter_id, profile, worktree, hired_at, state)
         VALUES (?, 'adapter', NULL, ?, 1, 'hired')`,
      ).run(`wish-${side}`, `/worktree/${side}`);
      db.query('INSERT INTO meta (key, value) VALUES (?, ?)').run(`meta-${side}`, side);
      insertStage(db, 1, { taskId: `task-${side}`, stage: 'report', note: side, createdAt: 1 });
      insertEvent(db, 1, { taskId: `task-${side}`, kind: 'report', note: side, createdAt: 1 });
    });
  }
  return { left, right };
}

function seedPreLanes(path: string): void {
  const db = new Database(path);
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      board_id TEXT REFERENCES boards(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('blocked','ready','in_progress','done')),
      claimed_by TEXT,
      claimed_at INTEGER,
      wish TEXT,
      group_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on_id)
    );
    CREATE TABLE stage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE wish_groups (
      wish TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('blocked','ready','in_progress','done')),
      depends_on TEXT NOT NULL DEFAULT '[]',
      assignee TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (wish, name)
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.close();
}

function seedPreRuntime(path: string): void {
  const db = new Database(path);
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE boards (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, lanes TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      board_id TEXT REFERENCES boards(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('blocked','ready','in_progress','done')),
      claimed_by TEXT, claimed_at INTEGER, wish TEXT, group_name TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lane TEXT
    );
    CREATE TABLE task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on_id)
    );
    CREATE TABLE stage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      stage TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, note TEXT, author_kind TEXT, author TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE wish_groups (
      wish TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('blocked','ready','in_progress','done')),
      depends_on TEXT NOT NULL DEFAULT '[]', assignee TEXT, started_at INTEGER, completed_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (wish, name)
    );
    CREATE TABLE hire_roster (
      wish TEXT NOT NULL, agent_adapter_id TEXT NOT NULL, profile TEXT, worktree TEXT NOT NULL,
      hired_at INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (wish, agent_adapter_id)
    );
    CREATE INDEX idx_task_deps_dep ON task_dependencies(depends_on_id);
    CREATE INDEX idx_tasks_status ON tasks(status);
    CREATE INDEX idx_stage_log_task ON stage_log(task_id);
    CREATE INDEX idx_task_events_task ON task_events(task_id);
  `);
  db.close();
}

function seedReorderedCurrent(
  path: string,
  taskStatuses = "'done', 'blocked', 'ready', 'in_progress'",
  transform: (sql: string) => string = (sql) => sql,
): void {
  const db = new Database(path);
  db.exec(
    transform(`
    PRAGMA user_version = 1;
    CREATE TABLE meta (value TEXT NOT NULL, key TEXT, PRIMARY KEY (key));
    CREATE TABLE boards (
      lanes TEXT, created_at INTEGER NOT NULL, name TEXT NOT NULL UNIQUE, id TEXT, PRIMARY KEY (id)
    );
    CREATE TABLE tasks (
      blocked_reason TEXT, heartbeat_at INTEGER, agent_kind TEXT, lane TEXT,
      updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL, group_name TEXT, wish TEXT,
      claimed_at INTEGER, claimed_by TEXT,
      status TEXT NOT NULL CHECK(status IN (${taskStatuses})),
      title TEXT NOT NULL,
      board_id TEXT REFERENCES boards(id) ON DELETE SET NULL,
      blocked_by TEXT,
      id TEXT,
      PRIMARY KEY (id)
    );
    CREATE TABLE task_dependencies (
      depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on_id)
    );
    CREATE TABLE stage_log (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      note TEXT,
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      stage TEXT NOT NULL
    );
    CREATE TABLE task_events (
      author TEXT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note TEXT,
      kind TEXT NOT NULL,
      author_kind TEXT
    );
    CREATE TABLE wish_groups (
      updated_at INTEGER NOT NULL,
      assignee TEXT,
      name TEXT NOT NULL,
      depends_on TEXT NOT NULL DEFAULT '[]',
      wish TEXT NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('ready','in_progress','done','blocked')),
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      PRIMARY KEY (wish, name)
    );
    CREATE TABLE hire_roster (
      state TEXT NOT NULL,
      agent_adapter_id TEXT NOT NULL,
      hired_at INTEGER NOT NULL,
      wish TEXT NOT NULL,
      worktree TEXT NOT NULL,
      profile TEXT,
      PRIMARY KEY (wish, agent_adapter_id)
    );
    CREATE INDEX idx_task_events_task ON task_events(task_id);
    CREATE INDEX idx_stage_log_task ON stage_log(task_id);
    CREATE INDEX idx_tasks_status ON tasks(status);
    CREATE INDEX idx_task_deps_dep ON task_dependencies(depends_on_id);
  `),
  );
  db.close();
}

describe('closed normalized current schema', () => {
  test('fresh, normalized additive-history, and reordered current schemas share one fingerprint', () => {
    const fresh = currentDb('fresh', null);
    const preLanes = pathFor('pre-lanes');
    const preRuntime = pathFor('pre-runtime');
    const reordered = pathFor('reordered');
    seedPreLanes(preLanes);
    seedPreRuntime(preRuntime);
    seedReorderedCurrent(reordered);

    // The normal current open path, not reconciliation, owns additive repair.
    openDb({ path: preLanes }).close();
    openDb({ path: preRuntime }).close();
    openDb({ path: reordered }).close();

    const fingerprints = [preLanes, preRuntime, reordered].map(
      (candidate) => planDatabaseReconciliation(bidirectional(fresh, candidate)).schemaFingerprint,
    );
    expect(new Set(fingerprints).size).toBe(1);
  });

  test('stale same-version additive shape is rejected read-only with normal-open guidance', () => {
    const stale = pathFor('stale');
    const current = currentDb('current');
    seedPreLanes(stale);
    const before = readFileSync(stale);

    const report = dryRunDatabaseReconciliation(bidirectional(stale, current));

    expect(report.status).toBe('operational-failure');
    expect(report.operationalFailure).toEqual({
      code: 'stale-current-schema',
      guidance:
        'Open the database once with Genie’s normal current open path (for example `genie board`) to normalize supported additive history, then retry reconciliation.',
    });
    expect(readFileSync(stale)).toEqual(before);
    const check = new Database(stale, { readonly: true });
    expect(check.query("SELECT 1 FROM sqlite_schema WHERE name = 'task_events'").get()).toBeNull();
    check.close();
  });

  test.each([
    ['extra column', (db: Database) => db.exec('ALTER TABLE tasks ADD COLUMN guest_extra TEXT')],
    ['extra table', (db: Database) => db.exec('CREATE TABLE guest_extra (id TEXT PRIMARY KEY)')],
    ['extra index', (db: Database) => db.exec('CREATE INDEX guest_extra ON tasks(title)')],
    ['view', (db: Database) => db.exec('CREATE VIEW guest_extra AS SELECT id FROM tasks')],
    ['virtual table', (db: Database) => db.exec('CREATE VIRTUAL TABLE guest_extra USING fts5(content)')],
  ])('%s is rejected before planning authority', (_name, alter) => {
    const guest = currentDb('guest');
    const peer = currentDb('peer');
    mutate(guest, alter);

    const report = dryRunDatabaseReconciliation(bidirectional(guest, peer));

    expect(report.status).toBe('operational-failure');
    expect(report.operationalFailure?.code).toBe('unsupported-schema');
    expect(report.targets).toEqual([]);
  });

  test('trigger is rejected and its guest-defined body never executes', () => {
    const guest = currentDb('guest');
    const peer = currentDb('peer');
    mutate(guest, (db) => {
      insertTask(db, { id: 't' });
      db.exec(`
        CREATE TRIGGER guest_trigger AFTER UPDATE ON tasks
        BEGIN
          INSERT INTO meta (key, value) VALUES ('trigger_executed', 'yes');
        END
      `);
    });

    const report = dryRunDatabaseReconciliation(bidirectional(guest, peer));

    expect(report.operationalFailure?.code).toBe('unsupported-schema');
    const check = new Database(guest, { readonly: true });
    expect(check.query("SELECT value FROM meta WHERE key = 'trigger_executed'").get()).toBeNull();
    check.close();
  });

  test('a non-schema-implied SQLite internal object is rejected', () => {
    const guest = currentDb('guest');
    const peer = currentDb('peer');
    mutate(guest, (db) => {
      // sqlite_stat1 is SQLite-owned, but unlike sqlite_sequence it is not
      // implied by Genie's supported schema and therefore is still closed out.
      db.exec('ANALYZE');
    });

    const report = dryRunDatabaseReconciliation(bidirectional(guest, peer));

    expect(report.status).toBe('operational-failure');
    expect(report.operationalFailure?.code).toBe('unsupported-schema');
  });

  test('missing expected index is stale but altered constraints are unsupported', () => {
    const peer = currentDb('peer');
    const missing = currentDb('missing');
    mutate(missing, (db) => db.exec('DROP INDEX idx_tasks_status'));
    expect(dryRunDatabaseReconciliation(bidirectional(missing, peer)).operationalFailure?.code).toBe(
      'stale-current-schema',
    );

    const wrongCheck = pathFor('wrong-check');
    seedReorderedCurrent(wrongCheck, "'done', 'blocked', 'ready', 'paused'");
    expect(dryRunDatabaseReconciliation(bidirectional(wrongCheck, peer)).status).toBe('operational-failure');
  });

  test.each([
    ['declared collation', (sql: string) => sql.replace('title TEXT NOT NULL', 'title TEXT COLLATE NOCASE NOT NULL')],
    [
      'constraint conflict policy',
      (sql: string) => sql.replace('name TEXT NOT NULL UNIQUE', 'name TEXT NOT NULL UNIQUE ON CONFLICT IGNORE'),
    ],
    [
      'regrouped foreign keys',
      (sql: string) =>
        sql.replace(
          /depends_on_id TEXT NOT NULL REFERENCES tasks\(id\) ON DELETE CASCADE,\s*task_id TEXT NOT NULL REFERENCES tasks\(id\) ON DELETE CASCADE,/,
          `task_id TEXT NOT NULL,
      depends_on_id TEXT NOT NULL,
      FOREIGN KEY (task_id, depends_on_id) REFERENCES tasks(id, id) ON DELETE CASCADE,`,
        ),
    ],
  ])('%s is rejected by the closed schema fingerprint', (_name, transform) => {
    const altered = pathFor('altered');
    const peer = currentDb('peer');
    seedReorderedCurrent(altered, "'done', 'blocked', 'ready', 'in_progress'", transform);

    const report = dryRunDatabaseReconciliation(bidirectional(altered, peer));

    expect(report.status).toBe('operational-failure');
    expect(report.operationalFailure?.code).toBe('unsupported-schema');
  });
});

describe('keyed, edge-set, and history-multiset planning', () => {
  test('all tables, nullable columns, local-ID collisions, and meaningful duplicates reconcile deterministically', () => {
    const left = currentDb('left', null);
    const right = currentDb('right', null);
    for (const [path, side] of [
      [left, 'left'],
      [right, 'right'],
    ] as const) {
      mutate(path, (db) => {
        insertBoard(db, {
          id: `b-${side}`,
          name: `board-${side}`,
          lanes: side === 'left' ? null : '["ready"]',
        });
        insertTask(db, { id: 'shared', title: 'same' });
        insertTask(db, { id: 'prerequisite', title: 'prerequisite' });
        insertTask(
          db,
          side === 'left'
            ? { id: 'nullable', title: 'nullable' }
            : {
                id: 'populated',
                boardId: 'b-right',
                title: 'populated',
                status: 'blocked',
                claimedBy: 'worker',
                claimedAt: 2,
                wish: 'wish',
                groupName: 'g',
                createdAt: 2,
                updatedAt: 3,
                lane: 'blocked',
                agentKind: 'codex',
                heartbeatAt: 4,
                blockedBy: 'prerequisite',
                blockedReason: 'waiting',
              },
        );
        db.query(
          `INSERT INTO wish_groups
             (wish, name, status, depends_on, assignee, started_at, completed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `wish-${side}`,
          'g',
          'ready',
          '[]',
          side === 'left' ? null : 'worker',
          side === 'left' ? null : 2,
          side === 'left' ? null : 3,
          1,
          1,
        );
        db.query(
          'INSERT INTO hire_roster (wish, agent_adapter_id, profile, worktree, hired_at, state) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(`wish-${side}`, 'adapter', side === 'left' ? null : 'profile', `/wt/${side}`, 1, 'hired');
        db.query('INSERT INTO meta (key, value) VALUES (?, ?)').run(`meta-${side}`, side);
      });
    }
    mutate(left, (db) => {
      db.query('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run('shared', 'prerequisite');
      insertStage(db, 1, { taskId: 'shared', stage: 'planned', note: 'same', createdAt: 10 });
      insertStage(db, 2, { taskId: 'shared', stage: 'planned', note: 'same', createdAt: 10 });
      insertEvent(db, 1, { taskId: 'shared', kind: 'comment', note: 'same', createdAt: 20 });
      insertEvent(db, 2, {
        taskId: 'shared',
        kind: 'report',
        note: 'left-only',
        authorKind: 'agent',
        author: 'a',
        createdAt: 21,
      });
    });
    mutate(right, (db) => {
      db.query('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run('populated', 'shared');
      // IDs collide with left but are intentionally local and excluded from identity.
      insertStage(db, 1, { taskId: 'shared', stage: 'planned', note: 'same', createdAt: 10 });
      insertStage(db, 2, { taskId: 'shared', stage: 'right-only', note: null, createdAt: 11 });
      insertEvent(db, 1, { taskId: 'shared', kind: 'comment', note: 'same', createdAt: 20 });
      insertEvent(db, 2, { taskId: 'shared', kind: 'comment', note: null, createdAt: 22 });
    });

    const first = planDatabaseReconciliation(bidirectional(left, right));
    const second = planDatabaseReconciliation(bidirectional(left, right));

    expect(first.status).toBe('changed');
    expect(first.report).toEqual(second.report);
    expect(target(first, 'left').changes).toMatchObject({
      boards: [{ id: 'b-right' }],
      tasks: [{ id: 'populated' }],
      wishGroups: [{ wish: 'wish-right' }],
      hireRoster: [{ wish: 'wish-right' }],
      meta: [{ key: 'meta-right' }],
      taskDependencies: [{ taskId: 'populated', dependsOnId: 'shared' }],
      stageLog: [{ count: 1, value: { stage: 'right-only' } }],
      taskEvents: [{ count: 1, value: { note: null } }],
    });
    expect(target(first, 'right').changes).toMatchObject({
      boards: [{ id: 'b-left' }],
      tasks: [{ id: 'nullable' }],
      wishGroups: [{ wish: 'wish-left' }],
      hireRoster: [{ wish: 'wish-left', profile: null }],
      meta: [{ key: 'meta-left' }],
      taskDependencies: [{ taskId: 'shared', dependsOnId: 'prerequisite' }],
      stageLog: [{ count: 1, value: { stage: 'planned', note: 'same' } }],
      taskEvents: [{ count: 1, value: { kind: 'report', authorKind: 'agent', author: 'a' } }],
    });
    expect(first.report.targets.every((item) => item.changes.deletions === 0)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.targets)).toBe(true);
    expect(Object.isFrozen(first.targets[0].changes.stageLog)).toBe(true);
  });

  test('pre-existing self-dependencies and cycles are rejected as invalid input graphs', () => {
    const peer = currentDb('peer');
    for (const kind of ['self', 'cycle'] as const) {
      const invalid = currentDb(kind);
      mutate(invalid, (db) => {
        insertTask(db, { id: 'x' });
        if (kind === 'self') {
          db.query('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run('x', 'x');
          return;
        }
        insertTask(db, { id: 'y' });
        db.query('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run('x', 'y');
        db.query('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run('y', 'x');
      });

      expect(() => planDatabaseReconciliation(bidirectional(invalid, peer))).toThrow(
        expect.objectContaining({ code: 'invalid-data' }),
      );
    }
  });

  test('a cycle formed only by the cross-endpoint dependency union conflicts before planning changes', () => {
    const left = currentDb('left');
    const right = currentDb('right');
    for (const path of [left, right]) {
      mutate(path, (db) => {
        insertTask(db, { id: 'x' });
        insertTask(db, { id: 'y' });
      });
    }
    mutate(left, (db) => {
      db.query('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run('x', 'y');
    });
    mutate(right, (db) => {
      db.query('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run('y', 'x');
    });

    const plan = planDatabaseReconciliation(bidirectional(left, right));

    expect(plan.status).toBe('conflict');
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ table: 'task_dependencies', reason: 'planned-integrity-failed', side: 'left' }),
      expect.objectContaining({ table: 'task_dependencies', reason: 'planned-integrity-failed', side: 'right' }),
    ]);
    expect(target(plan, 'left').changes.taskDependencies).toEqual([]);
    expect(target(plan, 'right').changes.taskDependencies).toEqual([]);
  });

  test('invalid loaded wish-group dependency graphs are rejected while valid per-wish graphs reconcile', () => {
    const invalidFixtures = [
      { name: 'malformed', rows: [['w', 'a', '{']] },
      { name: 'non-array', rows: [['w', 'a', '{}']] },
      { name: 'non-string', rows: [['w', 'a', '[1]']] },
      { name: 'dangling', rows: [['w', 'a', '["missing"]']] },
      { name: 'self', rows: [['w', 'a', '["a"]']] },
      {
        name: 'cycle',
        rows: [
          ['w', 'a', '["b"]'],
          ['w', 'b', '["a"]'],
        ],
      },
    ] as const;
    const peer = currentDb('peer');
    for (const fixture of invalidFixtures) {
      const invalid = currentDb(fixture.name);
      mutate(invalid, (db) => {
        for (const [wish, name, dependsOn] of fixture.rows) {
          db.query(
            `INSERT INTO wish_groups
               (wish, name, status, depends_on, created_at, updated_at)
             VALUES (?, ?, 'ready', ?, 1, 1)`,
          ).run(wish, name, dependsOn);
        }
      });
      expect(() => planDatabaseReconciliation(bidirectional(invalid, peer))).toThrow(
        expect.objectContaining({ code: 'invalid-data' }),
      );
    }

    const valid = currentDb('valid');
    mutate(valid, (db) => {
      for (const [wish, name, dependsOn] of [
        ['w1', 'a', '[]'],
        ['w1', 'b', '["a"]'],
        ['w2', 'a', '[]'],
      ]) {
        db.query(
          `INSERT INTO wish_groups
             (wish, name, status, depends_on, created_at, updated_at)
           VALUES (?, ?, 'ready', ?, 1, 1)`,
        ).run(wish, name, dependsOn);
      }
    });
    expect(planDatabaseReconciliation(bidirectional(valid, peer)).status).toBe('changed');
  });

  test('bidirectional same-key differences conflict without exposing hostile payloads', () => {
    const left = currentDb('left');
    const right = currentDb('right');
    mutate(left, (db) => insertBoard(db, { id: 'same', name: '<left-title>' }));
    mutate(right, (db) => insertBoard(db, { id: 'same', name: '<hostile-title> right' }));

    const plan = planDatabaseReconciliation(bidirectional(left, right));
    const reportJson = JSON.stringify(plan.report);

    expect(plan.status).toBe('conflict');
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ table: 'boards', reason: 'same-key-difference' });
    expect(plan.targets.every((item) => item.postimageDigest === null)).toBe(true);
    expect(reportJson).not.toContain('hostile-title');
    expect(reportJson).not.toContain('left-title');
  });

  test('directional source wins shared keyed rows and unknown meta while destination-only rows are preserved', () => {
    const source = currentDb('source', null);
    const destination = currentDb('destination', null);
    for (const [path, suffix] of [
      [source, 'source'],
      [destination, 'destination'],
    ] as const) {
      mutate(path, (db) => {
        insertBoard(db, { id: 'shared-board', name: `board-${suffix}` });
        insertTask(db, { id: 'shared-task', boardId: 'shared-board', title: `task-${suffix}` });
        db.query(
          `INSERT INTO wish_groups
             (wish, name, status, depends_on, assignee, started_at, completed_at, created_at, updated_at)
           VALUES ('w', 'g', 'ready', '[]', ?, NULL, NULL, 1, 1)`,
        ).run(suffix);
        db.query(
          `INSERT INTO hire_roster
             (wish, agent_adapter_id, profile, worktree, hired_at, state)
           VALUES ('w', 'a', ?, ?, 1, 'hired')`,
        ).run(suffix, `/wt/${suffix}`);
        db.query("INSERT INTO meta (key, value) VALUES ('unknown', ?)").run(suffix);
      });
    }
    mutate(destination, (db) => insertBoard(db, { id: 'destination-only', name: 'keep-me' }));

    const plan = planDatabaseReconciliation({
      mode: 'directional',
      sourcePath: source,
      destinationPath: destination,
    });
    const changes = target(plan, 'destination').changes;

    expect(changes.boards).toHaveLength(1);
    expect(changes.boards[0].name).toBe('board-source');
    expect(changes.tasks[0].title).toBe('task-source');
    expect(changes.wishGroups[0].assignee).toBe('source');
    expect(changes.hireRoster[0].worktree).toBe('/wt/source');
    expect(changes.meta).toEqual([{ key: 'unknown', value: 'source' }]);
    expect(changes.boards.some((row) => row.id === 'destination-only')).toBe(false);
    expect(plan.report.targets[0].changes.deletions).toBe(0);
  });

  test('a cross-image uniqueness collision conflicts instead of planning an invalid target', () => {
    const source = currentDb('source');
    const destination = currentDb('destination');
    mutate(source, (db) => insertBoard(db, { id: 'source-id', name: 'same-name' }));
    mutate(destination, (db) => insertBoard(db, { id: 'destination-id', name: 'same-name' }));

    const plan = planDatabaseReconciliation({
      mode: 'directional',
      sourcePath: source,
      destinationPath: destination,
    });

    expect(plan.status).toBe('conflict');
    expect(plan.conflicts).toContainEqual(
      expect.objectContaining({
        table: 'boards',
        reason: 'planned-integrity-failed',
        side: 'destination',
      }),
    );
    expect(target(plan, 'destination').postimageDigest).toBeNull();
  });

  test('exact event counts use max and identical independent additions remain indistinguishable', () => {
    const left = currentDb('left');
    const right = currentDb('right');
    for (const [path, id] of [
      [left, 1],
      [right, 999],
    ] as const) {
      mutate(path, (db) => {
        insertTask(db, { id: 't' });
        insertEvent(db, id, {
          taskId: 't',
          kind: 'comment',
          note: 'byte-identical',
          authorKind: 'human',
          author: 'same',
          createdAt: 10,
        });
      });
    }

    const plan = planDatabaseReconciliation(bidirectional(left, right));

    expect(plan.status).toBe('no-op');
    expect(plan.inputs[0].logicalDigest).toBe(plan.inputs[1].logicalDigest);
    expect(plan.historyLimitation).toBe(IDENTICAL_HISTORY_ADDITION_LIMITATION);
    expect(target(plan, 'left').changes.taskEvents).toEqual([]);
    expect(target(plan, 'right').changes.taskEvents).toEqual([]);
  });

  test('directional history count is max(destination, source), never sum', () => {
    const source = currentDb('source', null);
    const destination = currentDb('destination', null);
    for (const path of [source, destination]) {
      mutate(path, (db) => insertTask(db, { id: 't' }));
    }
    mutate(source, (db) => {
      for (let id = 1; id <= 3; id++) {
        insertEvent(db, id, { taskId: 't', kind: 'comment', note: 'same', createdAt: 1 });
      }
    });
    mutate(destination, (db) => {
      insertEvent(db, 20, { taskId: 't', kind: 'comment', note: 'same', createdAt: 1 });
    });

    const plan = planDatabaseReconciliation({
      mode: 'directional',
      sourcePath: source,
      destinationPath: destination,
    });

    expect(target(plan, 'destination').changes.taskEvents).toEqual([
      {
        count: 2,
        value: {
          taskId: 't',
          kind: 'comment',
          note: 'same',
          authorKind: null,
          author: null,
          createdAt: 1n,
        },
      },
    ]);
  });
});

describe('stage_log_backfill_v1 marker semantics', () => {
  test('all seven direct mappings plus both unknown mappings preserve exact task/time/null-author tuples', () => {
    const left = currentDb('left', '200');
    const right = currentDb('right', null);
    for (const path of [left, right]) mutate(path, (db) => insertTask(db, { id: 't' }));
    const direct = ['comment', 'move', 'claim', 'release', 'block', 'unblock', 'report'];
    const expectedEvents: TaskEventReconciliationValue[] = [];
    mutate(left, (db) => {
      let id = 1;
      for (const kind of direct) {
        const note = `note-${kind}`;
        insertStage(db, id, { taskId: 't', stage: kind, note, createdAt: 100 + id });
        insertEvent(db, id, { taskId: 't', kind, note, createdAt: 100 + id });
        expectedEvents.push({
          taskId: 't',
          kind,
          note,
          authorKind: null,
          author: null,
          createdAt: BigInt(100 + id),
        });
        id++;
      }
      insertStage(db, id, { taskId: 't', stage: 'planned', note: 'kickoff', createdAt: 200 });
      insertEvent(db, id, { taskId: 't', kind: 'comment', note: 'planned: kickoff', createdAt: 200 });
      expectedEvents.push({
        taskId: 't',
        kind: 'comment',
        note: 'planned: kickoff',
        authorKind: null,
        author: null,
        createdAt: 200n,
      });
      id++;
      insertStage(db, id, { taskId: 't', stage: 'implemented', note: null, createdAt: 201 });
      insertEvent(db, id, { taskId: 't', kind: 'comment', note: 'implemented', createdAt: 201 });
      expectedEvents.push({
        taskId: 't',
        kind: 'comment',
        note: 'implemented',
        authorKind: null,
        author: null,
        createdAt: 201n,
      });
    });

    const plan = planDatabaseReconciliation(bidirectional(left, right));
    const rightChanges = target(plan, 'right').changes;

    expect(plan.status).toBe('changed');
    expect(rightChanges.meta).toEqual([{ key: 'stage_log_backfill_v1', value: '200' }]);
    expect(rightChanges.taskEvents.map((addition) => addition.value)).toEqual(expect.arrayContaining(expectedEvents));
    expect(rightChanges.taskEvents).toHaveLength(expectedEvents.length);
    expect(rightChanges.taskEvents.every((addition) => addition.count === 1)).toBe(true);
    expect(
      rightChanges.taskEvents.every((addition) => addition.value.author === null && addition.value.authorKind === null),
    ).toBe(true);
    const stages = rightChanges.stageLog.map((addition) => addition.value);
    expect(stages.every((stage) => stage.taskId === 't')).toBe(true);
    expect(new Set(stages.map((stage) => stage.createdAt))).toEqual(
      new Set(expectedEvents.map((event) => event.createdAt)),
    );
  });

  test('two valid decimal markers converge to the numerically smaller canonical timestamp', () => {
    const left = currentDb('left', '000200');
    const right = currentDb('right', '100');

    const plan = planDatabaseReconciliation(bidirectional(left, right));

    expect(target(plan, 'left').changes.meta).toEqual([{ key: 'stage_log_backfill_v1', value: '100' }]);
    expect(target(plan, 'right').changes.meta).toEqual([]);
    expect(target(plan, 'left').postimageDigest).toBe(target(plan, 'right').postimageDigest);
  });

  test('directional reconciliation uses the valid source marker whenever it is present', () => {
    const fixtures = [
      { name: 'greater', source: '200', destination: '100', expected: '200' },
      { name: 'smaller', source: '100', destination: '200', expected: '100' },
      { name: 'destination-missing', source: '200', destination: null, expected: '200' },
      { name: 'source-missing', source: null, destination: '100', expected: null },
    ] as const;

    for (const fixture of fixtures) {
      const source = currentDb(`${fixture.name}-source`, fixture.source);
      const destination = currentDb(`${fixture.name}-destination`, fixture.destination);

      const plan = planDatabaseReconciliation({
        mode: 'directional',
        sourcePath: source,
        destinationPath: destination,
      });

      expect(target(plan, 'destination').changes.meta).toEqual(
        fixture.expected === null ? [] : [{ key: 'stage_log_backfill_v1', value: fixture.expected }],
      );
    }
  });

  test('invalid marker and invariant failure become deterministic conflicts', () => {
    const invalid = currentDb('invalid', 'not-decimal');
    const peer = currentDb('peer', null);
    const invalidPlan = planDatabaseReconciliation(bidirectional(invalid, peer));
    expect(invalidPlan.status).toBe('conflict');
    expect(invalidPlan.conflicts).toEqual([
      expect.objectContaining({ table: 'meta', reason: 'invalid-marker', side: 'left' }),
    ]);

    const failing = currentDb('failing', '100');
    mutate(failing, (db) => {
      insertTask(db, { id: 't' });
      insertStage(db, 1, { taskId: 't', stage: 'report', note: 'missing event', createdAt: 1 });
    });
    const first = planDatabaseReconciliation(bidirectional(failing, peer));
    const second = planDatabaseReconciliation(bidirectional(failing, peer));
    expect(first.status).toBe('conflict');
    expect(first.conflicts).toEqual(second.conflicts);
    expect(first.conflicts).toContainEqual(
      expect.objectContaining({ reason: 'marker-invariant-failed', side: 'left' }),
    );
  });

  test('mapped-count invariant aggregates distinct stage tuples that map to the same event tuple', () => {
    const left = currentDb('left', '100');
    const right = currentDb('right', null);
    mutate(left, (db) => {
      insertTask(db, { id: 't' });
      insertStage(db, 1, { taskId: 't', stage: 'comment', note: 'x', createdAt: 1 });
      insertStage(db, 2, { taskId: 't', stage: 'x', note: null, createdAt: 1 });
      insertEvent(db, 1, { taskId: 't', kind: 'comment', note: 'x', createdAt: 1 });
    });

    const plan = planDatabaseReconciliation(bidirectional(left, right));

    expect(plan.status).toBe('conflict');
    expect(plan.conflicts).toContainEqual(expect.objectContaining({ reason: 'marker-invariant-failed', side: 'left' }));
  });

  test('filling a missing marker checks the planned target event coverage', () => {
    const left = currentDb('left', '100');
    const right = currentDb('right', null);
    for (const path of [left, right]) mutate(path, (db) => insertTask(db, { id: 't' }));
    mutate(left, (db) => {
      insertStage(db, 1, { taskId: 't', stage: 'report', note: 'left', createdAt: 1 });
      insertEvent(db, 1, { taskId: 't', kind: 'report', note: 'left', createdAt: 1 });
    });
    mutate(right, (db) => {
      insertStage(db, 1, { taskId: 't', stage: 'report', note: 'right', createdAt: 2 });
    });

    const plan = planDatabaseReconciliation(bidirectional(left, right));

    expect(plan.status).toBe('conflict');
    expect(plan.conflicts).toContainEqual(
      expect.objectContaining({ reason: 'planned-marker-invariant-failed', side: 'left' }),
    );
    expect(plan.conflicts).toContainEqual(
      expect.objectContaining({ reason: 'planned-marker-invariant-failed', side: 'right' }),
    );
  });
});

describe('same-file, idempotency, and bounded failures', () => {
  test('symlink and hardlink aliases are true same-database no-ops in both modes', () => {
    for (const aliasKind of ['symlink', 'hardlink'] as const) {
      for (const mode of ['bidirectional', 'directional'] as const) {
        const path = currentDb(`${aliasKind}-${mode}`, '000100');
        const alias = join(fixtureRoot, `${aliasKind}-${mode}-alias.db`);
        if (aliasKind === 'symlink') symlinkSync(path, alias);
        else linkSync(path, alias);
        const request =
          mode === 'bidirectional'
            ? bidirectional(path, alias)
            : ({ mode, sourcePath: alias, destinationPath: path } as const);
        const plan = planDatabaseReconciliation(request);
        expect(plan.status).toBe('same-database');
        expect(plan.sameDatabase).toBe(true);
        expect(plan.report.status).toBe('no-op');
        expect(plan.inputs[0].logicalDigest).toBe(plan.inputs[1].logicalDigest);
        expect(plan.targets.every((item) => !Object.values(item.changes).some((rows) => rows.length > 0))).toBe(true);
      }
    }
  });

  test.each(
    (['invalid-marker', 'marker-invariant-failed'] as const).flatMap((failure) =>
      (['symlink', 'hardlink'] as const).flatMap((aliasKind) =>
        (['bidirectional', 'directional'] as const).map((mode) => [failure, aliasKind, mode] as const),
      ),
    ),
  )('same-physical %s %s aliases validate markers in %s mode', (failure, aliasKind, mode) => {
    const path = currentDb(`${failure}-${aliasKind}-${mode}`, failure === 'invalid-marker' ? 'not-decimal' : '100');
    if (failure === 'marker-invariant-failed') {
      mutate(path, (db) => {
        insertTask(db, { id: 't' });
        insertStage(db, 1, { taskId: 't', stage: 'report', note: 'missing event', createdAt: 1 });
      });
    }
    const alias = join(fixtureRoot, `${failure}-${aliasKind}-${mode}-alias.db`);
    if (aliasKind === 'symlink') symlinkSync(path, alias);
    else linkSync(path, alias);
    const request =
      mode === 'bidirectional'
        ? bidirectional(path, alias)
        : ({ mode, sourcePath: alias, destinationPath: path } as const);

    const plan = planDatabaseReconciliation(request);

    expect(plan.status).toBe('conflict');
    expect(plan.sameDatabase).toBe(true);
    expect(plan.report.status).toBe('conflict');
    expect(plan.conflicts).toHaveLength(2);
    expect(plan.conflicts.every((conflict) => conflict.reason === failure)).toBe(true);
    expect(plan.targets.every((item) => !Object.values(item.changes).some((rows) => rows.length > 0))).toBe(true);
  });

  test('hardlink aliases with a committed path-specific WAL are rejected independent of order and mode', () => {
    const path = currentDb('wal-alias');
    const alias = join(fixtureRoot, 'wal-hardlink.db');
    linkSync(path, alias);
    const writer = new Database(path);
    try {
      writer.exec('PRAGMA journal_mode = WAL');
      writer.exec('PRAGMA wal_autocheckpoint = 0');
      writer.exec('BEGIN IMMEDIATE');
      insertBoard(writer, { id: 'wal-only', name: 'committed in WAL' });
      writer.exec('COMMIT');
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(existsSync(`${path}-shm`)).toBe(true);

      const bidirectionalForward = dryRunDatabaseReconciliation(bidirectional(path, alias));
      const bidirectionalReverse = dryRunDatabaseReconciliation(bidirectional(alias, path));
      const directionalForward = dryRunDatabaseReconciliation({
        mode: 'directional',
        sourcePath: path,
        destinationPath: alias,
      });
      const directionalReverse = dryRunDatabaseReconciliation({
        mode: 'directional',
        sourcePath: alias,
        destinationPath: path,
      });

      expect(bidirectionalForward).toEqual(bidirectionalReverse);
      expect(directionalForward).toEqual(directionalReverse);
      for (const report of [bidirectionalForward, directionalForward]) {
        expect(report.status).toBe('operational-failure');
        expect(report.operationalFailure?.code).toBe('invalid-data');
        expect(report.targets).toEqual([]);
      }
    } finally {
      writer.close();
    }
  });

  test('equal logical images are idempotent despite local history IDs', () => {
    const left = currentDb('left');
    const right = currentDb('right');
    for (const [path, id] of [
      [left, 1],
      [right, 99],
    ] as const) {
      mutate(path, (db) => {
        insertTask(db, { id: 't' });
        insertStage(db, id, { taskId: 't', stage: 'report', note: 'same', createdAt: 1 });
        insertEvent(db, id, { taskId: 't', kind: 'report', note: 'same', createdAt: 1 });
      });
    }

    const first = planDatabaseReconciliation(bidirectional(left, right));
    const second = planDatabaseReconciliation(bidirectional(left, right));

    expect(first.status).toBe('no-op');
    expect(first.report).toEqual(second.report);
    expect(first.inputs[0].logicalDigest).toBe(first.inputs[1].logicalDigest);
  });

  test('corrupt inputs and invalid row types fail with bounded deterministic reports', () => {
    const peer = currentDb('peer');
    const corrupt = pathFor('corrupt');
    writeFileSync(corrupt, new Uint8Array([0, 1, 2, 3, 4, 5]));

    const first = dryRunDatabaseReconciliation(bidirectional(corrupt, peer));
    const second = dryRunDatabaseReconciliation(bidirectional(corrupt, peer));
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: 'operational-failure',
      operationalFailure: { code: 'malformed-database' },
      targets: [],
    });

    const invalid = currentDb('invalid-row');
    mutate(invalid, (db) => {
      insertTask(db, { id: 't' });
      db.exec("UPDATE tasks SET title = X'0102' WHERE id = 't'");
    });
    const invalidReport = dryRunDatabaseReconciliation(bidirectional(invalid, peer));
    expect(invalidReport.operationalFailure?.code).toBe('invalid-data');
  });

  test('foreign-key-invalid content fails integrity validation before planning', () => {
    const invalid = currentDb('invalid-fk');
    const peer = currentDb('peer');
    const db = new Database(invalid);
    db.exec('PRAGMA foreign_keys = OFF');
    insertTask(db, { id: 'orphan', boardId: 'missing-board' });
    db.close();

    const report = dryRunDatabaseReconciliation(bidirectional(invalid, peer));

    expect(report.status).toBe('operational-failure');
    expect(report.operationalFailure?.code).toBe('integrity-failed');
    expect(report.targets).toEqual([]);
  });

  test('planner throws a typed bounded error while dry-run reduces it to a safe report', () => {
    const missing = join(fixtureRoot, 'missing.db');
    const peer = currentDb('peer');
    expect(() => planDatabaseReconciliation(bidirectional(missing, peer))).toThrow(ReconciliationError);
    const report = dryRunDatabaseReconciliation(bidirectional(missing, peer));
    expect(report.operationalFailure).toEqual({ code: 'input-unavailable' });
    expect(JSON.stringify(report)).not.toContain(missing);
  });

  test('WAL-backed bytes and row counts are bounded before logical row materialization', () => {
    const peer = currentDb('peer');
    const walHeavy = currentDb('wal-heavy');
    writeFileSync(`${walHeavy}-wal`, '');
    truncateSync(`${walHeavy}-wal`, 256 * 1024 * 1024 + 1);
    expect(dryRunDatabaseReconciliation(bidirectional(walHeavy, peer)).operationalFailure?.code).toBe(
      'input-too-large',
    );

    const rowHeavy = currentDb('row-heavy');
    mutate(rowHeavy, (db) => {
      db.exec("INSERT INTO boards (id, name, created_at) VALUES ('bad', X'01', 1)");
      db.exec(`
        WITH RECURSIVE seq(value) AS (
          VALUES(0)
          UNION ALL
          SELECT value + 1 FROM seq WHERE value < 1000000
        )
        INSERT INTO meta (key, value)
        SELECT printf('key-%07d', value), 'v' FROM seq
      `);
    });
    expect(() => planDatabaseReconciliation(bidirectional(rowHeavy, peer))).toThrow(
      expect.objectContaining({
        code: 'invalid-data',
        message: expect.stringContaining('row-count'),
      }),
    );
  }, 30_000);

  test('conflict diagnostics have a bounded cardinality', () => {
    const left = currentDb('many-left');
    const right = currentDb('many-right');
    for (const [path, prefix] of [
      [left, 'left'],
      [right, 'right'],
    ] as const) {
      mutate(path, (db) => {
        db.exec(`
          WITH RECURSIVE seq(value) AS (
            VALUES(0)
            UNION ALL
            SELECT value + 1 FROM seq WHERE value < 10000
          )
          INSERT INTO boards (id, name, created_at)
          SELECT printf('id-%05d', value), '${prefix}-' || value, 1 FROM seq
        `);
      });
    }

    expect(() => planDatabaseReconciliation(bidirectional(left, right))).toThrow(
      expect.objectContaining({
        code: 'invalid-data',
        message: expect.stringContaining('diagnostic'),
      }),
    );
  });
});

describe('canonical locking and transactional apply', () => {
  test('applies every logical table through live handles and repeats as a no-op', () => {
    const { left, right } = seedBidirectionalApplyPair();
    const beforeInodes = [statSync(left).ino, statSync(right).ino];
    const plan = planDatabaseReconciliation(bidirectional(left, right));

    const report = applyDatabaseReconciliation(plan);

    expect(report).toMatchObject({ status: 'changed', converged: true, failure: null });
    expect(report.targets.every((item) => item.observation === 'expected-postimage')).toBe(true);
    for (const path of [left, right]) {
      expect(scalarCount(path, 'boards')).toBe(2);
      expect(scalarCount(path, 'tasks')).toBe(4);
      expect(scalarCount(path, 'wish_groups')).toBe(2);
      expect(scalarCount(path, 'hire_roster')).toBe(2);
      expect(scalarCount(path, 'meta')).toBe(2);
      expect(scalarCount(path, 'task_dependencies')).toBe(2);
      expect(scalarCount(path, 'stage_log')).toBe(2);
      expect(scalarCount(path, 'task_events')).toBe(2);
    }
    expect([statSync(left).ino, statSync(right).ino]).toEqual(beforeInodes);

    const repeatedPlan = planDatabaseReconciliation(bidirectional(right, left));
    const repeated = applyDatabaseReconciliation(repeatedPlan);
    expect(repeated).toMatchObject({ status: 'no-op', converged: true, failure: null });
  });

  test('directional apply keeps the locked source unchanged and preserves destination-only rows', () => {
    const source = currentDb('directional-source', null);
    const destination = currentDb('directional-destination', null);
    mutate(source, (db) => {
      insertTask(db, { id: 'shared', title: 'source authority' });
      insertTask(db, { id: 'source-only' });
    });
    mutate(destination, (db) => {
      insertTask(db, { id: 'shared', title: 'destination old' });
      insertTask(db, { id: 'destination-only' });
    });
    const plan = planDatabaseReconciliation(directional(source, destination));
    const sourcePreimage = plan.inputs.find((input) => input.role === 'source')?.logicalDigest;

    const report = applyDatabaseReconciliation(plan);
    const after = planDatabaseReconciliation(directional(source, destination));

    expect(report).toMatchObject({ status: 'changed', converged: true, failure: null });
    expect(after.inputs.find((input) => input.role === 'source')?.logicalDigest).toBe(sourcePreimage);
    expect(taskTitle(source, 'shared')).toBe('source authority');
    expect(taskTitle(source, 'destination-only')).toBeNull();
    expect(taskTitle(destination, 'shared')).toBe('source authority');
    expect(taskTitle(destination, 'source-only')).toBe('source-only');
    expect(taskTitle(destination, 'destination-only')).toBe('destination-only');
  });

  test('an older write after planning is preserved and aborts locked preimage revalidation', () => {
    const source = currentDb('source', null);
    const destination = currentDb('destination', null);
    mutate(source, (db) => db.query("INSERT INTO meta (key, value) VALUES ('planned', 'source')").run());
    const plan = planDatabaseReconciliation(directional(source, destination));
    mutate(destination, (db) => db.query("INSERT INTO meta (key, value) VALUES ('older', 'writer')").run());

    const report = applyDatabaseReconciliation(plan);

    expect(report).toMatchObject({
      status: 'preimage-changed',
      converged: false,
      failure: { code: 'input-changed', phase: 'revalidation' },
    });
    expect(metaValue(destination, 'older')).toBe('writer');
    expect(metaValue(destination, 'planned')).toBeNull();
  });

  test('a schema change after planning is rejected under locks before a guest trigger can execute', () => {
    const source = currentDb('source', null);
    const destination = currentDb('destination', null);
    mutate(source, (db) => db.query("INSERT INTO meta (key, value) VALUES ('planned', 'source')").run());
    const plan = planDatabaseReconciliation(directional(source, destination));
    mutate(destination, (db) => {
      db.exec(`
        CREATE TRIGGER intervening_trigger AFTER INSERT ON meta
        BEGIN
          INSERT INTO meta (key, value) VALUES ('trigger-fired', 'yes');
        END
      `);
    });

    const report = applyDatabaseReconciliation(plan);

    expect(report).toMatchObject({
      status: 'preimage-changed',
      converged: false,
      failure: { code: 'unsupported-schema', phase: 'revalidation', role: 'destination' },
    });
    expect(metaValue(destination, 'planned')).toBeNull();
    expect(metaValue(destination, 'trigger-fired')).toBeNull();
  });

  test('an opened SQLite handle fails closed across an A-to-B-open/B-to-A pathname restore', () => {
    const source = currentDb('aba-source', null);
    const destination = currentDb('aba-destination', null);
    mutate(source, (db) => db.query("INSERT INTO meta (key, value) VALUES ('planned', 'source')").run());
    const plan = planDatabaseReconciliation(directional(source, destination));
    let injected = false;

    const report = applyDatabaseReconciliation(plan, {
      openDatabase: (path, options) => {
        if (injected) return new Database(path, options);
        injected = true;
        const other = path === source ? destination : source;
        const saved = `${path}.saved`;
        renameSync(path, saved);
        renameSync(other, path);
        const opened = new Database(path, options);
        renameSync(path, other);
        renameSync(saved, path);
        return opened;
      },
    });

    expect(report).toMatchObject({
      status: 'preimage-changed',
      converged: false,
      failure: { code: 'input-changed', phase: 'revalidation' },
    });
    expect(metaValue(destination, 'planned')).toBeNull();
  });

  test('locked serialization rechecks the exact opened handle before reading bytes', () => {
    const source = currentDb('serialize-source', null);
    const destination = currentDb('serialize-destination', null);
    mutate(source, (db) => insertTask(db, { id: 'planned' }));
    const plan = planDatabaseReconciliation(directional(source, destination));

    const report = applyDatabaseReconciliation(plan, {
      onLocked: (inputs) => {
        const destinationInput = inputs.find((input) => input.role === 'destination');
        if (destinationInput === undefined) throw new Error('missing destination');
        const saved = `${destination}.saved`;
        renameSync(destination, saved);
        renameSync(source, destination);
        try {
          destinationInput.serialize();
        } finally {
          renameSync(destination, source);
          renameSync(saved, destination);
        }
      },
    });

    expect(report).toMatchObject({
      status: 'preimage-changed',
      failure: { code: 'input-changed', phase: 'revalidation', role: 'destination' },
    });
    expect(taskTitle(destination, 'planned')).toBeNull();
  });

  test('SQLite contention is bounded and rolls back earlier canonical locks without mutation', () => {
    const { left, right } = seedBidirectionalApplyPair();
    const plan = planDatabaseReconciliation(bidirectional(right, left));
    const heldPath = [left, right].sort()[0];
    const holder = new Database(heldPath);
    holder.exec('BEGIN IMMEDIATE');
    const startedAt = Date.now();
    try {
      const report = applyDatabaseReconciliation(plan, { busyTimeoutMs: 25 });
      expect(report).toMatchObject({
        status: 'lock-timeout',
        converged: false,
        failure: { code: 'sqlite-lock-timeout', phase: 'sqlite-lock' },
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(scalarCount(left, 'boards')).toBe(1);
      expect(scalarCount(right, 'boards')).toBe(1);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  test('reversed arguments stop on the first canonical advisory descriptor lock without taking the second', async () => {
    const { left, right } = seedBidirectionalApplyPair();
    const plan = planDatabaseReconciliation(bidirectional(right, left));
    const [first, second] = [left, right].sort();
    const firstLock = `${first}.genie-reconciliation.lock`;
    const secondLock = `${second}.genie-reconciliation.lock`;
    const holder = await spawnFlockHolder(firstLock, 250);
    const report = applyDatabaseReconciliation(plan, { busyTimeoutMs: 20 });
    expect(report).toMatchObject({
      status: 'lock-timeout',
      failure: { code: 'advisory-lock-timeout', phase: 'advisory-lock' },
    });
    expect(existsSync(secondLock)).toBe(false);
    expect(await holder.exited).toBe(0);
  });

  test('second advisory-lock contention releases the first lock and a retry succeeds', async () => {
    const { left, right } = seedBidirectionalApplyPair();
    const plan = planDatabaseReconciliation(bidirectional(right, left));
    const [, second] = [left, right].sort();
    const holder = await spawnFlockHolder(`${second}.genie-reconciliation.lock`, 250);

    const blocked = applyDatabaseReconciliation(plan, { busyTimeoutMs: 20 });
    expect(blocked).toMatchObject({
      status: 'lock-timeout',
      failure: { code: 'advisory-lock-timeout', phase: 'advisory-lock' },
      cleanupFailures: [],
    });
    expect(await holder.exited).toBe(0);

    const retried = applyDatabaseReconciliation(plan, { busyTimeoutMs: 500 });
    expect(retried).toMatchObject({ status: 'changed', converged: true, failure: null, cleanupFailures: [] });
  });

  test('an advisory writer that finishes during the shared wait bound is followed safely', async () => {
    const { left, right } = seedBidirectionalApplyPair();
    const plan = planDatabaseReconciliation(bidirectional(left, right));
    const [first] = [left, right].sort();
    const holder = await spawnFlockHolder(`${first}.genie-reconciliation.lock`, 75);

    const report = applyDatabaseReconciliation(plan, { busyTimeoutMs: 1_000 });

    expect(await holder.exited).toBe(0);
    expect(report).toMatchObject({ status: 'changed', converged: true, failure: null, cleanupFailures: [] });
  });

  test('advisory inputs are no-follow, regular, empty, and bounded without parsing owner data', () => {
    const cases: Array<{ name: string; prepare(path: string): void }> = [
      {
        name: 'symlink',
        prepare(path) {
          const target = `${path}.target`;
          writeFileSync(target, '');
          symlinkSync(target, path);
        },
      },
      {
        name: 'directory',
        prepare(path) {
          mkdirSync(path);
        },
      },
      {
        name: 'fifo',
        prepare(path) {
          const made = Bun.spawnSync({ cmd: ['mkfifo', path], stderr: 'pipe', stdout: 'pipe' });
          expect(made.exitCode).toBe(0);
        },
      },
      {
        name: 'malformed',
        prepare(path) {
          writeFileSync(path, '{not-json');
        },
      },
      {
        name: 'oversized',
        prepare(path) {
          writeFileSync(path, new Uint8Array(1024 * 1024));
        },
      },
    ];

    for (const fixture of cases) {
      const left = currentDb(`${fixture.name}-left`, null);
      const right = currentDb(`${fixture.name}-right`, null);
      mutate(left, (db) => insertTask(db, { id: fixture.name }));
      const plan = planDatabaseReconciliation(bidirectional(left, right));
      const [first] = [left, right].sort();
      const lockPath = `${first}.genie-reconciliation.lock`;
      fixture.prepare(lockPath);
      const started = Date.now();

      const report = applyDatabaseReconciliation(plan, { busyTimeoutMs: 20 });

      expect(report).toMatchObject({
        status: 'uncertain',
        failure: { code: 'unexpected-failure', phase: 'advisory-lock' },
      });
      expect(Date.now() - started).toBeLessThan(500);
      rmSync(lockPath, { recursive: true, force: true });
    }
  });

  test('release never removes a replacement advisory pathname', () => {
    const { left, right } = seedBidirectionalApplyPair();
    const replacements: string[] = [];
    const report = applyDatabaseReconciliation(planDatabaseReconciliation(bidirectional(left, right)), {
      onLocked: (inputs) => {
        for (const path of new Set(inputs.map((input) => `${input.canonicalPath}.genie-reconciliation.lock`))) {
          renameSync(path, `${path}.held-inode`);
          writeFileSync(path, '');
          replacements.push(path);
        }
      },
    });

    expect(report).toMatchObject({ status: 'changed', converged: true, cleanupFailures: [] });
    expect(replacements.every((path) => existsSync(path))).toBe(true);
  });

  test('opposite-order lock-aware reconcilers serialize without deadlock or overwrite', async () => {
    const { left, right } = seedBidirectionalApplyPair();
    const moduleUrl = new URL('./db-reconciliation.ts', import.meta.url).href;
    const go = join(fixtureRoot, 'concurrent-go');
    const readyA = join(fixtureRoot, 'concurrent-ready-a');
    const readyB = join(fixtureRoot, 'concurrent-ready-b');
    const childCode = `
        import { existsSync, writeFileSync } from 'node:fs';
        const api = await import(Bun.argv[1]);
        const request = Bun.argv[6] === 'reverse'
          ? { mode: 'bidirectional', leftPath: Bun.argv[3], rightPath: Bun.argv[2] }
          : { mode: 'bidirectional', leftPath: Bun.argv[2], rightPath: Bun.argv[3] };
        const plan = api.planDatabaseReconciliation(request);
        writeFileSync(Bun.argv[4], 'ready');
        while (!existsSync(Bun.argv[5])) await Bun.sleep(5);
        const report = api.applyDatabaseReconciliation(plan, { busyTimeoutMs: 1_000 });
        process.stdout.write(JSON.stringify({ status: report.status, converged: report.converged }));
      `;
    const spawn = (ready: string, order: 'forward' | 'reverse') =>
      Bun.spawn({
        cmd: [process.execPath, '-e', childCode, moduleUrl, left, right, ready, go, order],
        stderr: 'pipe',
        stdout: 'pipe',
      });
    const childA = spawn(readyA, 'forward');
    const childB = spawn(readyB, 'reverse');
    for (let attempt = 0; attempt < 400 && (!existsSync(readyA) || !existsSync(readyB)); attempt++) {
      await Bun.sleep(5);
    }
    expect(existsSync(readyA)).toBe(true);
    expect(existsSync(readyB)).toBe(true);
    writeFileSync(go, 'go');

    const [exitA, exitB, stdoutA, stdoutB] = await Promise.all([
      childA.exited,
      childB.exited,
      new Response(childA.stdout).text(),
      new Response(childB.stdout).text(),
    ]);
    expect([exitA, exitB]).toEqual([0, 0]);
    const statuses = [JSON.parse(stdoutA).status, JSON.parse(stdoutB).status].sort();
    expect(statuses).toEqual(['changed', 'preimage-changed']);
    expect(planDatabaseReconciliation(bidirectional(left, right)).status).toBe('no-op');
  }, 5_000);

  test('an older writer racing held SQLite locks receives bounded busy and cannot be overwritten', () => {
    const source = currentDb('source', null);
    const destination = currentDb('destination', null);
    mutate(source, (db) => db.query("INSERT INTO meta (key, value) VALUES ('planned', 'source')").run());
    const plan = planDatabaseReconciliation(directional(source, destination));
    const olderExitCodes: number[] = [];

    const report = applyDatabaseReconciliation(plan, {
      busyTimeoutMs: 100,
      onLocked: () => {
        for (const path of [source, destination]) {
          const child = Bun.spawnSync({
            cmd: [
              process.execPath,
              '-e',
              `import { Database } from 'bun:sqlite';
               const db = new Database(Bun.argv[1], { readwrite: true, create: false });
               db.exec('PRAGMA busy_timeout = 25');
               try {
                 db.exec('BEGIN IMMEDIATE');
                 db.query("INSERT INTO meta (key, value) VALUES ('older', 'writer')").run();
                 db.exec('COMMIT');
                 process.exit(0);
               } catch {
                 process.exit(7);
               } finally {
                 db.close();
               }`,
              path,
            ],
            stderr: 'pipe',
            stdout: 'pipe',
          });
          olderExitCodes.push(child.exitCode);
        }
      },
    });

    expect(olderExitCodes).toEqual([7, 7]);
    expect(report).toMatchObject({ status: 'changed', converged: true });
    expect(metaValue(destination, 'planned')).toBe('source');
    expect(metaValue(destination, 'older')).toBeNull();
  });

  test('foreign-key, integrity, and logical postimage checks all finish before commit', () => {
    const source = currentDb('source', null);
    const destination = currentDb('destination', null);
    mutate(source, (db) => {
      insertTask(db, { id: 'source-task' });
      insertEvent(db, 1, { taskId: 'source-task', kind: 'report', note: 'ready', createdAt: 1 });
    });
    const events: string[] = [];

    const report = applyDatabaseReconciliation(planDatabaseReconciliation(directional(source, destination)), {
      onEvent: (event: ReconciliationApplyEvent) => {
        if ('role' in event && event.role === 'destination') {
          events.push(`${event.phase}:${event.state}`);
        }
      },
    });

    expect(report.status).toBe('changed');
    expect(events).toEqual([
      'mutation:before',
      'mutation:after',
      'foreign-key-check:before',
      'foreign-key-check:after',
      'integrity-check:before',
      'integrity-check:after',
      'logical-postimage-check:before',
      'logical-postimage-check:after',
      'commit:before',
      'commit:after',
    ]);
  });

  test('a precommit failure rolls both live transactions back to their planned preimages', () => {
    const { left, right } = seedBidirectionalApplyPair();
    const plan = planDatabaseReconciliation(bidirectional(left, right));

    const report = applyDatabaseReconciliation(plan, {
      onEvent: (event) => {
        if (event.phase === 'commit' && event.state === 'before') throw new Error('injected before commit');
      },
    });

    expect(report).toMatchObject({ status: 'rolled-back', converged: false });
    expect(report.targets.every((item) => item.observation === 'expected-preimage')).toBe(true);
    expect(report.targets.every((item) => item.committed === false)).toBe(true);
    expect(scalarCount(left, 'boards')).toBe(1);
    expect(scalarCount(right, 'boards')).toBe(1);
  });

  test('a precommit failure with one no-op target is rolled back with zero commits', () => {
    const left = currentDb('a-no-op-target', null);
    const right = currentDb('z-changing-target', null);
    mutate(left, (db) => insertTask(db, { id: 'left-only' }));
    const plan = planDatabaseReconciliation(bidirectional(left, right));
    expect(plan.targets.filter((target) => target.preimageDigest === target.postimageDigest)).toHaveLength(1);

    const report = applyDatabaseReconciliation(plan, {
      onEvent: (event) => {
        if (event.phase === 'commit' && event.state === 'before') throw new Error('before first commit');
      },
    });

    expect(report).toMatchObject({ status: 'rolled-back', converged: false });
    expect(report.targets.every((target) => !target.committed)).toBe(true);
    expect(report.targets.map((target) => target.observation).sort()).toEqual([
      'expected-pre-and-postimage',
      'expected-preimage',
    ]);
    expect(taskTitle(left, 'left-only')).toBe('left-only');
    expect(taskTitle(right, 'left-only')).toBeNull();
  });

  test('the first-commit boundary records a committed no-op target without claiming rollback', () => {
    const left = currentDb('a-no-op-target', null);
    const right = currentDb('z-changing-target', null);
    mutate(left, (db) => insertTask(db, { id: 'left-only' }));
    const plan = planDatabaseReconciliation(bidirectional(left, right));
    let commits = 0;

    const report = applyDatabaseReconciliation(plan, {
      onEvent: (event) => {
        if (event.phase === 'commit' && event.state === 'after' && ++commits === 1) {
          throw new Error('after first commit');
        }
      },
    });

    expect(report).toMatchObject({ status: 'partial-commit', converged: false });
    expect(report.targets.filter((target) => target.committed)).toHaveLength(1);
    expect(report.targets.find((target) => target.committed)?.observation).toBe('expected-pre-and-postimage');
    expect(taskTitle(right, 'left-only')).toBeNull();
  });

  test('a failure after the first destination commit reports a known partial commit', () => {
    const { left, right } = seedBidirectionalApplyPair();
    const plan = planDatabaseReconciliation(bidirectional(left, right));
    let completedCommits = 0;

    const report = applyDatabaseReconciliation(plan, {
      onEvent: (event) => {
        if (event.phase === 'commit' && event.state === 'after' && ++completedCommits === 1) {
          throw new Error('injected after first commit');
        }
      },
    });

    expect(report).toMatchObject({ status: 'partial-commit', converged: false });
    expect(report.targets.filter((item) => item.observation === 'expected-postimage')).toHaveLength(1);
    expect(report.targets.filter((item) => item.observation === 'expected-preimage')).toHaveLength(1);
    expect(report.targets.filter((item) => item.committed)).toHaveLength(1);
  });

  test('an error after all commits reports expected postimages without claiming convergence', () => {
    const { left, right } = seedBidirectionalApplyPair();
    const plan = planDatabaseReconciliation(bidirectional(left, right));
    let completedCommits = 0;

    const report = applyDatabaseReconciliation(plan, {
      onEvent: (event) => {
        if (event.phase === 'commit' && event.state === 'after' && ++completedCommits === 2) {
          throw new Error('injected after second commit');
        }
      },
    });

    expect(report).toMatchObject({ status: 'expected-postimage', converged: false });
    expect(report.targets.every((item) => item.observation === 'expected-postimage')).toBe(true);
    expect(planDatabaseReconciliation(bidirectional(left, right)).status).toBe('no-op');
  });

  test('an older write after one commit is reported as unexpected and is never overwritten', () => {
    const { left, right } = seedBidirectionalApplyPair();
    const plan = planDatabaseReconciliation(bidirectional(left, right));
    const paths = { left, right };
    let injected = false;

    const report = applyDatabaseReconciliation(plan, {
      onEvent: (event) => {
        if (event.phase !== 'commit' || event.state !== 'after' || injected) return;
        injected = true;
        mutate(paths[event.role as 'left' | 'right'], (db) => {
          db.query("INSERT INTO meta (key, value) VALUES ('intervening', 'older-writer')").run();
        });
        throw new Error('stop after intervening write');
      },
    });

    expect(report).toMatchObject({ status: 'unexpected-intervening-write', converged: false });
    const unexpected = report.targets.find((item) => item.observation === 'unexpected');
    expect(unexpected).toBeDefined();
    expect(metaValue(paths[unexpected?.role as 'left' | 'right'], 'intervening')).toBe('older-writer');
  });

  test('an unclassifiable postcommit schema intervention is reported as uncertain', () => {
    const { left, right } = seedBidirectionalApplyPair();
    const plan = planDatabaseReconciliation(bidirectional(left, right));
    const paths = { left, right };
    let injected = false;

    const report = applyDatabaseReconciliation(plan, {
      onEvent: (event) => {
        if (event.phase !== 'commit' || event.state !== 'after' || injected) return;
        injected = true;
        mutate(paths[event.role as 'left' | 'right'], (db) => {
          db.exec('CREATE TABLE intervening_schema (id TEXT PRIMARY KEY)');
        });
        throw new Error('stop after unclassifiable intervention');
      },
    });

    expect(report).toMatchObject({ status: 'uncertain', converged: false });
    expect(report.targets.some((item) => item.observation === 'not-observed')).toBe(true);
  });

  test('a primary apply failure is preserved alongside rollback, close, and advisory cleanup failures', () => {
    const source = currentDb('cleanup-source', null);
    const destination = currentDb('cleanup-destination', null);
    mutate(source, (db) => insertTask(db, { id: 'planned' }));

    const report = applyDatabaseReconciliation(planDatabaseReconciliation(directional(source, destination)), {
      openDatabase: (path, options) => {
        const db = new Database(path, options);
        return new Proxy(db, {
          get(target, property) {
            if (property === 'exec') {
              return (sql: string) => {
                if (sql === 'ROLLBACK') throw new Error('injected rollback cleanup failure');
                return target.exec(sql);
              };
            }
            if (property === 'close') {
              return () => {
                target.close();
                throw new Error('injected close cleanup failure');
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      advisoryUnlock: () => -1,
      onEvent: (event) => {
        if (event.phase === 'commit' && event.state === 'before') throw new Error('primary commit failure');
      },
    });

    expect(report).toMatchObject({
      status: 'rolled-back',
      failure: { code: 'commit-failed', phase: 'commit' },
      cleanupFailures: [
        { code: 'rollback-failed', phase: 'rollback' },
        { code: 'close-failed', phase: 'cleanup' },
        { code: 'advisory-lock-release-failed', phase: 'cleanup' },
      ],
    });
    expect(taskTitle(destination, 'planned')).toBeNull();
  });

  test('directional board-name swaps use a transaction-local parking order', () => {
    const source = currentDb('swap-source', null);
    const destination = currentDb('swap-destination', null);
    mutate(source, (db) => {
      insertBoard(db, { id: 'a', name: 'A' });
      insertBoard(db, { id: 'b', name: 'B' });
    });
    mutate(destination, (db) => {
      insertBoard(db, { id: 'a', name: 'B' });
      insertBoard(db, { id: 'b', name: 'A' });
    });

    const report = applyDatabaseReconciliation(planDatabaseReconciliation(directional(source, destination)));

    expect(report).toMatchObject({ status: 'changed', converged: true });
    const db = new Database(destination, { readonly: true });
    expect(db.query('SELECT id, name FROM boards ORDER BY id').all()).toEqual([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]);
    db.close();
  });
});
