# Genie State Machine — the 10-minute read

> Three layers. One chokepoint. One surface. Read this once and the boot pass,
> the resume rules, and the `genie done` semantics stop being mysterious.

This document is the source of truth for how Genie thinks about agent
lifecycle, identity, runs, tasks, and the `genie status` / `genie done` /
`genie serve start` verbs that operate on them. It is paired with
`src/__tests__/state-machine.invariants.test.ts`, which converts the contracts
below into executable assertions. If this doc and the tests disagree, the
tests are wrong by definition; this is what we promise.

## Why this exists

The 2026-04-25 power outage stranded two team-leads in PG state nobody could
agree on. One consumer's "permanent" was another consumer's "task." The boot
pass tried to recover both as task-bound, the JSONL fallback tried to recover
both as permanent, and the operator spent two hours running ad-hoc SQL to
reconcile them by hand. The audit log captured every step; nothing was
listening.

The fragmentation had three roots:

1. **Many readers, no chokepoint.** Eight call sites reinvented "should this
   agent resume?" with subtly different JOINs. They diverged.
2. **Convention-only permanence.** `id LIKE 'dir:%'` was scattered across the
   codebase. One sweep that missed two files re-created the divergence.
3. **No aggregator.** Every observability surface (`ls`, `doctor`, `events`)
   computed its own truth. The operator memorized 28 different commands to
   answer one question: "is this safe to leave alone?"

This doc describes the post-fix world. Three layers, one chokepoint, one
surface. The 3am runbook is `genie serve start && genie status`.

## The three layers

| Layer | Table | Owns | Lifecycle |
|-------|-------|------|-----------|
| **Identity** | `agents` | who exists; team, role, parent, kind | survives across reboots |
| **Run** | `executors` | the OS-level process; tmux pane, claude session UUID | dies on crash, replaced on resume |
| **Task** | `assignments` | what the run is currently doing; wish, group, outcome | closes when work completes |

```
agents (identity)
  └── current_executor_id ──► executors (run)
                                  └── (1:N) ──► assignments (task)
```

**Identity is durable.** Restarting `serve` does not delete `agents` rows.
Agents 6 months old still appear in `genie ls`.

**Runs are ephemeral.** When the executor process dies (crash, reboot, manual
kill), the row stays for forensics but `agents.current_executor_id` is cleared.
The next resume creates a new `executors` row that joins back to the same
`agents` identity.

**Tasks are scoped to a run.** An assignment row says "executor X is currently
doing task Y for wish Z." When the agent calls `genie done`, the assignment
gets `outcome='completed'` and the executor's terminal state is recorded.

### Why three layers and not one

A single `agents` table that conflated identity, run state, and task progress
is exactly what we had through migration 046. Every restart corrupted the
agent row by overwriting last-known session UUIDs and clearing parent links
that the spawn path needed to recompute. The split lets each row evolve at
its own clock: identity rows are sticky, executor rows turn over with
processes, assignment rows turn over with task work.

## The `agents.kind` GENERATED column (migration 049)

Permanence is a *structural* property of identity, not a runtime fact. Three
shapes are permanent:

1. `id LIKE 'dir:%'` — a directory placeholder row (e.g., `dir:scout`). The
   directory layer creates these on-demand when an agent is referenced before
   it spawns. They never get deleted.
2. `reports_to IS NULL` — top-of-hierarchy. Team-leads, root identities,
   anything spawned without a parent.
3. Everything else — `kind = 'task'`. Child agents spawned by a parent for a
   specific assignment.

Migration 049 encodes this rule **once, in the schema**:

```sql
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS kind TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN id LIKE 'dir:%' OR reports_to IS NULL THEN 'permanent'
      ELSE 'task'
    END
  ) STORED;
```

The column is `GENERATED ALWAYS AS … STORED`. Three properties follow:

- **No consumer can author a wrong value.** `INSERT (kind=…)` is rejected by
  Postgres.
