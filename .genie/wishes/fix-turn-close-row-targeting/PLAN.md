# Fix Plan: Turn-Close Row Targeting + Boot-Mode Terminal Check

**Type:** Fix (not a wish — ~30 LoC single-PR scope)
**Origin:** Closes `turn-session-contract` WISH.md Gap #1 + Gap #2 (Review Results section)
**Replaces:** `agent-row-unification` wish (rejected 2026-04-21 per council; archived at `_archive/agent-row-unification-rejected-2026-04-21/`)
**Date:** 2026-04-21

## Problem

Two in-flight regressions in the turn-session-contract feature on live instances:

**Gap #1 — `genie done` flips wrong agent row.** `src/lib/turn-close.ts:119-123` updates `agents SET current_executor_id=NULL WHERE current_executor_id=${executorId}`. This sweeps the UUID identity row (which holds the executor FK) but leaves the legacy name-keyed row in `state='spawning'`. Reconcile sees the live `spawning` row and auto-resumes the agent. Result: calling `genie done` does not actually terminate the agent; it resurrects on next daemon restart.

**Gap #2 — boot-mode reconcile bypasses executor-terminal check.** `src/lib/scheduler-daemon.ts:868-871` unconditionally delegates to `attemptAgentResume` in boot mode. The D1/D3 turn-aware rules are skipped. Any agent with `auto_resume=true` + valid `claudeSessionId` gets resumed regardless of whether its last executor is already closed. Result: properly-closed agents (ones that called `genie done` before daemon restart) are resurrected on every restart.

Both gaps are traced in detail at `.genie/wishes/turn-session-contract/WISH.md` Review Results section (lines 380-470). Live reproduction evidence is in PG audit log on the test team `turn-session-contract-genie` (this agent resumed 2x in a single night despite clean closes).

## Fix

Two edits in `src/lib/`, two matching test additions. Total: ~30 LoC + ~40 LoC of tests.

### Change 1 — `src/lib/turn-close.ts:119-123`

**Before:**
```typescript
await tx`
  UPDATE agents
  SET current_executor_id = NULL
  WHERE current_executor_id = ${executorId}
`;
```

**After:**
```typescript
// Flip the identity row's state directly via executor.agent_id — not the
// reverse-FK sweep used previously (which missed dual-row legacy pairs).
// Also defensively sweeps any legacy name-keyed row sharing (custom_name, team)
// to close out the dual-row pattern on pre-unification instances. Becomes a
// no-op when `agents-runtime-extraction` lands and dual rows no longer exist.
const [ident] = await tx<{ custom_name: string | null; team: string | null }[]>`
  UPDATE agents
  SET state = 'done', current_executor_id = NULL
  WHERE id = ${row.agent_id}
  RETURNING custom_name, team
`;
if (ident?.custom_name && ident?.team) {
  await tx`
    UPDATE agents
    SET state = 'done', current_executor_id = NULL
    WHERE custom_name = ${ident.custom_name}
      AND team = ${ident.team}
      AND id != ${row.agent_id}
  `;
}
```

### Change 2 — `src/lib/scheduler-daemon.ts`

**Add helper (place near `terminalizeCleanExitUnverified`, ~line 998):**
```typescript
/**
 * Gap #2 (turn-session-contract): boot-mode reconciler's D1/D3 bypass resurrects
 * properly-closed agents across daemon restart. Check returns true when the agent's
 * current executor is already terminal (closed_at set OR outcome set), meaning an
 * explicit close verb OR pane-exit trap already fired. Caller should skip resume.
 */
async function isLegitimatelyClosed(deps: SchedulerDeps, worker: WorkerInfo): Promise<boolean> {
  const executorId = worker.currentExecutorId;
  if (!executorId) return false;
  try {
    const sql = await deps.getConnection();
    const rows = await sql<{ closed_at: Date | null; outcome: string | null }[]>`
      SELECT closed_at, outcome FROM executors WHERE id = ${executorId}
    `;
    if (rows.length === 0) return false;
    return rows[0].closed_at !== null || rows[0].outcome !== null;
  } catch {
    // DB blip — err on the side of attempting resume (legacy behavior).
    return false;
  }
}
```

