# Wish: Boards first-class — the genie lifecycle as kanban

| Field | Value |
|-------|-------|
| **Status** | SHIPPED — PR [#2611](https://github.com/automagik-dev/genie/pull/2611) merged to dev `fa163bd2` (2026-07-21, 16/16 CI); post-merge live QA ritual open (card in Review lane) |
| **Slug** | `boards-first-class` |
| **Date** | 2026-07-21 |
| **Author** | Felipe + team-lead brainstorm session |
| **Appetite** | large |
| **Branch** | `wish/boards-first-class` |
| **Repos touched** | genie |
| **Design** | [DESIGN.md](../../brainstorms/boards-first-class/DESIGN.md) |

## Summary

Make boards a first-class genie surface: creatable from the CLI, with lanes that mirror the genie
lifecycle (Idea → Brainstorm → Wish → Work → Review → Done) instead of execution-status internals,
and cards that tell the truth — who claimed them (Claude Code / Codex / Hermes / human), whether
the session is alive, why they're blocked, and what happened (a full timeline with comments and
worker reports). Blocked becomes a badge with enforced semantics, never a column. The design was
plan-reviewed to SHIP after 3 fix loops (2026-07-21).

## Scope

### IN

- `genie board create <name> [--lanes "A,B,C"]` + `genie board list`; default lane set = the
  lifecycle contract (`Idea, Brainstorm, Wish, Work, Review, Done`); lanes are `{name, label?,
  action?}` objects, `action` display-only.
- `boards.lanes` JSON column + `tasks.lane` (nullable, additive); `genie task move <id> --to
  <lane>` appending `task_events` `kind='move'`; lane-grouped board render with action hints.
- `genie idea "<text>"` — one-verb capture into the roadmap board's Idea lane (creates board with
  default lanes if absent).
- `task_events` — NEW additive table (comment|move|claim|release|block|unblock|report ×
  author + author_kind); `stage_log` retained deprecated, rows backfilled once; verbs `task
  comment`, `task block/unblock --reason`, `task release`, `task report`.
- Card runtime layer: `tasks.agent_kind`, `tasks.heartbeat_at`, `tasks.blocked_by`,
  `tasks.blocked_reason` (all nullable, additive); heartbeat-derived liveness render (▶/⏸/☠);
  ⛔ badge with provenance (deps render-derived; agent/human stored); 💬 count badge.
- Enforced blocks: `task checkout` gates on `blocked_by IS NULL` — the single carved,
  regression-tested exception to the untouched execution machine.
- Checkout briefing: a reassigning checkout surfaces the card's prior timeline; `/work` and
  checkout emit claim events; worker completion appends a concise `report` event (meeseeks
  contract — long-form evidence stays in git per TAXONOMY).
- Laneless (execution) board render reworked to three columns (`Ready / In Progress / Done`) with
  any blocked card badged ⛔ inside its column; board `--json` stays byte-identical (no runtime
  fields — separate projection for render/`task status`); `task export`/MCP additive.
- Jar ↔ board unification targeted at `.genie/INDEX.md`: warning-level `genie doctor` drift lint
  via the lifecycle-slug join (INDEX entry → first `brainstorms/|wishes/` link → slug → roadmap
  card `tasks.wish` → lane; unresolvable = `unlinked`, never drift); one-time `tasks.wish`
  backfill of the 13 seeded roadmap cards; `.genie/brainstorm.md` retired in-repo with a
  grep-verified reference sweep (brainstorm/dream/review skills).

### OUT

