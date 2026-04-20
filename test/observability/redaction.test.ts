/**
 * Synthetic secret-probe test (WISH §Group 2 deliverable #7).
 *
 * Emits an event whose payload deliberately contains a secret-shaped string
 * and a sensitive env-var assignment. The test asserts that the secret and
 * the env-var value are absent from the row written to `genie_runtime_events`.
 *
 * Runs against the bun-preload test pgserve (see src/lib/test-setup.ts).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { getConnection } from '../../src/lib/db.js';
import { __resetEmitForTests, emitEvent, flushNow, shutdownEmitter } from '../../src/lib/emit.js';
import { dropSecretShaped, stripEnvVars, tokenizePath } from '../../src/lib/events/redactors.js';

const DB_AVAILABLE = process.env.GENIE_TEST_PG_PORT !== undefined;

describe('redactors — pure helpers', () => {
  test('stripEnvVars redacts ANTHROPIC_API_KEY value', () => {
    const out = stripEnvVars('ANTHROPIC_API_KEY=sk-test-12345 and DEBUG=1');
    expect(out).toContain('ANTHROPIC_API_KEY=<REDACTED>');
    expect(out).not.toContain('sk-test-12345');
    expect(out).toContain('DEBUG=1');
  });

  test('stripEnvVars redacts _TOKEN / _PASSWORD / _SECRET suffixes', () => {
    const inp = 'GITHUB_TOKEN=ghp_abcdefghij12345 DB_PASSWORD=hunter2 APP_SECRET=s3kret';
    const out = stripEnvVars(inp);
    expect(out).not.toContain('ghp_abcdefghij12345');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('s3kret');
    expect(out).toContain('GITHUB_TOKEN=<REDACTED>');
    expect(out).toContain('DB_PASSWORD=<REDACTED>');
    expect(out).toContain('APP_SECRET=<REDACTED>');
  });

  test('dropSecretShaped redacts sk-ant-/gh*_/Bearer shapes', () => {
    const cases = [
      'sk-ant-01234567890abcdefghij',
      'ghp_abcdefghij0123456789012345678901',
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ];
    for (const c of cases) {
      const out = dropSecretShaped(c);
      expect(out).toContain('<REDACTED:');
      expect(out).not.toContain(c);
    }
  });

  test('tokenizePath collapses deep paths and hex ids', () => {
    // Build path under the current process HOME so the `~/` substitution is
    // exercised regardless of which user/runner executes the suite.
    const deep = `${homedir()}/workspace/agents/genie-configure/repos/genie/src/lib/emit.ts`;
    const out = tokenizePath(deep);
    expect(out.startsWith('~/')).toBe(true);
    expect(out).toContain('…');
    const withId = '/tmp/sessions/abcdef0123456789abcdef/log.jsonl';
    expect(tokenizePath(withId)).toContain('<id>');
  });
});

describe.skipIf(!DB_AVAILABLE)('emit — no secret leak probe', () => {
  afterAll(async () => {
    await shutdownEmitter();
  });

  test('emitted state_transition with ANTHROPIC_API_KEY in payload writes no leak', async () => {
    __resetEmitForTests();
    const SECRET = `sk-test-${'9'.repeat(24)}`;
    const sql = await getConnection();

    // Capture current max id so we can scope the read back to this test's row.
    const [{ max_id }] = (await sql`SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM genie_runtime_events`) as Array<{
      max_id: number;
    }>;

    emitEvent(
      'state_transition',
      {
        entity_kind: 'task',
        entity_id: 'task-redaction-probe',
        from: 'pending',
        to: 'in_progress',
        reason: `triggered by ANTHROPIC_API_KEY=${SECRET} in env`,
        actor: 'probe',
        before: { status: 'pending' },
        after: { status: 'in_progress' },
      },
      { severity: 'info', source_subsystem: 'redaction-test' },
    );

    await flushNow();

    const rows = (await sql`
      SELECT id, subject, data::text AS data_text
      FROM genie_runtime_events
      WHERE id > ${Number(max_id)}
        AND subject = 'state_transition'
      ORDER BY id DESC
      LIMIT 1
    `) as Array<{ id: number; subject: string; data_text: string }>;

    expect(rows.length).toBe(1);
    const raw = rows[0].data_text;
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('ANTHROPIC_API_KEY=<REDACTED>');
    // entity_id should be HMAC-hashed (tier-A), so the raw label shouldn't survive.
    expect(raw).not.toContain('task-redaction-probe');
    expect(raw).toContain('tier-a:entity:');
  });
});
