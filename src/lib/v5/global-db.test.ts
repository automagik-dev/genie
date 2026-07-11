import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ForeignDbError,
  GLOBAL_SCHEMA_VERSION,
  MIGRATED_STATUS_SENTINEL,
  MalformedDbError,
  acquireServiceLease,
  acquireServiceLeaseEpoch,
  clearAgentSessionIfCurrent,
  getAgentSession,
  insertAgentSessionIfAbsent,
  openGlobalDb,
  releaseServiceLease,
  renewServiceLease,
  replaceAgentSessionIfCurrent,
  resolveGlobalDbPath,
  upsertAgentSession,
} from './global-db.js';
import { listApprovalsNeedingStatusAck } from './omni-queue.js';

let dir: string;
const originalGenieHome = process.env.GENIE_HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-global-'));
  // Point GENIE_HOME at a tmpdir so the real ~/.genie is never touched.
  process.env.GENIE_HOME = dir;
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: process.env assignment coerces undefined→"undefined"; delete is the only correct unset
  if (originalGenieHome === undefined) delete process.env.GENIE_HOME;
  else process.env.GENIE_HOME = originalGenieHome;
  rmSync(dir, { recursive: true, force: true });
});

function userVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

describe('resolveGlobalDbPath', () => {
  test('honors GENIE_HOME and never reuses per-repo path constants', () => {
    expect(resolveGlobalDbPath()).toBe(join(dir, 'genie.db'));
  });
});

