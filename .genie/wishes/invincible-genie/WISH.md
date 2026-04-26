# Wish: Invincible Genie — `genie serve start && genie status` is the entire 3am runbook

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `invincible-genie` |
| **Date** | 2026-04-25 |
| **Author** | Felipe Rosa |
| **Appetite** | large |
| **Branch** | `wish/invincible-genie` |
| **Repos touched** | genie |
| **Design** | _No brainstorm — direct wish_ |
| **Brainstorm artifacts** | [DRAFT.md](../../brainstorms/happy-genie-resume/DRAFT.md), [COUNCIL.md](../../brainstorms/happy-genie-resume/COUNCIL.md) (council convened 2026-04-25 with architect, operator, measurer, simplifier — all opus, strong convergence) |
| **Parent incident** | 2026-04-25 power outage. `9623de43` (genie/genie team-lead) and `57635c8b` (genie/email teammate, 19.5MB) stranded for ~2h of manual SQL forensics. Audit log captured every step, no consumer aggregated it. |
| **Predecessor PRs** | #1395 (jsonl fallback in `getResumeSessionId`, merged) + #1397 (4 structural gaps, open) |

## Summary

Make `genie serve stop && genie serve start` a no-op for in-flight work. After PR #1395 + #1397 close the corruption bugs, this wish closes the **consumer-side gap**: every spawn / scheduler / resume path routes through one canonical `shouldResume(agentId)` chokepoint; every observability decision routes through one `genie status` aggregator that subscribes to derived signals from the audit stream; one `agents.kind` GENERATED column makes permanence schema-enforced; `serve start` becomes opinionated about preconditions (watchdog, partition rotation, backfill convergence) so day-one users inherit the same green state as Felipe's machine. The 28 fragmented observability commands collapse: corpse counter deleted, `events list --v2` folded as a flag, `doctor --state` collapsed into `status --debug`. **Acceptance is the 3am runbook**: at 3am, on a host you don't admin, `genie serve start && genie status` is the entire script. Green → sleep. Red → actionable verbs. No SQL. No JSONL inspection. No "permanent vs task-bound" mental gymnastics.

## Scope

### IN

- **`shouldResume(agentId): { resume, reason, sessionId? }`** as the single chokepoint in `src/lib/should-resume.ts` (or extending `executor-registry.ts`), wrapping the existing `getResumeSessionId` + assignments lookup.
- **8 consumer-site migrations** through `shouldResume()`: `scheduler-daemon.ts::defaultListWorkers`, `term-commands/agents.ts::buildResumeParams` and `:1985` resolveSpawnIdentity-canonical-dead branch, `genie.ts:153`, `genie-commands/session.ts:226/304/328/367/484` (5 sites total in session.ts).
- **Uniform boot-pass at `serve start`**: rehydrate every agent where `assignments.outcome IS NULL AND auto_resume=true`. Eager re-invoke for permanent (`kind='permanent'`); lazy for task-bound (surfaced in `genie status` as `genie agent resume <name>` actionable verb).
- **Derived-signal rule engine**: subscriber to `genie_runtime_events` that translates raw events into second-order signals — `session.reconciled` with non-null oldId → `observability.recovery_anchor_at_risk`; consecutive `resume.missing_session` per agent → `resume.lost_anchor`; `dead_pane_zombie` rate over baseline → `agents.zombie_storm`; `partition_health=fail` → `observability.partition.missing`.
- **`genie status`** as the canonical user-facing observability surface: aggregates `shouldResume()` × N agents + active derived signals + a small fixed health checklist. Three flags: `--health` (adds health checklist), `--all` (reveals archived/done), `--debug` (current `doctor --state` semantics, structural inference audit).
- **`agents.kind` column** as `GENERATED ALWAYS AS (CASE WHEN id LIKE 'dir:%' OR reports_to IS NULL THEN 'permanent' ELSE 'task' END) STORED`. Migration replaces inference at every consumer site with `WHERE kind='permanent'`. Fallback: ENUM with CHECK + populate trigger if backend blocks generated columns.
- **`genie serve start` opinionated preconditions**: today's partition exists or rotates now; watchdog daemon running or auto-installs; backfill drift < 5%; orphaned `dead_pane_zombie` rows surfaced in `status` with explicit user resolution. `--no-fix` flag for operators wanting manual control.
- **Deletions in same PR**: remove `genie metrics agents` (corpse counter); collapse `events list --v2` into `events list --enriched`; fold `doctor --state` into `status --debug`; quiesce 7+ archived `felipe-trace-*` rows + the legacy stringly-typed `felipe` row via cleanup migration.
- **`genie done` rejection on permanent context**: typed error `PermanentAgentDoneRejected`; database-level enforcement, not convention.
- **`docs/state-machine.md`**: 10-minute read covering three layers (identity / run / task), one chokepoint (`shouldResume`), one surface (`genie status`), the `kind` GENERATED column rationale, the boot-pass uniform decision, and the rehydrate-vs-re-invoke distinction. Pair with an invariant test that asserts the doc-claimed contracts.