- No per-board status machines or workflow engines; ready-set computation and dependency recompute
  untouched (checkout's `blocked_by` gate is the sole exception).
- None of v4's column machinery: `gate`, `auto_advance`, `transitions`, `roles`, `parallel`,
  `on_fail`, board templates, import/export. Lane `action` is never executed.
- No rule-derived lane membership; lanes are assigned manually only.
- No automation moving cards when wish state changes; the drift lint detects, never rewrites.
- No `PRAGMA user_version` bump; no schema-breaking change to board `--json`, MCP, or `task
  export`.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Lanes = lifecycle contract, extendable; blocked is a badge, never a lane | Felipe-ratified; v4 precedent (its pipeline columns never included blocked) |
| 2 | Axis named `lane`; moves append `task_events` `kind='move'` | `stage` is taken by the audit-trail concept; one timeline per card |
| 3 | `task_events` is a NEW table; `stage_log` retained + backfilled | Rename would split-brain older binaries on the worktree-shared DB and break `exportState` |
| 4 | All schema changes additive at `user_version = 1`, `EXPECTED_TABLES` + `schemaIsCurrent()` in lockstep | Version bump would lock older binaries out (`sqlite-open.ts:88-90`) |
| 5 | Blocks enforced at checkout (`blocked_by IS NULL`), single carved exception | A block that doesn't block is a lie |
| 6 | deps-provenance is render-derived, agent/human stored | Keeps `recomputeReady` literally untouched and the checkout exception literally single (reviewer recommendation) |
| 7 | Board `--json` never gains runtime fields; render/`task status` use a separate projection | Preserves the byte-freeze while export/MCP grow additively |
| 8 | Liveness heartbeat-derived, never self-reported | Dead sessions must render dead (☠) — kills the 9-day zombie `in_progress` lie |
| 9 | Cross-runtime state only via genie CLI verbs; timeline is the reassignment briefing | Claude Code/Codex/Hermes share state without forking; history travels with the card |
| 10 | `tasks.wish` broadened to "lifecycle slug" (docs-only) | Enables the pre-wish slug join; existing consumers (branch disambiguation, `--wish` filter) benignly widened — documented |

## Success Criteria

- [ ] `genie board create roadmap` defaults to the 6 lifecycle lanes; `--lanes "A,B"` honored; duplicate names fail exit ≠ 0
- [ ] `genie board list` shows every board with lane count + card count
- [ ] `genie task move <id> --to Wish` reflects on next render AND appends `task_events` `kind='move'`; undefined lane fails exit ≠ 0
- [ ] `genie idea "try X"` creates a card in the roadmap Idea lane in one command, creating the board if missing
- [ ] Lane headers render `action` hints; no code path executes an action
- [ ] `genie task comment` appends an authored event; `task status` renders the timeline; board shows 💬 count
- [ ] A card released by one runtime and checked out by another surfaces the prior timeline at checkout
- [ ] `task report` (or worker completion) appends a `report` event rendered with the author's runtime
- [ ] Claimed card with stale heartbeat renders ☠; agent-blocked shows ⛔ + provenance + reason; deps-blocked renders derived and auto-clears
- [ ] `task checkout` refuses `blocked_by`-set cards (exit ≠ 0, reason shown), regression-tested; all other checkout semantics unchanged
- [ ] Laneless boards render `Ready / In Progress / Done` with ⛔ badges; board `--json` byte-identical (regression-tested)
- [ ] `task_events` in `EXPECTED_TABLES` + `schemaIsCurrent()`; `stage_log` rows backfilled; `exportState` keeps `stage_log`, gains `task_events`; no `user_version` bump; pre-change DB fixture opens clean with the 13 roadmap cards intact
- [ ] `genie doctor` reports lane↔INDEX-section agreement via the slug join (≥1 live resolving entry; `unlinked` for linkless); `.genie/brainstorm.md` retired, zero dangling skill references (grep-verified)
- [ ] 13 seeded roadmap cards have `tasks.wish` backfilled to their lifecycle slugs
- [ ] `bun run check` passes (typecheck + lint + dead-code + tests)

## Execution Strategy

### Wave 1 (sequential — A is the schema+engine foundation)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| A | engineer | 5 — stateful (+2), no deterministic test for render (+1), multi-surface CLI+DB (+1), prior schema-contract rework sensitivity (+1) | `opus-xhigh` | Board engine: lanes schema + create/list/move/idea + lane render |

### Wave 2 (parallel after A)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| B | engineer | 7 — stateful (+2), agent-lifecycle/ACP (+2), subjective render acceptance (+2), CI-sensitive JSON freeze (+1) | `opus-xhigh` + Fable gate | Timeline + runtime layer: task_events, verbs, liveness, enforced blocks, renders |
| C | engineer | 3 — multi-surface docs+lint (+1), no deterministic test for INDEX parsing (+1), prompt-skill change (+1) | `opus-high` | Jar unification: doctor drift lint, wish backfill, brainstorm.md retirement |

## Execution Groups

### Group A: Board engine — lanes, create/list/move/idea

**Goal:** Boards become creatable with lifecycle lanes and cards become movable between them.

**Deliverables:**
1. `ensureBoardColumns` (`boards.lanes` JSON, nullable) + `tasks.lane` via `ensureTaskColumns`; `schemaIsCurrent()` updated in lockstep (no `user_version` bump).
2. `genie board create <name> [--lanes]` (default = 6 lifecycle lanes as `{name, label?, action?}` objects) + `genie board list`.
3. `genie task move <id> --to <lane>` — validates lane, sets `tasks.lane`, appends `task_events` `kind='move'` (table created in this group; full verb surface lands in B).
4. `genie idea "<text>"` — creates roadmap board if absent, adds card to Idea lane.
5. Lane-grouped render in `v5-board.ts` with lane-header action hints; status render untouched in this group.

**Acceptance Criteria:**
- [ ] All Success Criteria rows 1–5 pass
- [ ] `task_events` + lanes columns present in `EXPECTED_TABLES`/`schemaIsCurrent()`; pre-change DB fixture opens and backfills — this is Group A's half of Success Criterion row 12 (Group B owns the `stage_log` backfill + `exportState` half)
- [ ] Existing tests green; new colocated tests for create/list/move/idea (happy path + undefined-lane + duplicate-name failures, exit codes asserted); lane-grouped render + action hints substring-asserted against a seeded fixture (e.g. `Brainstorm` header contains `→ /wish`) — same zero-eyeball discipline as Group B

**Validation:**
```bash
bun test src/lib/v5/ src/term-commands/ && bun run check
```

**depends-on:** none

---

### Group B: Timeline + runtime layer — events, liveness, enforced blocks

**Goal:** Cards tell the truth: authored timeline, runtime identity, heartbeat liveness, enforced blocks, meeseeks reports.

**Deliverables:**
1. Runtime columns (`agent_kind`, `heartbeat_at`, `blocked_by`, `blocked_reason`) additive-nullable; backfill `stage_log` → `task_events` one-time; `exportState` gains `task_events` key, keeps `stage_log`.
2. Verbs: `task comment`, `task block/unblock --reason`, `task release`, `task report` — all appending authored events (`author_kind` from ACP env / `GENIE_AGENT_*`).
3. Checkout: `blocked_by IS NULL` gate (carved exception, regression-tested); claim/release events emitted by checkout/done/release; reassigning checkout prints the prior timeline (briefing).
4. Heartbeat write on ACP session activity — kept SEPARATE from the render: liveness rendering is a pure function of `heartbeat_at` age (deterministically testable); the heartbeat write is the integration piece, tested via a seeded-timestamp fixture, not eyeballs.
5. Renders: card badges (liveness, ⛔ with provenance — deps render-derived, 💬 count); laneless boards drop to `Ready / In Progress / Done`; timeline section in `task status`; board `--json` byte-freeze regression test (no runtime fields); MCP additive with a backward-compat assertion added to `src/term-commands/mcp.test.ts`.
6. Deterministic render tests: every badge/liveness state (▶, ⏸, ☠, ⛔×3 provenances, 💬 n, 3-column laneless) asserted by substring/snapshot against fixtures with injected `heartbeat_at`/`blocked_by`/events — no visual criterion is eyeball-accepted.

**Acceptance Criteria:**
- [ ] Success Criteria rows 6–12 pass; row 12's backfill + `exportState` halves are owned HERE (its schema/`EXPECTED_TABLES`/fixture halves are Group A's, see A's AC)
- [ ] Every visual state (▶/⏸/☠, ⛔ deps/agent/human, 💬 n, laneless 3-column) has a deterministic substring/snapshot test against seeded fixtures — zero eyeball-only criteria
- [ ] Byte-freeze test: board `--json` output identical pre/post on a lane-less fixture; MCP backward-compat assertion in `mcp.test.ts` passes
- [ ] Concurrency: two simultaneous checkouts of a blocked card both refuse cleanly (no `SQLITE_BUSY` flake — WAL + busy_timeout pattern)

**Validation:**
```bash
bun test src/lib/v5/ src/term-commands/ && bun run check
```

**depends-on:** A

---

### Group C: Jar unification — drift lint, backfill, retirement

**Goal:** One tracker: the board owns placement truth; INDEX.md prose stays hand-written but its sections are lint-checked against lanes.

**Deliverables:**
1. `genie doctor` warning-level check named exactly `jar: index-lane drift` (stable contract): parse INDEX.md sections → first `brainstorms/|wishes/` markdown link → slug → roadmap card (`tasks.wish`) → lane; verify against the section↔lane mapping table (Raw→Idea, Simmering→Brainstorm, Ready→{Brainstorm,Wish}, Poured→{Wish,Work,Review,Done}); unresolvable → `unlinked`, never drift; never `ok: false`. **Add-only** to the doctor `--json` `checks[]` contract — the existing schema is parsed by external consumers (doctor.ts:85 warning) and must not change.
2. One-time backfill: the 13 seeded roadmap cards get `tasks.wish` = lifecycle slug.
3. Retire `.genie/brainstorm.md` in-repo: fold content into INDEX.md, delete file, sweep references in brainstorm/dream/review skills (grep-verified); document the `tasks.wish` semantic broadening (lifecycle slug, valid pre-WISH) in TAXONOMY.md + CLAUDE.md.

**Acceptance Criteria:**
- [ ] Success Criteria rows 13–14 pass
- [ ] Doctor JSON exposes the lint result deterministically (stable check name + per-entry states)
- [ ] ≥1 live INDEX entry resolves through the full slug-join chain in the doctor run recorded as evidence

**Validation:**
```bash
# Local build under test — NEVER the installed global binary
bun test src/ && bun run src/genie.ts doctor --json | jq -e '.checks[] | select(.name == "jar: index-lane drift")' && bun run check
```

**depends-on:** A

---

## Dependencies

Self-contained: all schema changes are additive and no other wish must land first. The seven
RE-BRAINSTORM roadmap themes gain proper lane placement once this ships, and the "lane automation
on wish-state change" follow-up card is explicitly OUT of this wish — neither is a formal edge.

**depends-on:** none
**blocks:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: on a fresh repo, `genie idea "test"` → `genie board --board roadmap` shows the card in Idea; `task move` through all 6 lanes works end-to-end
- [ ] Integration: a real subagent run (`/work` on any small task) leaves a claim event, heartbeat, and report event visible in `task status`
- [ ] Cross-runtime: a card claimed under Claude Code and released, then commented from a Codex session, shows both authors with correct `author_kind`
- [ ] Regression: existing `genie board` (laneless), `task list/checkout/done`, MCP server, and `task export` behave; board `--json` unchanged
- [ ] Live board: Felipe's roadmap board renders all 13 cards with lanes after backfill, no data loss

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Status-vs-lane axis confusion in renders | Medium | Each board renders exactly one axis; docs state the split (lane = lifecycle, status = execution) |
| Worktree-shared DB opened by older binaries mid-rollout | Medium | No version bump; additive-only; older binaries ignore unknown columns/tables; fixture test proves it |
| INDEX.md prose parsing is brittle (drift lint) | Medium | Lint is warning-level, `unlinked` fallback for anything unparseable; never blocks doctor |
| Heartbeat writes add chatter to the shared DB | Low | Single-row UPDATE on a WAL DB, throttled (e.g. ≥30s between beats) |
| `tasks.wish` broadening surprises a future consumer | Low | Semantic documented in TAXONOMY.md + CLAUDE.md (Decision 10); slugs remain unique across brainstorm/wish roots |
| Slug renamed at pour (join breaks) | Low | Card's `wish` updated in the same move; stale slug degrades to `unlinked`, surfacing the miss |

---

## Review Results

**Final execution review: SHIP (2026-07-21)** — branch `wish/boards-first-class` @ `22d36078`, base `ddb54fdb`. All 15 Success Criteria evidenced; load-bearing spot-checks re-verified in code by the final reviewer (carved checkout exception sole added predicate; byte-freeze 10-key TaskRow; no `user_version` bump; `task_events` in `EXPECTED_TABLES`/`schemaIsCurrent` lockstep; `stage_log_backfill_v1` idempotency guard).

### Execution ledger

| Group | Engineer | Review | Commits |
|---|---|---|---|
| A: board engine | eng-A-board-engine (opus) | **SHIP** loop 0 | `8ab4d0e5`, `9386accc` |
| B: timeline + runtime | eng-B-timeline-runtime (opus) | **SHIP** loop 0 (TOCTOU-audited) | `8368705c` |
| C: jar unification | eng-C-jar-unification (opus, worktree) | **SHIP** loop 0 | `45ab48a8` (cherry-pick), orchestrator halves `1ca40d21` |

Routing: `Human override: approver=felipe; wish/group=boards-first-class#B; cap=routing.fableGate; old=fable-high; new=opus; reason=preserve fable tokens; timestamp=2026-07-21T18:30Z` (ultracode session directive "in opus to preserve fable tokens").

### Wish-level adversarial verify (ultracode)

4-lens workflow (migration / execution-machine / contract-freeze / wish-fidelity) over the full diff: 13 findings → 11 refuted → 2 confirmed:

1. **HIGH — `releaseTask` done→ready resurrection race** (stale pre-transaction status read + unconditional UPDATE; empirically reproduced with two processes). **Fixed `56e59632`**: CAS `WHERE id=? AND status='in_progress'`, typed `TaskReleaseError`, release event only in the winning transaction, two-process regression test with discriminating proof (reverting the CAS reproduces the resurrection). Verb audit: all other 8368705c verbs safe (no status-branch on stale reads).
2. **LOW — surrogate-pair display slice** in `truncateIndexEntry` (doctor). Waived: display-only, never affects slug/state/lane join.

### Post-review regression caught by full-suite validation

C's `skills/brainstorm/SKILL.md` edit shipped without regenerating the committed plugin mirror; `fresh-install-smoke` (scripts/, outside every group's scoped validation) correctly failed 9 tests on digest drift. **Fixed `22d36078`** (mirror regenerated, byte-identical, zero assertions weakened). Root-caused by orchestrator bisect: 17/0 at `8368705c`, 8/9-fail at `45ab48a8`.

