# Wish: CLI Noise + Hygiene Cleanup

| Field | Value |
|-------|-------|
| **Status** | PR-A + PR-B SHIPPED; PR-C DEFERRED PENDING RE-SCOPE (per reviewer 2026-05-07) |
| **Slug** | `cli-noise-and-hygiene-cleanup` |
| **Date** | 2026-05-04 (initial), 2026-05-07 (PR-C amendment + reviewer correction) |
| **Author** | felipe + dog-fooder (trace + Socratic synthesis); PR-C from genie team-lead QA pass; reviewer correction by genie reviewer agent |
| **Appetite** | small (~110 LOC for PR-A+B; PR-C re-scope pending) |
| **Branch** | `wish/cli-noise-and-hygiene-cleanup` (PR base: `dev`) |
| **Repos touched** | `genie` |
| **Design** | Direct from `/trace` report 2026-05-04 + lensed synthesis (questioner / simplifier / architect / ergonomist). PR-A shipped via PR #1634 (2026-05-04). PR-B shipped via PRs #1636 / #1637 / #1638 / #1640 / #1642 (2026-05-04). PR-C drafted 2026-05-07 from QA dogfood; **plan-review verdict FIX-FIRST**: G3 amendment is invalid (already gated at `scheduler-daemon.ts:1296`); G9 premise wrong (line is on stderr, not stdout); G10 design misaligned with `runVerifyProbe` shape at `update.ts:362`. Only G8 (kill-path dedup) survives intact. PR-C is deferred until G9/G10 are reframed. |

## Summary

Genie 4.260504.2 ships a clean dispatch path (wish 175 closed the FK lockdown story for `mailbox.from_worker`) but still pollutes every routine CLI invocation with **~140 lines of `[pg-seed]` warnings + 1 hard `fk_teams_leader` error**, leaves **28+ "error" agents visible in `genie ls`** with no working cleanup primitive for today's failures, and recommends a `genie team repair` command that **does not exist**. On top of that, **`genie team create` itself is blocked by the same migration-061 surface this wish addresses** (council infrastructure inoperable). This wish bundles all six findings into two queued PRs that ship on top of wish 175 without re-introducing FK risk.

**depends-on:** wish 175 (`retire-session-names-id-only`) closing — specifically the kill-switch closure (migration 063 reapply) must be settled before G2/G3 land. G4 can fold INTO wish 175 G7 closure if that work is still open.

**blocks:** any future `/council` invocation; any operator who runs `genie team create`; any user who reads `genie doctor --fix` output and despairs.

## Scope

### IN

- Silence pg-seed per-team warns by default; aggregate to a single summary line. Honor `DEBUG=pg-seed`.
- Filter the team-leader value in pg-seed against the same UUID/dir CHECK that members already use.
- Fix the `JSON.stringify` → JSONB-string bug in `team-manager.createTeam` and `updateTeamConfig` so `genie team create` stops violating `teams_members_uuid_check`.
- Broaden `archiveExhaustedZombies` reason filter and add a `genie prune --errored` mode with sub-24h TTL so today's stale workers can be cleaned.
- Implement (or wire to existing primitive) `genie team repair <name>` so the doctor's recommendation works.
- Make watchdog auto-install nag opt-out for bundled installs (`GENIE_WATCHDOG_SKIP=1`).

### OUT