### OUT

- **Subagent / sidechain resumability.** Claude Code's internal Task tool owns those; resume model is per-parent.
- **Cross-host resume.** Single-host happy first; multi-host is a separate wish.
- **New session-sync overwrite policy beyond PR #1397.** That fix lands; this wish does not revisit the divergence-preserved logic.
- **Migrating subscriber components beyond the resume + observability domain** (e.g., omni-bridge, board service). Those keep their existing readers.
- **Replacing `genie events list` / `metrics history` / `chat` / `inbox`** as commands. They stay as drill-downs; `genie status` is additive.
- **Per-agent retry / backoff policy redesign.** Existing `resume_attempts` / `max_resume_attempts` semantics preserved; this wish only routes them through `shouldResume`.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | `shouldResume(agentId)` is the canonical chokepoint; 8 consumer sites migrate to call it | Council F1 — eight current sites reinvent the resume decision with subtle JOIN differences; that's how `8b9b674e` overwrote `9623de43` on `d3fdeddd`. One canonical reader, many displays. |
| 2 | Boot-pass is **uniform** (`assignments.outcome IS NULL AND auto_resume=true`), NOT hybrid | Operator's 3am-runbook test: if `serve start` doesn't converge the world, we replaced "manual SQL forensics" with "memorize which subset is permanent and call resume on the rest." Same anti-pattern, fancier hat. Architect changed position from hybrid → uniform in council R2. |
| 3 | **Rehydrate ≠ Re-invoke** | Boot-pass ALWAYS rehydrates (load identity, register in `ls`/`status`). Re-invoke (push API tokens, send resume message) is eager for permanent, lazy for task-bound, surfaced as actionable verb. Three-line distinction; entire Q4 disagreement dissolved. |
| 4 | `agents.kind` as GENERATED column (Postgres `GENERATED ALWAYS AS … STORED`), not stored ENUM authored by hand | Council F6 — explicit AND impossible to drift. Inference rule enforced ONCE at schema layer, not redistributed across consumers. Same chokepoint discipline as `shouldResume()`. Fallback: ENUM + CHECK + trigger if version blocks. |
| 5 | Identity-shape inference (`id LIKE 'dir:%' OR reports_to IS NULL`), not assignments-presence inference | Architect over Simplifier (preserved as dissent in COUNCIL.md). Assignments-presence breaks under archived assignments — task agents that completed become "permanent" next boot. Identity-shape is structural, not lifecycle-dependent. CHECK constraint + `genie doctor` audit closes the corner case Simplifier flagged. |
| 6 | Derived-signal rule engine is a distinct subscriber component, NOT a one-line fold into the reconciler | Measurer R2 over Simplifier's compaction proposal — folding back into the reconciler IS what we have today, which is exactly how `session.reconciled` screamed into a closet for 3 hours. The reconciler is the emitter; the gap is the subscriber. |
| 7 | `genie status` aggregates derived signals + `shouldResume()` results; never duplicates the logic | Architect R1+R2 — pure aggregator over `shouldResume()` × N agents. Every observability surface (`ls`, `status`, `doctor --state`, future metrics rewrite) calls `shouldResume` and renders; nothing computes its own. |
| 8 | Install/upgrade story is folded as **preconditions on `serve start`**, not a 13th wish group | Simplifier R2 framing endorsed. `ensureServeReady()` orchestrates existing primitives (partition rotate, watchdog install, backfill convergence). `--no-fix` flag for operators who want manual control. |
| 9 | Deletions ship in the SAME PR as `genie status` | Simplifier R1+R2 — shipping the 29th surface without the 28 deletions just moves entropy. Measurer R2 endorsed: deletion blade and emission discipline are the same rule. |
| 10 | `genie done` rejection on permanent context is database-level, not convention | Council F4 — convention is what produced `team=NULL` rows in the first place. Typed error `PermanentAgentDoneRejected` raised at `genie done` entry point, validated against `agents.kind='permanent'`. |
| 11 | Methodology rule (Measurer): "no new metric / column / event / JOIN / command without a defined consumer + steady-state value + action threshold" | Council F4 — universal going forward. Adopted as a reviewer check (`/review` rejects PRs adding observability without contracts). |
| 12 | Backfill convergence is a P1 acceptance criterion, not P0 | Council F1 + Architect R1 scale concern. Required for the JSONL fallback to remain rare-recovery; achievable in parallel with the chokepoint work. |

