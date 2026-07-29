import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDb, resolveDbPath } from '../lib/v5/genie-db.js';
import { createTask, getTask, hireAgent, listHires, listTasks, unhireAgent } from '../lib/v5/task-state.js';
import { DATABASE_SYNC_EXIT_CODES } from './v5-db-sync.js';

const GENIE = join(import.meta.dir, '..', 'genie.ts');

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface JsonReport {
  reportVersion: number;
  operation: string;
  mode: string;
  status: string;
  inputs: Array<{ role: string; databaseIdentity: string; logicalDigest: string | null }>;
  plan: {
    status: string;
    schemaFingerprint: string | null;
    targets: Array<{ role: string; changes: Record<string, number> }>;
    conflicts: { total: number; byTable: Record<string, number> };
    operationalFailure: { code: string; guidance?: string } | null;
  } | null;
  apply: {
    generationId: string | null;
    recovery: { status: string };
    cleanupFailures: string[];
  } | null;
  rollback: {
    selectedGenerationId: string;
    safetyGenerationId: string | null;
    cleanupFailures: string[];
  } | null;
}

let root: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function createRepo(name: string, current = true): { repo: string; database: string } {
  const repo = join(root, name);
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'commit', '--allow-empty', '-m', 'init');
  const database = resolveDbPath(repo);
  if (current) {
    const db = openDb({ cwd: repo });
    db.close();
  }
  return { repo, database };
}

async function cli(cwd: string, ...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, GENIE, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      NO_COLOR: '1',
      GENIE_TEST_SKIP_PGSERVE: '1',
    },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, code: await proc.exited };
}

async function sync(...args: string[]): Promise<CliResult> {
  return cli(root, 'db', 'sync', ...args);
}

function parseJson(result: CliResult): JsonReport {
  return JSON.parse(result.stdout) as JsonReport;
}

function insertTask(path: string, id: string, title: string): void {
  const db = openDb({ path });
  db.query('INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    title,
    'ready',
    1,
    1,
  );
  db.close();
}

function taskTitles(path: string): string[] {
  const db = openDb({ path });
  try {
    return listTasks(db)
      .map((task) => task.title)
      .sort();
  } finally {
    db.close();
  }
}

function logicalInventory(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    const tables = (
      db
        .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    return tables.map(
      (table) => `${table}:${JSON.stringify(db.query(`SELECT * FROM "${table}" ORDER BY rowid`).all())}`,
    );
  } finally {
    db.close();
  }
}

function sqliteFileInventory(path: string): Record<string, string | null> {
  return Object.fromEntries(
    ['', '-wal', '-shm'].map((suffix) => {
      const file = `${path}${suffix}`;
      return [
        suffix === '' ? 'database' : suffix.slice(1),
        existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null,
      ];
    }),
  );
}

function databaseInventory(path: string): { logical: string[]; files: Record<string, string | null> } {
  return { logical: logicalInventory(path), files: sqliteFileInventory(path) };
}