- **No consumer can read a stale value.** Every `INSERT`/`UPDATE` that
  touches `id` or `reports_to` recomputes `kind` atomically.
- **Every consumer reads the same answer.** No more "this consumer thinks
  it's permanent, that consumer thinks it's a task."

Why identity-shape and not assignments-presence: archived assignments would
otherwise "promote" task agents to permanent the moment they completed work
(no open assignment → looks permanent). Identity-shape is structural and
cannot drift through normal lifecycle transitions.

The `auditAgentKind()` function (in `src/lib/agent-registry.ts`) is
belt-and-suspenders for non-PG backends and rogue raw-SQL writers. It scans
every row and reports drift; on a clean DB the drifted list is always empty.

## The one chokepoint: `shouldResume(agentId)`

```typescript
// src/lib/should-resume.ts
export async function shouldResume(agentId: string): Promise<ShouldResumeResult>;

export interface ShouldResumeResult {
  resume: boolean;                 // should the caller re-invoke?
  reason: ShouldResumeReason;      // why (machine-readable)
  sessionId?: string;              // present if a UUID was located
  rehydrate: 'eager' | 'lazy';     // boot-pass hint (eager = permanent)
}

export type ShouldResumeReason =
  | 'ok'                    // session located, resume permitted
  | 'unknown_agent'         // no agents row
  | 'auto_resume_disabled'  // operator paused or retry budget exhausted
  | 'assignment_closed'     // latest assignment has outcome != null
  | 'no_session_id';        // no executor + no JSONL fallback
```

### The rule table

| `kind` | latest assignment | `auto_resume` | session UUID | result |
|--------|-------------------|---------------|--------------|--------|
| permanent | (no assignments) | true | found | `resume=true reason=ok rehydrate=eager` |
| permanent | (no assignments) | true | missing | `resume=false reason=no_session_id rehydrate=eager` |
| permanent | (no assignments) | false | any | `resume=false reason=auto_resume_disabled rehydrate=eager` |
| task | open | true | found | `resume=true reason=ok rehydrate=lazy` |
| task | open | true | missing | `resume=false reason=no_session_id rehydrate=lazy` |
| task | closed | any | any | `resume=false reason=assignment_closed rehydrate=lazy` |
| any | n/a | n/a | n/a | `resume=false reason=unknown_agent rehydrate=lazy` (no row) |

### The user-action table

| `reason` | What `genie status` says | What the operator does |
|----------|--------------------------|------------------------|
| `ok` | green; resuming on next boot pass | nothing |
| `unknown_agent` | hidden by default; visible under `--all` | nothing — the row is gone |
| `auto_resume_disabled` | yellow with the verb `genie agent resume <name>` | run the verb if the pause was unintended |
| `assignment_closed` | hidden by default; visible under `--all` | nothing — the task already finished |
| `no_session_id` | red; flag suggests `genie agent resume <name>` or `genie agent kill <name>` | usually re-invoke; sometimes the agent is genuinely dead |

### The chokepoint contract

Every consumer of "should this agent resume?" — the scheduler boot pass,
manual `genie agent resume`, the protocol-router spawn path, the `genie
status` renderer — calls `shouldResume(agentId)` and reads the structured
result. Nobody recomputes the decision. Nobody reads
`executors.claude_session_id` directly. The invariant test enforces this with
grep guards (see below).

The reason: when eight call sites each maintained their own JOIN, they
diverged whenever the schema evolved. One added the `auto_resume` filter,
another forgot. The operator could not predict which subset of the world a
given verb operated on, because there was no canonical answer.

## Boot pass: rehydrate vs re-invoke

`genie serve start` runs a uniform boot pass:

> For every agent where `assignments.outcome IS NULL AND auto_resume = true`,
> ask `shouldResume(agentId)`. Always rehydrate; eager-invoke only the
> permanent ones.

