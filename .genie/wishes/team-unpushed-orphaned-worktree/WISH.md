# Wish: Detect Teams with Unpushed Commits in Orphaned Worktrees

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `team-unpushed-orphaned-worktree` |
| **Date** | 2026-04-21 |
| **Issue** | #1250 — team-create autonomous PR teams complete work but never push branches; no detector fires |
| **Siblings** | `pattern-5-zombie-team-lead` (nearest neighbor; different failure mode — alive-but-idle vs dead-with-WIP) |

## Summary

Autonomous `team create --wish <slug>` teams can complete their work locally (engineers edit files, make wip commits in the team worktree, reach `idle` state) and then **die before pushing the branch**. The leader pane exits or never re-engages; the worktree sits with commits ahead of origin; no detector fires; `genie wish status` shows nothing wrong. The operator only finds out hours later when auditing manually.

Reference incident (2026-04-20T23 → 2026-04-21T01 UTC): 6 `docs-pr-*` teams dispatched, only 1 opened a PR. 5 worktrees had committed-but-unpushed work that had to be salvaged by hand (~30-45 min recovery for work that should have been zero-touch).

**There is no detector for: "team has unpushed commits AND no live process is making forward progress."** This wish adds one.

## Scope

### IN

- **New detector `rot.team-unpushed-orphaned-worktree`** (`pattern-9-team-unpushed-orphaned-worktree.ts`), registered alongside the existing eight. Queries `teams` where:
  1. `teams.status NOT IN ('done', 'blocked', 'archived')` (i.e. still nominally active)
  2. No live executor for any agent in the team has been in state `running`/`spawning` for ≥ N minutes (default **10 min**, tunable via factory opts)
  3. The worktree at `teams.worktree_path` has commits ahead of `origin/<teams.base_branch>` (ahead > 0, pushed == 0 for the local branch)
- **Worktree probe is isolated + bounded**:
  - `git -C <worktree_path>` subprocess per suspect team, `timeout 3s`, stderr silenced
  - Cap at **32 teams per tick** to bound blast radius; additional teams re-evaluated next tick
  - Skip silently when `worktree_path` doesn't exist on disk (team was disbanded but row stragglers) — emit a separate low-signal log line, don't fire
- **Evidence payload** follows the existing `observed_state_json` shape:
  ```json
  {
    "team_name": "docs-pr-detectors-page",
    "worktree_path": "/home/genie/.genie/worktrees/docs/docs-pr-detectors-page",
    "base_branch": "main",
    "branch_ahead_count": 3,
    "last_commit_at": "2026-04-20T23:47:12Z",
    "last_executor_active_at": "2026-04-21T00:03:41Z",
    "minutes_since_active": 187,
    "threshold_minutes": 10,
    "lead_state": "exited",
    "total_stalled_teams": 5
  }
  ```
- **Tunable knobs** via factory opts (mirrors `pattern-5`):
  - `idleMinutes` — how long the "no live executor" window must be (default 10)
  - `maxTeamsPerTick` — worktree-probe batch cap (default 32)
  - `gitTimeoutMs` — per-probe subprocess timeout (default 3000)
- **Unit tests** covering:
  - Fires when all three predicates hold
  - Does NOT fire when executor is still `running`/`spawning` within the window
  - Does NOT fire when worktree is missing on disk (disbanded team)
  - Does NOT fire when ahead-count is 0 (no work to salvage)
  - Does NOT fire when `teams.status='done'` (team signalled completion)
  - Does NOT fire when `teams.status='blocked'` (team signalled blocked, operator aware)
  - Fires once per team per tick (uses existing fire-budget infra — see `src/detectors/__tests__/fire-budget.test.ts`)
  - Handles missing `base_branch` / malformed `worktree_path` without crashing (best-effort, skip-and-continue)
  - Handles subprocess timeout gracefully (treat as "unknown" → do not fire, log)
  - Caps payload when `total_stalled_teams > 32` (fires for first N, `total_stalled_teams` reflects the full count)
- **Docs update**: `docs/detectors/runbook.md` gets a new section for pattern-9 matching the existing 8 entries — what it detects, why it matters, operator action.

### OUT

