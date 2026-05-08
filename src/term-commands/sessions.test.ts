/**
 * Tests for the `genie sessions repair-links --apply` safety gates.
 *
 * Convergent advisory finding from reviewer (3 LOW) and qa (2 WARN) on
 * Groups 1–3 of fix-agent-session-linkage: the gates exist and work but
 * had zero automated coverage.
 *
 * Coverage in this file:
 *   1. Drift gate — preview vs in-tx recount mismatch, no --force → throws
 *   2. Drift gate with --force → does not throw, returns result
 *   3. Ambiguity gate — ambiguous>0 + no --force → blocked
 *   4. Ambiguity gate with --force → not blocked
 *   5. No-work short-circuit — returns RepairLinksApplyResult-shaped zero result
 *      (closes JSON-shape inconsistency LOW from reviewer)
 *
 * Strategy: the safety-gate decisions live in two pure helpers
 * (`evaluateAmbiguityGate`, `buildNoWorkResultIfApplicable`) and one
 * transaction wrapper (`applyRepairTransaction`). All three are exported
 * from sessions.ts. Tests stub the postgres.js Sql client with the minimum
 * surface the transaction touches: tagged-template SQL, `.begin(cb)`, and
 * `tx.json(...)`. No live DB is required.
 */

import { describe, expect, test } from 'bun:test';
import { applyRepairTransaction, buildNoWorkResultIfApplicable, evaluateAmbiguityGate } from './sessions.js';

import type { SessionLinkDiagnostics } from '../lib/session-link-repair.js';

// ============================================================================
// Test fixtures — minimal SessionLinkDiagnostics builder
// ============================================================================

function makeDiag(overrides: Partial<SessionLinkDiagnostics> = {}): SessionLinkDiagnostics {
  return {
    linkableOrphanSessions: 0,
    totalSessions: 0,
    statusOrphanedSessions: 0,
    nullExecutorIdSessions: 0,
    totalToolEvents: 0,
    toolEventsMissingAgent: 0,
    toolEventsMissingTeam: 0,
    toolEventsMissingWish: 0,
    toolEventsMissingTask: 0,
    toolEventsLinkableMissingAttribution: 0,
    toolEventsEmptyStringAgent: 0,
    toolEventsEmptyStringTeam: 0,
    toolEventsEmptyStringWish: 0,
    toolEventsEmptyStringTask: 0,
    sessionsEmptyStringTeam: 0,
    sessionsEmptyStringWishSlug: 0,
    sessionsEmptyStringRole: 0,
    ...overrides,
  };
}

// ============================================================================
// Stubbed postgres.js Sql client for applyRepairTransaction
//
// applyRepairTransaction issues four queries inside sql.begin(...):
//   1. SELECT count(*)::int AS n FROM sessions s JOIN executors e ...   (recount)
//   2. UPDATE sessions s SET ... FROM executors e ...                    (link)
//   3. UPDATE tool_events te SET ... FROM sessions s ...                 (backfill)
//   4. INSERT INTO audit_events ...                                      (audit row)
// We dispatch on substring of the rendered template to return shaped results.
// ============================================================================

interface StubScenario {
  recount: number;
  linkUpdateCount: number;
  teUpdateCount: number;
}

interface StubSql {
  (strings: TemplateStringsArray, ...values: unknown[]): unknown;
  begin: (cb: (tx: StubSql) => Promise<unknown>) => Promise<unknown>;
  json: (obj: unknown) => unknown;
  /** Captured SQL templates for assertion. */
  capturedSql: string[];
}

function makeStubSql(scenario: StubScenario): StubSql {
  const captured: string[] = [];

  const dispatch = (strings: TemplateStringsArray, ..._values: unknown[]): unknown => {
    const text = strings.join('?');
    captured.push(text);

    if (text.includes('SELECT count(*)::int AS n')) {
      return [{ n: scenario.recount }];
    }
    if (text.includes('UPDATE sessions s SET')) {
      // postgres.js UPDATE returns an array with a `.count` property.
      const arr: unknown[] & { count?: number } = [];
      arr.count = scenario.linkUpdateCount;
      return arr;
    }
    if (text.includes('UPDATE tool_events te SET')) {
      const arr: unknown[] & { count?: number } = [];
      arr.count = scenario.teUpdateCount;
      return arr;
    }
    if (text.includes('INSERT INTO audit_events')) {
      return [];
    }
    return [];
  };

  const sql = dispatch as unknown as StubSql;
  sql.capturedSql = captured;
  sql.json = (obj: unknown) => obj;
  sql.begin = async (cb) => {
    return cb(sql);
  };
  return sql;
}

// ============================================================================
// 1+2. Drift gate
// ============================================================================

