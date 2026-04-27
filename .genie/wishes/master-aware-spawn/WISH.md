# Wish: Master-Aware Team Spawn + Recovery Hardening

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `master-aware-spawn` |
| **Date** | 2026-04-26 |
| **Design** | [DESIGN.md](../../brainstorms/owner-vs-meeseeks-spawn/DESIGN.md) |

## Summary

Born from the 2026-04-25 power-outage recovery thread. Felipe's master agents (`email`, `genie`, `felipe`, `genie-pgserve`) lost their persistent claude session UUIDs every time a team-lead "hired" them, because the team-spawn path skipped the `shouldResume` chokepoint when no live worker row existed yet — generating fresh `--session-id <new>` instead of `--resume <uuid>`. This wish closes the master-recovery loop: a one-line chokepoint extension restores master sessions on team-spawn, plus 10 hardening items make the recovery path automatic and safe (self-healing partitions, `genie agent recover` verb, heal-not-wipe reconcilers, jsonl preservation, surfacing recoverables in `genie status`).

The taxonomy of agent classes (master / buddy / member / ephemeral) **does not require new schema** — existing primitives (`agents.kind`, `reports_to`, `team`, `task_id`, `wish_slug`, `repo_path`, `dir:` id prefix, `executors.claude_session_id`) already discriminate.

## Scope

### IN

- **(1) Spawn-path patch** in `src/lib/protocol-router.ts:resolveResumeSessionId` — fall back to `dir:<recipientId>` chokepoint lookup when `worker == null`. ~3-line change. Restores master agents' persistent sessions on team-lead "hire".
- **(2) `genie agent recover <name>` verb** — encapsulates the manual surgery (flip `auto_resume`, terminate stale `spawning` executor with `close_reason='recovery_anchor'`, anchor session UUID via chokepoint, resume).
- **(3) Heal-not-wipe reconciler guardrail** — `/trace` the code path that hard-deleted `dir:email` between resume.succeeded and now (audit-events trace). Replace DELETE with UPDATE for permanent rows. Add hard guard: never DELETE a row where `kind='permanent' AND repo_path != ''`.
- **(4) Partition self-heal** — `genie_runtime_events_maintain_partitions` PG function detects rows in default partition for date X, runs DETACH/CREATE/INSERT/DROP surgery automatically inside one transaction. Replaces today's silent error path.
- **(5) `genie status` recoverable-session inline** — for agents in STUCK section, surface the chokepoint-located session UUID with `genie agent recover <name>` hint when `auto_resume=false` and a session exists on disk.
- **(6) jsonl preservation + tail check** — when `claude --resume` exits non-cleanly, prefer `.bak` over the active jsonl if the active file's tail looks "ended" (state markers like `last-prompt`/`custom-title`/`pr-link` without subsequent conversation). Also: advisory PG lock keyed on session UUID to prevent two `--resume` processes racing.
- **(7) JSONL fallback identity-match relaxation** — current strict `(teamName, agentName)` match in `defaultScanForSession` refuses sessions whose team changed. Drop the strict team-match requirement; `agentName` becomes the load-bearing identity check. `repo_path` agreement is implicit because `defaultScanForSession(cwd, identity)` already scans only the agent's project dir derived from `cwd`. Every team-divergence recovery emits a `resume.recovered_via_jsonl_team_mismatch` audit event with both team values for traceability.
- **(8) Watchdog autoFix non-interactive guard** — detect `!process.stdin.isTTY && !sudoPasswordless`, return `refused` instead of blocking on `sudo`. Two-second timeout on `sudo -n true` probe.
- **(9) `--emergency` flag** for `genie serve start` — replaces test-only `GENIE_SKIP_PRECONDITIONS=1` with a documented operator escape that emits `serve.precondition.bypassed` audit event and surfaces in `genie doctor` until cleared.
- **(10) Stale-`spawning` reaper** — TTL-based pass in `reconcile-stale-spawns.ts` that terminates executors stuck in `state='spawning'` for >5 minutes with `close_reason='born_stuck'`. Only acts on rows where `claude_session_id IS NULL` to avoid killing slow-but-real spawns.
- **(11) Doctor partition_count audit** — reconcile `partition_count: 13` reported by `genie doctor --observability` vs `10` rows in `pg_inherits`. Either filter to active dailies + default, or rename for clarity (`partition_count_total` + `partition_count_active`).
- **(12) Fresh-install auto-start hardening** — `genie` (default command) on a clean machine triggers `autoStartServe` which throws after a 15-second deadline + dumps the entire minified `dist/genie.js` to stderr (no sourcemaps). User sees garbage, no actionable next step. Three sub-fixes: (a) extend deadline OR detect why first-time serve startup is slow (likely pgserve cold-start or partition init), (b) suppress the minified-trace dump on `autoStartServe` failure — print only the error message + a one-line "Run `genie serve --foreground` manually for diagnostics", (c) bundle with `--sourcemap` so any future trace is actually readable. Verifiable repro: `genie@genie-stefani:~/agents/simone$ genie` → 15s timeout + stack dump on fresh install of `4.260426.4`.
- **(14) Bare-name shadow cleanup + master backfill + registration guardrail** (discovered 2026-04-27 by genie-twin during Group 1 shadow analysis at `/tmp/genie-recover/group-1-shadow-analysis.json`):

  **The blast-radius problem:** Group 1's `dir:<recipientId>` fallback only fires for agents with the `dir:<name>` row shape. Twin's PG audit found that **today, the only master with this shape is `dir:email`**. The other three masters (`felipe`, `genie`, `genie-pgserve`) are bare-name + UUID pairs without dir: rows. Group 1's blast radius is currently 1 of 4 masters. To make the wish title true, Group 14 covers the rest.

  **Three shadow types** observed in PG today:
  - **Type A — `dir:` + bare** (only `email`): `dir:email` + bare `email` both exist. `findLiveWorkerFuzzy('email')` returns the bare row → `worker` non-null → Group 1's `??` doesn't fire. End-to-end fix needs Groups 1 + 3 (heal-not-wipe protects `dir:email`) + 7 (jsonl team-mismatch relaxation) + 14a.
  - **Type B — UUID + bare, NO `dir:`** (`felipe`, `genie`, `genie-pgserve`): live UUID + bare row, no `dir:*` row. Healthy today via role-fallback while the UUID is alive. **Vulnerable post-`unregister`**: bare row's `custom_name=''` blocks jsonl scan (`defaultScanForSession` requires non-empty). Group 1's patch DOES NOT FIRE — no dir: row exists. Fix needs 14b (backfill) + 7 (jsonl relaxation) + the customName-empty gap below.
  - **Type C — duplicate UUIDs** (`genie-pgserve` has 2: `4a859eb4` team='genie-pgserve' stale + `d9fd50c9` team='genie' current): orphan-cleanup gap, separate from Group 1's concern. Reconciler should archive the stale row.

  **Group 14 sub-deliverables:**
  - **14a — Bare-name shadow cleanup pass:** one-time SQL migration. For each pair where `dir:<name>` row + bare-name row share `custom_name` AND the bare row has `current_executor_id IS NULL`, archive (state='archived') the bare row — heal-not-wipe applies, never DELETE. Gated by the Group 3 guardrail.
  - **14b — Master backfill:** for each agent row with `kind='permanent' AND repo_path != ''` that has NO corresponding `dir:<name>` row, INSERT the missing dir-row with the canonical `(custom_name, role, team, repo_path)` from agent.yaml. Brings `felipe`/`genie`/`genie-pgserve` into Group 1's coverage.
  - **14c — Registration guardrail at spawn-create site:** when registering a new agent with `kind='permanent' AND repo_path != ''`, refuse to create a bare-name row if a `dir:<name>` row already exists. Prevents the shadow pattern from re-emerging.
  - **14d — `defaultScanForSession` customName fallback** (related but distinct): function currently requires `identity.customName` non-empty for jsonl matching. Bare rows have `custom_name=''`. Even with Group 7's team relaxation, jsonl recovery fails on empty customName. Either (i) populate `custom_name=role` on all bare rows during 14a, OR (ii) teach `defaultScanForSession` to fall back to `identity.role` when `customName` is empty. Recommend (i) — schema-level fix beats runtime-level fix.

  End-to-end coverage: Groups 1 + 3 + 7 + 14 (a+b+c+d) collectively close the loop for ALL masters (not just `dir:email`).