**Change `handleDeadPane` boot-mode branch (lines 868-871):**

**Before:**
```typescript
if (mode === 'boot') {
  const result = await attemptAgentResume(deps, config, worker);
  return result === 'resumed' ? 'resumed' : 'skipped';
}
```

**After:**
```typescript
if (mode === 'boot') {
  // Gap #2 fix: before resuming, check if the agent's executor is already
  // terminal. Otherwise we resurrect agents that called `genie done` before
  // the daemon restarted (2026-04-21 live regression).
  if (await isLegitimatelyClosed(deps, worker)) {
    deps.log({
      timestamp: deps.now().toISOString(),
      level: 'debug',
      event: 'agent_resume_skipped_boot_terminal',
      daemon_id: daemonId,
      agent_id: worker.id,
      reason: 'executor_already_closed',
    });
    return 'skipped';
  }
  const result = await attemptAgentResume(deps, config, worker);
  return result === 'resumed' ? 'resumed' : 'skipped';
}
```

### Test 1 — add to `src/lib/turn-close.test.ts`

```typescript
describe('Gap #1 regression — dual-row state flip', () => {
  it('flips both identity row and legacy name-keyed row to state=done', async () => {
    // Seed dual-row pair
    const teamName = 'gap1-test';
    const customName = 'gap1-agent';
    await sql`INSERT INTO agents (id, custom_name, team, state) VALUES (${customName}, ${customName}, ${teamName}, 'spawning')`;
    const [identity] = await sql`INSERT INTO agents (id, custom_name, team, state) VALUES (${randomUUID()}, ${customName}, ${teamName}, NULL) RETURNING id`;
    const [executor] = await sql`INSERT INTO executors (id, agent_id, state) VALUES (${randomUUID()}, ${identity.id}, 'running') RETURNING id`;
    await sql`UPDATE agents SET current_executor_id = ${executor.id} WHERE id = ${identity.id}`;

    await turnClose({ outcome: 'done', executorId: executor.id });

    const [identityAfter] = await sql`SELECT state FROM agents WHERE id = ${identity.id}`;
    const [legacyAfter]   = await sql`SELECT state FROM agents WHERE id = ${customName}`;
    expect(identityAfter.state).toBe('done');
    expect(legacyAfter.state).toBe('done');
  });
});
```

### Test 2 — add to `src/lib/__tests__/auto-resume-zombie-cap.test.ts`

```typescript
describe('Gap #2 regression — boot-mode terminal check', () => {
  it('skips resume for agent whose current executor is already terminal', async () => {
    const worker: WorkerInfo = makeTestWorker({ autoResume: true, claudeSessionId: 'sess-xyz', currentExecutorId: 'exec-done-1' });
    const deps: SchedulerDeps = makeTestDeps({
      getConnection: async () => sqlWithFixture({ executors: [{ id: 'exec-done-1', closed_at: new Date(), outcome: 'done' }] }),
    });

    const outcome = await handleDeadPane(deps, testConfig, 'daemon-1', worker, /* turnAware */ true, 'boot');
    expect(outcome).toBe('skipped');
    expect(deps.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'agent_resume_skipped_boot_terminal' }));
  });

  it('still resumes for agent with open executor in boot mode (no regression)', async () => {
    const worker: WorkerInfo = makeTestWorker({ autoResume: true, claudeSessionId: 'sess-xyz', currentExecutorId: 'exec-open-1' });
    const deps: SchedulerDeps = makeTestDeps({
      getConnection: async () => sqlWithFixture({ executors: [{ id: 'exec-open-1', closed_at: null, outcome: null }] }),
      resumeAgent: mock(async () => true),
    });

    const outcome = await handleDeadPane(deps, testConfig, 'daemon-1', worker, /* turnAware */ true, 'boot');
    expect(outcome).toBe('resumed');
  });
});
```

## Acceptance Criteria

