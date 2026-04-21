# Wish: Fix PG ↔ Disk Rehydration — Teams Survive Reinstall

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-pg-disk-rehydration` |
| **Date** | 2026-04-20 |
| **Design** | _No brainstorm — direct wish from live incident on `genie-stefani` server_ |

## Summary

After any `pgserve` reset (reinstall, migration, data wipe), the `teams` table ends up with at most one row per team actually touched by a spawn — and that row is **wrong**: `repo` / `worktree_path` come from `process.cwd()` of the spawning agent (not the team's natural repo), `leader` is `NULL`, `members` is `[]`-then-appended-as-stringified-jsonb, and the on-disk Claude-native config (`~/.claude/teams/<name>/config.json`) is completely ignored. On one production server this left **70 teams on disk vs. 1 in PG**, the surviving row rooted at the wrong repo with only the spawning agent as a "member" stored as jsonb-of-type-string. Root cause is threefold: (1) `pg-seed.ts` still targets the dead layout `~/.genie/teams/*.json` and never fires; (2) `ensureTeamRow` is a bare-minimum backfill that doesn't read disk config; (3) `hireAgent`/`fireAgent` double-encode `members` into a jsonb string via `JSON.stringify` + postgres.js tagged template. This wish fixes all three layers, adds a one-shot repair command, and writes a migration that normalizes existing double-encoded rows, so the next reinstall rehydrates cleanly instead of silently corrupting every team.

## Scope

### IN
- **Bug A — Stranded seed.** Rewrite the teams portion of `pg-seed.ts` to read `~/.claude/teams/<name>/config.json` (the live Claude-native layout) and upsert full `TeamConfig` rows. Remove the `teams/*.json` / `.migrated` marker gate for teams.
- **Bug B — Shallow backfill.** Make `ensureTeamRow(name)` in `team-manager.ts` load `~/.claude/teams/<name>/config.json` when it exists and hydrate all fields (`repo`, `worktreePath`, `leader`, `members`, `tmuxSessionName`, `nativeTeamParentSessionId`, `baseBranch`, `status`). Only fall back to `process.cwd()` when no config exists on disk.
- **Bug C — Backfill call site drops loaded config.** `claude-native-teams.ts:188` / `:206` call `backfillTeamRow(name)` after loading the config — change the call site to pass the already-loaded `NativeTeamConfig` so PG gets the same truth that disk has, without a second read.
- **Bug D — Double-encoded jsonb writes.** Audit all `jsonb`-targeted writes across `team-manager.ts` and `pg-seed.ts`; stop wrapping arrays in `JSON.stringify` before the tagged template. Use `sql.json(value)` (or pass the JS value directly and let postgres.js encode once).
- **Migration 045 — Normalize existing stringified rows.** Write `src/db/migrations/045_fix_stringified_jsonb.sql` that converts any `teams.members`, `agents.sub_panes`, `teams.allow_child_reachback` with `jsonb_typeof(x) = 'string'` back into proper jsonb via `x::text::jsonb` (parse-then-store). Idempotent: no-op on already-correct rows.
- **Repair command.** New `genie doctor --repair-teams` subcommand that runs the disk→PG rehydration on demand, idempotent, safe to re-run. Dry-run mode (`--dry-run`) prints what would change.
- **Regression detector.** Extend `rot.team-ls-drift.detected` so `status_mismatch` and `missing_in_ls` cases auto-emit after every `genie serve` boot (one detection pass), so future pgserve resets surface the drift within seconds instead of requiring a human to notice.

### OUT
- Redesigning the `teams` / `agents` schema (keep the jsonb column; just stop corrupting it).
- Moving team state out of `~/.claude/teams/` (the Claude-native directory layout stays authoritative; this wish makes PG a faithful mirror).
- Fixing agent-level `pane_id` drift (`%157` vs `%160` on the same incident) — filed separately, not blocking reinstall.
- Deleting / GC-ing the 9 `dir:*` zombie rows surfaced by the reconciler (orthogonal; one-line `DELETE FROM agents WHERE id LIKE 'dir:%' AND state='error'` can ship as a sibling fix).
- Omni / NATS / tmux infrastructure — none of these participate in the teams rehydration path.

## Dependencies & Prerequisites

This wish assumes the **agent-id model** stays as-is. Today the codebase carries **three coexisting identity formats** in the `agents` table:

1. **`dir:<name>`** — directory-registry rows produced by `genie dir add` / `dir sync`. No pane, no session, observed in state `error` as reconciler-zombies after worker death.
2. **UUID** — Claude-native session identifiers (e.g. `1295fb3f-ed1b-4764-82bb-60015271a148`), used as `parent_session_id` for teammates.
3. **Literal string** — bare role/team names like `genie-configure` or `genie-docs` used as `agents.id` for live workers.

Unifying these into a single canonical identity scheme is **explicitly OUT of scope for this wish** — the PG↔disk rehydration works correctly regardless of which format the `agents.id` column holds. However:

> **Sibling wish required before `genie doctor --repair-teams` can be considered feature-complete:** `agents-id-unification (TBD)`.

Until that sibling ships, the repair command treats agents as opaque by `id` and only reports on `dir:*` orphans (see Group 4) rather than attempting to consolidate them. Any consolidation logic belongs in the sibling wish, not here.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Disk is authoritative, PG is a mirror | `~/.claude/teams/<name>/config.json` survives any PG operation (reinstall, migration, wipe) and is the one place Claude Code native team IPC reads from. PG is a query/observability layer. Any divergence is resolved by reading disk → writing PG, never the other way. |
| `pg-seed.ts` is refactored, not deleted | The workers / chat seeding portions may still serve a purpose; only the `teamsDir` path is obsolete. Keep the module, replace the team-specific logic. |
| `ensureTeamRow` reads disk on every call | Callers already tolerate its cost (it's behind `best-effort` try/catch in `backfillTeamRow`). Reading one JSON file per call is negligible and eliminates the stale-row risk entirely. |
| Use `sql.json(value)` not `JSON.stringify(value)` | postgres.js auto-encodes JS values into jsonb correctly. Manual `JSON.stringify` + tagged template produces jsonb-string double-encoding. `sql.json` is the explicit "treat this as JSON" marker and is self-documenting. |
| Migration 045 is idempotent via `jsonb_typeof` guard | `UPDATE ... WHERE jsonb_typeof(col) = 'string'` means re-running after the code fix is a no-op. Also makes the migration safe to run before the code fix ships (fixes in-place, then code stops re-breaking). |
| `genie doctor --repair-teams` is distinct from `genie doctor` | Repair is a write operation; the default `genie doctor` must stay read-only. Explicit flag prevents footgun on CI / observability runs. |
| Boot-time drift detection, not periodic | The drift only appears across reinstall/reset boundaries. Running the detector at every scheduler tick would be noise; running once on `genie serve` start catches exactly the reinstall case. |

## Success Criteria

- [ ] After `pgserve` wipe + `genie serve start`, `genie team ls` lists every team that exists on disk under `~/.claude/teams/`, with correct `repo`, `worktreePath`, `leader`, and `members` array (proper jsonb, not string).
- [ ] `jsonb_typeof(members) = 'array'` for every row in `teams`; `jsonb_array_length(members)` equals the `members.length` in the corresponding `config.json`.
- [ ] `teams.repo` / `worktree_path` for an existing team never gets overwritten by a spawning agent's `process.cwd()`.
- [ ] `teams.leader` is populated from `config.json`'s `leadAgentId` (with `@<team>` suffix stripped to a bare name).
- [ ] `genie doctor --repair-teams` on a cleanly-installed machine is a no-op (exits 0, reports "0 teams repaired").
- [ ] `genie doctor --repair-teams --dry-run` on a drifted machine lists every team that would change, with before/after diff, and makes no writes.
- [ ] Migration 045 converts stringified `members` columns into proper jsonb arrays without data loss via `(col #>> '{}')::jsonb` (not `col::text::jsonb` — that cast is a silent no-op for jsonb-string values); re-running the migration is a no-op.
- [ ] `rot.team-ls-drift.detected` fires ≥1 event on `genie serve` boot if drift exists; fires 0 events on a healthy boot.
- [ ] Repro script `scripts/tests/repro-pg-disk-rehydration.sh` passes: create teams on disk → wipe PG → start serve → assert PG mirrors disk.
- [ ] `bun run check` passes (typecheck + lint + dead-code + test).
- [ ] No change to `~/.claude/teams/<name>/config.json` format or content by any code path in this wish (disk stays authoritative; nothing writes back from PG to disk).

## Execution Strategy

### Wave 1a (Group 1 alone — establishes the shared helper)

Group 1 must complete before Groups 2 and 3 can start: the helper `loadNativeTeamConfig` / `loadAllNativeTeamConfigs` it exports from `src/lib/claude-native-teams.ts` is a **hard dependency** for both downstream groups. Running them in parallel would race on the helper's signature and locations.

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Bug A + shared helper — refactor `pg-seed.ts` teams portion to read `~/.claude/teams/*/config.json` and upsert full `TeamConfig`. Export shared helpers. Gate runs on "any disk team missing from PG or mismatched". |

### Wave 1b (parallel — Groups 2 + 3 after Group 1 ships)

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Bug B + Bug C — `ensureTeamRow` loads disk config via the Group 1 helper; `claude-native-teams.ts` passes loaded config through to backfill (new 2-arg overload). |
| 3 | engineer | Bug D + Migration 045 — audit all jsonb writes, switch to `sql.json()`; write `045_fix_stringified_jsonb.sql` that normalizes existing rows; includes `agents.sub_panes` double-encoding (same root cause). |

### Wave 2 (depends on Wave 1a + Wave 1b)

| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Repair command — add `genie doctor --repair-teams [--dry-run]`; wire to the shared helper. |
| 5 | engineer | Boot-time drift detection — call `rot.team-ls-drift` detector once at end of `genie serve start`. |
| 6 | qa | Repro script + manual QA: wipe PG, start serve, verify rehydration matches disk; dry-run output review. |
| review | reviewer | Full review of all changes against success criteria. |

## Execution Groups

### Group 1: Refactor seed to Claude-native layout — Bug A

**Goal:** `pg-seed.ts` reads `~/.claude/teams/<name>/config.json` and upserts proper `TeamConfig` rows. Runs automatically whenever disk has teams PG doesn't.

**Deliverables:**
1. `src/lib/pg-seed.ts` — replace the `teamsDirPath()` / `needsSeed()` / `seedTeamsDir()` team-specific logic:
   - New helper `readClaudeNativeTeams(): Promise<NativeTeamConfig[]>` that reads every `~/.claude/teams/*/config.json`.
   - `needsSeed()` now returns `true` if **any** team config on disk is missing from PG `teams` or has a drift-worthy mismatch (repo, leader, members length).
   - `runSeed()` upserts full team rows using the loaded `NativeTeamConfig` (repo, worktreePath from the config's `cwd`/`worktreePath` — NOT `process.cwd()`; members jsonb as a real array via `sql.json`).
2. Remove dead code paths: the `teams/*.json` / `.migrated` marker logic and its tests. Keep the workers + chat seed paths intact (orthogonal).
3. `src/lib/pg-seed.test.ts` — rewrite team-specific tests against a temp `CLAUDE_HOME` with nested `teams/<name>/config.json` dirs. Assert `jsonb_typeof(members) = 'array'` after seed.
4. Shared helpers in `src/lib/claude-native-teams.ts` (single source of truth for disk-layout knowledge):
   - `export async function loadNativeTeamConfig(name: string): Promise<NativeTeamConfig | null>` — single-team loader used by Group 2's `ensureTeamRow` backfill.
   - `export async function loadAllNativeTeamConfigs(): Promise<NativeTeamConfig[]>` — bulk loader used by Group 1's seed pass and Group 4's repair command.
   Both are explicitly exported from `src/lib/claude-native-teams.ts` and imported by `src/lib/pg-seed.ts` and `src/lib/team-manager.ts`. Co-locating them keeps disk-layout knowledge centralized and avoids circular dependencies (the existing dynamic-import hack in `backfillTeamRow` can be removed once the helpers land here).

**Acceptance Criteria:**
- [ ] Fresh PG + disk with 3 teams → `genie serve start` → `SELECT count(*) FROM teams` = 3, each with correct `repo`, `leader`, `members`.
- [ ] Every `teams.members` has `jsonb_typeof = 'array'` and correct length.
- [ ] Re-running `runSeed` is a no-op (idempotent).
- [ ] Old `teams/*.json` files on disk are NOT touched (we don't own that path anymore).

**Validation:**
```bash
bun test src/lib/pg-seed.test.ts -t "native team seed"
```

**depends-on:** none

---

### Group 2: Hydrate backfill from disk — Bug B + Bug C

**Goal:** `ensureTeamRow` and `backfillTeamRow` produce PG rows that match disk config, not `process.cwd()` defaults.

**Deliverables:**
1. `src/lib/team-manager.ts:449-490` — change `ensureTeamRow(name, opts)` signature to `ensureTeamRow(name, opts?: { repo?: string; nativeConfig?: NativeTeamConfig })`. Logic:
   - If `opts.nativeConfig` provided → hydrate from it.
   - Else try `loadNativeTeamConfig(name)` (new shared helper) → hydrate from disk.
   - Else fall back to current `process.cwd()` behavior (truly fresh team with no disk presence).
2. Hydrate fields: `repo`, `worktreePath`, `leader` (derive bare name from `leadAgentId` by stripping `@<team>`), `members` (as real JS array — `sql.json` handles encoding), `baseBranch`, `nativeTeamsEnabled: true`, `tmuxSessionName` if present in config.
3. `src/lib/claude-native-teams.ts:188` + `:206` — `backfillTeamRow(name, config)` now takes the already-loaded config; pass it to `ensureTeamRow` as `opts.nativeConfig`. Avoid the second disk read.
4. `src/lib/team-manager.test.ts` — extend `describe('ensureTeamRow')`:
   - "reads disk config when present" — writes a fake `config.json` with 3 members, asserts PG row mirrors it.
   - "falls back to process.cwd when no disk config" — existing behavior preserved for truly-new teams.
   - "hydrated leader derives bare name from leadAgentId" — input `genie-docs@genie-docs` → stored `genie-docs`.

**Acceptance Criteria:**
- [ ] Spawning any agent with `--team <name>` against an empty PG creates a `teams` row whose `repo` matches `config.json`, not the spawning agent's cwd.
- [ ] `teams.members` is a proper jsonb array with every member listed in `config.json`.
- [ ] `teams.leader` is non-null and matches the disk config's `leadAgentId` (bare-name form).
- [ ] Existing test `ensureTeamRow is idempotent` still passes.

**Validation:**
```bash
bun test src/lib/team-manager.test.ts -t "ensureTeamRow"
bun test src/lib/claude-native-teams.test.ts -t "backfill"
```

**depends-on:** Group 1 (hard dependency — helper must exist).

---

### Group 3: Stop double-encoding jsonb — Bug D + Migration 045

**Goal:** Every `jsonb` column receives proper jsonb, not a jsonb-of-type-string. Existing drifted rows are normalized in place.

**Scope note:** `agents.sub_panes` double-encoding at `pg-seed.ts:119` is **IN scope** for this fix — same jsonb root cause as `teams.members`, and the migration's `sub_panes` UPDATE clause only makes sense if the write path is also fixed. Fixing both in the same group keeps the write-side and data-repair-side symmetric.

**Deliverables:**
1. Audit all tagged-template writes touching a jsonb column. Known offenders:
   - `src/lib/team-manager.ts:481` — INSERT into `teams.members` via `JSON.stringify(config.members)`.
   - `src/lib/team-manager.ts:520` — UPDATE `teams.members` via `JSON.stringify(config.members)` in `hireAgent`.
   - `src/lib/team-manager.ts:542` — same in `fireAgent`.
   - `src/lib/pg-seed.ts:119` — `agents.sub_panes` via `JSON.stringify(a.subPanes ?? [])` (IN scope — see scope note above).
   - `src/lib/pg-seed.ts:175` — `agent_templates.extra_args` via `JSON.stringify(t.extraArgs ?? [])`.
2. Replace each with `sql.json(value)` (postgres.js idiom) or pass the raw JS value if postgres.js auto-encodes jsonb columns. Confirm in one-off test which form the project uses; match convention elsewhere in `src/lib/db.ts`.
3. `src/db/migrations/045_fix_stringified_jsonb.sql`:
   ```sql
   UPDATE teams
   SET members = (members #>> '{}')::jsonb
   WHERE jsonb_typeof(members) = 'string';

   UPDATE teams
   SET allow_child_reachback = (allow_child_reachback #>> '{}')::jsonb
   WHERE allow_child_reachback IS NOT NULL
     AND jsonb_typeof(allow_child_reachback) = 'string';

   UPDATE agents
   SET sub_panes = (sub_panes #>> '{}')::jsonb
   WHERE sub_panes IS NOT NULL
     AND jsonb_typeof(sub_panes) = 'string';
   ```
   Idempotent; re-runs are no-ops.
4. Tests:
   - `src/lib/team-manager.test.ts` — assert every `INSERT`/`UPDATE` on `teams` produces `jsonb_typeof(members) = 'array'`.
   - `src/lib/pg-seed.test.ts` — same for `agents.sub_panes` and `agent_templates.extra_args`.
   - `src/db/migrations/__tests__/045.test.ts` — seed drifted rows, run migration, assert typeof-array, re-run is no-op.

**Acceptance Criteria:**
- [ ] `SELECT count(*) FROM teams WHERE jsonb_typeof(members) = 'string'` = 0 after migration.
- [ ] No new writes produce `jsonb_typeof = 'string'` (enforced by unit tests touching every write path).
- [ ] `bun run check` passes; biome doesn't flag the refactored writes.

**Validation:**
```bash
bun test src/lib/team-manager.test.ts -t "jsonb"
bun test src/db/migrations/__tests__/045.test.ts
genie db migrate
genie db query "SELECT name, jsonb_typeof(members) FROM teams"
```

**depends-on:** none — runs in parallel with Groups 1 and 2.

---

### Group 4: `genie doctor --repair-teams` command

**Goal:** Operators have a one-shot idempotent recovery tool without needing to bounce `genie serve`.

**Deliverables:**
1. `src/term-commands/doctor.ts` — add `--repair-teams [--dry-run]` flag branch. Implementation:
   - Call `loadAllNativeTeamConfigs()` → for each, call `ensureTeamRow(name, { nativeConfig: c })`.
   - For teams in PG but NOT on disk, log a warning (don't delete — operator intent unclear).
   - For teams with stringified `members`, normalize via `::text::jsonb`.
   - **Discovered orphans section** — query `SELECT id, custom_name, state FROM agents WHERE id LIKE 'dir:%' AND state = 'error'` and print the list to stdout (but do NOT delete — operator must decide, and consolidation belongs in the `agents-id-unification` sibling wish). Always surfaced, even when team repair itself found nothing to fix.
   - Dry-run: print diff table and orphan list, no writes.
2. `src/term-commands/doctor.test.ts` — test both modes with a mock disk + PG, including an orphan-list assertion.
3. Wire into `genie doctor` help output and CHANGELOG.

**Expected CLI output (healthy machine with 2 `dir:*` orphans):**

```
$ genie doctor --repair-teams
Teams repaired: 0 (PG matches disk for 70 teams)
Teams in PG but not on disk: 0
Stringified members normalized: 0

Discovered orphans (2):
  dir:genie-docs/gap-finder            state=error   (not deleted — see agents-id-unification)
  dir:genie-configure                  state=error   (not deleted — see agents-id-unification)

Exit 0.
```

**Expected CLI output (drifted machine, dry-run):**

```
$ genie doctor --repair-teams --dry-run
Teams that would be repaired: 3
  genie-docs      repo:  workspace/agents/genie-configure → workspace/agents/genie-docs
                  leader: NULL → genie-docs
                  members: ["genie-configure"] (string) → 3-element array
  brain-g1        MISSING IN PG → will upsert from disk (4 members)
  council-*       MISSING IN PG → will upsert from disk (10 members)

Discovered orphans (9): [... list ...]

Exit 0. No writes performed (dry-run).
```

**Acceptance Criteria:**
- [ ] `genie doctor --repair-teams` on a healthy machine: exits 0, prints `Teams repaired: 0`.
- [ ] `genie doctor --repair-teams --dry-run` on a drifted machine: prints diff, makes 0 writes (verified by pre/post row hash).
- [ ] `genie doctor --repair-teams` on a drifted machine: brings PG into agreement with disk, exits 0.
- [ ] Repair output always reports count and list of discovered `dir:*` orphans with `state='error'`, even when zero teams needed repair. Orphans are NEVER auto-deleted by this command.

**Validation:**
```bash
bun test src/term-commands/doctor.test.ts -t "repair-teams"
genie doctor --repair-teams --dry-run
genie doctor --repair-teams
```

**depends-on:** Group 1, Group 2, Group 3.

---

### Group 5: Boot-time drift detection

**Goal:** Pgserve resets self-announce via an event so the next incident is caught in seconds, not days.

**Deliverables:**
1. `src/term-commands/serve.ts` (or wherever `genie serve start` completes initial setup) — after seed + migrations, invoke one tick of `rot.team-ls-drift` detector. Emit event if drift found.
2. If `needsSeed()` returned `true` AND `runSeed` ran, emit a summary event: `{ teams_seeded: N, agents_seeded: M }`.
3. Test in `src/term-commands/serve.test.ts`: boot with a pre-populated `~/.claude/teams/*/config.json` but empty PG → verify seed fires AND drift detector reports zero residual divergence.

**Acceptance Criteria:**
- [ ] Healthy boot: zero `rot.team-ls-drift.detected` events.
- [ ] Reinstall-style boot (disk populated, PG empty): seed runs; drift detector post-seed reports zero divergence; summary event logged.
- [ ] Drift that seed can't fix (e.g. PG has team not on disk): drift event fires with `missing_in_disband` kind.

**Validation:**
```bash
bun test src/term-commands/serve.test.ts -t "drift detection"
```

**depends-on:** Group 1.

---

### Group 6: Repro + QA

**Goal:** One script that proves the reinstall case works end-to-end.

**Deliverables:**
1. `scripts/tests/repro-pg-disk-rehydration.sh`:
   - **S1** — Create 3 fake native teams on a temp `CLAUDE_HOME` (each with 2-3 members, a `leadAgentId`, a `repo` outside `$CWD`).
   - **S2** — Start a fresh `genie serve` against a fresh `GENIE_HOME`. Wait for ready.
   - **S3** — `genie db query` to assert 3 rows, correct `repo`/`leader`/`members`/`jsonb_typeof = array`.
   - **S4** — Write a manually drifted row (stringified `members`) into PG; run `genie doctor --repair-teams`; assert normalized.
   - **S5** — Run `genie doctor --repair-teams --dry-run` on a clean machine; assert zero writes (row hash unchanged).
   - **S6 (duplicate teams)** — Seed the same team twice with different agent IDs occupying the same role slot (simulates concurrent spawns during a botched reinstall). Run `genie doctor --repair-teams`. Assert either (a) the repair deduplicates by `(role, team)` composite key keeping the most recently-touched entry, OR (b) the repair surfaces the duplicate pair as a warning and exits non-zero so an operator can resolve manually. The chosen behavior is selected by Group 4's implementation — either is acceptable as long as duplicates never silently persist.
2. Manual QA checklist below.

**Acceptance Criteria:**
- [ ] `bash scripts/tests/repro-pg-disk-rehydration.sh` exits 0 on Linux.
- [ ] Script cleans up its `CLAUDE_HOME` + `GENIE_HOME` on both success and failure.
- [ ] Each scenario prints ✅ / ❌ with the assertion.
- [ ] No agent role appears 2× in the same team after `--repair-teams` run (asserted by S6 post-condition query: `SELECT role, team, count(*) FROM agents GROUP BY role, team HAVING count(*) > 1` returns zero rows, OR repair exited non-zero with a duplicate warning).

**Validation:**
```bash
bash scripts/tests/repro-pg-disk-rehydration.sh
```

**depends-on:** Groups 1-5.

---

## QA Criteria

_Tested on dev after merge before declaring the wish done._

- [ ] Repro: `rm -rf ~/.genie/data/pgserve && genie serve start` on a machine with populated `~/.claude/teams/` — every team re-appears in `genie team ls` with correct repo/leader/members within 5s of boot.
- [ ] `genie team ls` output matches `~/.claude/teams/<name>/config.json` for every team (spot-check 3 teams).
- [ ] Spawning a new agent with `--team <existing-team>` does NOT mutate the team's `repo` or `members` — only the `agents` row is created, team row unchanged (verified via pre/post `teams` hash).
- [ ] `genie doctor --repair-teams` on the **live incident server** (`genie-stefani`) restores all 70 teams to PG with correct data.
- [ ] Migration 045 runs cleanly on the live incident server, normalizing the one stringified row; re-running is a no-op.
- [ ] Scheduler log shows 1 drift detection event on boot (the pre-seed state) and zero subsequent events over a 10-minute idle window.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `sql.json()` isn't the postgres.js idiom this project uses | Low | Confirm in one-off test against existing jsonb-writing code paths (`omni-queue.ts`, etc.); match whatever pattern already works in the codebase. |
| An operator intentionally created PG-only teams (not backed by disk config) | Medium | Don't delete PG teams without disk config — just log a warning. If there's a legit use case, surface it in review before shipping. |
| Migration 045 `::text::jsonb` cast fails on a row whose string content isn't valid JSON | Low | The only way to write a jsonb-string is via `JSON.stringify`; that always produces valid JSON text. If a malformed row exists, the migration will fail loudly (preferred over silent data loss) — operator fixes manually. |
| `loadAllNativeTeamConfigs` is slow on a machine with 100+ teams | Low | One-time on boot, per-call elsewhere; ~100 small JSON reads is sub-100ms. If it becomes a concern, cache at the module level with inotify invalidation (out of scope). |
| Changing `ensureTeamRow` signature breaks callers | Low | Signature is `(name, opts?)` with `opts.nativeConfig` optional — all existing call sites remain valid. |
| Boot-time drift detector adds latency to `genie serve start` | Low | One pass = one `SELECT * FROM teams` + N `fs.stat` calls. Sub-50ms on realistic workloads. |
| Fixing the jsonb writes breaks a downstream consumer that expected the string form | Medium | Grep for `jsonb_typeof.*string` and `::jsonb` casts across the codebase before merging; update any reader that was working around the bug. |

---

## Review Results

### Plan Review — REVIEWED-FIX-APPLIED (2026-04-21)

Reviewer returned **FIX-FIRST** with 7 gaps (2 CRITICAL + 3 HIGH + 2 MEDIUM). All 7 fixes applied in this revision:

| # | Severity | Gap | Resolution |
|---|----------|-----|------------|
| 1 | 🔴 CRITICAL | Migration slot 013 collided with `013_external_linking.sql`; current latest is 044 | Renumbered to `045_fix_stringified_jsonb.sql` throughout — Scope IN, Group 3 deliverables, validation commands, Files to Create/Modify, QA criteria. |
| 2 | 🔴 CRITICAL | Agent-id unification dependency was implicit | Added new "Dependencies & Prerequisites" section enumerating the 3 coexisting agent-id formats (`dir:*`, UUID, literal string), marking unification as OUT of scope, and linking to sibling wish `agents-id-unification (TBD)`. |
| 3 | 🟡 HIGH | Wave 1 parallelism ignored the shared-helper hard dependency | Split into **Wave 1a** (Group 1 alone — establishes shared helper) + **Wave 1b** (Groups 2+3 parallel after helper ships). Group 2 `depends-on` hardened from "shares helper" to "hard dependency — helper must exist". |
| 4 | 🟡 HIGH | Duplicate teams scenario unaccounted for | Added **S6** to Group 6 repro script (seed twice with conflicting IDs, assert dedup-or-surface) + new acceptance criterion forbidding any `(role, team)` duplicate post-repair. |
| 5 | 🟡 HIGH | Operator observability of `dir:*` orphans missing | Extended Group 4 deliverable with mandatory "Discovered orphans" section listing every `dir:*` row in `state='error'` (never auto-deleted). Added two CLI output samples (healthy + dry-run drifted) and a new acceptance criterion. |
| 6 | 🟢 MEDIUM | Shared-helper location ambiguous | Group 1 deliverable 4 now pins both `loadNativeTeamConfig` (single) and `loadAllNativeTeamConfigs` (bulk) to `src/lib/claude-native-teams.ts` and names their consumers (`pg-seed.ts`, `team-manager.ts`). Removes need for the existing dynamic-import hack in `backfillTeamRow`. |
| 7 | 🟢 MEDIUM | `sub_panes` scope ambiguous | Added explicit scope note at top of Group 3 deliverables confirming `agents.sub_panes` double-encoding at `pg-seed.ts:119` is IN scope (same jsonb root cause), keeping write-side and migration-side symmetric. |

**Open questions carried forward for re-review:**
- Is `sql.json()` the right postgres.js idiom for this codebase, or is raw-value pass-through the established pattern? (Group 3 deliverable 2.)
- For S6, which duplicate-handling strategy should Group 4's repair command implement: (a) auto-deduplicate on `(role, team)` keeping most-recently-touched, OR (b) surface the pair and exit non-zero for manual resolution? Either satisfies the acceptance criterion; pick one before `/work`.

_Execution review — populated after `/work` completes._

---

## Files to Create/Modify

```
Modify:
  src/lib/pg-seed.ts                        # Bug A — replace teams seed path
  src/lib/team-manager.ts                   # Bug B — hydrate ensureTeamRow from disk; Bug D — sql.json writes
  src/lib/claude-native-teams.ts            # Bug C — pass loaded config to backfill; shared loader
  src/term-commands/doctor.ts               # Group 4 — --repair-teams flag
  src/term-commands/serve.ts                # Group 5 — boot-time drift detection call