- **(15) Audit-trail completeness for `agent-directory.rm`** (discovered 2026-04-27 by twin during Group 3 validation; one critical bug folded into Group 3, two gaps deferred):
  - **15a — CRITICAL, folded into Group 3:** `recordAuditEvent(...).catch(() => {})` at `src/lib/agent-directory.ts:282` is fire-and-forget; the immediate `throw` after it kills the CLI process before the INSERT round-trips → `directory.rm.refused` event silently dropped in production. Unit test passes only because of a 50ms `setTimeout` hack in the test. **Fix:** add `await` before the call (1-line change) + drop the 50ms hack from the test. Audit-trail observability restored.
  - **15b — GAP (Wave 2):** no `directory.rm.permitted` audit event when `--explicit-permanent` legitimately succeeds. Operators can't audit successful master deletions. Should emit `directory.rm.permitted` with `{actor, agent_id, reason: 'explicit_permanent_acknowledged'}`.
  - **15c — ENHANCEMENT (Wave 3 candidate, optional):** PG-level `BEFORE DELETE ON agents` trigger captures raw-`psql` deletions outside the application layer. Covers the documented LIMIT in Group 3 (raw-SQL bypass). Trigger writes a `pg.delete.permanent_row` event before allowing the delete to proceed (or raise if certain invariants).
