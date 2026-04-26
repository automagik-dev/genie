# Brainstorm: Happy Genie — `genie serve` restart is a no-op

| Field | Value |
|-------|-------|
| **Status** | DRAFT (interactive brainstorm, not yet a wish) |
| **Slug** | `happy-genie-resume` |
| **Date** | 2026-04-25 |
| **Driver** | Felipe Rosa |
| **Trigger** | 2026-04-25 power-outage incident: `9623de43` (genie/genie team-lead conversation) and `57635c8b` (genie/email teammate, 19.5MB) stranded by a sequence of write-time corruptions in session-sync, FK-nulling reconcilers, and session metadata gaps. Required ~2 hours of manual SQL forensics to recover. Felipe's verdict: *"too dirty for a simple power outage and such a organized event system we have."* |

## The "happy genie" experience (Felipe's vision)

> *"It doesn't really matter if a user closes and kills everything about genie, when they start again, it resumes everything that wasn't done."*

User-facing contract (proposed — please confirm/correct):

1. **`genie serve stop` + `genie serve start` is a no-op** for in-flight work. Every agent that was alive comes back alive at the same conversation point. No manual recovery, no `--resume` flags, no DB surgery.

2. **`genie ls` post-restart shows the truth.** Every agent that should resume is listed with last-known state. Agents whose purpose was fulfilled (`genie done` was called) are absent or archived.

3. **The state machine is the contract**, not memorized procedures. New users (and future Felipe) can read three primitives — `agents`, `executors`, `assignments` — and predict exactly what `genie serve start` will do.

## What we already have (primitive inventory)

The state machine is **already this rich** — the gap is in consumers, not data model:

### Identity layer (`agents`)
- `(custom_name, team)` composite unique key — the durable identity.
- `current_executor_id` FK → the run holding the conversation UUID.
- `auto_resume`, `resume_attempts`, `max_resume_attempts` — explicit policy fields.
- `state` (legacy, NULL for identity-only rows) — separate from runtime state.

### Run layer (`executors`)
- `claude_session_id` — the on-disk JSONL UUID, recovery anchor.
- `state ∈ {spawning, running, idle, working, permission, question, done, error, terminated}` — explicit lifecycle.
- `outcome ∈ {done, blocked, failed, clean_exit_unverified}` — turn-close contract.
- `closed_at`, `ended_at` — lifecycle bookends.

### Task layer (`assignments`)
- Created by `genie spawn <role>` for task-bound work.
- `genie done` writes terminal outcome.
- Distinguishes "this agent's purpose is fulfilled" from "this agent is just paused."

### Identity kinds (implicit today, should be explicit)
1. **Permanent agents** — team-leads, directory agents (e.g., `genie/genie`, `felipe/felipe`, `dir:email`). Purpose: be alive indefinitely. **Always resume.** Never call `genie done`.
2. **Task-bound agents** — engineers, reviewers, fixers spawned by team-leads. Have an `assignments` row. Call `genie done` when work is fulfilled. **Resume only if `assignments.outcome IS NULL`.**
3. **Subagent / sidechain** — Claude Code's internal Task tool spawns. Live inside the parent's process. No DB row of their own; not directly resumable.

## The gap (why happy doesn't happen today)

Reading the state machine *correctly* would already give the right answer. We have at least eight paths that read it *incorrectly*:

