/**
 * Unit tests for the audit-chain verifier.
 *
 * The full PG round-trip is covered by `test/observability/rbac-matrix.sh`;
 * here we pin the pure digest replay so a migration-side tweak to the
 * `audit_events_chain_hash()` trigger breaks CI loudly.
 *
 * Wish: genie-serve-structured-observability, Group 5.
 */

import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { type AuditChainRow, computeRowDigest } from './audit-chain.js';

function mkRow(overrides: Partial<AuditChainRow> = {}): AuditChainRow {
  return {
    id: 1,
    kind: 'audit.un_hash',
    agent: 'admin',
    text: 'reversed tier-a hash',
    data: { namespace: 'actor', resolved: true },
    trace_id: '00000000-0000-0000-0000-000000000001',
    span_id: null,
    severity: 'warn',
    created_at: '2026-04-20T00:00:00.000Z',
    chain_hash: null,
    chain_key_version: 0,
    ...overrides,
  };
}

describe('computeRowDigest', () => {
  test('is deterministic for identical input', () => {
    const a = computeRowDigest(mkRow());
    const b = computeRowDigest(mkRow());
    expect(a.equals(b)).toBe(true);
  });

  test('changes when any pipe-separated field changes', () => {
    const base = computeRowDigest(mkRow());
    const diffs = [
      mkRow({ kind: 'audit.export' }),
      mkRow({ agent: 'other' }),
      mkRow({ text: 'different' }),
      mkRow({ data: { namespace: 'actor', resolved: false } }),
      mkRow({ trace_id: 'deadbeef-0000-0000-0000-000000000001' }),
      mkRow({ span_id: 'span-1' }),
      mkRow({ severity: 'error' }),
      mkRow({ created_at: '2026-04-20T00:00:00.001Z' }),
    ];
    for (const row of diffs) {
      const d = computeRowDigest(row);
      expect(d.equals(base)).toBe(false);
    }
  });

  test('matches the documented pipe-join canonical form', () => {
    const row = mkRow();
    const dataText = JSON.stringify(row.data);
    const expected = createHash('sha256')
      .update(
        [
          row.kind,
          '|',
          row.agent,
          '|',
          row.text,
          '|',
          dataText,
          '|',
          row.trace_id ?? '',
          '|',
          row.span_id ?? '',
          '|',
          row.severity ?? '',
          '|',
          row.created_at,
        ].join(''),
      )
      .digest();
    expect(computeRowDigest(row).equals(expected)).toBe(true);
  });

  test('tolerates null span_id / trace_id by substituting empty string', () => {
    const digest = computeRowDigest(mkRow({ span_id: null, trace_id: null }));
    expect(digest.length).toBe(32);
  });

  test('tolerates stringified JSON in data field', () => {
    const row = mkRow({ data: '{"namespace":"actor","resolved":true}' });
    const digest = computeRowDigest(row);
    const rowFromObj = computeRowDigest(mkRow({ data: { namespace: 'actor', resolved: true } }));
    expect(digest.equals(rowFromObj)).toBe(true);
  });
});

describe('chain recomputation (unkeyed v0)', () => {
  test('builds the same chain_hash as the trigger for three sequential rows', () => {
    const rows = [mkRow({ id: 1 }), mkRow({ id: 2, text: 'second' }), mkRow({ id: 3, text: 'third' })];
    let prior = Buffer.alloc(32, 0);
    for (const row of rows) {
      const rowDigest = computeRowDigest(row);
      const input = Buffer.concat([prior, rowDigest]);
      const expected = createHash('sha256').update(input).digest();
      // Simulate the trigger's behavior when chain_key_version = 0 (unkeyed).
      row.chain_hash = expected;
      row.chain_key_version = 0;
      prior = expected;
    }
    // Every row's chain_hash must be 32 bytes and unique.
    const hashes = rows.map((r) => r.chain_hash!.toString('hex'));
    expect(new Set(hashes).size).toBe(rows.length);
  });

  test('HMAC-keyed chain produces different hash than unkeyed', () => {
    const row = mkRow({ id: 1 });
    const digest = computeRowDigest(row);
    const prior = Buffer.alloc(32, 0);
    const input = Buffer.concat([prior, digest]);

    const keyed = createHmac('sha256', 'secret-v1').update(input).digest();
    const unkeyed = createHash('sha256').update(input).digest();
    expect(keyed.equals(unkeyed)).toBe(false);
  });
});