### Live evidence

- Roadmap board seeded via real CLI at `9386accc`: 13 cards in lifecycle lanes, 13 `kind='move'` events ([qa/jar-drift-live-evidence-20260721.md](qa/jar-drift-live-evidence-20260721.md)).
- Drift lint's first live run caught **2 real INDEX drifts** (codex-plugin-update-handoff, routing-delivery-fix in Ready with Work/Review lanes) — fixed in `1ca40d21`. The tool paid for itself before merging.
- `genie idea` first real-world use: card `t_mrv19mpx` (board-edit-lanes gap) captured in one command.
- Final doctor on branch: `36 INDEX entries: 13 ok, 0 drift, 23 unlinked`.

### Gates

Full `bun test` **2067 pass / 0 fail** (82 files); typecheck clean; biome clean (193 files); complexity-budget 0/7; all downstream lints green (run individually — see caveat). `bun run check` as a single command still aborts at knip's documented pre-existing devDep false positives before its later steps; every constituent gate verified green directly. Follow-up recommended: suppress knip's known FPs so `check` reaches its full chain.

### Residue (non-blocking, recorded)

(a) `parseLanes` lacks per-element shape validation — LOW; (b) doctor.test.ts commit-message count 12-vs-13 — LOW; (c) missing-lane-column degradation untested — LOW; (d) ANSI passthrough in operator reason text — NIT (pre-existing pattern); (e) surrogate-pair slice — LOW cosmetic.