describe('applyRepairTransaction — drift gate', () => {
  test('throws when in-tx recount differs from previewCount and not forced', async () => {
    const sql = makeStubSql({ recount: 7, linkUpdateCount: 0, teUpdateCount: 0 });
    // previewCount=5, recount=7 → drift, force=false → throws
    await expect(applyRepairTransaction(sql, 5, false)).rejects.toThrow(
      /candidate count drifted between preview \(5\) and apply \(7\)/,
    );
    // The drift abort lands BEFORE either UPDATE runs.
    expect(sql.capturedSql.some((s) => s.includes('UPDATE sessions s SET'))).toBe(false);
    expect(sql.capturedSql.some((s) => s.includes('UPDATE tool_events te SET'))).toBe(false);
  });

  test('does not throw when forced — proceeds through the transaction', async () => {
    const sql = makeStubSql({ recount: 7, linkUpdateCount: 7, teUpdateCount: 42 });
    // previewCount=5, recount=7 → drift, force=true → proceeds
    const result = await applyRepairTransaction(sql, 5, true);
    expect(result.sessionsLinked).toBe(7);
    expect(result.toolEventsBackfilled).toBe(42);
    expect(result.forced).toBe(true);
    expect(result.driftDetected).toBe(false);
    // Both UPDATEs and the audit row landed.
    expect(sql.capturedSql.some((s) => s.includes('UPDATE sessions s SET'))).toBe(true);
    expect(sql.capturedSql.some((s) => s.includes('UPDATE tool_events te SET'))).toBe(true);
    expect(sql.capturedSql.some((s) => s.includes('INSERT INTO audit_events'))).toBe(true);
  });

  test('does not throw when recount matches preview (no drift)', async () => {
    const sql = makeStubSql({ recount: 5, linkUpdateCount: 5, teUpdateCount: 12 });
    const result = await applyRepairTransaction(sql, 5, false);
    expect(result.sessionsLinked).toBe(5);
    expect(result.toolEventsBackfilled).toBe(12);
    expect(result.forced).toBe(false);
  });
});

// ============================================================================
// 3+4. Ambiguity gate
// ============================================================================

describe('evaluateAmbiguityGate', () => {
  test('blocks --apply when ambiguous > 0 and not forced', () => {
    const r = evaluateAmbiguityGate(3, false);
    expect(r.blocked).toBe(true);
    expect(r.message).toContain('3 ambiguous claude_session_id');
    expect(r.message).toContain('refusing --apply');
  });

  test('does not block when --force is passed even with ambiguous matches', () => {
    const r = evaluateAmbiguityGate(3, true);
    expect(r.blocked).toBe(false);
    expect(r.message).toBeNull();
  });

  test('does not block when ambiguous count is zero', () => {
    const r = evaluateAmbiguityGate(0, false);
    expect(r.blocked).toBe(false);
    expect(r.message).toBeNull();
  });
});

// ============================================================================
// 5. No-work short-circuit + JSON-shape consistency (closes reviewer LOW B)
// ============================================================================

describe('buildNoWorkResultIfApplicable', () => {
  test('returns a RepairLinksApplyResult-shaped zero object when nothing to repair', () => {
    const diag = makeDiag({ linkableOrphanSessions: 0, toolEventsLinkableMissingAttribution: 0 });
    const r = buildNoWorkResultIfApplicable(diag, 0, false);
    expect(r).not.toBeNull();
    // Same keys as RepairLinksApplyResult on the apply path — JSON consumers
    // see one schema regardless of whether work was performed.
    expect(r).toEqual({
      sessionsLinked: 0,
      toolEventsBackfilled: 0,
      ambiguousCount: 0,
      forced: false,
      driftDetected: false,
    });
  });

  test('threads ambiguousCount and forced into the result for transparency', () => {
    const diag = makeDiag({ linkableOrphanSessions: 0, toolEventsLinkableMissingAttribution: 0 });
    const r = buildNoWorkResultIfApplicable(diag, 4, true);
    expect(r).toEqual({
      sessionsLinked: 0,
      toolEventsBackfilled: 0,
      ambiguousCount: 4,
      forced: true,
      driftDetected: false,
    });
  });

  test('returns null when there is repair work pending (linkable orphans)', () => {
    const diag = makeDiag({ linkableOrphanSessions: 5, toolEventsLinkableMissingAttribution: 0 });
    expect(buildNoWorkResultIfApplicable(diag, 0, false)).toBeNull();
  });

  test('returns null when there is repair work pending (tool_events backlog)', () => {
    const diag = makeDiag({ linkableOrphanSessions: 0, toolEventsLinkableMissingAttribution: 200 });
    expect(buildNoWorkResultIfApplicable(diag, 0, false)).toBeNull();
  });
});