- Re-architecting migration 061 (it's correct; the callers leak).
- Migration 063 gating decision (owned by wish 175).
- Watchdog systemd-unit redesign or shipping the watchdog binary in the npm tarball (separate appetite).
- pg-seed cache marker rework (deferred to G6 — only if measured to matter).
- Backfill drift threshold tuning (under threshold, not actionable).
- Touching `archiveWishNamedAgents` or wish-state divergence — that's a wish-175 cleanup separately tracked.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Bundle six findings into one wish, two PRs | Same root cause (migration 061 caller leaks). One wish, one risk register. Two PRs because some bits depend on wish 175 closing. |
| 2 | G4 (team-manager JSONB encoding) hoisted to PR-A | It's the council unblocker and a wish 175 G7 callsite that was missed. May fold INTO wish 175 G7 closure if that's still open at land time. |
| 3 | G6 (cache marker stability) deferred until benchmarked | After G1 silences the warns, the cache miss is no longer user-visible. Don't ship complexity without evidence. |
| 4 | `genie prune --errored` is opt-in, not auto-run by `genie doctor --fix` | A sysop investigating an errored row may have set `auto_resume=false` deliberately. Don't archive their evidence. |
| 5 | Defense-in-depth: keep filters even after data is migrated | Downstream consumers may regress; the filter cost is negligible. |
| 6 | Per-team pg-seed warns go to `DEBUG=pg-seed`, not to a separate log file | Operators rarely consult log files; they read stderr. Env-gated verbosity is the established Unix convention. |
| 7 | `genie team repair` archives (not deletes) orphaned dirs | Inboxes and partial state may contain unread messages; `_archive/<name>-<ts>/` preserves them and reflects existing patterns elsewhere in the codebase. |

## Success Criteria

- [ ] `genie doctor --fix` on a fresh post-wish-175 install emits ≤ 30 lines of stderr (currently ~150).
- [ ] `genie team create test-foo --repo .` succeeds without `teams_members_uuid_check` violation.
- [ ] `genie team create council-<ts>` succeeds (council infrastructure unblocked).
- [ ] After `genie prune --errored --ttl-hours 1`, `genie ls` shows zero state=error rows from completed wish work.
- [ ] Doctor's `team_config_orphans` precondition's hint resolves to a real, working command.
- [ ] No regression in wish 175's FK invariants (migrations 061/063 still enforced after release).
- [ ] `DEBUG=pg-seed genie doctor` retains today's verbose output for operator debugging.

## Execution Strategy

### Wave 1 — PR-A: unblock + silence (SHIPPED via PR #1634, 2026-05-04)

| Group | Agent | Description | Status |
|-------|-------|-------------|--------|
| 1 | engineer | pg-seed silent-by-default | SHIPPED #1634 |
| 2 | engineer | pg-seed leader filter | SHIPPED #1634 + follow-up #1646 (audit dedup) |
| 4 | engineer | team-manager JSONB encoding fix | SHIPPED #1634 |
| (review) | reviewer | Verify all three patches together | DONE |

### Wave 2 — PR-B: hygiene primitives (SHIPPED via PRs #1636/#1637/#1638/#1640/#1642, 2026-05-04)

| Group | Agent | Description | Status |
|-------|-------|-------------|--------|
| 3 | engineer | `genie prune --errored` + broadened reason filter | SHIPPED #1636 + #1637 |
| 5 | engineer | `genie team repair <name>` command | SHIPPED #1640 |
| 7 | engineer | Watchdog opt-out for bundled installs | SHIPPED #1638 + docs #1642 |
| (review) | reviewer | Integration smoke | DONE |

### Wave 3 — PR-C: 72-h QA dogfood findings (DEFERRED PENDING RE-SCOPE 2026-05-07)

**Reviewer verdict 2026-05-07: FIX-FIRST.** Three of four PR-C items have invalid premises. See "Reviewer findings" section below for evidence. Only G8 survives intact.

| Group | Description | Reviewer verdict | Action required |
|-------|-------------|------------------|-----------------|
| 8 | `genie agent kill <id>` dedups shadow + UUID rows in one pass | FIX-FIRST (cosmetic — wrong file path) | Fix breadcrumb to `src/term-commands/agents.ts:2817 (handleWorkerKill)`; THEN dispatch |
| 9 | Silence `[pgserve] connected to postgres` (was: stdout pollution; CORRECTED: stderr noise — `db.ts:1128` already uses `process.stderr.write`) | FIX-FIRST (premise wrong) | Reframe: stderr noise reduction, not jq-pipeline breakage. Drop the `expect parse error` validation. Fix is still defensible. |
| 10 | Post-update verify reports correct post-install version | FIX-FIRST (design misaligned) | `runVerifyProbe` exists at `update.ts:362` and reads HTTP, NOT a binary. Actual surface: `opts.cliVersion` (passed by caller) is the `VERSION` constant from the OLD running process — needs re-read from freshly installed `package.json` post-install, OR re-exec into new binary before probe. Read `update.ts:362` first, then rewrite. |
| ~~G3 amendment~~ | ~~Gate scheduler retries on auto_resume=false~~ | **DROPPED** | Already implemented at `src/lib/scheduler-daemon.ts:1296` (and `:1469`, `:1812`). The events the QA pass observed come from the **reconciler** (`agent-registry.ts:542,568`) on one-time state transitions, NOT a retry loop. No fix needed. |

### Deferred

| Group | Status | Trigger to revisit |
|-------|--------|--------------------|
| 6 | Deferred | If benchmarked seedTeams > 500ms on representative dataset |

---

## Execution Groups

### Group 1: pg-seed silent-by-default

**Goal:** Stop dumping 109 per-team `[pg-seed]` warn lines on every CLI invocation. Replace with one summary line; gate per-team detail behind `DEBUG=pg-seed`.

**Deliverables:**
1. Wrap `console.warn` at `src/lib/pg-seed.ts:411-414` with `if (process.env.DEBUG?.includes('pg-seed'))`.
2. Track aggregate `(seededCount, droppedTeams)` in `seedTeams` and emit one summary line at end: `[pg-seed] re-seeded N teams (M had legacy member names dropped; set DEBUG=pg-seed for detail)`.
3. Same gate for the `[pg-seed] Failed to seed team "..."` warn at line 446 — keep visible by default (it's a real error), but suppress if `DEBUG=pg-seed-quiet` is set (escape hatch).
4. Update `src/lib/pg-seed.ts:253` warn (legacy bare-name agent skip) the same way.

**Acceptance Criteria:**
- [ ] `genie doctor --fix` default: zero `[pg-seed] team "..."` lines visible to user; one optional summary line.
- [ ] `DEBUG=pg-seed genie doctor` retains today's verbose output.
- [ ] Snapshot test: `genie doctor` stderr ≤ 30 lines on a representative fixture (vs. ≈150 today).
- [ ] Failed-seed errors (e.g. fk_teams_leader before G2 lands) still visible in default mode — only the per-team success warns are suppressed.

**Validation:**
```bash
# Default — should be clean
genie doctor --fix 2>&1 | grep -c "^\[pg-seed\] team " # expect 0
genie doctor --fix 2>&1 | wc -l                       # expect ≤ 30

# Verbose — should match today's output
DEBUG=pg-seed genie doctor --fix 2>&1 | grep -c "^\[pg-seed\] team " # expect ≥ 100

# Tests
bun test src/lib/pg-seed.test.ts
```

**Lensed challenges (resolved):**
- *questioner:* "Why not delete pg-seed altogether?" — Defense for pgserve resets is real; the warn payload is what hurts, not the seed itself.
- *simplifier:* "Drop the warn entirely?" — Operators want the count; aggregate keeps it.
- *architect:* "Will this hide real failures?" — No: the catch block at :446 still emits, and `DEBUG=pg-seed` recovers all detail.
- *ergonomist:* "What does the user need?" — Either silence or one line. Aggregate is the smaller change.

**depends-on:** none. First to land.

---

### Group 2: pg-seed leader filter (kills `fk_teams_leader` violation)

**Goal:** Stop pg-seed from inserting bare-name leader values that violate `fk_teams_leader`. Filter the leader column with the same UUID/dir CHECK already applied to members.

**Deliverables:**
1. In `upsertNativeTeam` (`src/lib/pg-seed.ts:407`), compute `safeLeader = isValidTeamMember(deriveLeader(c)) ? deriveLeader(c) : null` before the INSERT.
2. Pass `safeLeader` (not raw `deriveLeader(c)`) into the INSERT at line 423.
3. When `safeLeader` is null and `deriveLeader(c)` was non-null, emit one audit event: `recordAuditEvent('team', c.name, 'leader_sanitized', 'pg-seed', { dropped: leader, reason: 'fk_teams_leader_check' })`.
4. Keep the existing audit pattern; do not silently drop.

**Acceptance Criteria:**
- [ ] `council-1777896175` and any other legacy team with bare-name leader seed without throwing.
- [ ] Audit log shows one `leader_sanitized` event per affected team (drift detection signal).
- [ ] Test: PG fixture with team config containing `leadAgentId: "<bare-name>@<bare-name>"` → upsert succeeds, leader stored as `null`, audit row written.

**Validation:**
```bash
# Reproduce
genie doctor --fix 2>&1 | grep "fk_teams_leader" # expect: no output

# Tests
bun test src/lib/pg-seed.test.ts -t "leader filter"
bun test src/lib/pg-seed.test.ts -t "audit on sanitized leader"
```

**Lensed challenges (resolved):**
- *questioner:* "Why does the leader column have a bare name?" — Legacy `leadAgentId: "<name>@<name>"` from pre-061 era. The data is the bug; defense-in-depth is the seed-side fix.
- *simplifier:* "Just nullable leader." — That's the proposal.
- *architect:* "Will null leader break runtime?" — `getTeam` already handles null; `ensureTeamRow` updates leader on first real spawn.
- *sentinel:* "Auth bypass via null leader?" — No. Hierarchy bypass keys on `cli` sender, not team leader. Null leader = no bypass surface added.

**depends-on:** none. Independent of G1 — both can ship in same PR.

---

### Group 3: `genie prune --errored` (cleans 28 visible zombies)

**Goal:** Make `genie prune` actually clean today's failures. The current `--zombies` filter requires `reason='dead_pane_zombie'` AND >24h age — both fail for today's `stale_spawn_dead_pane` workers.

**Deliverables:**
1. Broaden `archiveExhaustedZombies` reason filter at `src/lib/agent-registry.ts:623`: `details->>'reason' IN ('dead_pane_zombie', 'stale_spawn_dead_pane')`.
2. Add `genie prune --errored` mode: archive any state=error+auto_resume=false regardless of reason tag, with `--ttl-hours <n>` (default 1). Distinct from `--zombies` (24h, reason-gated).
3. Update `src/term-commands/prune.ts` to register the new flag and route to a `archiveAllExhaustedErrored(ttlHours)` helper that mirrors `archiveExhaustedZombies` minus the reason filter.
4. Update `--help` text to document the distinction: `--zombies` = reconciler-tagged dead-pane (24h default); `--errored` = any exhausted error state (1h default, opt-in).
5. Audit event on archive remains `state_changed` with `reason: 'errored_ttl_exhausted'` for `--errored` and `dead_pane_zombie_ttl_exhausted` for `--zombies` (preserves existing taxonomy).

**Acceptance Criteria:**
- [ ] After G3 lands and `genie prune --errored --ttl-hours 1` runs on the trace dataset, `genie ls` shows zero state=error rows from wish 175 / autopg engineer-* workers.
- [ ] `--dry-run` mode lists targets without mutating.
- [ ] `genie prune` with no flag still errors with the existing "no prune target" message.
- [ ] Existing `--zombies` behavior unchanged.
- [ ] Test: 5-row fixture with mixed reasons, `--zombies` matches only `dead_pane_zombie`+24h; `--errored` matches all error+exhausted.

**Validation:**
```bash
# Repro before fix:
genie prune --zombies --dry-run | grep -c "Would archive"  # 0 today (TTL+reason)

# After fix:
genie prune --errored --dry-run --ttl-hours 1 | grep -c "Would archive"  # ≥ 28 on a noisy host
genie prune --errored --ttl-hours 1
genie ls --json | jq '[.[] | select(.status | startswith("error"))] | length'  # 0

bun test src/lib/agent-registry.test.ts -t "archiveExhaustedZombies"
bun test src/term-commands/prune.test.ts
```

**Lensed challenges (resolved):**
- *questioner:* "What if the user wants to keep an errored row visible?" — Set `auto_resume=true` until investigation completes. Document in `--help`.
- *simplifier:* "One mode, broaden `--zombies`." — Risk: erases the distinction between reconciler-tagged dead-pane and other error causes. Adding `--errored` preserves it.
- *operator:* "Auto-fix in doctor is dangerous." — Don't default it on. `genie doctor --fix` does not invoke `prune --errored`.
- *architect:* "Will `IN` filter regress prune --zombies?" — No: existing reason `dead_pane_zombie` still matches; we only ADD `stale_spawn_dead_pane` to the set.

**depends-on:** none for code; in PR-B because we want wish 175 closed first to avoid archiving wish-175-active rows.

**PR-C amendment DROPPED (2026-05-07):** Original draft proposed gating scheduler retries on `auto_resume=false`. Reviewer verified this is **already implemented** at `src/lib/scheduler-daemon.ts:1296` (`if (worker.autoResume === false) continue;`) plus secondary gates at `:1469` and `:1812`. The events the QA pass observed (`stale_spawn_dead_pane` / `dead_pane_zombie`) come from the **reconciler** at `agent-registry.ts:542, 568` on one-time `spawning|running → error` transitions (UPDATE has `WHERE state = ${prevState}` which prevents repeat firing). The "~1,440 lines/day per stuck agent" extrapolation was incorrect — actual rate is one event per state transition. **No fix required.**

---

### Group 4: `genie team create` doesn't violate `teams_members_uuid_check` (P0 council unblocker)

**Goal:** Fix the JSONB-string encoding bug in `team-manager.createTeam` and `updateTeamConfig` so `genie team create` stops failing on a pristine, empty members array.

**Background:** Migration 045 documented the `JSON.stringify` → JSONB-string anti-pattern and migrated several callers to `sql.json`. `team-manager.ts:399-415` (createTeam INSERT) and `:910-928` (updateTeamConfig UPDATE) were missed. Pre-061 the bug was harmless (no CHECK to fail). Post-061's `teams_members_uuid_check` calls `jsonb_typeof = 'array'` on the value; a JSONB STRING `"[]"` fails the check even though it represents an empty array.

**Deliverables:**
1. `src/lib/team-manager.ts:408` — replace `${JSON.stringify(config.members)}` with `${sql.json(config.members)}`.
2. `src/lib/team-manager.ts:414` — replace `${config.allowChildReachback ? JSON.stringify(...) : null}` with `${config.allowChildReachback ? sql.json(...) : null}`.
3. `src/lib/team-manager.ts:918` (updateTeamConfig UPDATE) — same `sql.json` migration for `members`.
4. `src/lib/team-manager.ts:926` (UPDATE) — same for `allow_child_reachback`.
5. Defense-in-depth: add `members.filter(isValidMember)` in createTeam BEFORE the INSERT (in case some downstream code populates bad names). `isValidMember` uses the same regex pattern from `pg-seed.ts:402-405` — extract to a shared `src/lib/identity-shape.ts` helper.

**Acceptance Criteria:**
- [ ] `genie team create test-foo --repo .` succeeds with empty members.
- [ ] `genie team create council-<ts> --repo .` succeeds (council infrastructure unblocked).
- [ ] Round-trip test: createTeam → getTeam → members reads as JS array `[]`, NOT string `"[]"`. Verified via `jsonb_typeof(members) = 'array'`.
- [ ] Audit fixture: simulate downstream caller injecting a bare-name member into `config.members`; createTeam filters and inserts only valid entries; emits `team.member_sanitized` audit event.

**Validation:**
```bash
# Repro before fix
genie team create probe-$(date +%s) --repo . 2>&1 | grep "teams_members_uuid_check" # expect non-empty

# After fix — both should succeed
genie team create probe-$(date +%s) --repo .
genie team create council-test-$(date +%s) --repo .

# Tests
bun test src/lib/team-manager.test.ts -t "createTeam encoding"
bun test src/lib/team-manager.test.ts -t "updateTeamConfig encoding"
bun test src/lib/team-manager.test.ts -t "filters bare-name members"

# Council probe
genie team create council-smoke-$(date +%s) --repo . && genie team done council-smoke-*
```

**Lensed challenges (resolved):**
- *questioner:* "Is this the bug, or is `members` populated with bad names somewhere upstream?" — Verified: createTeam initializes `members: []` and never adds names. The bug is encoding. (Defense-in-depth filter is cheap insurance, not the primary fix.)
- *simplifier:* "Why hasn't this surfaced before?" — Pre-061 the CHECK didn't exist; double-encoding was harmless. 061 made it fatal. Same story as the dispatcher GENIE_AGENT_ID flip.
- *architect:* "Should this fold INTO wish 175 instead of standalone?" — Strongly yes if wish 175 G7 is still open at land time. It's the same callsite-flip pattern. Wish 175's PR can absorb this without rebase pain.
- *ergonomist:* "Will users see this fix?" — Indirectly: it unblocks the council, normal team creation, and any operator hitting `--repo .` workflows. Most users never run team-create directly, but the noise from failed seeds reaches everyone.

**depends-on:** none. Should hoist to land FIRST in PR-A — this is the council unblocker.

**Folding option:** If wish 175 G7 closure work is open at land time, fold this group into wish 175 G7 instead of shipping standalone. Same callsite class, same review surface, same release window.

---

### Group 5: `genie team repair <name>` (fixes broken doctor hint)

**Goal:** Implement the `genie team repair` command that the doctor's `team_config_orphans` precondition recommends but does not exist.

**Deliverables:**
1. New command in `src/term-commands/team.ts`: `genie team repair <name>` with handler `repairTeamCommand(name)`.
2. Logic:
   - If `~/.claude/teams/<name>/config.json` is missing AND PG team row exists → write config.json from PG row.
   - If `~/.claude/teams/<name>/config.json` exists AND PG team row is missing → ensureTeamRow upsert from disk.
   - If both are missing partial state (e.g., only `inboxes/` subdir) → archive `~/.claude/teams/<name>/` to `~/.claude/teams/_archive/<name>-<unixtime>/` and emit audit `team.repaired`.
   - If both exist and consistent → no-op with `[ok]` message.
   - If both exist but conflict (PG and disk disagree) → print diff, exit 2 without mutating, recommend `--force-pg` or `--force-disk`.
3. Add `--force-pg` and `--force-disk` flags for the conflict case.
4. Update doctor's `team_config_orphans` hint at `src/term-commands/serve/ensure-ready.ts` to point at this command.

**Acceptance Criteria:**
- [ ] `genie team repair felipe-scout` archives the orphaned `inboxes/`-only dir to `_archive/felipe-scout-<ts>/`.
- [ ] Doctor's `team_config_orphans` precondition with the felipe-scout fixture resolves cleanly after `genie team repair`.
- [ ] Test: PG-only fixture → repair writes config.json. Disk-only fixture → repair upserts PG row. Conflicting fixture → exit 2 + diff.

**Validation:**
```bash
genie team repair felipe-scout
ls /home/genie/.claude/teams/_archive/felipe-scout-*/inboxes # exists

genie doctor --fix 2>&1 | grep "team_config_orphans" # expect: [ok]

bun test src/term-commands/team.test.ts -t "repair"
```

**Lensed challenges (resolved):**
- *ergonomist:* "Repair is too vague. What's the contract?" — Documented above: "make PG and disk consistent for this team name; archive on unrecoverable partial state."
- *questioner:* "Should we just delete?" — Risk: inboxes may contain unread messages. Archive (don't delete) is safer and reversible.
- *simplifier:* "Just point doctor at `genie team archive` if it exists?" — `archive` is a different verb (preserve PG row, mark archived). `repair` is for inconsistency between PG and disk. Different semantics, both useful.

**depends-on:** none.

---

### Group 6: pg-seed cache marker stability (DEFERRED)

**Goal:** Replace mtime-based cache invalidation with content-hash invalidation so the seed loop doesn't re-run on every spawn.

**Deferred unless benchmarked.** After G1 silences the warns, the cache miss is no longer user-visible. Likely not worth the complexity. Revisit only if measured to be a perf cost.

**Trigger to revisit:**
- `genie doctor` cold-start measured at > 500ms in seedTeams.
- Or operator reports CLI invocation slowness post-G1.

**Stub deliverable when revisited:**
- Replace `teamsDirMtime` with `teamsDirContentHash` (sorted set of subdirectory names, hashed).
- Marker stores hash instead of mtimeMs.
- Re-seed only when team-set membership changes (create/destroy), not on every internal modification.

**depends-on:** G1.

---

### Group 7: Watchdog opt-out for bundled installs

**Goal:** Stop the doctor from emitting `[!!] watchdog — auto-install failed` on every run for bundle-mode users who don't have `packages/watchdog/`.

**Deliverables:**
1. In `src/term-commands/serve/ensure-ready.ts:207-225` (`defaultInstallWatchdog`), check `process.env.GENIE_WATCHDOG_SKIP === '1'` first; return `{ status: 'skipped', reason: 'GENIE_WATCHDOG_SKIP=1' }` without trying to resolve the CLI.
2. When `resolveWatchdogCliPath` returns null AND `GENIE_WATCHDOG_SKIP` is unset, downgrade the precondition from `[!!]` to `[~~]` (informational) and surface a clearer hint: `"Watchdog optional in this install. Set GENIE_WATCHDOG_SKIP=1 to silence, or run from source repo to enable."`
3. Document `GENIE_WATCHDOG_SKIP` in the doctor `--help` text and in any wish/install README.

**Acceptance Criteria:**
- [ ] `GENIE_WATCHDOG_SKIP=1 genie doctor` shows `[ok] watchdog (skipped)` instead of `[!!]`.
- [ ] Default bundle install shows informational hint, not a blocking warning.
- [ ] Source-repo install (with `packages/watchdog/`) still tries the install and reports `[ok]` or `[!!]` as today.

**Validation:**
```bash
# Bundle install (no packages/)
GENIE_WATCHDOG_SKIP=1 genie doctor 2>&1 | grep watchdog # expect: [ok] (skipped)
genie doctor 2>&1 | grep watchdog # expect: [~~] (informational), not [!!]

bun test src/term-commands/serve/ensure-ready.test.ts -t "watchdog skip"
```

**Lensed challenges (resolved):**
- *operator:* "What does watchdog actually do?" — systemd unit for daemon healthcheck. Low value for casual users; high for prod.
- *simplifier:* "If most users don't need it, default-skip." — `GENIE_WATCHDOG_SKIP=1` opt-out is a middle ground; auto-skipping when CLI absent is implicit default already (just downgrades severity).
- *deployer:* "Ship the binary in npm tarball." — Bigger change; defer to separate appetite.

**depends-on:** none.

---

### Group 8: `genie agent kill` dedups shadow + UUID rows in one pass

**Status:** FIX-FIRST (cosmetic) — premise valid, file path corrected by reviewer 2026-05-07.

**Goal:** Killing a `dir:<name>` shadow row OR a concrete UUID row should clean BOTH halves of the same logical agent. Today they're independent — proven by the 2026-05-07 cleanup where killing 7× `dir:codex-*` left 7× UUID twins alive in `error` state.

**Background:** The `agents` table holds two kinds of rows for any agent that has ever been registered:
- A `dir:<name>` shadow row (logical anchor, persistent template).
- A concrete UUID row (per-instance executor handle).

`genie agent kill <id>` accepts either ID and removes only the row that matched. The other half stays and reappears in `genie ls` until manually killed too. (The "scheduler retry leak" framing in the prior PR-C amendment was wrong — see DROPPED amendment note above. The actual harm is row-count drift in `genie ls` and potential confusion for operators trying to clean up.)

**Deliverables:**
1. In **`src/term-commands/agents.ts:2817 (`handleWorkerKill`)** — entry point is `src/term-commands/agent/kill.ts:15` which delegates here. After the matched row is removed via `registry.unregister(w.id)`, look up the *paired* row by `(name, team)` and remove it as well, atomically (one transaction).
   - If matched-row id starts with `dir:` → also delete any UUID row where `name = <matched-name>` AND `team = <matched-team>`.
   - If matched-row id is a UUID → also delete the `dir:<name>` row for the same `(name, team)` if it exists AND no other UUID instances share that name.
2. New audit event `agent.kill.dedup_paired` emitted once per kill that nuked a paired row. Includes `{ matched: <id>, paired: <id> }` for forensic traceability.
3. Operator output: extend the success message to `Agent "<id>" killed and unregistered (template preserved). Paired row "<paired-id>" also removed.` when dedup fired.
4. Defensive: if the operator passes `--keep-paired`, skip the dedup step (escape hatch for the rare forensic case where the operator wants the surviving half to study).

**Acceptance Criteria:**
- [ ] `genie agent kill dir:foo` removes BOTH the `dir:foo` shadow AND any UUID row in `agents` named `foo` in the same team.
- [ ] `genie agent kill <uuid-of-foo>` removes BOTH the UUID row AND the `dir:foo` shadow IF no other UUID instances share the name.
- [ ] Audit log shows exactly one `agent.kill.dedup_paired` event per dedup-active kill.
- [ ] `--keep-paired` preserves today's single-row behavior.
- [ ] After a kill of any genuinely-zombie agent, `genie events errors --since 5m` produces zero NEW dead-pane patterns from that agent's UUID (paired with G3 amendment).
- [ ] Test: 4-row fixture with 2 logical agents (each with shadow + UUID), kill one → 2 rows removed; kill the other UUID → 2 more rows removed; final state is empty.

**Validation:**
```bash
# Repro before fix (today's behavior — provably broken on 2026-05-07):
genie ls --json | jq '[.[] | select(.team == "<team>")] | length'   # N
genie agent kill dir:<name>
genie ls --json | jq '[.[] | select(.team == "<team>")] | length'   # N-1 (UUID twin survives)

# After fix:
genie ls --json | jq '[.[] | select(.team == "<team>")] | length'   # N
genie agent kill dir:<name>
genie ls --json | jq '[.[] | select(.team == "<team>")] | length'   # N-2 (both halves gone)

# Tests
bun test src/term-commands/agent.test.ts -t "kill dedup paired"
```

**Lensed challenges (resolved):**
- *questioner:* "Why are there two rows for the same agent in the first place?" — Migration history. The `dir:` shadow is the persistent template; the UUID is the per-instance executor. Both are useful. The bug is in the kill path, not the schema.
- *simplifier:* "Just kill by UUID, drop dir support." — Loses the operator's ability to address "the team's qa agent" without first finding the UUID. Status quo addressing is more useful; fix the kill path.
- *architect:* "Race: another spawn could land between the two deletes." — Atomic transaction. Deletes happen in a single `BEGIN; ... COMMIT;`.
- *sentinel:* "Could the dedup nuke a row the operator wanted to keep?" — Yes; `--keep-paired` is the escape. Default behavior matches operator intent ("kill the agent" = kill all its rows).

**depends-on:** none. Independent of G3 PR-C amendment but ships in the same PR-C bundle.

**File(s) to modify:** `src/term-commands/agents.ts:2817` (`handleWorkerKill` body), `src/term-commands/agent/kill.ts:15` (caller; may stay unchanged), `src/lib/agent-registry.ts` (paired-row helper if needed), tests.

---

### Group 9: Reduce `[pgserve] connected to postgres` stderr noise on every CLI invocation

**Status:** FIX-FIRST (premise rewritten by reviewer 2026-05-07).

**Goal:** Reduce stderr noise emitted on every CLI invocation. The line `[pgserve] connected to postgres` is **already on stderr** (verified at `src/lib/db.ts:1128` — `process.stderr.write(...)`), so it does NOT break JSON-consuming pipelines. It does, however, fire on every command that touches the DB and clutters operator terminals.

**Background — what was wrong with the original premise:**
The original PR-C draft claimed `genie ls --json | jq '.[0]'` failed with a parse error. Reviewer verified live on `4.260507.1`: the pipeline succeeds. The prefix lands on stderr, jq parses stdout cleanly. Operators see the prefix on the terminal but it does not corrupt machine-readable output. The fix is still defensible as a hygiene improvement, but the framing must change.

**Corrected deliverables:**
1. Gate `src/lib/db.ts:1128` (`process.stderr.write('[pgserve] connected to ${db}\n')`) behind `DEBUG=pgserve` (parity with G1 pg-seed pattern). Default: silent.
2. Audit other unconditional stderr writes from connection / bootstrap paths (e.g. `[scheduler] tick`, `[mailbox] reconciled` if any exist). Inventory first; touch only the ones that are strictly informational, NOT diagnostic warnings/errors.
3. Lint guard: add an `emit-discipline` rule that flags `process.stderr.write` / `console.error` calls in connection/bootstrap modules. Exemptions require an explicit `// emit-discipline: ok — <reason>` comment.
4. **Out of scope:** any line that is a real warning or error (sanitization audits, FK violation surfaces, etc.) stays default-on.

**Acceptance Criteria:**
- [ ] Default invocation: `genie ls --json` produces clean JSON on stdout AND no `[pgserve] connected to postgres` line on stderr.
- [ ] `DEBUG=pgserve genie ls --json 2>&1 1>/dev/null | head -5` retains today's verbose connection log.
- [ ] Real warnings/errors (e.g. FK violations) still emit at default verbosity.
- [ ] Lint rule fails on any new informational `process.stderr.write` in connection/bootstrap modules without the exemption comment.
- [ ] `bun run check:fast` includes the new lint rule.

**Validation:**
```bash
# Today's behavior (live-verified 2026-05-07):
genie ls --json | jq '.[0]'              # WORKS (already)
genie ls --json 2>&1 1>/dev/null | head -3
# [pgserve] connected to postgres        # ← stderr noise we want to silence

# After fix:
genie ls --json 2>&1 1>/dev/null | head -3
# (silent unless DEBUG=pgserve)

# Verbose recovery:
DEBUG=pgserve genie ls --json 2>&1 1>/dev/null | head -3
# [pgserve] connected to postgres

# Tests
bun test src/lib/db.test.ts -t "no default stderr emit on connect"
```

**Lensed challenges (resolved):**
- *ergonomist:* "Why is this on stdout in the first place?" — Likely an old debug print that was never gated. Stale code, not intentional design.
- *operator:* "I rely on the prefix to confirm pgserve is up." — `genie doctor` is the canonical path; the prefix is noise on every other command.
- *simplifier:* "Just delete the line." — `DEBUG=pgserve` recovery preserves the diagnostic value for the rare debug case.
- *measurer:* "What about machine-readable output?" — JSON-on-stdout is the public contract for `--json` commands. Anything else on stdout is a defect.

**depends-on:** none. Independent of G1 (which silences `[pg-seed]` warns).

**File(s) to modify:** `src/lib/db.ts:1128` (gate emit), plus the lint rule under `tools/lint/` or equivalent.

---

### Group 10: Post-update verify probe reports the freshly installed CLI version

**Status:** FIX-FIRST (design misaligned with `runVerifyProbe` shape — reviewer 2026-05-07). Needs a `/trace` pass into `update.ts:362` before re-spec.

**Goal:** After `genie update`, the verify probe must report the FRESHLY INSTALLED version, not the version from the running (old) process's compiled-in `VERSION` constant. Today the probe receives `opts.cliVersion: VERSION` from the running process — which is the OLD binary's compile-time version — so a successful update can verify "ok" against itself with a stale version string and miss a failed install.

**Background — what was wrong with the original premise:**
The original PR-C draft assumed `runVerifyProbe` shells out to `genie doctor --json`, and proposed using the resolved post-install binary path. **Reviewer verified live**: `runVerifyProbe` exists at `src/genie-commands/update.ts:362` and takes `opts.cliVersion` from the caller (currently `VERSION` constant, see line 1652). It does NOT spawn a binary — it reads HTTP. So `realpath`, `hash -r`, and "binary invocation" framings do not apply.

The actual bug surface is: **how does `opts.cliVersion` get computed?** Today it's the in-process `VERSION` constant. After `bun install` of a new version, the running process still has the OLD `VERSION` because the binary on disk has been replaced but the running image is the original. The verify probe then compares `opts.cliVersion` (old) against `serverHealthBody.version` (which may be old or new depending on whether the daemon restarted), and `decideVerify` either says `ok` (if both still old, masking failed restart) or `version-mismatch`.

**Re-spec required (BLOCKING for dispatch):**
A `/trace` pass needs to:
1. Read `src/genie-commands/update.ts:362-400` (`runVerifyProbe`) and `:1652` (the `VERSION`-passing callsite).
2. Document the actual flow: where does `opts.cliVersion` come from at each call site? When does a fresh value become available?
3. Identify the right fix: (a) re-read `package.json` from the install destination after install completes, then pass that as `opts.cliVersion`; (b) re-exec into the new binary before running the probe; (c) something else.
4. Re-write G10's deliverables once the trace is complete.

**Provisional acceptance criteria (to confirm post-trace):**
- [ ] After `genie update` from `vX → vY`, `runVerifyProbe` receives `opts.cliVersion === 'vY'` (the freshly installed version), not `vX` (the running-process compile-time constant).
- [ ] Diagnostics file shows both `installedVersion` and `cliVersion` fields explicitly; mismatch exits non-zero.
- [ ] Test: synthetic install fixture verifies post-install version is the one passed to the probe.

**depends-on:** `/trace` pass into `update.ts:362` to confirm the actual callsite shape. Until that's done, G10 dispatch is blocked.

**Cross-wish note:** the `update-unify-stages` G4 cross-reference in the original PR-C draft is **stale** — `runVerifyProbe` already exists in this tree. Verify whether `update-unify-stages` G4 has actually landed; if so, the "fold-or-layer" decision is moot.

**File(s) to inspect/modify (after trace):** `src/genie-commands/update.ts:362, 1652` plus tests.

---

## Risk Register

| # | Risk | Mitigation |
|---|------|-----------|
| 1 | G2/G4 filter masks a real bare-name leak | Audit events on every sanitized leader/member; alerting via `genie events errors --type leader_sanitized\|member_sanitized` to detect drift. |
| 2 | G3 archives a row a sysop wanted to keep | Default TTL ≥ 1h; require explicit `--errored` flag (not in `--zombies`); document `auto_resume=true` as the "keep visible" signal. |
| 3 | G4 folded into wish 175 mid-PR causes rebase | If wish 175 G7 already closed, ship G4 standalone in PR-A. Coordinate with wish 175 owner before folding. |
| 4 | G1 hides a real seed regression | `DEBUG=pg-seed` recovery path retains today's verbose mode; failed-seed errors (G2 surface) still emit by default. |
| 5 | Council remains broken if G4 lands but bundled binary not rebuilt | After G4 merges, dogfood smoke must include `npm pack` → install → `genie team create council-smoke-$(date +%s)` round-trip before declaring done. |
| 6 | G5 race condition: PG row created concurrent with repair | `repair` reads PG state once at start; if state mutates mid-repair, exit 2 + recommend retry. No silent overwrites. |
| 7 | G8 dedup nukes a forensic-only paired row | `--keep-paired` escape hatch documented in `--help`; default behavior matches operator intent. |
| 8 | G9 silences a connection log an operator depended on | `DEBUG=pgserve` recovery; `genie doctor` is the canonical health check. |
| 9 | G10 fold collision with `update-unify-stages` G4 | Coordinate at land time: if G4 unmerged, fold G10 deliverables INTO G4 PR. Otherwise ship as layered amendment. |
| 10 | G3 PR-C amendment masks a real scheduler bug | Audit event `scheduler.skip_disabled` per-tick provides drift signal; if rate spikes, investigate before re-broadening. |

---

## Acceptance for the Whole Wish

When all of these are true, the wish is DONE:

- [ ] `genie doctor --fix` on a fresh post-wish-175 install emits ≤ 30 lines of stderr (currently ~150).
- [ ] No `fk_teams_leader` violation visible during pg-seed runs.
- [ ] `genie team create test-foo --repo .` succeeds without error.
- [ ] `genie team create council-<ts> --repo .` succeeds and `genie spawn council--questioner --team council-<ts>` succeeds (council infra restored).
- [ ] After `genie prune --errored --ttl-hours 1`, `genie ls` shows zero `error (0/3 resumes)` rows from completed wish work.
- [ ] `genie team repair felipe-scout` resolves the doctor's `team_config_orphans` warning.
- [ ] `GENIE_WATCHDOG_SKIP=1 genie doctor` does not flag watchdog as `[!!]`.
- [ ] Wish 175's FK invariants (migrations 061/063) remain enforced.
- [ ] Audit events for all sanitization paths visible in `genie events list --type team.member_sanitized,leader_sanitized` for drift detection.
- [ ] **PR-C** — `genie agent kill <id>` removes both shadow + UUID rows in one pass; `--keep-paired` preserved.
- [ ] **PR-C** — `genie ls --json | jq '.[0]'` works without `2>/dev/null`; pgserve connect line gated behind `DEBUG=pgserve`.
- [ ] **PR-C** — `genie update --yes` reports the freshly installed binary version in the verify probe; mismatch is fatal.
- [ ] **PR-C** — Scheduler tick produces zero retry attempts on `auto_resume=false` rows; one `scheduler.skip_disabled` audit event per skipped row.

---

## Sequencing Note (Critical)

This wish ships **on top of** wish 175 (`retire-session-names-id-only`), not in conflict with it. Specifically:

- **G4 may fold INTO wish 175 G7 closure** if that group is still open. Coordinate before opening PR-A.
- **G2 + G3 must land AFTER wish 175's migration 063 closes the kill-switch** — otherwise we ship a fix for FK violations that 062 has temporarily disabled, masking whether the fix actually works.
- **G1, G5, G7 are independent** of wish 175 and can ship anytime.

The recommended pipeline:
1. Wish 175 closes G7 → G4 folds in OR ships immediately after as PR-A0.
2. Wish 175 closes 063 reapply → G2 + G1 ship as PR-A.
3. Wish 175 fully retires → G3 ships as PR-B.
4. G5 + G7 ship anytime alongside.

---

## Reviewer findings — 2026-05-07 plan-review FIX-FIRST

The reviewer agent (`01794572-94cb-437d-b733-d114cf1ef243`) ran a full plan review against the live binary `4.260507.1` and the source tree. Key corrections to the prior PR-C draft:

| Item | Premise as drafted | Live state | Action |
|------|--------------------|------------|--------|
| PR-A reference | "shipped via #1644 + #1646" | **Shipped via #1634** (2026-05-04 16:13). #1644 is unrelated; #1646 is a follow-up audit-dedup. | Header corrected. |
| PR-B status | "in flight, drafted" | **ALREADY MERGED** via PRs #1636 / #1637 / #1638 / #1640 / #1642 (all 2026-05-04). | Wave 2 table marked SHIPPED. |
| G3 PR-C amendment | "scheduler still tries to resume `auto_resume=false` rows; ~1,440 lines/day spam" | `src/lib/scheduler-daemon.ts:1296` already has `if (worker.autoResume === false) continue;` (plus gates at `:1469`, `:1812`). Observed events come from the **reconciler** at `agent-registry.ts:542,568` on one-time state transitions, NOT a retry loop. | **DROPPED** — premise invalid. |
| G8 file path | `src/term-commands/agent.ts` | File does not exist. Actual: `src/term-commands/agents.ts:2817 (handleWorkerKill)`, called via `src/term-commands/agent/kill.ts:15`. | Path corrected. |
| G9 premise | "stdout pollution breaks `--json \| jq` pipelines" | `src/lib/db.ts:1128` already uses `process.stderr.write` — line is on stderr, jq pipelines work fine without redirect. | Reframed: stderr noise reduction, not pipeline breakage. |
| G10 design | "invoke verify probe via fully resolved post-install binary path" | `runVerifyProbe` at `src/genie-commands/update.ts:362` reads HTTP, does NOT spawn a binary. `opts.cliVersion` is passed by caller (the `VERSION` constant from the running process). | **DEFERRED** — needs `/trace` pass before re-spec. |

**Verified live (genie 4.260507.1):**
- `genie ls --json | jq '.[0].id'` returns `"dir:aegis"` cleanly. No stderr redirect needed for jq.
- `grep "autoResume === false" src/lib/scheduler-daemon.ts` returns 3 hits, the `:1296` early-continue being the dominant gate.
- `grep "process.stderr.write" src/lib/db.ts | grep connected` confirms the emit is on stderr.

**Verdict:** PR-C as drafted is **NOT SHIPPABLE**. Only G8 retains a valid premise; it ships standalone after the file-path correction (now in this wish). G9 is reframed and ready. G10 needs trace. G3 amendment is dropped. PR-B is already shipped — do not redispatch.

---

## Trace Provenance

This wish was synthesized from the `/trace` report dated 2026-05-04, run during the dog-fooder triage role. Source observations include:

- **Direct PG queries** of `agents`, `teams`, `audit_events` tables on the live host pgserve (port 20900).
- **File-line reads** of `src/lib/pg-seed.ts`, `src/lib/team-manager.ts`, `src/lib/agent-registry.ts`, `src/term-commands/prune.ts`, `src/term-commands/serve/ensure-ready.ts`, and migration 061/062/063 SQL.
- **Live reproduction**: `genie team create council-1777904104` failed with `teams_members_uuid_check` (G4 evidence). `mailbox.send` with UUID `from_worker` succeeded post-fix (wish 175 G7 evidence, scoping context).
- **DB query proof of cleanup gap**: `total=123, errored=28, exhausted=28, eligible_24h=0` — i.e., today's `genie prune --zombies` does nothing (G3 evidence).

Council deliberation was attempted (intended to formalize the Socratic challenge) but **blocked by the same migration-061 surface this wish addresses** — an existence proof that G4 belongs in PR-A. The four-lens analysis (questioner / simplifier / architect / ergonomist) was applied inline by the trace-author against Felipe's stated requirement: *"i want all in one wish use the council for socratic discussion of the best solutions, we're still in the middle of a larger fix, everything needs to be considered and queued."*