These two verbs do different things:

- **Rehydrate** = load the identity into the in-memory directory, register it
  in `genie ls`, surface it in `genie status`. Cheap. Idempotent. Always.
- **Re-invoke** = push API tokens to the executor, send the resume message,
  resume the conversation. Expensive. Has side effects. Only for permanent
  agents.

For task agents, the boot pass surfaces a `genie agent resume <name>` verb in
`genie status` and stops there. The operator decides whether the task should
resume. This avoids the previous failure mode where a half-completed task
agent would resume on every reboot, replay its last few turns, and then get
confused.

For permanent agents (team-leads, dir:* placeholders, root identities), the
boot pass re-invokes immediately. Permanent agents are *defined* as the ones
we want eagerly available; if `serve start` returns and the team-lead is not
yet talking, that's a regression.

The `BootPassDecision` type and `classifyBootPass(agentId, decision)`
function in `src/lib/should-resume.ts` make this split explicit. Each
classified decision emits one of four audit events; see the JSDoc on
`bootPassEventType()` for the consumer contract.

## The one surface: `genie status`

`genie status` is the canonical user-facing observability surface. Three
flags fan out from the default view:

```bash
genie status              # everything actionable; one line per agent
genie status --health     # adds the 4 health checks (partition, watchdog, …)
genie status --all        # reveals archived/done/closed-assignment rows
genie status --debug      # the former `doctor --state`; structural inference audit
```

Default output for one agent looks like:

```
team-lead             ✅  resume=ok               sess=…/abc-123
engineer-g6           🟡  resume=auto_resume_disabled  → genie agent resume engineer-g6
dispatch-eng-old      🔴  resume=no_session_id    → genie agent resume dispatch-eng-old | genie agent kill dispatch-eng-old
```

Three guarantees:

1. **Aggregator only.** `genie status` calls `shouldResume(agentId)` for each
   agent and renders. It never recomputes the decision.
2. **Derived signals folded in.** A separate subscriber translates raw
   `genie_runtime_events` into second-order signals like
   `observability.recovery_anchor_at_risk` (the corruption fingerprint from
   2026-04-25). When such signals are active, they appear in the red-flag
   section above the agent list.
3. **Verbs are concrete.** Every red/yellow agent has at least one `genie …`
   command the operator can copy-paste. No "see the docs," no SQL.

The `--debug` flag exists for the case where the chokepoint disagrees with
your mental model. It dumps the inputs to `shouldResume` (agent row,
executor row, latest assignment, JSONL fallback) so you can see exactly which
axis is forcing the decision. This is what `genie doctor --state` used to do;
that command has been folded in.

## The 3am runbook

Imagine: 3am, prod host you don't admin, power blip recovered, pager fires.
You have a phone, an SSH session, and nothing else. The runbook is two
commands:

```bash
$ genie serve start
[serve] preconditions: partition rotated • watchdog up • backfill drift 0.3%
[serve] boot pass: 14 agents rehydrated • 8 eager-invoked • 6 lazy-pending
[serve] ready

$ genie status
🔴 1 derived signal active: observability.recovery_anchor_at_risk × 1 (15m)
🟡 6 agents pending operator action

  team-lead              ✅  resume=ok                  sess=…/abc
  engineer-g1            ✅  resume=ok                  sess=…/def
  engineer-g6            🟡  resume=auto_resume_disabled
                              → genie agent resume engineer-g6
  dispatch-eng-old       🔴  resume=no_session_id
                              → genie agent resume dispatch-eng-old
  ...
```

Three possible outcomes:

- **All green.** Sleep. Verify in the morning.
- **Yellow only.** Optional verbs. The system is *running*; these are agents
  the operator paused or the scheduler exhausted retries on. Run the verbs if
  the pause was unintended; otherwise leave them.
- **Red.** Each red row has a verb. Run it. Re-run `genie status`. Repeat
  until green or escalate. There is no SQL. There is no JSONL inspection.

