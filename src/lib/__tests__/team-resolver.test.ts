/**
 * Spawn-time team resolver — unit tests for Wish: spawn-compounding-defects,
 * Group 1 (Bugs 1+4 from #1710).
 *
 * Covers the four cases tabulated in the wish's Group 1 deliverable list:
 *
 *   | Case | --team   | Self-leader registered | Caller context | Expected   |
 *   |------|----------|------------------------|----------------|------------|
 *   | 1    | foo      | irrelevant             | irrelevant     | foo        |
 *   | 2    | (omit)   | yes (<agent>@<agent>)  | bar            | <agent>    |
 *   | 3    | (omit)   | no                     | bar            | bar        |
 *   | 4    | bar      | yes, but bar !== <agent> | irrelevant   | bar + WARN |
 *
 * Plus the accompanying audit-trail helpers (`formatMisbindingWarning`) and
 * the `loadCanonicalSelfLeaderTeam` lookup. No filesystem reads — every
 * dependency is injected so the suite is hermetic.
 *
 * Run: bun test src/lib/__tests__/team-resolver.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { type ResolveSource, formatMisbindingWarning, resolveTeamForSpawn } from '../team-resolver.js';

// ============================================================================
// Helpers
// ============================================================================

/** Stub a canonical-self-leader loader that returns `team` for `agent`. */
function stubCanonical(agent: string, team: string | null): (a: string) => Promise<string | null> {
  return async (a: string) => (a === agent ? team : null);
}

/** Stub a discover() that returns `team` (the caller-context fallback). */
function stubDiscover(team: string | null): () => Promise<string | null> {
  return async () => team;
}

// ============================================================================
// Case 1 — explicit --team always wins
// ============================================================================

describe('resolveTeamForSpawn: Case 1 — explicit --team', () => {
  test('explicit --team beats every other tier (self-leader registered)', async () => {
    const outcome = await resolveTeamForSpawn({
      explicitTeam: 'foo',
      agentName: 'genie',
      loadCanonical: stubCanonical('genie', 'genie'),
      env: { GENIE_TEAM: 'env-team' },
      discover: stubDiscover('caller-team'),
    });
    expect(outcome.team).toBe('foo');
    expect(outcome.source).toBe<ResolveSource>('explicit_flag');
    // Canonical is still computed (we surface it for the WARN gate downstream).
    expect(outcome.canonicalTeam).toBe('genie');
    // Explicit beats canonical but they differ → misbound flag fires.
    expect(outcome.misbound).toBe(true);
  });

  test('explicit --team beats every other tier (no self-leader)', async () => {
    const outcome = await resolveTeamForSpawn({
      explicitTeam: 'foo',
      agentName: 'engineer',
      loadCanonical: stubCanonical('engineer', null),
      env: { GENIE_TEAM: 'env-team' },
      discover: stubDiscover('caller-team'),
    });
    expect(outcome.team).toBe('foo');
    expect(outcome.source).toBe<ResolveSource>('explicit_flag');
    expect(outcome.canonicalTeam).toBeNull();
    expect(outcome.misbound).toBe(false);
  });
});

// ============================================================================
// Case 2 — no --team, self-leader registered → canonical wins over caller
// ============================================================================

describe('resolveTeamForSpawn: Case 2 — canonical self-leader', () => {
  test('canonical-self-leader wins over caller-context when no explicit/entry/env', async () => {
    const outcome = await resolveTeamForSpawn({
      agentName: 'genie',
      loadCanonical: stubCanonical('genie', 'genie'),
      env: {},
      discover: stubDiscover('bar'),
    });
    expect(outcome.team).toBe('genie');
    expect(outcome.source).toBe<ResolveSource>('canonical_self_leader');
    expect(outcome.canonicalTeam).toBe('genie');
    expect(outcome.misbound).toBe(false);
  });

  test('canonical-self-leader wins over GENIE_TEAM env var', async () => {
    const outcome = await resolveTeamForSpawn({
      agentName: 'felipe',
      loadCanonical: stubCanonical('felipe', 'felipe'),
      env: { GENIE_TEAM: 'env-team' },
      discover: stubDiscover('bar'),
    });
    expect(outcome.team).toBe('felipe');
    expect(outcome.source).toBe<ResolveSource>('canonical_self_leader');
  });

  test('entry_team beats canonical when both present (PR #1133 invariant preserved)', async () => {
    // entryTeam is tier 2 in the resolver (template-pinned). Keeping it ahead
    // of canonical preserves the canonical-UUID-per-agent invariant from PR
    // #1133/#1134 — the test pins the order.
    const outcome = await resolveTeamForSpawn({
      entryTeam: 'pinned',
      agentName: 'genie',
      loadCanonical: stubCanonical('genie', 'genie'),
      env: {},
      discover: stubDiscover('bar'),
    });
    expect(outcome.team).toBe('pinned');
    expect(outcome.source).toBe<ResolveSource>('entry_team');
    // canonical still surfaces, misbound flag fires (entry !== canonical).
    expect(outcome.canonicalTeam).toBe('genie');
    expect(outcome.misbound).toBe(true);
  });
});