- [ ] Agent in dual-row state calls `genie done` → both rows flip to `state='done'` in one transaction
- [ ] Agent with terminal executor does NOT resume on daemon boot
- [ ] Agent with open executor (mid-turn crash) STILL resumes on daemon boot (no regression)
- [ ] `bun run check` passes
- [ ] turn-session-contract WISH.md Review Results Gap #1 + Gap #2 can be marked resolved

## Validation

```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie
bun test src/lib/turn-close.test.ts
bun test src/lib/__tests__/auto-resume-zombie-cap.test.ts
bun run check
```

## Branch + commit

**Branch name:** `fix/turn-close-row-targeting` (from `dev`)

**Commit message (conventional commits):**
```
fix(turn-close): flip both identity + legacy rows; skip boot-resume of terminal executors

Closes turn-session-contract Gap #1 and Gap #2.

Gap #1: turnClose() was sweeping `agents.current_executor_id=NULL WHERE current_executor_id=...` which only flipped identity rows and left legacy name-keyed dual-row zombies in state='spawning'. Reconcile then auto-resumed them. Now updates identity row by executor's agent_id FK (direct key) and defensively sweeps any legacy row sharing (custom_name, team).

Gap #2: scheduler-daemon boot-mode bypassed the D1/D3 turn-aware rules, delegating unconditionally to attemptAgentResume. This resurrected properly-closed agents on every daemon restart. Now checks executor terminal state (closed_at IS NOT NULL OR outcome IS NOT NULL) before resume.

Architectural debt (runtime state still on agents table instead of executors) deferred to wish agents-runtime-extraction.

Refs: turn-session-contract/WISH.md Review Results (Gaps #1, #2, #4)
Refs: _archive/agent-row-unification-rejected-2026-04-21/council-report.md (why this path was chosen over full migration)
```

## PR description template

```markdown
## Summary

Close two live regressions in turn-session-contract:
- **Gap #1**: `genie done` leaves legacy name-keyed rows in `state='spawning'` → reconcile resurrects them
- **Gap #2**: daemon boot-mode unconditionally resumes agents with valid `claudeSessionId`, bypassing the turn-aware D1/D3 terminal check

30 LoC of source changes + 40 LoC of tests. No schema change. No flag. No migration.

## Context

This replaces the rejected `agent-row-unification` wish (archived at `.genie/wishes/_archive/agent-row-unification-rejected-2026-04-21/`). The council deliberation (preserved in that directory's `council-report.md`) concluded the full migration was over-engineered for the actual blast radius; the minimalist fix here closes the observed regressions with the minimum necessary code.

The architectural debt flagged by the council (runtime state living on `agents` instead of `executors`) is tracked in the sibling wish `agents-runtime-extraction`. This PR does not touch that layer.

## Test plan

- [ ] `bun test src/lib/turn-close.test.ts` — Gap #1 regression test passes
- [ ] `bun test src/lib/__tests__/auto-resume-zombie-cap.test.ts` — Gap #2 tests pass (terminal skip + open-executor resume preserved)
- [ ] `bun run check` — typecheck + lint + dead-code + existing tests pass
- [ ] Manual live-instance check: spawn agent, call `genie done`, restart daemon, verify no resume event within 60s
- [ ] Turn-session-contract WISH.md Review Results section can be updated to close Gap #1 + Gap #2

## Does not fix

- **Gap #3** (`GENIE_EXECUTOR_ID` env verification) — deferred; needs live-instance instrumentation to confirm, not a code change
- **Gap #5** (native-teams config schema: missing `workingDir`, auto-resume-appends-member) — separate wish needed (`native-teams-config-hardening`)
- Architectural cleanup (runtime columns on `agents`) — tracked in `agents-runtime-extraction` wish
```

## Ready to execute?

This plan is complete and ready. Two paths forward:

**Self-execute:** I apply the edits, create `fix/turn-close-row-targeting` branch from `dev`, commit with the message above, open PR against `dev`. Requires explicit user authorization per agent-bible (destructive branch op + commit).

**Engineer handoff:** User or a dispatched engineer picks up this PLAN.md, executes the same steps. Zero additional context needed — this doc is self-contained.

My default is the second path unless user explicitly says "execute" or "commit it now" — PLAN.md is non-destructive artifact, commits are not.