## Success Criteria

- [ ] `shouldResume(agentId)` exported from `src/lib/should-resume.ts` (or extension of `executor-registry.ts`); 8 prior consumer sites migrated; `rg "agent\.claudeSessionId\|worker\.claudeSessionId" repos/genie/src` returns zero hits outside the new chokepoint.
- [ ] `genie serve start` boot-pass: every agent with `assignments.outcome IS NULL AND auto_resume=true` rehydrated; `genie ls` post-restart shows pre-restart truth, not a fresh slate.
- [ ] `genie status` exists; default output lists agents that should resume (one line each with reason); `--health` adds the 4 health checks; `--all` reveals archived/done; `--debug` is the former `doctor --state`.
- [ ] `agents.kind` column populated for every row; consumer reads use `WHERE kind='permanent'` not `id LIKE 'dir:%'` ad-hoc; `kind` cannot drift (GENERATED column) or has CHECK + trigger that prevent drift (fallback path).
- [ ] Derived-signal rule engine subscribes to `genie_runtime_events`; emits `observability.recovery_anchor_at_risk` on the `session.reconciled` corruption fingerprint; emits `agents.zombie_storm` when `dead_pane_zombie` rate > baseline; both visible in `genie status` red-flag section.
- [ ] `genie serve start` refuses or auto-fixes: today's partition exists; watchdog daemon running; backfill drift < 5%; no orphaned `dead_pane_zombie` rows; no orphaned team-config dirs (active orphans flagged in `genie status` with `genie team repair <name>` verb; stale orphans archived to `_archive/`).
- [ ] Deletions landed in same PR: `genie metrics agents` removed (or returns deprecation warning + redirects to `status`); `events list --v2` folded as `--enriched` flag; `doctor --state` removed (folded into `status --debug`); cleanup migration archives `felipe-trace-*` rows + legacy stringly-typed identity rows.
- [ ] `genie done` from a permanent agent context throws `PermanentAgentDoneRejected` with the agent identifier; existing task-bound `genie done` flow unchanged.
- [ ] `docs/state-machine.md` exists, < 600 lines, covers three layers + chokepoint + surface + key decisions; an invariant test in `src/__tests__/state-machine.invariants.test.ts` asserts the doc-claimed contracts (`kind` consistency, `shouldResume` chokepoint usage, no consumer reads `agents.claude_session_id` directly).
- [ ] **3am runbook test passes** (manual smoke, documented in QA): from a clean shell, `genie serve start && genie status` shows every prior in-flight agent in green-or-actionable state. No SQL. No JSONL. Time-to-runbook-completion < 30 seconds for ≤ 100 agents.
- [ ] `bun run check` passes (typecheck + lint + tests); 50+ new tests covering `shouldResume`, boot-pass uniform, derived-signal emission, `kind` column behavior, `genie status` rendering.

## Execution Strategy

### Wave 1 (parallel — independent foundations)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | `shouldResume()` chokepoint + 8 consumer migrations + uniform boot-pass + rehydrate/re-invoke split |
| 3 | engineer | `agents.kind` GENERATED column migration + read-site replacement |

### Wave 2 (parallel — depend on Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Derived-signal rule engine + `genie status` aggregator + flags (depends on G1) |
| 6 | engineer + docs | `docs/state-machine.md` + invariant test + `genie done` rejection (depends on G1, G3) |

### Wave 3 (parallel — depend on `genie status` existing in Wave 2)

| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | `genie serve start` opinionated preconditions (`ensureServeReady`) — surfaces refused-precondition output through `genie status --health` |
| 5 | engineer | Deletions: `metrics agents`, `events list --v2`, `doctor --state`, archive cleanup migration |

### Wave 4 (after all — QA + review)

| Group | Agent | Description |
|-------|-------|-------------|
| QA | qa | 3am-runbook smoke + boot-pass smoke + corruption-fingerprint smoke |
| review | reviewer | Validate against success criteria |

## Execution Groups

### Group 1: `shouldResume()` chokepoint + 8 consumer migrations + uniform boot-pass

**Goal:** One canonical reader for "should this agent resume? if so, with what session?". Eight current consumer sites collapse to one. Boot-pass at `serve start` rehydrates uniformly; re-invoke is split eager-permanent / lazy-task.