function rewriteGenerationState(snapshotRoot: string, generationId: string, state: string): void {
  const manifestPath = join(snapshotRoot, generationId, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.state = state;
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
}

async function syncWithInjectedReport(report: unknown, ...args: string[]): Promise<CliResult> {
  const harness = join(root, 'db-sync-runner.ts');
  const commandUrl = new URL('./v5-db-sync.ts', import.meta.url).href;
  writeFileSync(
    harness,
    [
      "import { Command } from 'commander';",
      `import { registerV5DatabaseSyncCommand } from ${JSON.stringify(commandUrl)};`,
      `const report = ${JSON.stringify(report)};`,
      "const program = new Command().name('genie');",
      'registerV5DatabaseSyncCommand(program, { execute: () => report });',
      "await program.parseAsync(['node', 'genie', 'db', 'sync', ...process.argv.slice(2)]);",
    ].join('\n'),
  );
  const proc = Bun.spawn([process.execPath, harness, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, code: await proc.exited };
}

/** Exact pre-lanes, pre-runtime user_version=1 shape accepted by normal current open. */
function seedPriorDatabase(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec('PRAGMA user_version = 1');
  db.exec(`
    CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      board_id TEXT REFERENCES boards(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('blocked','ready','in_progress','done')),
      claimed_by TEXT, claimed_at INTEGER, wish TEXT, group_name TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
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
    CREATE TABLE wish_groups (
      wish TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('blocked','ready','in_progress','done')),
      depends_on TEXT NOT NULL DEFAULT '[]', assignee TEXT,
      started_at INTEGER, completed_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (wish, name)
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.query('INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    't_prior',
    'prior task',
    'ready',
    1,
    1,
  );
  db.close();
}

function schemaInventory(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    const objects = (
      db
        .query("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
        .all() as Array<{ type: string; name: string }>
    ).map((row) => `${row.type}:${row.name}`);
    const tables = (
      db
        .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    const columns = tables.flatMap((table) =>
      (
        db.query(`PRAGMA table_info("${table}")`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }>
      )
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(
          (column) =>
            `${table}.${column.name}:${column.type}:${column.notnull}:${column.dflt_value ?? '-'}:${column.pk}`,
        ),
    );
    return [...objects, ...columns];
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-v5-db-sync-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('database sync CLI contract', () => {
  test('help publishes both explicit modes, recovery options, JSON, and exit codes', async () => {
    const result = await sync('--help');
    expect(result.code).toBe(DATABASE_SYNC_EXIT_CODES.success);
    expect(result.stderr).toBe('');
    for (const text of [
      '<database-a> <database-b>',
      '--source <database>',
      '--destination <database>',
      '--dry-run',
      '--rollback <generation>',
      '--snapshot-root <absolute-path>',
      '--keep-snapshots <count>',
      '--busy-timeout-ms <milliseconds>',
      '--json',
      '6 recovery handled',
    ]) {
      expect(result.stdout).toContain(text);
    }
  });

  test('ambiguous and invalid forms fail before database or snapshot mutation', async () => {
    const left = createRepo('left');
    const right = createRepo('right');
    insertTask(left.database, 't_left', 'left');
    const beforeLeft = databaseInventory(left.database);
    const beforeRight = databaseInventory(right.database);
    const snapshotRoot = join(root, 'snapshots');
    const otherSnapshotRoot = join(root, 'other-snapshots');
    const generationA = `${'a'.repeat(64)}--0000000000000001--00000000-0000-4000-8000-000000000001`;
    const generationB = `${'b'.repeat(64)}--0000000000000002--00000000-0000-4000-8000-000000000002`;
    const cases = [
      [left.database, '--snapshot-root', snapshotRoot],
      ['--source', left.database, '--snapshot-root', snapshotRoot],
      [
        left.database,
        right.database,
        '--source',
        left.database,
        '--destination',
        right.database,
        '--snapshot-root',
        snapshotRoot,
      ],
      [left.database, right.database, '--dry-run', '--keep-snapshots', '3'],
      [left.database, right.database, '--keep-snapshots', '-1', '--snapshot-root', snapshotRoot],
      [left.database, right.database, '--busy-timeout-ms', '2147483648', '--snapshot-root', snapshotRoot],
      [left.database, right.database, '--snapshot-root', 'relative'],
      [left.database, right.database, '--rollback', 'not-a-generation', '--snapshot-root', snapshotRoot],
      ['--source', left.database, '--source', right.database, '--destination', right.database],
      ['--source', left.database, '--destination', right.database, '--destination', left.database],
      [left.database, right.database, '--snapshot-root', snapshotRoot, '--snapshot-root', otherSnapshotRoot],
      [left.database, right.database, '--rollback', generationA, '--rollback', generationB],
      [left.database, right.database, '--keep-snapshots', '1', '--keep-snapshots', '2'],
      [left.database, right.database, '--busy-timeout-ms', '0', '--busy-timeout-ms', '1'],
      [left.database, right.database, '--dry-run', '--dry-run'],
      [left.database, right.database, '--json', '--json'],
    ];

    for (const [index, args] of cases.entries()) {
      const result = await sync(...args);
      expect(result.code).toBe(DATABASE_SYNC_EXIT_CODES.usage);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('genie db sync --help');
      if (index >= 8) expect(result.stderr).toContain('may be specified only once');
    }
    expect(databaseInventory(left.database)).toEqual(beforeLeft);
    expect(databaseInventory(right.database)).toEqual(beforeRight);
    expect(existsSync(snapshotRoot)).toBe(false);
    expect(existsSync(otherSnapshotRoot)).toBe(false);
  });

  test('Commander syntax errors retain parser exit 1', async () => {
    const result = await sync('--unknown-option');
    expect(result.code).toBe(DATABASE_SYNC_EXIT_CODES.parserError);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown option '--unknown-option'");
  });

  test('human output and same-database success remain stable and path-free', async () => {
    const database = createRepo('same').database;
    insertTask(database, 't_hostile', 'HOSTILE SAME-DATABASE TITLE');

    const result = await sync(database, database, '--dry-run');

    expect(result.code).toBe(DATABASE_SYNC_EXIT_CODES.success);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Database reconciliation dry-run: no-op');
    expect(result.stdout).toContain('Mode: bidirectional');
    expect(result.stdout).toContain('Plan: no-op; conflicts=0');
    expect(result.stdout).not.toContain(database);
    expect(result.stdout).not.toContain('HOSTILE SAME-DATABASE TITLE');
  });

  test('persistent recovery maps converged to exit 6 and hostile uncertain state to exit 5', async () => {
    const left = createRepo('recovery-left');
    const right = createRepo('recovery-right');
    insertTask(left.database, 't_left', 'left');
    insertTask(right.database, 't_right', 'right');
    const snapshotRoot = join(root, 'recovery-snapshots');

    const applied = await sync(left.database, right.database, '--snapshot-root', snapshotRoot, '--json');
    const generationId = parseJson(applied).apply?.generationId;
    if (generationId == null) throw new Error('Expected a durable generation.');
    rewriteGenerationState(snapshotRoot, generationId, 'complete');

    const converged = await sync(left.database, right.database, '--snapshot-root', snapshotRoot, '--json');
    expect(converged.code).toBe(DATABASE_SYNC_EXIT_CODES.recoveryHandled);
    expect(parseJson(converged).status).toBe('converged');

    rewriteGenerationState(snapshotRoot, generationId, 'complete');
    insertTask(left.database, 't_hostile', 'HOSTILE RECOVERY CONTENT\nMUST NOT LEAK');
    const beforeLeft = databaseInventory(left.database);
    const beforeRight = databaseInventory(right.database);

    const uncertain = await sync(left.database, right.database, '--snapshot-root', snapshotRoot, '--json');
    expect(uncertain.code).toBe(DATABASE_SYNC_EXIT_CODES.uncertain);
    expect(uncertain.stderr).toBe('');
    expect(uncertain.stdout).not.toContain('HOSTILE RECOVERY CONTENT');
    expect(uncertain.stdout.length).toBeLessThan(8_000);
    expect(parseJson(uncertain).status).toBe('uncertain');
    expect(databaseInventory(left.database)).toEqual(beforeLeft);
    expect(databaseInventory(right.database)).toEqual(beforeRight);
  });

  test('cleanup failures map an otherwise successful subprocess report to exit 4', async () => {
    const report = {
      reportVersion: 1,
      command: 'database-sync',
      operation: 'apply',
      mode: 'bidirectional',
      status: 'changed',
      inputs: [],
      plan: null,
      apply: {
        status: 'changed',
        generationId: null,
        recovery: {
          status: 'none',
          generationId: null,
          restoredDatabaseIdentities: [],
          failure: null,
          cleanupFailures: [],
        },
        apply: null,
        failure: null,
        cleanupFailures: ['snapshot-cleanup-failed'],
      },
      rollback: null,
    };

    const result = await syncWithInjectedReport(report, '/unused/left.db', '/unused/right.db');

    expect(result.code).toBe(DATABASE_SYNC_EXIT_CODES.operationalFailure);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Database reconciliation apply: changed');
    expect(result.stdout).toContain('Cleanup failures: 1');
  });

  test('directional dry-run reports bounded identities and counts without row content or writes', async () => {
    const source = createRepo('source');
    const destination = createRepo('destination');
    const sourceDb = openDb({ path: source.database });
    createTask(sourceDb, { title: 'HOSTILE ROW CONTENT\nSHOULD NOT LEAK' });
    sourceDb.close();
    const beforeSource = readFileSync(source.database);
    const beforeDestination = readFileSync(destination.database);

    const result = await sync(
      '--source',
      source.database,
      '--destination',
      destination.database,
      '--dry-run',
      '--json',
    );
    expect(result.code).toBe(DATABASE_SYNC_EXIT_CODES.success);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('HOSTILE ROW CONTENT');
    const report = parseJson(result);
    expect(report).toMatchObject({
      reportVersion: 1,
      operation: 'dry-run',
      mode: 'directional',
      status: 'changed',
    });
    expect(report.inputs.map((input) => input.role)).toEqual(['source', 'destination']);
    expect(report.inputs.every((input) => /^[a-f0-9]{64}$/.test(input.databaseIdentity))).toBe(true);
    expect(report.plan?.targets[0].changes.tasks).toBe(1);
    expect(readFileSync(source.database)).toEqual(beforeSource);
    expect(readFileSync(destination.database)).toEqual(beforeDestination);
    expect(existsSync(join(destination.repo, '.genie', 'sync-snapshots'))).toBe(false);
  });

  test('operational reports omit hostile input paths and remain bounded', async () => {
    const destination = createRepo('operational-destination');
    const hostile = join(root, 'HOSTILE PATH\nMUST NOT LEAK.db');

    const result = await sync('--source', hostile, '--destination', destination.database, '--dry-run', '--json');

    expect(result.code).toBe(DATABASE_SYNC_EXIT_CODES.operationalFailure);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('HOSTILE PATH');
    expect(result.stdout).not.toContain(hostile);
    expect(result.stdout.length).toBeLessThan(8_000);
    expect(parseJson(result).plan?.operationalFailure?.code).toBe('input-unavailable');
  });

  test('bidirectional apply converges disjoint additions, never deletes, and reports a durable generation', async () => {
    const left = createRepo('left');
    const right = createRepo('right');
    insertTask(left.database, 't_left', 'LEFT HOSTILE TITLE');
    insertTask(right.database, 't_right', 'RIGHT HOSTILE TITLE');

    const result = await sync(left.database, right.database, '--json');
    expect(result.code).toBe(DATABASE_SYNC_EXIT_CODES.success);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('HOSTILE TITLE');
    const report = parseJson(result);
    expect(report.status).toBe('changed');
    expect(report.apply?.generationId).toMatch(/^[a-f0-9]{64}--[0-9]{16}--[a-f0-9-]{36}$/);
    expect(report.apply?.recovery.status).toBe('converged');
    expect(report.plan?.targets.map((target) => target.changes.deletions)).toEqual([0, 0]);
    expect(taskTitles(left.database)).toEqual(['LEFT HOSTILE TITLE', 'RIGHT HOSTILE TITLE']);
    expect(taskTitles(right.database)).toEqual(['LEFT HOSTILE TITLE', 'RIGHT HOSTILE TITLE']);

    const noOp = await sync(right.database, left.database, '--json');
    expect(noOp.code).toBe(DATABASE_SYNC_EXIT_CODES.success);
    expect(parseJson(noOp).status).toBe('no-op');
  });

  test('bidirectional apply propagates an explicit roster tombstone without a schema migration', async () => {
    const host = createRepo('tombstone-host');
    const guest = createRepo('tombstone-guest');
    const hostDb = openDb({ path: host.database });
    hireAgent(hostDb, { wish: 'w', agentAdapterId: 'agent', worktree: '/wt/host' });
    hostDb.close();
    const guestDb = openDb({ path: guest.database });
    expect(unhireAgent(guestDb, 'w', 'agent')).toBe(false);
    guestDb.close();

    const preview = await sync(host.database, guest.database, '--dry-run');
    expect(preview.code).toBe(DATABASE_SYNC_EXIT_CODES.success);
    expect(preview.stdout).toContain('left: meta=1; deletions=1');

    const result = await sync(host.database, guest.database, '--json');

    expect(result.code).toBe(DATABASE_SYNC_EXIT_CODES.success);
    expect(parseJson(result).plan?.targets.map((target) => target.changes.deletions)).toEqual([1, 0]);
    for (const path of [host.database, guest.database]) {
      const db = openDb({ path });
      expect(listHires(db, 'w')).toEqual([]);
      expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBeGreaterThan(0);
      db.close();
    }
  });

  test('bidirectional mutable conflicts use exit 3, bounded digests/counts, and zero mutation', async () => {
    const left = createRepo('left');
    const right = createRepo('right');
    insertTask(left.database, 't_shared', 'LEFT SECRET');
    insertTask(right.database, 't_shared', 'RIGHT SECRET');
    const beforeLeft = readFileSync(left.database);
    const beforeRight = readFileSync(right.database);

    const result = await sync(left.database, right.database, '--json');
    expect(result.code).toBe(DATABASE_SYNC_EXIT_CODES.conflict);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('LEFT SECRET');
    expect(result.stdout).not.toContain('RIGHT SECRET');
    const report = parseJson(result);
    expect(report.status).toBe('conflict');
    expect(report.plan?.conflicts.total).toBe(1);
    expect(report.plan?.conflicts.byTable.tasks).toBe(1);
    expect(readFileSync(left.database)).toEqual(beforeLeft);
    expect(readFileSync(right.database)).toEqual(beforeRight);
  });

  test('directional source authority overwrites shared rows while preserving destination-only rows and source bytes', async () => {
    const source = createRepo('source');
    const destination = createRepo('destination');
    insertTask(source.database, 't_shared', 'source wins');
    insertTask(destination.database, 't_shared', 'destination loses');
    insertTask(destination.database, 't_destination', 'destination remains');
    const beforeSource = readFileSync(source.database);

    const result = await sync(
      '--source',
      source.database,
      '--destination',
      destination.database,
      '--keep-snapshots',
      '2',
      '--busy-timeout-ms',
      '1000',
      '--json',
    );
    expect(result.code).toBe(DATABASE_SYNC_EXIT_CODES.success);
    expect(parseJson(result).status).toBe('changed');
    expect(readFileSync(source.database)).toEqual(beforeSource);
    expect(taskTitles(destination.database)).toEqual(['destination remains', 'source wins']);
  });

  test('rollback restores both pre-sync images and current task/database commands remain compatible', async () => {
    const left = createRepo('left');
    const right = createRepo('right');
    insertTask(left.database, 't_left', 'left only');
    insertTask(right.database, 't_right', 'right only');

    const applied = await sync(left.database, right.database, '--json');
    const generation = parseJson(applied).apply?.generationId;
    if (generation == null) throw new Error('Expected apply to publish a generation.');
    expect(taskTitles(left.database)).toEqual(['left only', 'right only']);

    const rolledBack = await sync(left.database, right.database, '--rollback', generation, '--json');
    expect(rolledBack.code).toBe(DATABASE_SYNC_EXIT_CODES.success);
    const report = parseJson(rolledBack);
    expect(report.status).toBe('rolled-back');
    expect(report.rollback?.selectedGenerationId).toBe(generation);
    expect(report.rollback?.safetyGenerationId).toMatch(/^[a-f0-9]{64}--/);
    expect(taskTitles(left.database)).toEqual(['left only']);
    expect(taskTitles(right.database)).toEqual(['right only']);

    for (const repo of [left.repo, right.repo]) {
      const exported = await cli(repo, 'task', 'export');
      expect(exported.code).toBe(0);
      expect(() => JSON.parse(exported.stdout)).not.toThrow();
      const board = await cli(repo, 'board', '--json');
      expect(board.code).toBe(0);
      expect(() => JSON.parse(board.stdout)).not.toThrow();
    }
  });

  test('stale prior shape fails read-only, then normal current commands normalize it to the identical complete schema', async () => {
    const prior = createRepo('prior', false);
    const current = createRepo('current');
    seedPriorDatabase(prior.database);
    const staleBytes = readFileSync(prior.database);

    const rejected = await sync(prior.database, current.database, '--dry-run', '--json');
    expect(rejected.code).toBe(DATABASE_SYNC_EXIT_CODES.operationalFailure);
    const rejectedReport = parseJson(rejected);
    expect(rejectedReport.plan?.operationalFailure?.code).toBe('stale-current-schema');
    expect(rejectedReport.plan?.operationalFailure?.guidance).toContain('normal current open path');
    expect(readFileSync(prior.database)).toEqual(staleBytes);

    const priorBoard = await cli(prior.repo, 'board', '--json');
    expect(priorBoard.code).toBe(0);
    const priorCreate = await cli(prior.repo, 'task', 'create', '--title', 'current command task');
    expect(priorCreate.code).toBe(0);

    const reconciled = await sync(prior.database, current.database, '--json');
    expect(reconciled.code).toBe(DATABASE_SYNC_EXIT_CODES.success);
    expect(parseJson(reconciled).status).toBe('changed');
    expect(schemaInventory(prior.database)).toEqual(schemaInventory(current.database));

    for (const repo of [prior.repo, current.repo]) {
      const listed = await cli(repo, 'task', 'list', '--json');
      expect(listed.code).toBe(0);
      expect(JSON.parse(listed.stdout)).toHaveLength(2);
      const db = openDb({ cwd: repo });
      expect(getTask(db, 't_prior')?.title).toBe('prior task');
      db.close();
    }
  });

  test('retention zero uses only same-process recovery and publishes no persistent root', async () => {
    const source = createRepo('source');
    const destination = createRepo('destination');
    insertTask(source.database, 't_source', 'source');

    const result = await sync(
      '--source',
      source.database,
      '--destination',
      destination.database,
      '--keep-snapshots',
      '0',
      '--json',
    );
    expect(result.code).toBe(DATABASE_SYNC_EXIT_CODES.success);
    const report = parseJson(result);
    expect(report.status).toBe('changed');
    expect(report.apply?.generationId).toMatch(/^[a-f0-9]{64}--/);
    expect(report.apply?.cleanupFailures).toEqual([]);
    expect(existsSync(join(destination.repo, '.genie', 'sync-snapshots'))).toBe(false);
  });

  test('busy timeout is forwarded as a bounded operational result', async () => {
    const source = createRepo('source');
    const destination = createRepo('destination');
    insertTask(source.database, 't_source', 'source');
    const held = new Database(destination.database);
    held.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    try {
      const result = await sync(
        '--source',
        source.database,
        '--destination',
        destination.database,
        '--busy-timeout-ms',
        '0',
        '--json',
      );
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result.code).toBe(DATABASE_SYNC_EXIT_CODES.operationalFailure);
      expect(parseJson(result).status).toBe('operational-failure');
    } finally {
      held.exec('ROLLBACK');
      held.close();
    }
    expect(taskTitles(destination.database)).toEqual([]);
  });
});