describe('openGlobalDb schema init', () => {
  test('creates the file, stamps user_version, and is idempotent', () => {
    const path = join(dir, 'genie.db');

    const db1 = openGlobalDb();
    db1.close();
    expect(existsSync(path)).toBe(true);
    expect(userVersion(path)).toBe(GLOBAL_SCHEMA_VERSION);

    // Re-open: must not throw, must not change the version, tables intact.
    const db2 = openGlobalDb();
    const tables = db2
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    db2.close();

    expect(userVersion(path)).toBe(GLOBAL_SCHEMA_VERSION);
    expect(tables).toEqual(['agent_sessions', 'approvals', 'inbound_messages', 'service_leases']);
  });

  test('WAL journal mode is enabled', () => {
    const db = openGlobalDb();
    const mode = (db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    db.close();
    expect(mode.toLowerCase()).toBe('wal');
  });

  test('creates the parent directory when absent', () => {
    const path = join(dir, 'nested', 'deep', 'genie.db');
    const db = openGlobalDb({ path });
    db.close();
    expect(existsSync(path)).toBe(true);
  });

  test('repairs an interrupted event-idempotency index migration on reopen', () => {
    const db1 = openGlobalDb();
    db1.exec('DROP INDEX idx_inbound_event_key');
    db1.close();

    const db2 = openGlobalDb();
    try {
      const index = (
        db2.query('PRAGMA index_list(inbound_messages)').all() as Array<{
          name: string;
          unique: number;
          partial: number;
        }>
      ).find((entry) => entry.name === 'idx_inbound_event_key');
      expect(index).toMatchObject({ unique: 1, partial: 1 });
    } finally {
      db2.close();
    }
  });
});

describe('machine-scoped service leases', () => {
  test('permits one owner, fences non-owners, renews, expires, and token-checks release', () => {
    const db = openGlobalDb();
    try {
      expect(acquireServiceLease(db, 'omni-serve', 'owner-a', 100, 50)).toBe(true);
      expect(acquireServiceLease(db, 'omni-serve', 'owner-b', 149, 50)).toBe(false);
      expect(renewServiceLease(db, 'omni-serve', 'owner-b', 149, 50)).toBe(false);
      expect(renewServiceLease(db, 'omni-serve', 'owner-a', 140, 50)).toBe(true);
      expect(acquireServiceLease(db, 'omni-serve', 'owner-b', 189, 50)).toBe(false);
      expect(acquireServiceLease(db, 'omni-serve', 'owner-b', 190, 50)).toBe(true);
      expect(releaseServiceLease(db, 'omni-serve', 'owner-a')).toBe(false);
      expect(releaseServiceLease(db, 'omni-serve', 'owner-b')).toBe(true);
    } finally {
      db.close();
    }
  });

  test('advances a monotonic fencing epoch only when an expired owner is replaced', () => {
    const db = openGlobalDb();
    try {
      expect(acquireServiceLeaseEpoch(db, 'omni-serve', 'owner-a', 100, 50)).toBe(1);
      expect(acquireServiceLeaseEpoch(db, 'omni-serve', 'owner-b', 149, 50)).toBeUndefined();
      expect(acquireServiceLeaseEpoch(db, 'omni-serve', 'owner-a', 140, 50)).toBe(1);
      expect(acquireServiceLeaseEpoch(db, 'omni-serve', 'owner-b', 190, 50)).toBe(2);
      expect(renewServiceLease(db, 'omni-serve', 'owner-a', 191, 50, 1)).toBe(false);
      expect(releaseServiceLease(db, 'omni-serve', 'owner-a', 1)).toBe(false);
      expect(releaseServiceLease(db, 'omni-serve', 'owner-b', 2)).toBe(true);
      expect(acquireServiceLeaseEpoch(db, 'omni-serve', 'owner-c', 191, 50)).toBe(3);
    } finally {
      db.close();
    }
  });
});

describe('provider session persistence', () => {
  test('stores and replaces a Codex thread by provider, instance, and chat', () => {
    const db = openGlobalDb();
    try {
      expect(getAgentSession(db, 'codex', 'i', 'c')).toBeUndefined();
      upsertAgentSession(db, 'codex', 'i', 'c', 'thread-1', 1);
      expect(getAgentSession(db, 'codex', 'i', 'c')).toBe('thread-1');
      upsertAgentSession(db, 'codex', 'i', 'c', 'thread-2', 2);
      expect(getAgentSession(db, 'codex', 'i', 'c')).toBe('thread-2');
      expect(getAgentSession(db, 'claude', 'i', 'c')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('owns conditional insert, replace, and clear operations behind typed outcomes', () => {
    const db = openGlobalDb();
    try {
      expect(insertAgentSessionIfAbsent(db, 'codex', 'i', 'c', 'thread-1', 1)).toBe(true);
      expect(insertAgentSessionIfAbsent(db, 'codex', 'i', 'c', 'racer', 2)).toBe(false);
      expect(replaceAgentSessionIfCurrent(db, 'codex', 'i', 'c', 'stale', 'bad', 3)).toBe(false);
      expect(replaceAgentSessionIfCurrent(db, 'codex', 'i', 'c', 'thread-1', 'thread-2', 4)).toBe(true);
      expect(getAgentSession(db, 'codex', 'i', 'c')).toBe('thread-2');
      expect(clearAgentSessionIfCurrent(db, 'codex', 'i', 'c', 'thread-1')).toBe(false);
      expect(clearAgentSessionIfCurrent(db, 'codex', 'i', 'c', 'thread-2')).toBe(true);
      expect(getAgentSession(db, 'codex', 'i', 'c')).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe('openGlobalDb additive column backfill (last_status_glyph)', () => {
  /** The pre-column v1 approvals schema, as an earlier build stamped it. */
  const OLD_APPROVALS_SQL = `
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, session_hint TEXT, tool TEXT NOT NULL,
      input_summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
      omni_message_id TEXT, requested_by TEXT, resolved_by TEXT,
      created_at INTEGER NOT NULL, resolved_at INTEGER
    );
    CREATE TABLE inbound_messages (
      id TEXT PRIMARY KEY, instance TEXT NOT NULL, chat TEXT NOT NULL, sender TEXT NOT NULL,
      body TEXT NOT NULL, received_at INTEGER NOT NULL, handled_at INTEGER
    );`;

  function columns(db: Database, table: string): Set<string> {
    return new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  }

  test('backfills the column on an existing v1 DB without bumping user_version or losing data', () => {
    const path = join(dir, 'legacy.db');
    const seed = new Database(path);
    seed.exec(OLD_APPROVALS_SQL);
    seed.exec(`PRAGMA user_version = ${GLOBAL_SCHEMA_VERSION}`);
    // A pre-existing approval row must survive the additive migration untouched.
    seed
      .query(
        "INSERT INTO approvals (id, repo, tool, input_summary, status, created_at) VALUES ('appr_old','/r','Bash','x','pending',1)",
      )
      .run();
    seed.close();
    expect(columns(new Database(path, { readonly: true }), 'approvals').has('last_status_glyph')).toBe(false);

    // Opening runs the additive ALTER (schemaIsCurrent sees the missing column).
    const db = openGlobalDb({ path });
    try {
      expect(columns(db, 'approvals').has('last_status_glyph')).toBe(true);
      for (const column of [
        'announce_claim',
        'announce_claim_owner',
        'announce_claim_epoch',
        'announce_claimed_at',
        'announce_phase',
        'announce_prior_claim',
        'announce_prior_owner',
        'announce_prior_epoch',
      ]) {
        expect(columns(db, 'approvals').has(column)).toBe(true);
      }
      for (const column of [
        'event_key',
        'processing_claim',
        'processing_claim_owner',
        'processing_claim_epoch',
        'processing_claimed_at',
        'processing_phase',
        'outbound_event_id',
        'outbound_subject',
        'outbound_payload',
        'outbound_meta',
      ]) {
        expect(columns(db, 'inbound_messages').has(column)).toBe(true);
      }
      expect(columns(db, 'service_leases').has('epoch')).toBe(true);
      const row = db.query("SELECT last_status_glyph FROM approvals WHERE id = 'appr_old'").get() as {
        last_status_glyph: string | null;
      };
      expect(row.last_status_glyph).toBeNull(); // new column, back-filled NULL
    } finally {
      db.close();
    }
    // Same version — additive backfill stays within v1 (no destructive migration).
    expect(userVersion(path)).toBe(GLOBAL_SCHEMA_VERSION);
  });

  test('one-time backfill stamps pre-upgrade CLOSED history as MIGRATED so reconcile ignores it', () => {
    const path = join(dir, 'legacy-history.db');
    const seed = new Database(path);
    seed.exec(OLD_APPROVALS_SQL);
    seed.exec(`PRAGMA user_version = ${GLOBAL_SCHEMA_VERSION}`);
    // Historical announced+closed rows (approved/denied/expired) — the kind that,
    // pre-fix, the first post-upgrade tick would fire a reaction POST for.
    const insert = seed.query(
      'INSERT INTO approvals (id, repo, tool, input_summary, status, omni_message_id, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?)',
    );
    insert.run('appr_a', '/r', 'Bash', 'x', 'approved', 'stanza-a', 1, 100);
    insert.run('appr_d', '/r', 'Bash', 'x', 'denied', 'stanza-d', 2, 200);
    insert.run('appr_e', '/r', 'Bash', 'x', 'expired', 'stanza-e', 3, 300);
    // A still-pending row must stay reconcilable (not stamped).
    insert.run('appr_p', '/r', 'Bash', 'x', 'pending', 'stanza-p', 4, null);
    seed.close();

    const db = openGlobalDb({ path });
    try {
      const closed = db
        .query("SELECT id, last_status_glyph AS g FROM approvals WHERE status != 'pending'")
        .all() as Array<{ id: string; g: string | null }>;
      // Every historical closed row is stamped with the sentinel.
      expect(closed.every((r) => r.g === MIGRATED_STATUS_SENTINEL)).toBe(true);
      // Pending row untouched.
      expect(
        (db.query("SELECT last_status_glyph AS g FROM approvals WHERE id = 'appr_p'").get() as { g: string | null }).g,
      ).toBeNull();
      // The reconciliation query returns NONE — no reaction fires on the first tick.
      const now = 1_000_000;
      expect(listApprovalsNeedingStatusAck(db, ['\u{2705}', '\u{274C}'], now, 24 * 60 * 60 * 1000)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('openGlobalDb refusal (typed errors from sqlite-open)', () => {
  test('refuses a malformed (non-sqlite) file with MalformedDbError', () => {
    const path = join(dir, 'garbage.db');
    writeFileSync(path, 'definitely not a sqlite database\n'.repeat(64));
    expect(() => openGlobalDb({ path })).toThrow(MalformedDbError);
  });

  test('refuses a foreign versioned database with ForeignDbError', () => {
    const path = join(dir, 'foreign.db');
    const seed = new Database(path);
    seed.exec('PRAGMA user_version = 9');
    seed.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY)');
    seed.close();
    expect(() => openGlobalDb({ path })).toThrow(ForeignDbError);
  });

  test('refuses an unversioned database that already holds foreign tables', () => {
    const path = join(dir, 'foreign-unversioned.db');
    const seed = new Database(path);
    seed.exec('CREATE TABLE legacy_stuff (id INTEGER PRIMARY KEY)');
    seed.close();
    expect(() => openGlobalDb({ path })).toThrow(ForeignDbError);
  });

  test('adopts an empty (0-byte) file as a fresh database', () => {
    const path = join(dir, 'empty.db');
    writeFileSync(path, '');
    const db = openGlobalDb({ path });
    db.close();
    expect(userVersion(path)).toBe(GLOBAL_SCHEMA_VERSION);
  });
});
