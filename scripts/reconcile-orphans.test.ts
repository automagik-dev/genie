/**
 * Tests for scripts/reconcile-orphans.ts — the Group 7 one-shot.
 *
 * Covers:
 *   • Dry-run lists orphans and spares live agents.
 *   • --apply with correct confirmation terminalizes orphans.
 *   • --apply with wrong confirmation aborts without writing.
 *   • Re-running --apply is a no-op (idempotent).
 *   • An audit row is emitted per terminalized agent.
 *   • The ghost-loop scenario (stale pane, state=idle, >1h old) is
 *     terminalized rather than resumed.
 *   • CLI flag parsing honors flags-before-positionals and unknown flags.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getConnection } from '../src/lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../src/lib/test-db.js';
import {
  type Candidate,
  type PaneAliveFn,
  findOrphans,
  parseCliArgs,
  run,
  terminalizeOrphans,
} from './reconcile-orphans.ts';

async function insertAgent(opts: {
  id: string;
  state: string | null;
  paneId: string | null;
  lastStateChange: string;
}): Promise<void> {
  const sql = await getConnection();
  await sql`
    INSERT INTO agents (id, pane_id, session, repo_path, state, started_at, last_state_change)
    VALUES (${opts.id}, ${opts.paneId}, ${'sess'}, ${'/tmp'}, ${opts.state}, ${opts.lastStateChange},
            ${opts.lastStateChange})
  `;
}

const deadAlways: PaneAliveFn = async () => false;

describe('parseCliArgs', () => {
  test('defaults to dry-run', () => {
    const { apply, help, unknown } = parseCliArgs([]);
    expect(apply).toBe(false);
    expect(help).toBe(false);
    expect(unknown).toEqual([]);
  });

  test('--apply enables apply mode', () => {
    expect(parseCliArgs(['--apply']).apply).toBe(true);
  });

  test('later --dry-run wins over earlier --apply (flag order preserved)', () => {
    expect(parseCliArgs(['--apply', '--dry-run']).apply).toBe(false);
    expect(parseCliArgs(['--dry-run', '--apply']).apply).toBe(true);
  });

  test('captures unknown flags so main() can reject them', () => {
    expect(parseCliArgs(['--oops', 'pos']).unknown).toEqual(['--oops', 'pos']);
  });

  test('--help and -h set the help flag', () => {
    expect(parseCliArgs(['--help']).help).toBe(true);
    expect(parseCliArgs(['-h']).help).toBe(true);
  });
});

describe.skipIf(!DB_AVAILABLE)('reconcile-orphans (integration)', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM audit_events`;
    await sql`DELETE FROM agents`;
  });

  afterEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM audit_events`;
    await sql`DELETE FROM agents`;
  });

  const twoHoursAgo = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const tenMinAgo = () => new Date(Date.now() - 10 * 60 * 1000).toISOString();

  test('dry-run lists orphans and spares live agents', async () => {
    await insertAgent({ id: 'orphan-1', state: 'idle', paneId: '%42', lastStateChange: twoHoursAgo() });
    await insertAgent({ id: 'alive-1', state: 'idle', paneId: '%1', lastStateChange: twoHoursAgo() });
    await insertAgent({ id: 'young-1', state: 'idle', paneId: '%99', lastStateChange: tenMinAgo() });
    await insertAgent({ id: 'done-1', state: 'done', paneId: '%99', lastStateChange: twoHoursAgo() });

    const onlyOrphan1Dead: PaneAliveFn = async (p) => p !== '%42';
    const candidates = await findOrphans({ isPaneAlive: onlyOrphan1Dead });

    expect(candidates.map((c) => c.id)).toEqual(['orphan-1']);
    expect(candidates[0].state).toBe('idle');
    expect(candidates[0].action).toBe('terminalize');

    const sql = await getConnection();
    const [alive] = await sql<{ state: string }[]>`SELECT state FROM agents WHERE id = 'alive-1'`;
    expect(alive.state).toBe('idle'); // untouched
  });

  test('identity-only (state IS NULL) rows are skipped', async () => {
    await insertAgent({ id: 'identity', state: null, paneId: '', lastStateChange: twoHoursAgo() });
    const found = await findOrphans({ isPaneAlive: deadAlways });
    expect(found.map((c) => c.id)).toEqual([]);
  });

  test('recent rows (< 1h) are spared even with a dead pane', async () => {
    await insertAgent({ id: 'recent', state: 'working', paneId: '%2', lastStateChange: tenMinAgo() });
    const found = await findOrphans({ isPaneAlive: deadAlways });
    expect(found.map((c) => c.id)).toEqual([]);
  });

  test('run() in dry-run mode does not write', async () => {
    await insertAgent({ id: 'orphan-dry', state: 'idle', paneId: '%1', lastStateChange: twoHoursAgo() });

    const logged: string[] = [];
    const result = await run({
      apply: false,
      isPaneAlive: deadAlways,
      log: (line) => logged.push(line),
    });

    expect(result.mode).toBe('dry-run');
    expect(result.candidates.length).toBe(1);
    expect(result.terminalized).toBe(0);

    const sql = await getConnection();
    const [row] = await sql<{ state: string }[]>`SELECT state FROM agents WHERE id = 'orphan-dry'`;
    expect(row.state).toBe('idle');
    const audits = await sql<{ id: number }[]>`SELECT id FROM audit_events WHERE entity_id = 'orphan-dry'`;
    expect(audits.length).toBe(0);
  });

  test('apply with correct confirmation terminalizes orphans + emits audit', async () => {
    await insertAgent({ id: 'orphan-apply', state: 'idle', paneId: '%1', lastStateChange: twoHoursAgo() });
    await insertAgent({ id: 'stay-alive', state: 'idle', paneId: '%2', lastStateChange: twoHoursAgo() });

    const aliveOnly2: PaneAliveFn = async (p) => p === '%2';
    const result = await run({
      apply: true,
      isPaneAlive: aliveOnly2,
      readConfirmation: async () => 'I UNDERSTAND',
      actor: 'test-reconciler',
      log: () => {},
    });

    expect(result.mode).toBe('apply');
    expect(result.aborted).toBe(false);
    expect(result.terminalized).toBe(1);

    const sql = await getConnection();
    const [orphan] = await sql<{ state: string }[]>`SELECT state FROM agents WHERE id = 'orphan-apply'`;
    expect(orphan.state).toBe('error');

    const [alive] = await sql<{ state: string }[]>`SELECT state FROM agents WHERE id = 'stay-alive'`;
    expect(alive.state).toBe('idle');

    const audits = await sql<{ event_type: string; actor: string; details: unknown }[]>`
      SELECT event_type, actor, details FROM audit_events
      WHERE entity_type = 'agent' AND entity_id = 'orphan-apply'
    `;
    expect(audits.length).toBe(1);
    expect(audits[0].event_type).toBe('reconcile.terminalize');
    expect(audits[0].actor).toBe('test-reconciler');
    const details = audits[0].details as Record<string, unknown>;
    expect(details.state_before).toBe('idle');
    expect(details.pane_id).toBe('%1');
  });

  test('apply with wrong confirmation aborts without writing', async () => {
    await insertAgent({ id: 'unconfirmed', state: 'idle', paneId: '%5', lastStateChange: twoHoursAgo() });

    const result = await run({
      apply: true,
      isPaneAlive: deadAlways,
      readConfirmation: async () => 'yes please',
      log: () => {},
    });

    expect(result.aborted).toBe(true);
    expect(result.terminalized).toBe(0);

    const sql = await getConnection();
    const [row] = await sql<{ state: string }[]>`SELECT state FROM agents WHERE id = 'unconfirmed'`;
    expect(row.state).toBe('idle');
    const audits = await sql<{ id: number }[]>`SELECT id FROM audit_events WHERE entity_id = 'unconfirmed'`;
    expect(audits.length).toBe(0);
  });

  test('re-running apply is a no-op (idempotent)', async () => {
    await insertAgent({ id: 'idem', state: 'idle', paneId: '%9', lastStateChange: twoHoursAgo() });

    const first = await run({
      apply: true,
      isPaneAlive: deadAlways,
      readConfirmation: async () => 'I UNDERSTAND',
      log: () => {},
    });
    expect(first.terminalized).toBe(1);

    const second = await run({
      apply: true,
      isPaneAlive: deadAlways,
      readConfirmation: async () => 'I UNDERSTAND',
      log: () => {},
    });
    expect(second.terminalized).toBe(0);
    expect(second.candidates.length).toBe(0);

    const sql = await getConnection();
    const audits = await sql<{ id: number }[]>`
      SELECT id FROM audit_events WHERE entity_id = 'idem'
    `;
    expect(audits.length).toBe(1); // only the first run wrote an audit row
  });

  test('ghost-loop regression: stale pane_id + state=idle → terminalized, not resumed', async () => {
    // Replay of the 2026-04-19 scenario from the wish: an agent with
    // auto_resume=true, state=idle, stale pane_id pointing at a long-dead
    // tmux pane that was the impetus for this whole wish.
    const sql = await getConnection();
    await sql`
      INSERT INTO agents (id, pane_id, session, repo_path, state, started_at, last_state_change, auto_resume)
      VALUES ('ghost-loop', '%ancient', 'sess', '/tmp', 'idle',
              now() - interval '3 hours', now() - interval '3 hours', true)
    `;

    const result = await run({
      apply: true,
      isPaneAlive: deadAlways,
      readConfirmation: async () => 'I UNDERSTAND',
      log: () => {},
    });

    expect(result.terminalized).toBe(1);
    const [row] = await sql<{ state: string }[]>`SELECT state FROM agents WHERE id = 'ghost-loop'`;
    expect(row.state).toBe('error'); // terminalized — no resume possible
  });

  test('tmux unreachable → row is skipped, not wrongly terminalized', async () => {
    await insertAgent({ id: 'tmux-down', state: 'idle', paneId: '%1', lastStateChange: twoHoursAgo() });
    const throwsUnreachable: PaneAliveFn = async () => {
      throw new Error('no server running');
    };

    const found = await findOrphans({ isPaneAlive: throwsUnreachable });
    expect(found.map((c) => c.id)).toEqual([]);
  });

  test('terminalizeOrphans skips rows whose state flipped between find and apply', async () => {
    await insertAgent({ id: 'racey', state: 'idle', paneId: '%1', lastStateChange: twoHoursAgo() });
    const candidate: Candidate = {
      id: 'racey',
      state: 'idle',
      paneId: '%1',
      lastStateChange: twoHoursAgo(),
      action: 'terminalize',
      reason: 'pane_id=%1 dead',
    };

    const sql = await getConnection();
    await sql`UPDATE agents SET state = 'done' WHERE id = 'racey'`;

    const changed = await terminalizeOrphans([candidate], 'test');
    expect(changed).toBe(0);

    const [row] = await sql<{ state: string }[]>`SELECT state FROM agents WHERE id = 'racey'`;
    expect(row.state).toBe('done'); // preserved — idempotent skip
    const audits = await sql<{ id: number }[]>`SELECT id FROM audit_events WHERE entity_id = 'racey'`;
    expect(audits.length).toBe(0);
  });
});