| # | Site | Wrong behavior | Should be |
|---|------|-----------------|-----------|
| 1 | `session-sync` (PreToolUse hook) | Overwrites stored UUID on divergence even when executor is terminal-state | Refuse overwrite when executor is recovery anchor (✅ fixed in PR #1397) |
| 2 | `scheduler-daemon::terminalize…` (×2) | Nulls `current_executor_id` on terminate — erases recovery anchor | Keep FK pointing at terminated executor (✅ fixed in PR #1397) |
| 3 | `pane-trap::trapPaneExit` | Same as #2 | (✅ fixed in PR #1397) |
| 4 | `agent-directory::add()` | Inserts `dir:` rows with `team=NULL` and no `repo_path` — session-sync lookup misses | Write team + repo_path at insert (✅ fixed in PR #1397) |
| 5 | `scheduler-daemon::defaultListWorkers` | Bare DB JOIN at boot, never calls `getResumeSessionId` (skips JSONL fallback) | Per-agent `getResumeSessionId` call OR a boot-time `recoverOrphanedSessions()` pass |
| 6 | `genie spawn` (`agents.ts:1722`, `:1985`) | Mints fresh UUID without consulting `getResumeSessionId` | Read fallback first; mint only on null |
| 7 | `genie --session <name>` (`genie.ts:153`) | Always starts fresh (TODO comment "Group 5 will wire up resume") | Wire Group 5 |
| 8 | `genie-commands/session.ts` (4 sites) | Same as #7 | (same wish) |

Plus an even deeper observation: **there is no single function `shouldResume(agentId)` that the runtime can ask.** Every consumer reinvents the answer with a slightly different JOIN. PR #1397 made the data model self-consistent; the next step is making the *consumers* go through one chokepoint.

## Proposed `shouldResume()` contract

```
function shouldResume(agentId): { resume: boolean; reason: string; sessionId?: string }

  identity := agents row
  if identity is null → { false, "agent_not_found" }

  // Kind 1: directory / team-lead identity (permanent)
  if identity is permanent (no active assignments row):
    sessionId := getResumeSessionId(agentId)  // already covers DB+JSONL paths
    if sessionId → { true, "permanent_with_session", sessionId }
    else         → { false, "permanent_no_session_yet" }

  // Kind 2: task-bound (assignments row exists)
  asgmt := latest assignment for this agent
  if asgmt.outcome is set ({done, blocked, failed, clean_exit_unverified}):
    → { false, "task_fulfilled" }
  if asgmt.outcome is null:
    sessionId := getResumeSessionId(agentId)
    if sessionId → { true, "task_in_flight", sessionId }
    else         → { false, "task_in_flight_no_session" }
```

`scheduler-daemon::defaultListWorkers` and every `genie spawn` / resume call site routes through this single chokepoint.

## Acceptance criteria for "happy genie restart"

After PR #1397 merges and a follow-up wish closes Gap 5–8 (above), a `genie serve` stop+start should satisfy:

- [ ] **Permanent agents are always resumed.** `genie/genie`, `felipe/felipe`, `dir:email`, etc. — every identity-keyed row with no terminal assignments comes back at its prior conversation UUID.
- [ ] **Task-bound agents that called `genie done` are absent / archived.** They served their purpose; resuming them is a bug.
- [ ] **Task-bound agents in flight are resumed at their prior state.** Engineer mid-edit, reviewer mid-pass, fixer mid-loop — all back at the conversation point.
- [ ] **`genie ls` shows the truth.** Status reflects pre-restart reality, not a fresh slate.
- [ ] **Audit trail tells the story.** `resume.found` / `resume.recovered_via_jsonl` / `resume.skipped_task_done` events make every decision auditable.
- [ ] **Documentation explains the model.** A short doc at `docs/state-machine.md` that a new user reads in 10 minutes and predicts what `genie serve start` will do.

## Out of scope (separate wishes)

- Subagent / sidechain resumability. Claude Code's internal Task tool owns those.
- Cross-host resume (genie state on host A, restart on host B). Single-host happy first.
- The 7 spawn-path call sites still minting fresh UUIDs (`genie.ts:153`, `session.ts:×4`, `agents.ts:×2`). Tracked under Wish Group 4/5 follow-up.

## Reality check — telemetry from this instance (2026-04-25, post-incident)

I pulled real data instead of reasoning from first principles. Here's what the genie CLI itself reveals about its own state:

### The corruption is in the audit log already

```
$ genie events list --type session.reconciled --since 24h
3h ago | executor | d3fdeddd-... | session.reconciled | new_session_id: 8b9b67...
```

That single line IS the bug — session-sync overwriting the dormant `9623de43` with my live `8b9b674e` on `d3fdeddd`. **The audit log captured it. Nobody was listening.** No alert, no health check, no `genie ls` red badge.

### Resume timeline tells the whole story

```
$ genie events list --type "resume.*" --since 24h
6h ago | bab3f112 | resume.missing_session | no_executor       (post-crash)
6h ago | bab3f112 | resume.found           | 9623de43-...      (after my re-link)
5h ago | f6728b2f | resume.missing_session | no_executor       (felipe pre-recovery)
5h ago | f6728b2f | resume.found           | fa1fac7b-...      (after re-link)
4h ago | bab3f112 | resume.missing_session | no_executor       (FK got nulled again)
2h ago | bab3f112 | resume.found           | 8b9b674e-...      (CORRUPTION — should be 9623de43)
2h ago | dir:email| resume.found           | 57635c8b-...      (good)
```

Every state transition is recorded. **The data to know whether the system is healthy already exists.** The gap is consumer-side aggregation.

### Error pattern domination

```
$ genie events errors --since 7d
33+ patterns | state_changed | <agent> | dead_pane_zombie
```

`dead_pane_zombie` is the **dominant** error pattern — 33 distinct agents flagged in 7 days. Each one is a potential stranded session. The reconciler detects them; nothing surfaces "you have N agents that died and weren't recovered" to the user.

### Heartbeat metrics surface is a graveyard

```
$ genie metrics agents
Total worker rows: 65
Status distribution: {'dead': 65}
```

**Zero live agents tracked.** All 65 rows say `dead`. The metrics surface uses process IDs (`1001706`, `1010480`, …) instead of agent identity, so post-restart the IDs all change and the prior rows orphan. This isn't useful telemetry — it's a corpse counter.

### Observability health says fail

```
$ genie doctor --observability
partition_health: fail
next_rotation_at: 2026-04-25T00:00:00.000Z   (in the past!)
oldest_partition: genie_runtime_events_p20260419
newest_partition: genie_runtime_events_p20260424   (today's missing)
watchdog: warn — "watchdog not installed"
4 watcher metrics in `warn`: emitter.rejected, emitter.latency_p99,
                             notify.delivery.lag, stream.gap.detected
```

Today's partition (`p20260425`) doesn't exist; new audit events probably falling through to default partition or dropping. Watchdog is uninstalled. Four critical observability metrics never seen.

### Drift between disk and DB

```
$ genie sessions list   → 30 tracked
$ ls ~/.claude/projects/*/*.jsonl | wc -l   → 200+ on disk
```

Session-backfill subsystem captures ~15% of what's actually on disk.

### Observability surface fragmentation (Felipe's "unified" point, quantified)

The CLI exposes **at least 28 read paths** to observability state:

| Surface | Shows |
|---------|-------|
| `genie events list` | audit_events table |
| `genie events list --v2` | genie_runtime_events table (different model) |
| `genie events errors` | aggregated error patterns |
| `genie events costs` | OTel costs |
| `genie events scan` | ccusage server-wide |
| `genie events stream` | real-time tail |
| `genie events admin` | incident-response (different model again) |
| `genie metrics now` | current machine state |
| `genie metrics history` | snapshots |
| `genie metrics agents` | heartbeats (graveyard) |
| `genie ls` / `--json` | agents table snapshot |
| `genie sessions list` / replay / search / sync | JSONL store |
| `genie history <name>` | compressed session per agent |
| `genie log [agent]` | "unified" feed (still siloed) |
| `genie brief` | startup context |
| `genie doctor` / `--observability` | static checks |
| `genie chat` / `inbox` / `read` / `broadcast` / `send` | comms layer |
| `genie board` / `project` / `qa-report` | task layer |

**None answers "what was I doing, what's still in flight, what should resume?"** That's the 29th command we need.

## The unification proposal — one command answers the question

```
$ genie status [--since 24h]
HAPPY GENIE STATE — 2026-04-25 22:30 UTC
═══════════════════════════════════════════════════════════════
You should resume:
  ◉ genie/genie         9623de43  1.7MB    /review on design-system-severance (3h dormant)
  ◉ genie/email         57635c8b  19.9MB   GH Actions Node 24 fix → dev→main merge needed
  ◉ felipe/felipe       fa1fac7b  0.7MB    Brain mounts + Task #1
  ◉ /home/genie/security 100481de 6.2MB    Leak-corpus dedup, Op6 (top-level, no team)

Done (no resume needed):
  ✓ engineer@aegis-hotfix     v0.1.2 shipped, issue #11 filed
  ✓ engineer@sec-scan-progress completed 2026-04-23

Stuck or attention needed:
  ⚠ felipe (legacy id="felipe") in error state, auto_resume=off — abandoned?
  ⚠ 7 felipe-trace-* archived rows piled up, never cleaned

Health:
  ✗ partition_health: today's partition missing (last rotation 6h overdue)
  ✗ session-backfill drift: 30 in DB / 200+ on disk
  ⚠ watchdog: not installed
  ⚠ 4 watcher metrics never seen

Recovery anchors at risk:
  (none — checked d3fdeddd corruption already triaged)
```

That's THE unified command. It pulls from `agents`, `executors`, `assignments`, `genie_runtime_events`, JSONL discovery, partition health, watcher metrics — and tells the user what `genie serve start` will do AND what they need to manually decide.

Underneath, this is just `shouldResume()` × N agents + a few aggregate health pulls. The data exists; we're not aggregating it.

## Revised proposed wish scope (now bigger than initial draft)

Original 6 groups + the new ones surfaced by real data:

### Original (state-machine correctness)
1. `agents.kind` column + migration
2. `shouldResume()` chokepoint + 3 audit events
3. Scheduler boot pass
4. 7 spawn-path call sites migrated
5. `genie agent pause/unpause` + `genie done` rejection on permanent
6. `docs/state-machine.md` + `genie doctor --state`

### New (added from real telemetry)
7. **`genie status` unified command** — the 29th command that obsoletes the other 28's "what's happening" use-case (they keep their drill-down value)
8. **`genie metrics agents` rewrite** — index by agent identity, not process_id; show live + recent-dead with reason
9. **Session-backfill drift fix** — `genie sessions sync` should converge to 100%, not 15%
10. **Partition rotation health** — `genie doctor --fix` should rotate when overdue; emit `observability.partition.missing` event when behind
11. **Recovery-anchor monitor** — when `session.reconciled` overwrites a non-null oldSessionId with a fresh live one (the corruption signature), emit `observability.recovery_anchor_at_risk` so it's visible in `genie status`
12. **Watchdog install path** — make it a `genie serve --headless` precondition or auto-install on first `genie doctor`

**Q0 (NEW from telemetry) — `genie status` as primary entry point.** Before fixing 28 fragmented commands, agree the user-facing lens is one command: `genie status` answers "what was I doing / what's in flight / what should resume / system health" in one screen. The other 28 stay as drill-downs. *Recommendation: yes, ship this in Group 7 — it's the felt-experience win.*

**Q1 — Permanence detection.** Today the only signals are: id starts with `dir:` (directory agent), or row has `reports_to=NULL` (team-lead). Should we add an explicit `agents.kind ∈ {'permanent','task'}` column, or keep inferring? *Recommendation: add the column — explicit > inferred.*

**Q2 — Task-fulfilled signal.** `assignments.outcome IS NOT NULL` is the durable signal that `genie done` was called. But `genie done` is implemented per-executor, not per-assignment, today. Do we plumb it through assignments too, or is the executor-level signal enough? *Recommendation: assignment-level — that's the "task" semantic; executor-level is the "process" semantic.*

**Q3 — Auto-resume policy.** `auto_resume` column exists per-agent (defaults true). Want to honor it as the user's "off switch" (e.g., `genie agent pause felipe` → `auto_resume=false`)? Or keep it scheduler-internal? *Recommendation: surface as a CLI verb so users can pause an agent without killing it.*

**Q4 — Boot-time pass vs lazy.** `recoverOrphanedSessions()` at scheduler boot is one option. Lazy (resume-on-first-spawn-request) is another. Hybrid: boot pass for permanent agents, lazy for task-bound. *Recommendation: hybrid — permanent should be visible immediately, task-bound can wait for explicit `genie agent resume`.*

**Q5 — Documentation depth.** Is a `docs/state-machine.md` enough, or do you want this to be a Wish artifact + a CLI verb (`genie state`) that prints the model + a runtime decision diagram? *Recommendation: doc + `genie doctor --state` that prints the live decision for every agent.*

**Q6 — `genie done` for permanent agents.** Currently the rule is "permanent agents never call done". Should we make this enforceable (`genie done` rejects when called from a permanent agent context)? Or trust convention? *Recommendation: enforce — fail loud, reject with `PermanentAgentDoneRejected` error.*

## Status of related work

- ✅ PR #1395 — JSONL fallback in `getResumeSessionId` (merged)
- ✅ PR #1397 — 4 structural gaps closed (open, ready for review/merge)
- 📋 This brainstorm — crystallizing into wish `fix-resume-finish-the-job`
- 📋 Wish Group 4/5 follow-up — 7 spawn-path call sites still mint fresh UUIDs

## Felipe's homework before this becomes a /wish

Answer Q1–Q6 above. Once we converge on the contract, I'll convert this into a structured wish with execution groups and acceptance criteria.