- **(16) Worker edit-revert race during multi-engineer dispatch** (discovered 2026-04-27 during Wave 1 execution): engineer-w1g3 reported "My edits were reverted. Let me check the test file too and re-apply both" while applying the Group 15a one-line audit-await fix. Indicates a concurrent worker editing the same file (likely engineer-w1g2 touching adjacent areas of agent-directory.test.ts during its lint-pass refactor) and overwriting w1g3's in-flight edits without merge. Tooling gap: the team-spawn flow does not coordinate concurrent edits across siblings on the same branch. Two fixes possible: (a) per-file advisory locks held by a worker for the duration of a `read → edit → re-read` cycle (file-watcher in agent-sync.ts could enforce); (b) explicit `git pull --rebase` + retry-on-conflict semantics for every Edit tool call in the worker's harness. Recommend (b) — simpler, leverages git's existing merge primitives, no new infrastructure. Repro: dispatch two engineers to adjacent regions of the same file and observe one overwriting the other.
- **(13) `genie agent send` routing fixes (discovered 2026-04-27 during this wish's own dispatch):**
  (a) **Bare-name vs UUID-keyed collision** — when an agent has both a bare-name row (no executor) AND a UUID-keyed row (live executor) on the same team, `genie agent send --to <name>` resolves to the bare-name row first and errors "Cannot reach <name>". Fix: prefer rows with non-null `current_executor_id`, OR auto-archive bare-name rows whose UUID-keyed peers are alive.
  (b) **Scope-violation false positive** — `genie agent send --to <uuid>` with both sender and recipient confirmed on the same team via `agents.team` AND `teams.members[]` returns "Scope violation: <uuid> is not in sender's team(s): <team>". The scope check uses a different lookup than the visible team membership. Reproducer: kill+respawn an `engineer` on team genie, send to its UUID from genie@genie → fails despite both rows showing team=genie in PG. Fix: align the scope-check query with `genie team ls` semantics, OR include both `agents.team` and `teams.members[]` in the membership union.
  Both bugs surfaced while orchestrating Wave 1 of THIS wish — meta-confirmation that the spawn/identity layer needs hardening across the board.

### OUT

- **No new schema column** for master/buddy/member/ephemeral classification. Existing primitives discriminate.
- **No TUI redesign** for visual class distinction (separate concern, would belong with severance design system).
- **No partial-checkpoint mid-task resume redesign** — that's v5 territory.
- **No migration tooling** for legacy multi-UUID owner agents (those whose history fragmented across many session UUIDs pre-invincible-genie).
- **No deep-dive into `.trimmed.jsonl` auto-compaction interaction** — flagged for documentation-only follow-up, not in this wish.
- **No automated cross-host recovery** — single-host-only, no remote/replica failover.
- **No upstream patches to claude-agent-sdk** — all changes confined to `@automagik/genie`.

## Decisions

| Decision | Rationale |
|----------|-----------|
| `dir:<recipientId>` lookup as the master-recovery bridge in `resolveResumeSessionId` | Master agents are exactly the rows with `id LIKE 'dir:%'` that have a workspace `repo_path`. The chokepoint already resolves them. The team-spawn router just needs to ASK when `worker` is null. |
| Self-heal in PG function, not in autoFix orchestrator | Partition surgery must be atomic (single transaction) and idempotent. Living inside `genie_runtime_events_maintain_partitions` keeps it transactional and reusable from any caller, not just `ensureServeReady`. |
| `--emergency` flag over docs-only env var | Production needs a documented escape. Env var hides intent in shell history; CLI flag puts it in command-line and audit log. |
| Heal-not-wipe gated on `kind='permanent' AND repo_path != ''` | Master agents own irreplaceable identity. Wholesale deletion is a data-loss bug. Other rows can still be deleted; the guardrail scopes precisely to permanence-with-workspace. |
| JSONL fallback relaxation with audit-event-on-mismatch | Strict match was correct security default but produced false-negative recoveries when team membership history changed. Audit event preserves traceability of when relaxation fired. |
| One wish, multi-wave delivery | All 11 items are recovery-hardening — same theme, same review surface, same release window (`.5`). Wave them in PRs (Wave 1 → Wave 2 → Wave 3) for atomic conceptual ship. |

## Success Criteria

- [ ] After killing a team-lead's auto-spawn-fresh, `genie agent resume email` resumes with `--resume <existing-uuid>`, not `--session-id <new>`. Verifiable via `ps -ef | grep --resume`.
- [ ] When the felipe team-lead hires email, the spawn cmd emits `--resume <existing-uuid>`, not `--session-id <new>`. Verifiable via the audit-events `agent.boot_pass.eager_invoked` payload `sessionId`.
- [ ] `genie agent recover <name>` flips `auto_resume`, terminates stale `spawning` executors, anchors session UUID, and resumes — all in one command. Idempotent.
- [ ] `genie_runtime_events_maintain_partitions(2, 30)` succeeds when the default partition has rows for date X, instead of erroring with "constraint violation".
- [ ] `genie status` shows recoverable sessions inline with attach hint for `auto_resume=false` rows where the chokepoint locates a session UUID.
- [ ] Watchdog precondition in `--no-fix` mode never hangs in non-interactive context — returns `refused` within 2 seconds.
- [ ] `genie serve start --emergency` boots and emits `serve.precondition.bypassed` audit event; same boot without flag respects preconditions.
- [ ] No reconciler can DELETE an agents row with `kind='permanent' AND repo_path != ''`. Unit test asserts.
- [ ] Stale-spawning reaper kills `spawning` executors with `claude_session_id IS NULL` after 5 minutes; preserves those that have a session UUID.
- [ ] JSONL fallback finds a session when `agentName` matches but `teamName` differs; emits `resume.recovered_via_jsonl_team_mismatch` audit event with both team values in the payload.
- [ ] `genie doctor` partition_count matches `pg_inherits` count, OR is renamed to `partition_count_total` + `partition_count_active` for clarity.
- [ ] All Wave 1 items shipped before Wave 2. All Wave 2 items shipped before Wave 3. Each wave is a separate PR; all three on dev → main for `.5`.
- [ ] **No regression in existing test suite.** `bun test` total pass count is unchanged or grew across all 3 waves (no removed tests, no newly skipped tests, no `--bail`-suppressed failures). Verifiable by comparing pre-Wave-1 vs post-Wave-3 `bun test` summary lines.

## Execution Strategy

> **Wave gates are PROCESS gates, not code gates.** Strictly, Groups 4, 6, 7, 8–11 have no code dependency on Wave 1 — they're sequenced in Wave 2/3 for atomic conceptual ship and to gate parallelism behind a SHIP-verdict review. Groups 2 and 5 DO have a code dependency on Group 1 (chokepoint extension). Group 3 is parallel with Group 1 inside Wave 1. The `depends-on:` line per group reflects code dependencies; wave membership reflects ship cadence. `/dream` should respect both — never start a Wave-N group until Wave-(N-1) review-gate returns SHIP.

### Wave 1 (CRITICAL — closes the "master agent loses session on reboot" loop)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Spawn-path patch: `resolveResumeSessionId` falls back to `dir:<recipientId>` chokepoint lookup |
| 2 | engineer | `genie agent recover <name>` verb (depends on Group 1's chokepoint extension being live) |
| 3 | trace + engineer | Heal-not-wipe reconciler guardrail. /trace finds the DELETE path; engineer replaces with UPDATE + permanent-row guard |
| review-w1 | reviewer | Plan-review Groups 1+2+3, gate on SHIP before Wave 2 |

### Wave 2 (HIGH — automatic resilience, parallel after Wave 1 ships)

| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | `maintain_partitions` self-heal — PG function + migration |
| 5 | engineer | `genie status` recoverable-session inline render |
| 6 | engineer | jsonl preservation + tail check + advisory lock |
| 7 | engineer | jsonl-fallback identity-match relaxation + audit event |
| review-w2 | reviewer | Review Groups 4–7, gate on SHIP before Wave 3 |

### Wave 3 (MED/LOW — polish + operator UX, parallel after Wave 2 ships)

| Group | Agent | Description |
|-------|-------|-------------|
| 8 | engineer | Watchdog autoFix non-interactive guard |
| 9 | engineer | `--emergency` flag + audit-event surface |
| 10 | engineer | Stale-`spawning` reaper TTL pass |
| 11 | engineer | Doctor partition_count audit |
| 12 | engineer | Fresh-install auto-start hardening (autoStartServe + sourcemap + clean error) |
| review-w3 | reviewer | Review Groups 8–12 |
| qa | qa | End-to-end recovery smoke: kill master agent's pane, reboot serve, verify auto-recovery; PLUS fresh-install smoke on a clean container |

## Execution Groups

### Group 1: Spawn-path master fallback
**Goal:** When the team-spawn path encounters a recipient with no live worker row, consult the chokepoint via `dir:<recipientId>` so master agents' persistent sessions are honored with `--resume` instead of fresh `--session-id`.

**Deliverables:**
1. Modify `src/lib/protocol-router.ts:resolveResumeSessionId` — change early-return to probe `agentIdToProbe = worker?.id ?? \`dir:\${recipientId}\``.
2. Unit tests in `src/lib/protocol-router.test.ts`:
   - master agent (`dir:email` exists, no live worker, current_executor with claude_session_id) → returns the session UUID.
   - master agent fallback to jsonl (current_executor null) → returns UUID via jsonl fallback.
   - ephemeral spawn (no `dir:<name>`, no worker) → returns undefined → fresh spawn.
   - existing live worker path unchanged.
3. Audit events: `agent.boot_pass.eager_invoked` payload includes `sessionId` when chokepoint resolved one.

**Acceptance Criteria:**
- [ ] Patch is ≤10 lines in `resolveResumeSessionId` body (excluding tests).
- [ ] All 4 unit-test branches above pass.
- [ ] No regression in existing `protocol-router.test.ts` cases.

**Validation:**
```bash
bun test src/lib/protocol-router.test.ts
```

**depends-on:** none

---

### Group 2: `genie agent recover <name>` verb
**Goal:** One-shot operator command that runs the manual surgery sequence required to recover a master agent post-outage. Idempotent.

**Deliverables:**
1. New `genie agent recover <name>` subcommand in `src/term-commands/agents.ts`.
2. Behavior:
   - Resolve `<name>` to agent row (by `custom_name` or `dir:<name>`).
   - `UPDATE agents SET auto_resume = true WHERE id = <agentId>`.
   - `UPDATE executors SET state = 'terminated', closed_at = now(), close_reason = 'recovery_anchor' WHERE agent_id = <agentId> AND state = 'spawning' AND ended_at IS NULL`.
   - Call `shouldResume(<agentId>)` — if no session UUID, scan jsonl in `repo_path` and create executor anchor.
   - Invoke `genie agent resume <name>` (uses Group 1's patched chokepoint).
   - Print pane id + `tmux attach -t <session>` hint.
3. `--yes` flag for unattended use; default to interactive confirm.
4. Help text + manual-recovery one-liner in error messages from boot pass.

**Acceptance Criteria:**
- [ ] `genie agent recover email` succeeds when run against an agent with stale `spawning` executor and `auto_resume=false`.
- [ ] Idempotent: second invocation is a no-op (already healed).
- [ ] Failure modes: agent not found → exit 2 with explicit message; spawn fails → preserves PG state and surfaces error.

**Validation:**
```bash
bun test src/term-commands/agents.test.ts -t "recover"
# Manual: spawn a stale executor, run recover, verify session UUID retained
```

**depends-on:** Group 1

---

### Group 3: Heal-not-wipe reconciler guardrail
**Goal:** Find the code path that hard-deleted `dir:email` between `agent.resume.succeeded` and now in tonight's audit trail. Replace DELETE with UPDATE for permanent rows. Add hard guard: never DELETE rows where `kind='permanent' AND repo_path != ''`.

**Deliverables:**
1. /trace investigation: which reconciler wiped `dir:email`? Audit-events between `2026-04-26 21:38:50` (resume.succeeded) and the next moment dir:email was missing. Likely candidates: `src/lib/reconcile-stale-spawns.ts`, `src/lib/agent-directory.ts:rm`, `src/db/migrations/050_archive_legacy_identity_rows.sql`, periodic GC in scheduler-daemon.
2. Replace identified DELETE with UPDATE that heals the inconsistency (e.g., update `team` from disk source-of-truth, leave row intact).
3. Add hard guardrail at the lowest-level row-deletion call site: refuse to delete agents rows with `kind='permanent' AND repo_path != ''`. Throw + audit-log instead.
4. Unit test: attempt to delete a `dir:email`-shaped row → throws with clear error.

**Acceptance Criteria:**
- [ ] /trace report identifies the exact code path that deleted `dir:email`.
- [ ] DELETE replaced with UPDATE-or-no-op for permanent rows.
- [ ] Unit test asserting "cannot delete permanent + repo_path agent row" passes.
- [ ] No regression in legitimate row deletion (ephemeral, archived).

**Validation:**
```bash
bun test src/lib/agent-directory.test.ts src/lib/reconcile-stale-spawns.test.ts
```

**depends-on:** none (parallel with Group 1)

---

### Group 4: `maintain_partitions` self-heal
**Goal:** Replace the brittle `genie_runtime_events_maintain_partitions` function with a self-healing version that detects "rows in default partition for target_date" and runs the DETACH/CREATE/INSERT/DROP surgery automatically inside one transaction.

**Deliverables:**
1. New migration `src/db/migrations/<NNN>_partition_self_heal.sql`:
   - Helper function `genie_runtime_events_self_heal_default_overflow(target_date DATE)` that does the surgery (DETACH default → rename to old → CREATE empty new default → CREATE missing dailies → `INSERT … OVERRIDING SYSTEM VALUE` from old → DROP old).
   - Replace `genie_runtime_events_maintain_partitions(retention_days, forward_days)` body to call the helper when overflow detected before each create.
2. Migration must be idempotent + replayable.
3. Tests in `src/db/migrations/observability-migrations.test.ts`:
   - Pre-populate default partition with rows spanning multiple days; call maintain function; verify rows redistributed; verify constraint not violated.
   - Re-run maintain function: no-op (idempotent).
   - Concurrent `INSERT` during surgery: blocked or rolled back (advisory lock).

**Acceptance Criteria:**
- [ ] All migration tests pass.
- [ ] `genie doctor --observability` shows `partition_health: ok` after maintain runs even with default-partition overflow.
- [ ] No data loss: row counts pre/post maintain are equal.

**Validation:**
```bash
bun test src/db/migrations/observability-migrations.test.ts
```

**depends-on:** none (Wave 2 parallel with Groups 5–7)

---

### Group 5: `genie status` recoverable-session inline
**Goal:** For each agent in the STUCK section of `genie status`, surface the chokepoint-located session UUID and a `genie agent recover <name>` hint when `auto_resume=false` and a session exists.

**Deliverables:**
1. Modify the status renderer (likely `src/genie-commands/status.ts` or `derived-signals/*`) to call `getResumeSessionId` (or read from chokepoint result) for each STUCK row.
2. New rendering format for recoverable rows:
   ```
   [p] email   57635c8b last:24h ago    auto_resume_disabled (RECOVERABLE)
      → genie agent recover email   # session on disk, jsonl 10422 lines
   ```
3. JSONL line count fetched once per row (cheap `wc -l` or `stat`).
4. `genie status --json` includes the new `recoverable: true|false` field per agent.

**Acceptance Criteria:**
- [ ] `genie status` shows the new "(RECOVERABLE)" tag and recover hint for `auto_resume=false` rows whose chokepoint returns a session UUID.
- [ ] `--json` output includes `recoverable` boolean per agent.
- [ ] Snapshot test in `src/genie-commands/status.test.ts` locks the rendering.

**Validation:**
```bash
bun test src/genie-commands/status.test.ts
```

**depends-on:** Group 1 (uses extended chokepoint behavior)

---

### Group 6: jsonl preservation + tail check
**Goal:** Prevent orphan `claude --resume` processes from corrupting the active jsonl with state-marker tails. Hold an advisory PG lock per session UUID to prevent two `--resume` racing.

**Deliverables:**
1. In `src/lib/providers/claude-code.ts` (or a new helper), pre-resume check:
   - If `<uuid>.jsonl` tail (last 10 lines) is dominated by state markers (`last-prompt`, `custom-title`, `agent-name`, `permission-mode`, `pr-link`, `pane-color`) WITHOUT subsequent conversation entries, AND a `<uuid>.jsonl.<timestamp>.bak` exists with later valid conversation, prefer the `.bak`.
   - When preferring `.bak`: rename current to `<uuid>.jsonl.corrupted-<timestamp>`, copy `.bak` to live path, log audit event `resume.jsonl_restored_from_bak`.
2. Acquire advisory PG lock keyed on session UUID before invoking `claude --resume`. Release on exit. Concurrent attempts get a clear error.
3. Tests in `src/lib/providers/claude-code.test.ts`:
   - tail-state-markers + valid bak → bak preferred.
   - tail looks normal → main preferred.
   - concurrent advisory lock attempt → second blocks/errors.

**Acceptance Criteria:**
- [ ] State-marker tail detection works for the 5-marker pattern from tonight's email corruption.
- [ ] `.bak` restore audit-logged.
- [ ] Advisory lock prevents two `--resume` processes on same UUID.

**Validation:**
```bash
bun test src/lib/providers/claude-code.test.ts
```

**depends-on:** none

---

### Group 7: jsonl-fallback identity-match relaxation
**Goal:** Today's `defaultScanForSession` requires strict `(teamName, agentName)` match, blocking recovery when an agent's team changed historically. Drop the strict team check; `agentName` becomes load-bearing. `repo_path` agreement is already enforced because the function scans only the agent's project dir. Every team-divergence recovery emits an audit event for traceability.

**Deliverables:**
1. Modify `src/lib/executor-registry.ts:defaultScanForSession`:
   - On `agentName !== identity.customName`: skip (unchanged — agentName is the identity anchor).
   - On `teamName !== identity.team` BUT `agentName === identity.customName`: emit `resume.recovered_via_jsonl_team_mismatch` audit event with `{jsonlTeam, currentTeam, agentId}` payload, then return the UUID.
2. Document the relaxation in the function's header docstring, explaining (a) why team-match was strict originally, (b) why dropping it is safe (`repo_path` scoping already prevents cross-workspace bleed), (c) the audit-event traceability contract.
3. Tests in `src/lib/executor-registry.test.ts`:
   - jsonl team='genie' + agent team='felipe' + agent custom_name='email' → returns UUID + audit event with both team values.
   - jsonl agentName mismatch → returns null (no relaxation here).
   - Same team in both: returns UUID, NO mismatch audit event (only fires on actual divergence).

**Acceptance Criteria:**
- [ ] Tonight's email scenario (jsonl team='genie' vs agent team='felipe') auto-recovers without manual executor INSERT.
- [ ] Audit event fires with both team values.
- [ ] No regression in cases where both fields match (happy path unchanged).

**Validation:**
```bash
bun test src/lib/executor-registry.test.ts -t "jsonl"
```

**depends-on:** none

---

### Group 8: Watchdog autoFix non-interactive guard
**Goal:** Prevent `genie serve start` from hanging on `sudo` prompts in non-interactive contexts (CI, SDK harness, no-TTY). Detect early, return `refused` instead of blocking.

**Deliverables:**
1. New helper `isSudoPasswordless()` in `src/term-commands/serve/ensure-ready.ts` (or shared util): runs `sudo -n true` with 1-second timeout; returns boolean.
2. In `defaultInstallWatchdog` (or wherever the sudo invocation happens): if `!process.stdin.isTTY && !await isSudoPasswordless()`, throw with explicit message → caught by `checkWatchdog` → returned as `refused` with `fixCommand: 'sudo bun run packages/watchdog/src/cli.ts install'`.
3. Tests in `src/term-commands/serve/ensure-ready.test.ts`: simulate non-TTY + non-passwordless-sudo → `refused` within 2s, no hang.

**Acceptance Criteria:**
- [ ] Probe completes in ≤2 seconds.
- [ ] Hangs in non-interactive context are eliminated (test under `bun test --timeout 5000`).
- [ ] Existing tests in `ensure-ready.test.ts` unchanged.

**Validation:**
```bash
bun test src/term-commands/serve/ensure-ready.test.ts --timeout 5000
```

**depends-on:** none

---

### Group 9: `--emergency` flag + audit
**Goal:** Replace the test-only `GENIE_SKIP_PRECONDITIONS=1` env-var escape with a documented production flag. Audit-log every bypass.

**Deliverables:**
1. Add `--emergency` flag to `genie serve start` in `src/term-commands/serve.ts`.
2. When set: log warning, emit `serve.precondition.bypassed` audit event with `{reason: 'emergency_flag'}`, skip `ensureServeReady`.
3. `GENIE_SKIP_PRECONDITIONS=1` continues to work but logs a deprecation warning pointing at `--emergency`.
4. `genie doctor` surfaces a yellow flag if the most recent serve.start used `--emergency` and no clean (non-emergency) start has run since.
5. Tests:
   - `--emergency` in non-interactive: succeeds, emits audit event.
   - `GENIE_SKIP_PRECONDITIONS=1`: deprecation warning printed.
   - `genie doctor`: shows emergency flag until cleared.

**Acceptance Criteria:**
- [ ] `--emergency` boots without preconditions check; audit event present.
- [ ] Deprecation warning visible on `GENIE_SKIP_PRECONDITIONS=1`.
- [ ] `genie doctor` shows emergency state correctly.

**Validation:**
```bash
bun test src/term-commands/serve.test.ts -t "emergency"
```

**depends-on:** none

---

### Group 10: Stale-`spawning` reaper
**Goal:** TTL pass that terminates executors stuck in `state='spawning'` for >5 minutes with `claude_session_id IS NULL` (born-stuck cases like Felipe's pre-outage executor `19265576-…`). Preserves slow-but-real spawns by gating on `claude_session_id`.

**Deliverables:**
1. New function `archiveStaleSpawning(ttlMin: number)` in `src/lib/reconcile-stale-spawns.ts`:
   ```sql
   UPDATE executors
   SET state = 'terminated', ended_at = now(), closed_at = now(),
       close_reason = 'born_stuck'
   WHERE state = 'spawning'
     AND started_at < now() - interval '<ttlMin> minutes'
     AND claude_session_id IS NULL
   ```
2. Wire into the periodic reconcile pass alongside `reconcileStaleSpawns`.
3. Audit event `executor.archived_born_stuck` per row.
4. Tests:
   - `spawning + claude_session_id NULL + age > 5min` → terminated with `born_stuck`.
   - `spawning + claude_session_id present` → preserved.
   - `spawning + age < 5min` → preserved.

**Acceptance Criteria:**
- [ ] Reaper runs in periodic pass; terminates only born-stuck executors.
- [ ] No false positives on real spawns with session UUIDs assigned but state still spawning.

**Validation:**
```bash
bun test src/lib/reconcile-stale-spawns.test.ts -t "born_stuck"
```

**depends-on:** none

---

### Group 11: Doctor partition_count audit
**Goal:** Reconcile `genie doctor --observability` partition_count discrepancy (13 reported vs 10 in `pg_inherits`).

**Deliverables:**
1. Inspect `src/genie-commands/observability-health.ts`'s partition_count source.
2. Either:
   a. Filter to active dailies + default; OR
   b. Rename to `partition_count_total` + add `partition_count_active` for clarity.
3. Update `genie doctor --observability` output and any consumers (`genie status --health`).
4. Snapshot test in `src/genie-commands/observability-health.test.ts`.

**Acceptance Criteria:**
- [ ] Reported count matches `SELECT count(*) FROM pg_inherits WHERE inhparent = 'genie_runtime_events'::regclass` OR field is renamed.
- [ ] Snapshot test locks the new format.

**Validation:**
```bash
bun test src/genie-commands/observability-health.test.ts
```

**depends-on:** none

---

### Group 12: Fresh-install auto-start hardening
**Goal:** Make `genie` (default command) on a clean machine produce a clean experience: serve starts reliably OR fails with a one-line actionable message — never dump the minified bundle to stderr.

**Reproducer (verbatim from a fresh `genie@genie-stefani` install of `4.260426.4`):**
```
$ genie
Starting genie serve...
2374 |     ... (massive minified `dist/genie.js` dump) ...
error: genie serve failed to start within 15s. Run `genie serve` manually.
      at autoStartServe (/home/genie/.bun/install/global/node_modules/@automagik/genie/dist/genie.js:2379:639)
note: missing sourcemaps for /home/genie/.bun/install/global/node_modules/@automagik/genie/dist/genie.js
note: consider bundling with '--sourcemap' to get unminified traces
```

**Deliverables:**
1. **Suppress the minified-trace dump on `autoStartServe` failure.** Catch the error, print only:
   ```
   error: genie serve failed to start within 15s.
   try: genie serve --foreground   # see startup diagnostics
        genie doctor                # check preconditions
   ```
   No stack trace from minified code unless `GENIE_DEBUG=1` is set.
2. **Root-cause the 15s timeout** on first-time-fresh-install starts. Suspect: pgserve cold-start (binary download, schema bootstrap, partition init) on a new host. Either extend the deadline to 60s on first-run-detected (no `~/.genie/state` or no prior PID file), OR background pgserve startup and hand `genie serve` a fast-fail readiness probe that polls until ready.
3. **Build with `--sourcemap`** so any future trace dump is at least readable. Add to `package.json` build script.
4. **Tests:**
   - `autoStartServe` failure path emits clean error message (no minified content in stderr) — snapshot test.
   - First-run readiness probe waits up to 60s when `~/.genie/state/serve.pid` doesn't exist; falls back to 15s for warm starts.
   - Build artifact `dist/genie.js.map` exists post-`bun run build`.

**Acceptance Criteria:**
- [ ] On a fresh-install repro (clean Linux container, no prior `~/.genie/`), `genie` either starts successfully OR fails with the clean 4-line message above (no minified dump).
- [ ] `bun run build` produces `dist/genie.js.map`.
- [ ] First-run timeout is 60s; subsequent runs use 15s.

**Validation:**
```bash
bun test src/term-commands/auto-start.test.ts
ls -la dist/genie.js.map
# Manual: spin up clean docker container, install npm i -g @automagik/genie@latest, run genie
```

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Master-recovery loop:** kill the felipe team-lead's auto-spawn-fresh of email (`pkill claude --session-id b26af7ee`), then send a message to email — verify the new spawn uses `--resume <existing-uuid>` not `--session-id <new>`. Confirm via `ps -ef | grep --resume`.
- [ ] **End-to-end recovery:** simulate power outage (kill claude + pgserve abruptly), restart `genie serve start`, confirm master agents (felipe, genie, email, genie-pgserve) auto-recover their persistent sessions without operator intervention. Audit events show `agent.boot_pass.eager_invoked` with non-null `sessionId` for each.
- [ ] **`genie agent recover` smoke:** manually mangle a master agent's executor row (state='spawning', stale started_at), run `genie agent recover <name>`, verify it heals within 5 seconds.
- [ ] **Partition self-heal:** insert rows into `genie_runtime_events_default` with timestamps from yesterday, run `genie_runtime_events_maintain_partitions(2, 30)`, verify rows redistributed and partition_health turns ok.
- [ ] **Status surface:** flip `auto_resume=false` on a master with valid jsonl on disk, run `genie status`, confirm RECOVERABLE tag + `genie agent recover` hint visible.
- [ ] **Watchdog non-interactive:** run `genie serve start --no-fix` in a Bash subshell with `< /dev/null`, verify it returns within 5 seconds without hanging (refused state).
- [ ] **`--emergency` flag:** `genie serve start --emergency` boots, audit-log shows `serve.precondition.bypassed`, `genie doctor` flags emergency state.
- [ ] **Born-stuck reaper:** create an executor row with `state='spawning'`, `claude_session_id=NULL`, `started_at = now() - interval '10 minutes'`. Run reconcile. Verify state transitions to `terminated` + `close_reason='born_stuck'`.
- [ ] **No-regression on team-spawn for ephemerals:** dispatch a fresh task agent (no `dir:` row) — verify it spawns with `--session-id <new>` (no false-positive `--resume`).
- [ ] **No-regression on existing genie ls:** `genie ls --json` output schema unchanged for live workers.
- [ ] **Fresh-install smoke:** clean Docker container with `npm i -g @automagik/genie@latest`, run `genie` — observes either successful TUI launch OR the clean 4-line error message; confirms NO minified-bundle dump in stderr.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `dir:<recipientId>` lookup matches an archived/orphan dir row | Medium | `shouldResume` already excludes archived rows via state filter; add explicit guard if missing. Test covers archived case. |
| Reconciler heal-not-wipe still wipes when it CAN'T heal (unparseable yaml, permission denied) | Medium | Fall back to "mark inconsistent + alert via genie doctor" rather than DELETE. Surface in doctor output. |
| JSONL fallback relaxation could attach wrong session if two agents share `agentName` across teams | Low | Relaxation requires `repo_path` agreement. `repo_path` is per-agent unique. Audit event preserves traceability. |
| Stale-spawning reaper kills a real spawn that's just slow | Low | Gates on `claude_session_id IS NULL`. Real spawns acquire session UUID within seconds. 5-minute TTL is generous. |
| `maintain_partitions` self-heal under concurrent writes | Medium | Wrap surgery in advisory lock + serializable transaction. Concurrent inserts during surgery either block or roll back. |
| Recovery verb runs in non-interactive context with confirmation prompts | Low | `--yes` flag for unattended use; default to interactive confirm; SDK callers always pass `--yes`. |
| /trace investigation in Group 3 takes longer than expected | Medium | Time-box to 4h. If root cause unidentified, ship the universal guardrail (refuse DELETE on permanent rows) without finding the specific culprit; the guardrail short-circuits any future DELETE regardless of source. |
| Wave 1 ships before Wave 2/3 reconcile other gaps | Low | Acceptable — Wave 1 closes the critical loop; Waves 2/3 are hardening. Each wave is independently shippable. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/lib/protocol-router.ts                                  # Group 1
src/lib/protocol-router.test.ts                             # Group 1 (tests)
src/term-commands/agents.ts                                 # Group 2
src/term-commands/agents.test.ts                            # Group 2 (tests)
src/lib/agent-directory.ts                                  # Group 3 (heal-not-wipe)
src/lib/agent-directory.test.ts                             # Group 3 (tests)
src/lib/reconcile-stale-spawns.ts                           # Group 3 + 10
src/lib/reconcile-stale-spawns.test.ts                      # Group 3 + 10 (tests)
src/db/migrations/<NNN>_partition_self_heal.sql             # Group 4
src/db/migrations/observability-migrations.test.ts          # Group 4 (tests)
src/genie-commands/status.ts                                # Group 5
src/genie-commands/status.test.ts                           # Group 5 (tests)
src/lib/providers/claude-code.ts                            # Group 6
src/lib/providers/claude-code.test.ts                       # Group 6 (tests)
src/lib/executor-registry.ts                                # Group 7
src/lib/executor-registry.test.ts                           # Group 7 (tests)
src/term-commands/serve/ensure-ready.ts                     # Group 8
src/term-commands/serve/ensure-ready.test.ts                # Group 8 (tests)
src/term-commands/serve.ts                                  # Group 9
src/term-commands/serve.test.ts                             # Group 9 (tests)
src/genie-commands/observability-health.ts                  # Group 11
src/genie-commands/observability-health.test.ts             # Group 11 (tests)
.genie/wishes/master-aware-spawn/WISH.md                    # this wish
.genie/brainstorms/owner-vs-meeseeks-spawn/DESIGN.md        # source design (already crystallized)
```