### Open post-merge QA (by design — Felipe's live ritual)

Fresh-repo idea→move-through-lanes e2e; real `/work` leaving claim+heartbeat+report; cross-runtime author_kind (Claude Code + Codex on one card); dev regression sweep (laneless board, checkout/done, MCP, export); live roadmap renders 13 cards no data loss.

---

## Files to Create/Modify

```
src/lib/v5/genie-db.ts              # ensureBoardColumns, task_events, EXPECTED_TABLES, schemaIsCurrent
src/lib/v5/task-state.ts            # move/comment/block/release/report, checkout gate, events API, projections
src/lib/v5/task-state.test.ts       # + new colocated tests
src/term-commands/v5-board.ts       # board create/list, lane render, badges, 3-column laneless render
src/term-commands/v5-board.test.ts
src/term-commands/v5-task.ts        # move/comment/block/unblock/release/report verbs, timeline in status
src/term-commands/v5-task.test.ts
src/term-commands/idea.ts (new)     # genie idea quick-capture
src/genie-commands/doctor.ts        # jar drift lint check "jar: index-lane drift" (add-only to checks[])
src/genie-commands/doctor.test.ts
src/term-commands/mcp.ts            # additive fields only
src/lib/v5/TAXONOMY.md              # timeline/lane/wish-slug semantics
skills/brainstorm/SKILL.md          # jar reference sweep
skills/dream/SKILL.md
skills/review/SKILL.md
CLAUDE.md                           # board/lane/idea command docs, tasks.wish semantic
.genie/brainstorm.md                # retired (deleted, content folded into INDEX.md)
```