Create:
  src/db/migrations/045_fix_stringified_jsonb.sql
  src/db/migrations/__tests__/045.test.ts
  scripts/tests/repro-pg-disk-rehydration.sh
  .genie/wishes/fix-pg-disk-rehydration/WISH.md     # this file

Test additions (may be in existing files):
  src/lib/pg-seed.test.ts                   # native-team seed tests
  src/lib/team-manager.test.ts              # hydrated ensureTeamRow + jsonb asserts
  src/lib/claude-native-teams.test.ts       # backfill-with-config
  src/term-commands/doctor.test.ts          # --repair-teams + --dry-run
  src/term-commands/serve.test.ts           # drift detection on boot
```

---

## Live Incident Reference

Investigation trace from production server `genie-stefani` (2026-04-20 ~23:00 UTC):

| Surface | Observed | Expected |
|---------|----------|----------|
| Disk teams (`~/.claude/teams/`) | 70 | N/A |
| PG teams | 1 (only `genie-docs`) | 70 |
| `teams.repo` for `genie-docs` | `workspace/agents/genie-configure` | `workspace/agents/genie-docs` |
| `teams.leader` for `genie-docs` | `NULL` | `genie-docs` |
| `teams.members` for `genie-docs` | `'["genie-configure"]'` (jsonb string) | `["genie-docs", "genie-docs/gap-finder", "genie-configure"]` (jsonb array) |
| `~/.genie/teams/` | does not exist | — (confirms seed stranded) |
| `pg-seed.ts` needsSeed() | `false` (target dir missing) | `true` after rewrite |
| `rot.team-ls-drift.detected` events | 0 | ≥1 on boot after fix |

Triggering action: `genie spawn genie-configure --team genie-docs` against an empty `teams` table. Spawn flow:
1. `ensureNativeTeam('genie-docs', ...)` loaded existing `config.json` → 3 members, proper repo.
2. `backfillTeamRow('genie-docs')` → `ensureTeamRow('genie-docs')` (no `nativeConfig`) → wrote bare row: `repo = process.cwd() = /home/genie/workspace/agents/genie-configure`, `members = []`, `leader = null`.
3. Subsequent `hireAgent('genie-docs', 'genie-configure')` → `UPDATE teams SET members = '["genie-configure"]'` (jsonb-string, not array).
4. Disk config never re-consulted after step 1. Other two members lost.