- **Leader-completion contract** (`team.completed` / `team.pushed` / `team.pr_opened` events). That's the deeper architectural fix suggested in #1250 and deserves its own wish — it would let the detector condition on "leader never emitted team.completed" instead of inferring from executor state. Not in scope here; this wish is the "observe the gap" half, not the "close the gap" half.
- **Auto-push / auto-recover.** Detecting the stall is this wish's job. Actually pushing the branch or opening the PR on behalf of the dead leader is a separate decision (may want operator review, may want reconciler-driven retry — design discussion, not this wish).
- **Cross-repo worktree discovery.** We trust `teams.worktree_path` as authoritative. If that row is wrong or stale, that's a teams-table integrity issue, not a detector-scope issue.
- **Performance optimization for very large team counts** (>256 simultaneous). The per-tick cap handles this gracefully — stalled teams just take more ticks to be reported. Optimization can follow when that becomes a real workload.
- **New `genie team rescue` command** to drive a one-shot salvage of detected teams. Valuable operator UX but separate — first land the signal, then add the action.

## Dependencies & Prerequisites

- `teams` table schema (migration 005) is already in place with `worktree_path`, `repo`, `base_branch`, `status`.
- Existing detector infrastructure (`src/detectors/index.ts`, `registerDetector`, `DetectorEvent`, `DetectorModule`) carries the fire-budget + render contract this wish plugs into.
- `genie_runtime_events` provides the `executor state = running|spawning` timestamps via the same event stream pattern-5 consumes.
- No migrations required. No schema changes.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Name the event `rot.team-unpushed-orphaned-worktree.detected`, not `rot.team-silent-push-failure.detected` | "unpushed-orphaned-worktree" is observable state; "silent-push-failure" is a causal hypothesis. Match the existing pattern naming discipline (observable state only). |
| Use `teams.status NOT IN ('done','blocked','archived')` as the gate, not a positive status match | Operators can mark teams `done` / `blocked` explicitly; those are signals we should respect. Any other status (including nulls, new statuses added later) counts as "still nominally active." |
| Executor-liveness window defaults to **10 minutes** (double pattern-5's 5) | 5 min matches "alive but not working"; 10 min matches "probably exited." The two detectors intentionally span different time windows so they overlap without dup-firing on the same underlying incident in the ambiguous zone. |
| Per-tick team cap at **32** | Sane upper bound for concurrent dispatch (Felipe's worst-case observed was 6 simultaneous). Prevents a runaway scan if the teams table accumulates zombies. |
| Fire-budget: **once per team per hour** | Matches pattern-5's re-fire discipline. Operator wants to know once, not every tick. |
| Do NOT attempt to push on behalf of the team | Autonomous mutation is out of scope. The detector is advisory — tooling built on top of this signal (e.g. `genie team rescue`) can decide its own safety policy. |
| `git` subprocess timeout at 3s | Longer than the slowest healthy `rev-list` observed (~200ms); short enough that a hung git call doesn't stall the detector tick. |
| Skip-and-log on missing `worktree_path` on disk | Team rows with no on-disk worktree are out of the detector's domain. Emitting a second-class event is a different design problem (`rot.team-row-orphaned`, perhaps). |
| Docs update lives in `docs/detectors/runbook.md` alongside the other 8 patterns | Runbook is the canonical operator surface. Updating it closes the "there is no detector for X" statement in the issue. |

## Success Criteria

- [ ] `rot.team-unpushed-orphaned-worktree.detected` fires within one detector tick when all three predicates hold on a test team with a populated worktree.
- [ ] Does NOT fire while any agent in the team has an executor in `running`/`spawning` state within the idleness window.
- [ ] Does NOT fire when `teams.status IN ('done','blocked','archived')`.
- [ ] Does NOT fire when the worktree has zero commits ahead of `origin/<base_branch>`.
- [ ] Evidence payload includes `branch_ahead_count`, `last_commit_at`, `minutes_since_active`, `worktree_path` — enough for the operator to run a one-liner salvage without more detective work.
- [ ] Fire budget: same team fires once per hour max, not once per tick.
- [ ] Subprocess timeout (3s) gracefully degrades — no detector-tick deadlock when git hangs.
- [ ] Reproducer: manual end-to-end — spawn a team, kill the leader pane, commit in the worktree, let one tick pass, observe the detector firing via `genie events list --type rot.detected --since 5m`.
- [ ] `docs/detectors/runbook.md` section added for pattern-9.
- [ ] `bun run check` passes (typecheck + lint + knip + test).
- [ ] No regression to patterns 1-8 (all existing detector tests still pass).

## Execution Strategy

Two waves, parallel where possible.

### Wave 1 — detector + tests (parallel)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Implement `src/detectors/pattern-9-team-unpushed-orphaned-worktree.ts`: SQL query for suspect teams + git subprocess probe + evidence render. Follow `pattern-5-zombie-team-lead.ts` layout exactly (factory + `registerDetector` side effect). |
| 2 | engineer | Write `src/detectors/__tests__/pattern-9-team-unpushed-orphaned-worktree.test.ts` covering the 9 scenarios listed under SC. Use the existing `__fixtures__/` helpers for fake SQL + fake git. If no git fixture exists, add one in `__fixtures__/` as a reusable helper (factor along the lines of the fake-sql helper). |

### Wave 2 — docs + validation (after Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | docs | Add pattern-9 section to `docs/detectors/runbook.md`. Match the existing 8 entries (heading, signal, evidence, operator action). Mirror the "Reference incident" from the issue. |
| review | reviewer | Full review against success criteria. Confirm fire budget is wired, subprocess timeout is honored, and no regression to patterns 1-8. |

## Execution Groups

### Group 1: Detector — `pattern-9-team-unpushed-orphaned-worktree.ts`

**Goal:** New detector module following the pattern-5 shape, queryable + fire-able, with factory knobs for test determinism.

**Deliverables:**
- `src/detectors/pattern-9-team-unpushed-orphaned-worktree.ts` with:
  - `createTeamUnpushedOrphanedWorktreeDetector(opts?)` factory
  - SQL: `teams` LEFT JOIN against latest-live-executor per team
  - Git probe: `git -C <worktree> rev-list --count origin/<base_branch>..HEAD`, timeout 3s
  - `render()` emits `rot.detected` with `pattern_id: 'pattern-9-team-unpushed-orphaned-worktree'` and the documented evidence shape
  - Side-effect `registerDetector(createTeamUnpushedOrphanedWorktreeDetector())` at module tail

**Validation:**
- Typecheck clean
- Lint clean (keep cognitive complexity ≤ 15)
- Module loads without throwing when required at process start

### Group 2: Tests — `pattern-9-team-unpushed-orphaned-worktree.test.ts`

**Goal:** 9 scenarios from SC, using deterministic injected query + git fn, no real subprocess, no real DB.

**Deliverables:**
- `src/detectors/__tests__/pattern-9-team-unpushed-orphaned-worktree.test.ts`
- Reusable `__fixtures__/fake-git-probe.ts` if a factored helper makes the other pattern tests cleaner (optional — only if it reduces duplication)

**Validation:**
- `bun test src/detectors/__tests__/pattern-9-team-unpushed-orphaned-worktree.test.ts` — all 9 pass
- `bun test src/detectors/` — full suite still green (no regression)

### Group 3: Docs — runbook entry

**Goal:** Operator can read one page and know what the new signal means + what to do when it fires.

**Deliverables:**
- New section in `docs/detectors/runbook.md` under the existing detector list
- Shape: ID, trigger, evidence fields, operator action, severity, related events

### Group 4: Review

**Goal:** Everything merges cleanly without hand-holding.

**Deliverables:**
- Reviewer confirms SC 1-10 all pass
- `bun run check` green
- No cognitive-complexity regressions in `pattern-9-*.ts`
- Docs entry renders correctly in Mintlify

## Non-goals & follow-up wishes

- **`genie team rescue` command** — one-shot salvage driver that reads the fired detector events and offers `push` / `open-pr` / `archive` actions per team. Separate wish.
- **Leader-completion contract** (`team.completed` events + reconciler assertions) — separate wish, touches team-lead runtime + reconciler.
- **Cross-repo worktree index** — if `teams.worktree_path` ever becomes unreliable, a filesystem index of `~/.genie/worktrees/` is the fallback. Not needed now.
