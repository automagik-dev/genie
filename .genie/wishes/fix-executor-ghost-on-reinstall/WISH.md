# Wish: Fix Executor Ghost on Reinstall — Workers Can Always Close Their Turn

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-executor-ghost-on-reinstall` |
| **Date** | 2026-04-21 |
| **Design** | _Sibling to `fix-pg-disk-rehydration` (PR #1249, merged) — same root-cause family_ |
| **Parent incident** | live genie-stefani server: agent `genie-configure` session had `GENIE_EXECUTOR_ID=49483b1e-…` in env, row didn't exist in `executors` table; all three turn-close verbs (`done`/`blocked`/`failed`) threw `executor not found` — unrecoverable without raw SQL |

## Summary

After any `pgserve` reset, reinstall, or schema reboot, live worker sessions retain their `GENIE_EXECUTOR_ID` env var — but the matching row in the `executors` table is gone. `turnClose` (the shared impl behind `genie done` / `genie blocked` / `genie failed`) does a hard `SELECT state, outcome, agent_id FROM executors WHERE id = ${env}` and throws `executor not found` when zero rows return. `resolveExecutorId` has no name-based fallback — confirmed by its own test (`turn-close.test.ts:174` explicitly asserts "errors loudly when no executor id is resolvable"). The FK constraint `executors_agent_id_fkey` forbids a naive INSERT to paper over the ghost — the user has to first materialize (or find) a matching `agents.id` row, then insert the executor, then retry. Result: **every pgserve reset permanently strands every live worker** — they can continue working but can never signal completion, so the turn-session contract stays open, `auto_resume` sees a stuck row, and the orchestrator loses track. This wish makes ghosts self-heal: the resolver falls back to `agent_id` when the env UUID doesn't resolve, and `genie serve` boot reconciles live workers' env vars against the `executors` table, resurrecting or warning as needed.

## Scope

### IN
- **Bug E — Resolver has no fallback.** `resolveExecutorId(opts)` in `src/lib/turn-close.ts` (or wherever the shared impl lives) is modified: if `GENIE_EXECUTOR_ID` is set but no row exists, attempt `SELECT id FROM executors WHERE agent_id = $GENIE_AGENT_NAME ORDER BY started_at DESC LIMIT 1` before throwing. On hit, emit a one-line warning (`[turn-close] executor <env-id> not found, falling back to agent_id '<name>' → <resolved-id>`) so the drift is visible in logs. On miss, throw the same `executor not found` error as today (but with the fallback attempted in the message).
- **Bug F — Boot-time resurrection.** On `genie serve` start, after migrations + seed, iterate live tmux panes with `GENIE_WORKER=1` env, read each pane's `GENIE_EXECUTOR_ID` + `GENIE_AGENT_NAME`, and for every env pair where the executor row is missing, either (a) resurrect a minimal row if the `agents.id = GENIE_AGENT_NAME` exists, OR (b) log a warning that the worker is orphaned. Emit one summary event: `{ ghosts_resurrected: N, ghosts_unrecoverable: M }`. Best-effort — never block boot.
- **Migration 046 — Verify FK.** Add `ON DELETE SET NULL` semantics to `agents.current_executor_id → executors.id` FK so that dropping an executor row doesn't cascade-delete the agent. (Already the case? Audit first; only change if missing.) Non-destructive audit migration.
- **Audit event.** New `rot.executor-ghost.detected` audit event emitted by both the resolver fallback AND the boot reconciler so operators can watch for ghost-rate trends.

### OUT
- Claude Code harness env-var handling (we can't retroactively change env vars in already-running panes — only compensate at the resolver + boot reconciler layer).
- Cross-process IPC for env-var updates on live workers (out of scope; boot reconciler handles the reset case).
- Unifying `GENIE_EXECUTOR_ID` with the UUID-vs-literal agent-id drift enumerated in the `fix-pg-disk-rehydration` Dependencies section (that's a separate multi-wish effort; this one only fixes ghost-resolution, not the 3-format coexistence).
- Auto-deleting executor rows on pane death (orthogonal — existing reconciler handles that).
- `genie kill` UX improvements (lives in its own sibling wish backlog).

## Dependencies & Prerequisites

This wish **builds on** `fix-pg-disk-rehydration` (PR #1249, merged) — the teams rehydration story. The `agents.id` rows are the FK target for `executors.agent_id`, so the teams-side rehydration must land first so that the boot reconciler has live `agents` rows to match ghost env vars against.

The **3 coexisting agent-id formats** (`dir:*` / UUID / literal string) remain OUT of scope — see the sibling wish `agents-id-unification (TBD)`. The resolver fallback in this wish looks up by `GENIE_AGENT_NAME` (the literal-string form that appears in worker env), so it works regardless of how the ID story evolves later.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Resolver fallback uses **`agent_id = GENIE_AGENT_NAME`**, not `agent_id LIKE '%<name>%'` | Exact match is the only safe semantics — partial matches could resolve to the wrong worker's executor. If the agent row doesn't exist, we fail loudly (no silent miss). |
| Resolver picks **most recent by `started_at`** on multi-hit | Long-running workers accumulate multiple executor rows over time (one per `agent resume` etc.). Most recent is the live one. |
| Boot reconciler is **best-effort** — failures don't block `genie serve` | Matches the policy of `pg-seed`, `backfillTeamRow`, and every other boot-time rehydration path. Operators see warnings; boot continues. |
| New audit event `rot.executor-ghost.detected`, not reuse `rot.team-ls-drift.detected` | Different subsystem, different signal. Consumers/dashboards can filter independently. Cheap to add. |
| No code change to Claude Code harness env injection | Not owned by this repo. The resolver + reconciler are the correct boundary. |
| Minimal executor row shape for resurrection: `id, agent_id, provider, transport, state='running', started_at=now(), metadata='{}'` | Matches what ghost rows would look like if they were never wiped. Let reconciler update state/metadata later as events arrive. |

## Success Criteria

- [ ] After `pgserve` wipe + `genie serve start`, live workers with stale `GENIE_EXECUTOR_ID` env vars can still run `genie done` / `genie blocked` / `genie failed` successfully without raw SQL intervention.
- [ ] `genie done` emits a warning to stderr when it falls back to name-resolution (so operators notice drift).
- [ ] Boot reconciler summary event logged on every `genie serve` start: `{ ghosts_resurrected, ghosts_unrecoverable }`. Zero on a clean boot.
- [ ] `resolveExecutorId` still throws loudly when NEITHER env UUID NOR `agent_id` resolves — no silent no-op close.
- [ ] `rot.executor-ghost.detected` event shape matches the pattern of `rot.team-ls-drift.detected` (tier-tagged, redacted, capped size).
- [ ] Repro script `scripts/tests/repro-executor-ghost.sh` passes: spawn a worker, wipe PG executors, assert `genie done` from that worker succeeds via fallback.
- [ ] `bun run check` passes (typecheck + lint + test).
- [ ] No regression to `resolveExecutorId` happy-path behavior (env UUID present + row exists → resolves directly, no extra SELECT).

## Execution Strategy

### Wave 1 (parallel — resolver and reconciler are independent files)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Bug E — resolver fallback in `src/lib/turn-close.ts`; emits `rot.executor-ghost.detected` audit event; warning to stderr. |
| 2 | engineer | Bug F — boot reconciler in `src/term-commands/serve.ts` (post-seed hook); iterate live panes, resurrect or warn; emit summary event. |

### Wave 2 (validation, after Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Repro script + bun tests for both paths. |
| review | reviewer | Full review against success criteria. |

## Execution Groups

### Group 1: Resolver fallback — Bug E

**Goal:** `turnClose` survives the env-UUID-ghost case by falling back to `agent_id` lookup, with a visible warning.

**Deliverables:**
1. `src/lib/turn-close.ts` (or wherever `resolveExecutorId` lives — locate via grep): add fallback branch.
   ```ts
   // Inside resolveExecutorId after the env-UUID lookup returns 0 rows:
   const envId = process.env.GENIE_EXECUTOR_ID;
   const agentName = process.env.GENIE_AGENT_NAME;
   if (envId && agentName) {
     const [hit] = await sql`
       SELECT id FROM executors
       WHERE agent_id = ${agentName}
       ORDER BY started_at DESC LIMIT 1
     `;
     if (hit) {
       console.warn(`[turn-close] executor ${envId} not found, falling back to agent_id='${agentName}' → ${hit.id}`);
       await emit('rot.executor-ghost.detected', { env_id: envId, resolved_id: hit.id, agent_name: agentName });
       return hit.id;
     }
   }
   throw new Error(`turnClose: executor ${envId} not found (no fallback by agent_id)`);
   ```
2. `src/lib/events/schemas/rot.executor-ghost.detected.ts` — new event schema, modeled on `rot.team-ls-drift.detected.ts`. Fields: `env_id`, `resolved_id`, `agent_name`, `resolution_source` enum (`'resolver' | 'reconciler'`).
3. `src/lib/turn-close.test.ts` — new tests:
   - "falls back to agent_id when env UUID not found"
   - "throws when neither env nor agent_id resolves"
   - "emits rot.executor-ghost.detected on fallback"
   - "happy path unchanged — env UUID + row present takes one SELECT"

**Acceptance Criteria:**
- [ ] `genie done` succeeds after a pgserve wipe provided the `agents` row still exists.
- [ ] Stderr warning on every fallback (ghost-visibility requirement).
- [ ] Happy-path query count unchanged (verified by mock).
- [ ] Bun tests pass.

**Validation:**
```bash
bun test src/lib/turn-close.test.ts -t "fallback"
```

**depends-on:** none.

---

### Group 2: Boot reconciler — Bug F

**Goal:** `genie serve` start proactively resurrects executor rows for live workers whose env UUIDs point to missing rows, so the first `genie done` doesn't need the resolver fallback.

**Deliverables:**
1. `src/term-commands/serve.ts`: after `runMigrations` + `runSeed`, invoke a new `reconcileExecutorGhosts()` function.
2. `src/lib/executor-registry.ts` (or new `executor-ghost-reconciler.ts`): implement `reconcileExecutorGhosts()`:
   - Read live tmux panes via `tmux list-panes -a -F '#{pane_id} #{pane_current_command}'` scoped to the genie socket.
   - For each pane, read env vars via `tmux show-environment -t <pane> GENIE_EXECUTOR_ID GENIE_AGENT_NAME GENIE_TEAM`.
   - For each pane with `GENIE_EXECUTOR_ID` set, check if the row exists in `executors`.
   - If missing AND `agents.id = GENIE_AGENT_NAME` exists: INSERT a minimal row (same shape as the incident-workaround: `id, agent_id, provider='claude', transport='tmux', state='running', started_at=now(), metadata='{}'`).
   - If missing AND agent row also missing: log warning with pane + env, skip (unrecoverable — likely a dead worker).
   - Tally and emit one `rot.executor-ghost.detected` summary event: `{ ghosts_resurrected: N, ghosts_unrecoverable: M, resolution_source: 'reconciler' }`.
3. `src/lib/executor-ghost-reconciler.test.ts` — test each branch with a mock tmux + PG.

**Acceptance Criteria:**
- [ ] After a clean boot with no live workers, reconciler logs nothing and emits `ghosts_resurrected: 0, ghosts_unrecoverable: 0`.
- [ ] After a pgserve wipe + reboot with 3 live workers, all 3 have `executors` rows inside `serve` start time.
- [ ] Dead workers (env var set but pane gone) do not get rows inserted.
- [ ] Reconciler failure does NOT block `genie serve` startup.
- [ ] Bun tests pass.

**Validation:**
```bash
bun test src/lib/executor-ghost-reconciler.test.ts
bun test src/term-commands/serve.test.ts -t "executor ghost reconcile"
```

**depends-on:** none (uses Group 1's event schema but event emission is best-effort).

---

### Group 3: Repro script + QA

**Goal:** Prove end-to-end that the executor-ghost case is fully automated.

**Deliverables:**
1. `scripts/tests/repro-executor-ghost.sh`:
   - **S1** (Bug E — resolver fallback): Spawn a worker. Delete its `executors` row. Run `genie done` from the worker's env. Assert exit 0 + warning on stderr + `rot.executor-ghost.detected` event.
   - **S2** (Bug F — boot reconciler): Spawn a worker. Wipe ALL executors. Restart `genie serve`. Assert the worker's executor row reappears before any manual close.
   - **S3** (unrecoverable path): Set env to a name with no matching agent row. `genie done`. Assert exit non-zero with clear error.
2. Manual QA checklist.

**Acceptance Criteria:**
- [ ] `bash scripts/tests/repro-executor-ghost.sh` exits 0 on Linux.
- [ ] Each scenario prints ✅/❌ with the assertion.
- [ ] Script cleans up spawned workers on both success and failure.

**Validation:**
```bash
bash scripts/tests/repro-executor-ghost.sh
```

**depends-on:** Groups 1 + 2.

---

## QA Criteria

_Tested on dev after merge before declaring the wish done._

- [ ] Repro: `rm -rf ~/.genie/data/pgserve && genie serve start` on a machine with ≥1 live worker — worker can run `genie done` without raw SQL.
- [ ] Scheduler log shows a `ghosts_resurrected` summary on boot, zero on a subsequent idle boot.
- [ ] Resolver fallback emits stderr warning every time it resolves by name (verified by grepping a live scheduler.log).
- [ ] No regression on happy-path turn-close latency (micro-bench with mock sql).
- [ ] Live incident server (`genie-stefani`) no longer requires the manual `INSERT INTO executors` workaround used on 2026-04-21.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `tmux show-environment` output format differs across tmux versions | Low | Parse defensively; skip panes whose env can't be read; they'll fall through to Group 1 resolver fallback on their own when they close. |
| Resolver fallback adds one SELECT per turn-close in the miss case | Low | Only fires when the primary lookup returns 0 rows — i.e. the session is already known-drifted. Zero cost on happy path. |
| Multiple executor rows for the same `agent_id` (from `agent resume`) confuse the fallback | Low | `ORDER BY started_at DESC LIMIT 1` picks the most recent. Matches intent (live session). |
| Boot reconciler races against new spawns during `serve` startup | Low | Reconciler runs before the spawn accept loop opens. If a spawn races in anyway, the new executor row was just INSERTed by the spawn path — reconciler's ON CONFLICT DO NOTHING keeps it. |
| Worker holds a now-stale `env_id` that happens to collide with a future resurrected UUID | Very low | UUIDs are 128-bit. Collision rate is astronomically small; not mitigating. |
| The agent's `agent_id` literal string changes at some point (e.g. role rename) | Low | Fallback is point-in-time at turn-close. If agent is renamed mid-session, the close may fail — rename ops can emit a new executor row explicitly. |

---

## Review Results

### Plan Review — DRAFT (awaiting first review)

_To be populated by `/review` after this wish is assigned._

**Open questions for reviewer:**
- Should the boot reconciler also fire periodically (e.g. every N scheduler ticks), not just on boot? Current scope is boot-only.
- For unrecoverable ghosts (env set, no agent row), should we also clean up the env by tmux `set-environment -u` so the worker stops hitting the throw repeatedly? Currently we only log.
- Is a new event schema warranted, or should we shoehorn this onto `rot.team-ls-drift.detected` with a `kind='executor_ghost'`? Separate event is cleaner but adds one file.

_Execution review — populated after `/work` completes._

---

## Files to Create/Modify

```
Modify:
  src/lib/turn-close.ts                     # Bug E — resolver fallback
  src/term-commands/serve.ts                # Bug F — call reconcileExecutorGhosts after seed

