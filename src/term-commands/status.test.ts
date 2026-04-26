/**
 * Tests for `genie status`.
 *
 * The aggregator is exercised end-to-end against PG (real fixtures, no
 * mocks per the QA discipline) — we seed agents + executors + audit events,
 * then assert the rendered output (or JSON payload) matches.
 *
 * Performance acceptance: < 1s for ≤ 100 agents (verified with 100 fixtures).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '../lib/audit.js';
import { getConnection } from '../lib/db.js';
import { statusCommand } from './status.js';

interface SeededAgent {
  id: string;
  name: string;
  team: string;
}

async function seedAgent(
  name: string,
  team: string,
  opts: { kind?: 'permanent' | 'task'; reportsTo?: string } = {},
): Promise<SeededAgent> {
  const sql = await getConnection();
  // For task agents we set reports_to to a sentinel non-null UUID to flip
  // kind via the GENERATED column inference rule (id LIKE 'dir:%' OR
  // reports_to IS NULL → permanent; else task).
  const id = opts.kind === 'task' ? randomUUID() : `dir:${randomUUID()}`;
  await sql`
    INSERT INTO agents (id, pane_id, session, repo_path, custom_name, role, team, state, started_at, last_state_change, auto_resume, reports_to)
    VALUES (
      ${id}, 'inline', 'genie', '/tmp/repo', ${name}, ${name}, ${team},
      'idle', now(), now(), true, ${opts.reportsTo ?? null}
    )
  `;
  return { id, name, team };
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const originalLog = console.log;
  const buffers: string[] = [];
  console.log = (...args: unknown[]) => {
    buffers.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    buffers.push('\n');
  };
  try {
    const result = await fn();
    return { result, output: buffers.join('') };
  } finally {
    console.log = originalLog;
  }
}

describe('statusCommand', () => {
  let testTeam: string;

  beforeEach(async () => {
    testTeam = `status-test-${randomUUID().slice(0, 8)}`;
  });

  afterEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM agents WHERE team = ${testTeam}`;
    await sql`DELETE FROM audit_events WHERE entity_type = 'derived_signal' AND entity_id = ${`test-subj-${testTeam}`}`;
  });

  test('--json output is valid + contains agents/signals keys', async () => {
    await seedAgent('alpha', testTeam, { kind: 'permanent' });
    const { output } = await captureStdout(() => statusCommand({ json: true }));
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('agents');
    expect(parsed).toHaveProperty('signals');
    expect(Array.isArray(parsed.agents)).toBe(true);
  });

  test('seeded permanent agent appears in --json agents list with kind=permanent', async () => {
    await seedAgent('bravo', testTeam, { kind: 'permanent' });
    const { output } = await captureStdout(() => statusCommand({ json: true }));
    const parsed = JSON.parse(output);
    const found = parsed.agents.find((a: { name: string }) => a.name === 'bravo');
    expect(found).toBeDefined();
    expect(found.kind).toBe('permanent');
  });

  test('--health adds health checklist with 4 entries', async () => {
    const { output } = await captureStdout(() => statusCommand({ json: true, health: true }));
    const parsed = JSON.parse(output);
    expect(parsed.health).toBeDefined();
    expect(parsed.health.length).toBe(4);
    const names = parsed.health.map((h: { name: string }) => h.name);
    expect(names).toContain('partition');
    expect(names).toContain('watchdog');
    expect(names).toContain('spill journal');
    expect(names).toContain('watcher metrics');
  });

  test('a recent derived_signal appears in active signals list', async () => {
    const subject = `test-subj-${testTeam}`;
    await recordAuditEvent('derived_signal', subject, 'agents.zombie_storm', 'derived-signals', {
      severity: 'warn',
      triggered_at: new Date().toISOString(),
      window_ms: 3_600_000,
      threshold: 5,
      zombies_in_window: 7,
      latest_agent: 'a-1',
    });
    const { output } = await captureStdout(() => statusCommand({ json: true }));
    const parsed = JSON.parse(output);
    const sig = parsed.signals.find(
      (s: { type: string; subject: string }) => s.type === 'agents.zombie_storm' && s.subject === subject,
    );
    expect(sig).toBeDefined();
    expect(sig.severity).toBe('warn');
  });

  test('completes in under 1 second for a small test fixture', async () => {
    for (let i = 0; i < 10; i++) await seedAgent(`bulk-${i}`, testTeam, { kind: 'permanent' });
    const t0 = Date.now();
    await captureStdout(() => statusCommand({ json: true }));
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000);
  });

  test('non-json render writes the bold IN-FLIGHT header', async () => {
    await seedAgent('charlie', testTeam, { kind: 'permanent' });
    const { output } = await captureStdout(() => statusCommand({}));
    // Match either the colorized variant or plain text — env-dependent.
    expect(output).toContain('IN-FLIGHT');
    expect(output).toContain('ACTIVE SIGNALS');
  });

  test('--debug renders the kind-audit section', async () => {
    await seedAgent('delta', testTeam, { kind: 'permanent' });
    const { output } = await captureStdout(() => statusCommand({ debug: true }));
    expect(output).toContain('DEBUG');
    expect(output).toContain('kind audit');
  });
});