**Deliverables:**
1. `src/lib/should-resume.ts` exporting `shouldResume(agentId): Promise<{ resume: boolean; reason: string; sessionId?: string; rehydrate: 'eager' | 'lazy' }>`. Wraps `getResumeSessionId` + assignments lookup + `auto_resume` flag.
2. Consumer migrations:
   - `scheduler-daemon.ts::defaultListWorkers` (replace bare DB JOIN with per-agent `shouldResume`).
   - `term-commands/agents.ts::buildResumeParams` and `:1985` `resolveSpawnIdentity` canonical-dead branch.
   - `genie.ts:153` (Group 5 TODO from prior wish).
   - `genie-commands/session.ts` × 5 sites (`:226, :304, :328, :367, :484`).
3. Boot-pass logic in `scheduler-daemon` boot path: enumerate agents where `assignments.outcome IS NULL AND auto_resume=true`; call `shouldResume(agentId)` × N (parallelized, batch=32); rehydrate ALL (DB row + executor anchor); re-invoke eager for `kind='permanent'`, lazy for `kind='task'` (surfaced via `genie status` as actionable verb).
3a. **Dispatcher pre-spawned-teammate reuse** (DX gap caught from live `genie work` dispatch on 2026-04-26): before spawning a fresh `engineer-N` for a wish group, `genie work` should check `genie ls --json` for idle teammates of the matching role in the same team, and reuse if available. Today the dispatcher mints fresh agents even when an idle one is sitting next to them — wasted compute and confusing topology. New helper `pickEngineerForGroup(groupNumber, team)` either returns an idle existing engineer or spawns. Adds `agent.dispatcher.reused_idle` audit event (consumer: `genie status` "Dispatch efficiency" line, info-level).
4. New audit events (per Measurer's methodology rule — defined consumer + green-state + action threshold per event):
   - `agent.boot_pass.rehydrated` (consumer: `genie status`; green = boot completed; action = none, info-level).
   - `agent.boot_pass.skipped_task_done` (consumer: `genie status --all`; green = expected; action = none).
   - `agent.boot_pass.eager_invoked` / `agent.boot_pass.lazy_pending` (consumer: `genie status`; green = invoked or pending verb; action threshold = pending > 5 min for permanent agents).

**Acceptance Criteria:**
- [ ] `rg "getResumeSessionId\|claude_session_id" repos/genie/src` shows reads only inside `should-resume.ts` and `getResumeSessionId` itself.
- [ ] `bun test src/lib/should-resume.test.ts` passes — happy path, no executor, executor with no session, archived assignment, permanent vs task.
- [ ] Manual smoke: kill genie pane, `genie serve start` triggers boot-pass; `genie events list --type agent.boot_pass.* --since 1m` shows rehydrated events for every prior in-flight agent.

**Validation:**
```bash
cd repos/genie && bun test src/lib/should-resume.test.ts src/lib/scheduler-daemon.test.ts && bun run typecheck
```

**depends-on:** none

---

### Group 2: Derived-signal rule engine + `genie status` aggregator

**Goal:** Subscribe to the audit stream; translate raw events into named derived signals; render them in one user-facing screen. Close the loop from emit → detect → surface.

**Deliverables:**
1. `src/lib/derived-signals/` module with subscriber that reads `genie_runtime_events` and emits second-order events:
   - `session.reconciled` with non-null `old_session_id` ≠ `new_session_id` AND executor was terminal-state at write time → `observability.recovery_anchor_at_risk`.
   - Consecutive `resume.missing_session` per agent (≥ 3 in 5 min) → `resume.lost_anchor`.
   - `dead_pane_zombie` rate per hour > 5 → `agents.zombie_storm`.
   - `partition_health=fail` (from `genie doctor --observability` periodic check) → `observability.partition.missing`.
2. `src/term-commands/status.ts` — `genie status` command:
   - Default: list of agents that should resume (one line each: identity, session UUID prefix, JSONL size, last-write age, last-known activity).
   - Section: agents that called `genie done` (compact archive list — only with `--all`).
   - Section: stuck/attention (agents whose `shouldResume` returned false with non-trivial reason).
   - Section: active derived signals (red badge per signal with link to drill-down command).
   - Flags: `--health` (adds 4 fixed health checks: partition, watchdog, backfill drift, watcher metric liveness), `--all` (reveals done), `--debug` (former `doctor --state` content), `--json`.
3. Integration: `genie status` reads from PG (one round-trip per agent OR a single CTE-style query); never falls back to JSONL scan unless `shouldResume()` itself does.
4. **`genie wish status <slug>` slug-resolution fix** (DX gap caught 2026-04-26): today the command is cwd-bound — fails with "no WISH.md found in cwd or repo root" from any cwd that isn't the wish's repo root. With multiple repos (genie, omni, brain, agents/<name>), the user has to memorize where each wish lives. Fix: search known repo roots (from `genie config` workspace registry) for `<slug>/WISH.md`, fall back to current behavior if not found. Same fix for `genie wish lint <slug>` and `genie wish done <slug>`.
5. **TUI Nav reads `shouldResume()`** (TUI-2 from live audit): today `Nav.tsx` shows `wsAgentState ∈ {running, stopped, error, spawning}` — that's process state. The wish needs work state (`in_flight (resumable)`, `done (purpose fulfilled)`, `stuck (attention)`, `paused`). Replace the `getAgentIcon`/`getAgentColor` switches in `TreeNode.tsx` with calls to `shouldResume(agentId)` for the icon/color decision; add a `paused` state when `auto_resume=false`. Inline `[stuck — press R to retry]` already-good pattern extends to all attention states.
6. **TUI Nav header shows derived-signal badge**: when the rule engine has emitted a `recovery_anchor_at_risk` / `agents.zombie_storm` / `observability.partition.missing` signal that hasn't been acked, render a `🔴 N alerts` badge in the Nav header next to `Sessions/Agents`. Drill-down to `genie status --debug`. Closes the "audit log captured the corruption, nobody listened" gap at the TUI surface.

**Acceptance Criteria:**
- [ ] `genie status` runs in < 1s for ≤ 100 agents.
- [ ] Derived-signal subscriber catches the corruption fingerprint within 30s of `session.reconciled` write (verified by integration test that emits the bad event and asserts `observability.recovery_anchor_at_risk` appears).
- [ ] `genie status --health` shows partition, watchdog, backfill, watcher-metric status.
- [ ] `bun test src/term-commands/status.test.ts src/lib/derived-signals/*.test.ts` passes.

**Validation:**
```bash
cd repos/genie && bun test src/term-commands/status.test.ts src/lib/derived-signals/ && bun run typecheck
```

**depends-on:** Group 1 (uses `shouldResume`)

---

### Group 3: `agents.kind` GENERATED column

**Goal:** Permanence is schema-enforced and drift-proof. No consumer reinvents the inference rule; one schema-layer chokepoint.

**Deliverables:**
1. New migration `NNN_agents_kind_generated.sql`:
   ```sql
   ALTER TABLE agents ADD COLUMN kind TEXT
     GENERATED ALWAYS AS (
       CASE WHEN id LIKE 'dir:%' OR reports_to IS NULL
            THEN 'permanent' ELSE 'task' END
     ) STORED;
   CREATE INDEX agents_kind_idx ON agents (kind);
   ```
   Fallback path (if backend blocks GENERATED): plain TEXT column with CHECK constraint (`kind IN ('permanent','task')`) + INSERT/UPDATE trigger that populates from inference rule. Document the backend-detection logic.
2. Read-site replacement: every `id LIKE 'dir:%'` / `reports_to IS NULL` ad-hoc inference replaced with `WHERE kind='permanent'`. Known sites (grep-bound, exact list expanded by engineer): `lib/agent-registry.ts` (rowToAgentIdentity + role-based filters), `lib/agent-directory.ts` (existing `dir:` checks), `lib/team-manager.ts` (team-lead detection), `term-commands/agents.ts` (list filters), `lib/should-resume.ts` (post-Group 1 — uses kind for rehydrate/re-invoke split). Estimated ≤ 12 sites total; baseline `rg "id LIKE 'dir:%'\|reports_to IS NULL" repos/genie/src` should drop to zero hits outside the migration file.
3. Startup audit hook (folded into `genie doctor --state` content, surfaced via `genie status --debug`): asserts `kind` agrees with structural inference for every row; logs `agents.kind.audit_drift` on mismatch.
4. Tests: column populated correctly for `dir:`, team-lead-shape, task-shape rows; index usable; ad-hoc inference grep returns zero hits in `src/`.

**Acceptance Criteria:**
- [ ] Migration applies cleanly on a fresh PG and on the live instance.
- [ ] `rg "id LIKE 'dir:%'\|reports_to IS NULL" repos/genie/src` returns zero hits outside the migration file and the doc.
- [ ] `bun test src/lib/agent-registry.test.ts src/db/migrations/agents-kind.test.ts` passes.
- [ ] `genie status --debug` shows kind audit OK on a fresh DB.

**Validation:**
```bash
cd repos/genie && bun run typecheck && bun test src/lib/agent-registry.test.ts src/db/migrations/
```

**depends-on:** none (parallel with Group 1)

---

### Group 4: `genie serve start` opinionated preconditions

**Goal:** Day-one user inherits Felipe's-machine green state, not Felipe's incident. Install/upgrade story is automatic.

**Deliverables:**
1. `src/term-commands/serve/ensure-ready.ts` — `ensureServeReady(opts: { autoFix: boolean })` orchestrator:
   - Today's partition exists OR rotate now (calls existing partition-rotation primitive).
   - Watchdog daemon running OR auto-install (calls `bun run packages/watchdog/src/cli.ts install` or equivalent).
   - Session-backfill drift measured; if > 5%, run convergence pass (existing `genie sessions sync` primitive in foreground).
   - Orphaned `dead_pane_zombie` rows flagged in `genie status` with explicit user resolution.
   - **Orphaned team-config dirs** (`<claudeConfigDir>/teams/<name>/` missing `config.json` while `inboxes/` exists): classify as either (a) **active orphan** — inbox files non-empty AND newer than 24h → flag in `genie status` with action `genie team repair <name>` (re-derive `workingDir` from agent template / first-message metadata / user prompt); or (b) **stale orphan** — inbox files empty/older than 24h → archive to `<claudeConfigDir>/teams/_archive/<name>-<timestamp>/`. Closes the chronic class of "inbox-watcher: Cannot spawn team-lead for <X> — no workingDir in config" warnings. Live evidence (2026-04-26): 13 stale `qa-moak*` dirs from a 2026-04-22 QA run accumulated this way; one active orphan (`felipe-scout`) was tripping the warning silently. The inbox-watcher's `MAX_SPAWN_FAILURES` cap masks this — boot-time precondition forces resolution.
2. `genie serve start` integration: calls `ensureServeReady({ autoFix: true })` by default; `--no-fix` flag passes `autoFix: false` and refuses to start if any precondition fails (printing the fix command per failure).
3. New audit events: `serve.precondition.fixed`, `serve.precondition.refused` (consumer: `genie status --health`).
4. Documentation note in `docs/state-machine.md` (Group 6) explaining why `serve start` is opinionated.

**Acceptance Criteria:**
- [ ] On a fresh install / fresh DB, `genie serve start` succeeds without manual fix steps.
- [ ] On a degraded install (no watchdog, missing partition), `genie serve start` either auto-fixes (default) or refuses with actionable error (`--no-fix`).
- [ ] `bun test src/term-commands/serve/ensure-ready.test.ts` covers all four preconditions × auto-fix and refuse paths.

**Validation:**
```bash
cd repos/genie && bun test src/term-commands/serve/ && bun run typecheck
```

**depends-on:** Group 2 (`genie status --health` is the surface for refused-precondition output)

---

### Group 5: Deletions in same PR

**Goal:** Net-negative line count after this wish ships. Felipe's "every line is a liability" + Measurer's methodology rule applied to commands.

**Deliverables:**
1. Delete `genie metrics agents` command (corpse counter — fails methodology rule day one). Replace with deprecation stub that prints `Use \`genie status\` for live agent state.` and exits 0 for one release.
2. Collapse `genie events list --v2` into `genie events list --enriched` flag (one schema, one surface). Migrate any callers in `repos/genie/scripts/` and tests.
3. Remove `genie doctor --state` flag — content folded into `genie status --debug`.
4. Cleanup migration `NNN_archive_legacy_identity_rows.sql`:
   - Quiesce 7+ archived `felipe-trace-*` rows (set `auto_resume=false`).
   - Quiesce legacy stringly-typed identity rows (e.g., `id='felipe'` with `custom_name=NULL`) where a UUID-keyed counterpart exists.
   - Document the cleanup logic so future operators understand what was archived.
5. Companion filesystem cleanup `scripts/archive-orphan-team-configs.ts` (idempotent, safe to re-run; invoked once by the migration runner and also exposed as `genie doctor --fix-team-orphans`): walks `<claudeConfigDir>/teams/`, identifies dirs missing `config.json`, applies the active-vs-stale heuristic from Group 4 deliverable 1, archives stale to `_archive/`, leaves active flagged for `genie status`. Cleans the 13 `qa-moak*`-shape leftovers that accumulate from `qa-runner.ts` partial team creations.
6. **Auto-archive wish-named agent rows on wish done** (DX gap caught 2026-04-26): `genie ls` still shows a `design-system-severance` agent (team=`design-system-severance`, self-orphaned shape) long after that wish shipped. Same orphan class as the team-config dirs but in PG. When `genie wish done <slug>` is called, archive every agent row whose `team = <slug>` (the wish-team-lead-shape rows) — set `auto_resume=false` and `state='archived'`. Cleanup migration backfills the existing wish-named orphans by cross-referencing `.genie/wishes/_archive/` slugs.
7. **Strip `[type]` debug labels from TUI tree** (TUI-1 from live audit): `src/tui/components/TreeNode.tsx:55` renders `<span fg={palette.textMuted}>{` [${node.type}]`}</span>` — every row in the Nav ends with `[agent]` / `[session]` / `[window]` / `[pane]`. Pure debug instrumentation that leaked into prod UI. Either drop entirely (preferred — type is implicit from icon + indent) or move behind a `GENIE_TUI_DEBUG=1` env guard.
8. Smoke-test the deprecation paths to ensure no script in `scripts/` or `.github/workflows/` calls the removed commands.

**Acceptance Criteria:**
- [ ] `git diff --stat` for this PR shows net negative LoC.
- [ ] `rg "genie metrics agents\|genie doctor --state\|events list --v2" repos/genie` returns zero hits outside the migration file, doc, and the deprecation stub.
- [ ] Cleanup migration runs idempotently on a live DB without erroring.
- [ ] `bun test` passes including new deprecation-stub tests.

**Validation:**
```bash
cd repos/genie && bun test && bun run typecheck && rg "genie metrics agents" repos/genie/src | grep -v deprecated.ts
```

**depends-on:** Group 2 (`genie status --debug` must exist before `doctor --state` is removed)

---

### Group 6: `docs/state-machine.md` + invariant test + `genie done` rejection

**Goal:** "Buggy and undocumented" → "buggy is impossible because the invariants are tested, undocumented is impossible because the doc enforces them." 10-minute read, paired with a test.

**Deliverables:**
1. `docs/state-machine.md` (< 600 lines):
   - Three layers: identity (`agents`) / run (`executors`) / task (`assignments`).
   - One chokepoint: `shouldResume(agentId)` — pseudocode + table mapping reasons to user actions.
   - One surface: `genie status` — what each section means.
   - The `kind` GENERATED column rationale.
   - Boot-pass uniform decision (rehydrate vs re-invoke distinction).
   - `genie done` semantics — when to call, when it's rejected.
   - 3am runbook walkthrough.
2. `src/__tests__/state-machine.invariants.test.ts`:
   - No consumer reads `agents.claude_session_id` directly (the column is dropped per #1395 wish; this test guards against accidental re-introduction via a future migration).
   - No consumer infers permanence ad-hoc (`rg "id LIKE 'dir:%'"` must be zero outside migrations + doc).
   - `shouldResume()` is the only function that calls `getResumeSessionId()` (callers via grep).
   - `agents.kind` agrees with structural inference for every row in test fixtures.
3. `genie done` rejection logic:
   - `src/term-commands/done.ts`: pre-check `agents.kind` for the calling agent's identity. If `kind='permanent'`, throw `PermanentAgentDoneRejected({ agentId, reason: 'permanent_agents_never_call_done' })` with exit code 4.
   - Test covers: permanent agent invoking `genie done` → rejected; task agent → succeeds.

**Acceptance Criteria:**
- [ ] `docs/state-machine.md` exists, lints with markdownlint clean, < 600 lines.
- [ ] `bun test src/__tests__/state-machine.invariants.test.ts` passes; every invariant has its own test case.
- [ ] `genie done` from a permanent identity throws `PermanentAgentDoneRejected`, exits 4; from a task identity succeeds as before.

**Validation:**
```bash
cd repos/genie && bun test src/__tests__/state-machine.invariants.test.ts src/term-commands/done.test.ts && bunx markdownlint-cli2 docs/state-machine.md
```

**depends-on:** Group 1, Group 3

---

## Dependencies

- **depends-on:** `claude-resume-by-session-id` (Wish Group 4/5 deferred work — finishing `continueName` deletion + name-based resume removal). Some of the 8 consumer-site migrations overlap; coordinate so we don't double-edit the same lines.
- **depends-on:** PR #1397 merging (closes 4 structural gaps; this wish assumes session-sync no longer corrupts on divergence).
- **blocks:** none.
- **runs-in-parallel-with:** any docs sweep on `.genie/wishes/_archive/`.

## QA Criteria

- [ ] **3am runbook test (the SLI):** Stop genie serve. Power-cycle simulated (kill pgserve + tmux). Restart genie serve. Run `genie status`. **Expected:** every prior in-flight agent shows green-or-actionable; no SQL forensics needed; total time < 30s for ≤ 100 agents.
- [ ] **Corruption-fingerprint detection:** Manually emit a `session.reconciled` event with `old_session_id != new_session_id` and `executor.state='terminated'` (mocking the bad path). Within 30s, `genie status` red-flags `observability.recovery_anchor_at_risk`.
- [ ] **Permanent-agent-done rejection:** From a permanent agent context (e.g., team-lead session), `genie done` exits 4 with `PermanentAgentDoneRejected`. From a task-bound agent context (engineer), `genie done` succeeds.
- [ ] **Boot-pass uniformity:** Spawn 10 mixed agents (5 permanent, 5 task-bound, mix of `auto_resume=true/false`). Stop genie serve. Start it. **Expected:** all 5 permanent rehydrated + eager-invoked; all `auto_resume=true` task-bound rehydrated + listed in `status` with actionable verb; `auto_resume=false` agents present but flagged as paused.
- [ ] **Deletion sweep:** `git log -p` shows the deletion commits land in the same PR as the `genie status` introduction.
- [ ] **No regressions:** `bun test` 100% pass; baseline test count + new tests, no removals without justification in commit message.
- [ ] **Docs invariant test passes** as part of `bun test`.
- [ ] **Methodology rule enforced:** every new audit event added in this wish has a documented consumer in `genie status` (or rule engine) AND a documented action threshold (or "info-only" tag).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Postgres version blocks `GENERATED ALWAYS AS … STORED` | Medium | Documented fallback: ENUM + CHECK + populate trigger. Detection logic at migration time chooses the path. |
| Boot-pass × 1000 agents at scale exceeds 30s budget | Medium | Parallelize at batch=32 (already designed). Backfill convergence (P1 acceptance) makes DB read authoritative so JSONL fallback is rare. If still slow, switch to deferred-rehydrate (load identity sync, full re-invoke async). |
| Derived-signal rule engine over-emits and pollutes audit log | Low | Methodology rule applied at design time: every signal has a defined consumer in `genie status` + an action threshold. Rate-limited at the subscriber layer. |
| `genie metrics agents` deprecation breaks user scripts | Low | One-release deprecation stub prints redirect message; documented in CHANGELOG; mention in `genie doctor` warning. |
| Cleanup migration archives a row a user expected to resume | Low | Migration is idempotent and only quiesces (auto_resume=false), never deletes. Explicit user can re-enable via `genie agent unpause <id>`. |
| `kind` GENERATED column drifts on legacy rows | Low | CHECK + audit hook flag mismatches via `agents.kind.audit_drift` event surfaced in `genie status --debug`. |
| Wish scope creep beyond 6 groups (Simplifier's flag) | Medium | Council R2 explicit dissent: any creep beyond 6 must be challenged. Reviewer enforces in `/review`. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
NEW:
  src/lib/should-resume.ts                                    (Group 1)
  src/lib/should-resume.test.ts                               (Group 1)
  src/lib/derived-signals/index.ts                            (Group 2)
  src/lib/derived-signals/recovery-anchor.ts                  (Group 2)
  src/lib/derived-signals/zombie-storm.ts                     (Group 2)
  src/lib/derived-signals/lost-anchor.ts                      (Group 2)
  src/lib/derived-signals/partition-missing.ts                (Group 2)
  src/lib/derived-signals/<n>.test.ts                         (Group 2)
  src/term-commands/status.ts                                 (Group 2)
  src/term-commands/status.test.ts                            (Group 2)
  src/term-commands/serve/ensure-ready.ts                     (Group 4)
  src/term-commands/serve/ensure-ready.test.ts                (Group 4)
  src/db/migrations/NNN_agents_kind_generated.sql             (Group 3)
  src/db/migrations/agents-kind.test.ts                       (Group 3)
  src/db/migrations/NNN_archive_legacy_identity_rows.sql      (Group 5)
  src/__tests__/state-machine.invariants.test.ts              (Group 6)
  docs/state-machine.md                                       (Group 6)

MODIFY:
  src/lib/scheduler-daemon.ts                                 (Group 1 — boot-pass + defaultListWorkers)
  src/lib/executor-registry.ts                                (Group 1 — co-export shouldResume helpers)
  src/term-commands/agents.ts                                 (Group 1 — buildResumeParams + resolveSpawnIdentity)
  src/genie.ts                                                (Group 1 — :153)
  src/genie-commands/session.ts                               (Group 1 — × 5 sites)
  src/lib/agent-registry.ts                                   (Group 3 — kind read-sites)
  src/lib/audit.ts                                            (Group 3 — kind audit hook)
  src/term-commands/serve.ts                                  (Group 4 — ensureServeReady call)
  src/term-commands/agents/list.ts                            (Group 5 — replace metrics agents flow)
  src/term-commands/events-stream.ts                          (Group 5 — fold --v2 into --enriched)
  src/term-commands/doctor.ts                                 (Group 5 — remove --state, add deprecation)
  src/term-commands/done.ts                                   (Group 6 — kind=permanent rejection)

DELETE:
  src/term-commands/agents-resume.ts (if only metrics-agents-flavored — verify before delete)
  legacy --v2 implementations after fold
```