Create:
  src/lib/executor-ghost-reconciler.ts      # Bug F — reconciler impl
  src/lib/events/schemas/rot.executor-ghost.detected.ts  # new event schema
  scripts/tests/repro-executor-ghost.sh     # Group 3 repro
  .genie/wishes/fix-executor-ghost-on-reinstall/WISH.md  # this file

Test additions:
  src/lib/turn-close.test.ts                # resolver fallback + ghost event
  src/lib/executor-ghost-reconciler.test.ts # all reconciler branches
  src/term-commands/serve.test.ts           # boot hook invocation
```

---

## Live Incident Reference

**Server:** `genie-stefani`, 2026-04-21 ~04:30 UTC, directly after `genie update` (installed 4.260421.3 containing the `fix-pg-disk-rehydration` fix).

**Symptom:** `genie done` from agent `genie-configure` threw:
```
error: turnClose: executor 49483b1e-ebd6-4d7a-b824-fffa945ec052 not found
```

**Investigation:**
- `GENIE_EXECUTOR_ID=49483b1e-ebd6-4d7a-b824-fffa945ec052` in worker env.
- `SELECT count(*) FROM executors` → 27 rows present.
- `SELECT * FROM executors WHERE id = '49483b1e-...' OR agent_id LIKE '%genie-configure%'` → **0 rows**.
- `SELECT * FROM agents WHERE id = 'genie-configure'` → **1 row** (so the agent row existed — only the executor was a ghost).

**Workaround applied (not scalable):**
```sql
INSERT INTO executors (id, agent_id, provider, transport, state, metadata, started_at)
VALUES ('49483b1e-ebd6-4d7a-b824-fffa945ec052', 'genie-configure', 'claude', 'tmux',
        'running', '{}'::jsonb, now())
ON CONFLICT (id) DO NOTHING;
```

First attempt failed on `executors_agent_id_fkey` with `agent_id='genie-configure@genie-docs'`; second attempt with bare `'genie-configure'` succeeded (matched existing agents row). Then `genie done` succeeded.

**Why the fix-pg-disk-rehydration update didn't self-heal this:** that wish rehydrates `teams` from disk configs. There is no equivalent on-disk source of truth for `executors` — they're runtime-only — so the seed has nothing to read from. This wish is the correct scope to fix the executor-side of the same family of bugs.