Time-to-runbook-completion is budgeted at **< 30 seconds for ≤ 100 agents**.
The boot-pass concurrency cap is 32 (see `BOOT_PASS_CONCURRENCY_CAP`).

## `genie done` — when to call, when it's rejected

`genie done` has two paths:

```bash
# Inside an agent session (GENIE_AGENT_NAME set):
genie done

# Team-lead closing a wish group:
genie done my-wish#3
```

The agent-session path closes the calling executor's *current task*: writes
`outcome='done'` on the executor, clears `agents.current_executor_id`, marks
the latest assignment row `completed`. The agent process keeps running until
its own shutdown completes; only the *task lifecycle* is closed.

**The wish enforces a database-level guard:** if the calling agent's `kind` is
`permanent`, `genie done` throws `PermanentAgentDoneRejected` and exits with
code 4. Permanent identities (team-leads, dir:* placeholders, root agents) do
not have task lifecycles to close. Calling `genie done` against them would
flip `state='done'`, clear `current_executor_id`, and break the next boot
pass's invariant ("permanent agents are always rehydrated").

The check is database-driven, not convention-driven: `done.ts` joins
`executors → agents` via `GENIE_EXECUTOR_ID` and reads `agents.kind` from
the GENERATED column. No string matching on agent names; no inference rule
duplicated from the schema.

If you're a permanent agent and want to halt: `genie agent stop <name>`.
That tears down the executor process and clears the FK without marking the
identity terminal.

## Invariants enforced by tests

The contracts above are not aspirational; they are verified by
`src/__tests__/state-machine.invariants.test.ts`. The four invariants:

1. **No consumer reads `agents.claude_session_id` directly.** That column
   was dropped by migration 047 — the canonical session UUID lives on
   `executors.claude_session_id` and is read via `getResumeSessionId(agentId)`,
   which joins `agents.current_executor_id → executors.claude_session_id`.
   The test guards against accidental re-introduction by a future migration.
2. **No consumer infers permanence ad-hoc.** `rg "id LIKE 'dir:%'"` returns
   zero hits outside the migration files, the migration test, and this doc.
3. **Only `shouldResume()` calls `getResumeSessionId()`.** The chokepoint is
   the single allowed reader; every other consumer reads the structured
   `ShouldResumeResult` instead.
4. **`agents.kind` agrees with structural inference for every row.** The
   `auditAgentKind()` helper (in `src/lib/agent-registry.ts`) scans all rows
   and reports drift; on a clean DB the drift list is always empty.

If any of these invariants regresses, the test fails and the wish-acceptance
gate blocks. If the rule needs to change, change the test in the same PR as
the rule — never silently weaken the doc.

## Future-proofing rule (Methodology, council R2)

> No new metric, column, event, JOIN, or command without a defined consumer,
> a defined steady-state value, and a defined action threshold.

This rule lives at `/review` time. PRs that add observability without
contracts get rejected. The reasoning: every undefined metric becomes a
mystery in the next 3am incident. The corruption fingerprint of 2026-04-25
existed in the audit stream for three hours before anyone noticed, because
nobody had wired up a consumer for `session.reconciled` events. The fix is
the rule, not more dashboards.

## Cross-references

- `src/lib/should-resume.ts` — chokepoint implementation + boot-pass
  orchestration.
- `src/lib/agent-registry.ts` — `auditAgentKind()`, `findOrCreateAgent()`,
  `getAgentByName()`.
- `src/db/migrations/047_drop_agents_claude_session_id.sql` — column drop.
- `src/db/migrations/049_agents_kind_generated.sql` — `kind` column add.
- `src/term-commands/done.ts` — permanent-agent rejection guard.
- `src/__tests__/state-machine.invariants.test.ts` — invariant tests.
- `.genie/wishes/invincible-genie/WISH.md` — the wish that produced this doc.