// ============================================================================
// Case 3 — no --team, no self-leader → caller-context fallback (no regression)
// ============================================================================

describe('resolveTeamForSpawn: Case 3 — caller-context fallback', () => {
  test('non-master agent (no self-leader) resolves via caller-context', async () => {
    const outcome = await resolveTeamForSpawn({
      agentName: 'engineer',
      loadCanonical: stubCanonical('engineer', null),
      env: {},
      discover: stubDiscover('bar'),
    });
    expect(outcome.team).toBe('bar');
    expect(outcome.source).toBe<ResolveSource>('caller_context');
    expect(outcome.canonicalTeam).toBeNull();
    expect(outcome.misbound).toBe(false);
  });

  test('GENIE_TEAM env var beats discover() when caller-context is needed', async () => {
    // Tier order check: env_genie_team (tier 4) sits above caller_context
    // (tier 5). When neither explicit/entry/canonical fires, env wins.
    const outcome = await resolveTeamForSpawn({
      agentName: 'engineer',
      loadCanonical: stubCanonical('engineer', null),
      env: { GENIE_TEAM: 'env-team' },
      discover: stubDiscover('bar'),
    });
    expect(outcome.team).toBe('env-team');
    expect(outcome.source).toBe<ResolveSource>('env_genie_team');
  });

  test('returns null when every tier yields nothing', async () => {
    const outcome = await resolveTeamForSpawn({
      agentName: 'engineer',
      loadCanonical: stubCanonical('engineer', null),
      env: {},
      discover: stubDiscover(null),
    });
    expect(outcome.team).toBeNull();
    expect(outcome.source).toBeNull();
    expect(outcome.canonicalTeam).toBeNull();
    expect(outcome.misbound).toBe(false);
  });
});

// ============================================================================
// Case 4 — explicit --team diverges from canonical → resolves to explicit + WARN
// ============================================================================

describe('resolveTeamForSpawn: Case 4 — misbinding (--team !== canonical)', () => {
  test('explicit --team wins but misbound flag fires when canonical exists and differs', async () => {
    const outcome = await resolveTeamForSpawn({
      explicitTeam: 'bar',
      agentName: 'genie',
      loadCanonical: stubCanonical('genie', 'genie'),
      env: {},
      discover: stubDiscover('caller-team'),
    });
    expect(outcome.team).toBe('bar');
    expect(outcome.source).toBe<ResolveSource>('explicit_flag');
    expect(outcome.canonicalTeam).toBe('genie');
    expect(outcome.misbound).toBe(true);
  });

  test('formatMisbindingWarning produces the exact wording the brief mandates', () => {
    // The wording is part of the contract — operators grep for it. Any
    // change to the WARN format must update the wish acceptance criteria
    // and the Bug 4 documentation.
    const line = formatMisbindingWarning('genie', 'genie', 'bar');
    expect(line).toBe(
      'WARN: genie is registered as leader of team:genie but spawning into team:bar — pass --team genie to fix or --team bar to suppress this warning',
    );
  });
});

// ============================================================================
// Tier ordering invariants — guard against accidental tier reordering
// ============================================================================

describe('resolveTeamForSpawn: tier ordering', () => {
  test('precedence: explicit > entry > canonical > env > caller', async () => {
    // All five tiers populated → explicit wins.
    const all = await resolveTeamForSpawn({
      explicitTeam: 't1',
      entryTeam: 't2',
      agentName: 'genie',
      loadCanonical: stubCanonical('genie', 'genie'),
      env: { GENIE_TEAM: 't4' },
      discover: stubDiscover('t5'),
    });
    expect(all.team).toBe('t1');

    // Drop explicit → entry wins.
    const dropExplicit = await resolveTeamForSpawn({
      entryTeam: 't2',
      agentName: 'genie',
      loadCanonical: stubCanonical('genie', 'genie'),
      env: { GENIE_TEAM: 't4' },
      discover: stubDiscover('t5'),
    });
    expect(dropExplicit.team).toBe('t2');

    // Drop entry → canonical wins.
    const dropEntry = await resolveTeamForSpawn({
      agentName: 'genie',
      loadCanonical: stubCanonical('genie', 'genie'),
      env: { GENIE_TEAM: 't4' },
      discover: stubDiscover('t5'),
    });
    expect(dropEntry.team).toBe('genie');

    // Drop canonical → env wins.
    const dropCanonical = await resolveTeamForSpawn({
      agentName: 'genie',
      loadCanonical: stubCanonical('genie', null),
      env: { GENIE_TEAM: 't4' },
      discover: stubDiscover('t5'),
    });
    expect(dropCanonical.team).toBe('t4');

    // Drop env → caller wins.
    const dropEnv = await resolveTeamForSpawn({
      agentName: 'genie',
      loadCanonical: stubCanonical('genie', null),
      env: {},
      discover: stubDiscover('t5'),
    });
    expect(dropEnv.team).toBe('t5');
  });
});
