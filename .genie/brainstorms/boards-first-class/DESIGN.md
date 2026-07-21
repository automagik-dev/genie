# Design: Boards first-class — the genie lifecycle as kanban

| Field | Value |
|-------|-------|
| **Slug** | `boards-first-class` |
| **Date** | 2026-07-21 |
| **WRS** | 100/100 |

## Problem

`genie board` hardcodes its columns to the four execution statuses (`blocked/ready/in_progress/done`
at `src/term-commands/v5-board.ts:32-37`) and boards cannot even be created from the CLI
(`createBoard()` in `src/lib/v5/task-state.ts:208` has no command surface) — so genie's own
lifecycle (Idea → Brainstorm → Wish → Work → Review) cannot be seen as a roadmap, and idea capture
has no frictionless entry point. This matters because `genie board` is Felipe's daily driver and the
roadmap board seeded 2026-07-21 renders all 13 macro cards in a single meaningless "Ready" column.

## Vocabulary

The new axis is called a **lane** everywhere in schema and code (`boards.lanes`, `tasks.lane`,
`--to <lane>`), because `stage` is already taken: the `stage_log` table (`genie-db.ts:158-164`,
`TAXONOMY.md:104-116`) is the append-only audit trail of task stage transitions. Lane moves ARE
audit-worthy transitions, so every `genie task move` appends a timeline event (`task_events`,
`kind='move'`). User-facing docs may say "column"; the flag and schema say lane.

**Lanes are places; blocked is a state** (ratified by Felipe 2026-07-21, confirmed by v4
precedent). A lane answers "where in the pipeline is this card"; blocked answers "can it move" —
mixing them is the current board's concept error. v4's board model (`origin/v4`:
`src/db/migrations/008_boards.sql`, `src/lib/board-service.ts`) never gave blocked a column: its
columns were pure pipeline stages (the builtin `software` template — triage→draft→brainstorm→
wish→build→review→qa→ship — is the direct ancestor of our lifecycle lanes). Dependency-blocked
cards therefore render as a **badge on the card** (`⛔`) in whatever lane/column they occupy,
never as a place. v4's per-column workflow engine (`gate`, `auto_advance`, `transitions`,
`roles`, `parallel`, `on_fail`) is the over-engineering we explicitly decline.

## Scope

### IN
- `genie board create <name> [--lanes "A,B,C"]` and `genie board list` — CLI surface for the
  existing `createBoard()`; default lane set for new boards is the lifecycle contract: `Idea,
  Brainstorm, Wish, Work, Review, Done` (canonical 6 — supersedes the 5-column sketch in
  DRAFT.md).
- Lanes are small objects, not bare strings — `{name, label?, action?}` (v4 inspiration, minus
  the workflow engine): `action` names the skill that advances a card out of that lane (Idea →
  `/brainstorm`, Brainstorm → `/wish`, Wish → `/work`, Work → `/review`) and is **display-only**
  (shown as a hint on the lane header; nothing executes it). `--lanes "A,B,C"` sugar creates
  name-only lanes.
- Per-board lane list persisted as a nullable JSON `lanes` column on the `boards` row (additive
  `ALTER TABLE`, no new table); card-level `lane` assignment as a nullable `tasks.lane` column;
  `genie task move <id> --to <lane>` (manual moves only — no automation), appending to the
  timeline.
- Card runtime layer (see "Card timeline" section): additive nullable columns `tasks.agent_kind`,
  `tasks.heartbeat_at`, `tasks.blocked_by`, `tasks.blocked_reason`; `task_events` evolution of
  `stage_log`; verbs `task comment`, `task block/unblock`, `task report`; `/work` and `task
  checkout` emit claim events and surface the timeline as the reassignment briefing. (At `/wish`
  time this scope splits into execution groups: board engine ∥ timeline+runtime ∥ jar+relabel.)
- Board render groups by lane on boards that define lanes. **Blocked is a badge, not a place**: a
  dependency-blocked card renders with a `⛔` marker in its lane. The status render for boards
  without lanes drops the Blocked column to three (`Ready / In Progress / Done`), showing blocked
  cards badged inside Ready — presentation-only; the `--json` payload keeps all four status keys
  exactly as today.
- `genie idea "<text>"` — one-verb capture: creates a card in the `Idea` lane of the roadmap
  board (creating the board with default lanes if absent).
- **Jar ↔ board unification, targeted at `.genie/INDEX.md`** (the operational jar — its
  `Raw/Simmering/Ready/Poured` sections; NOT the legacy `.genie/brainstorm.md`). Contract per
  TAXONOMY (docs-in-git, state-in-SQLite): INDEX.md keeps its hand-written prose entries; the
  board owns placement truth; a **drift lint** (a `genie doctor` check) verifies each INDEX entry
  that links a carded brainstorm/wish sits in the section its card's lane maps to. Section↔lane
  mapping:

  | INDEX.md section | Board lane |
  |---|---|
  | Raw | Idea |
  | Simmering | Brainstorm |
  | Ready | Brainstorm (WRS 100, awaiting pour — boundary case, lint accepts either Brainstorm or Wish) |
  | Poured | Wish, Work, Review, or Done (a WISH.md exists; execution position is the card's lane) |

  **Entry↔card join key:** the lifecycle slug. By repo convention a plan keeps one slug for life —
  `brainstorms/<slug>/` becomes `wishes/<slug>/` on pour (e.g. `codex-plugin-update-handoff`,
  `council-workflow` both exist under both roots). The existing `tasks.wish` field is redefined
  (docs-only; no schema change) as "the lifecycle slug this card tracks" — valid from the moment a
  brainstorm directory exists, not only after a WISH.md does. The lint resolves:
  INDEX entry → its first markdown link path (`brainstorms/<slug>/…` or `wishes/<slug>/…`) → slug →
  card `WHERE tasks.wish = slug` on the roadmap board → lane. "Card link resolves" means exactly
  this chain succeeds; entries with no markdown link into `brainstorms/` or `wishes/`, or with no
  matching card, are skipped (reported as `unlinked`, never as drift).

  The legacy `.genie/brainstorm.md` in this repo is retired: content folded into INDEX.md, file
  deleted, and the brainstorm/dream/review skills' references updated in the same wish (the
  brainstorm skill's migrate-away path stays valid for other repos).
- Relabel execution-board lane headers to framework language while **keeping the underlying
  status enum and JSON keys unchanged** (presentation-only rename; `--json`, MCP, and `task export`
  contracts are frozen).

### OUT
- No per-board status machines or workflow engines — the execution state machine
  (ready-set computation, `task checkout`, dependency recompute) is untouched and remains the sole
  execution authority, **with exactly one carved, regression-tested exception:** `task checkout`
  additionally gates on `blocked_by IS NULL` so an agent/human block actually prevents claiming.
  No other checkout/ready-set semantics change.
- None of v4's column machinery: `gate`, `auto_advance`, `transitions`, `roles`, `parallel`,
  `on_fail`, board templates, import/export. Lane `action` is a display hint, never executed.
- No derived/rule-based lane membership (query-defined lanes) — lanes are assigned, never inferred.
- No automation moving cards between lanes when wish state changes (a follow-up card, not this
  wish); the drift lint detects disagreement, it never rewrites INDEX.md.
- No `PRAGMA user_version` bump and no schema-breaking changes to `--json` output, the MCP server,
  or `task export` — additive fields only.

## Card timeline, runtime identity, and the worker contract

Three additions ratified 2026-07-21 (Felipe), extending the lane model to full card life:

**1. Runtime identity + liveness.** A claimed card knows *which agent runtime* holds it
(`agent_kind`: `claude-code | codex | hermes | human`) and whether the session is alive —
liveness is derived from a heartbeat timestamp the ACP session updates (`▶ running` / `⏸ idle` /
`☠ stale` past threshold), **never self-reported**. Blocked becomes a settable state with
provenance — `{by: deps|agent|human, reason}` — deps-blocked is **render-derived**
(`status='blocked'` with `blocked_by IS NULL` displays as deps; nothing stores or clears it, so
`recomputeReady` stays literally untouched); agent/human-blocked is stored
(`genie task block <id> --reason`) and cleared explicitly. **Blocked
is ENFORCED, not advisory:** `task checkout` refuses a card whose `blocked_by` is set — this is
the single, deliberate, regression-tested exception to the "execution machine untouched" boundary
(see Scope OUT), because a block that doesn't block is a lie. Lane = place, claim = who,
liveness = alive?, blocked = movable? — four orthogonal axes, never conflated into columns.

**2. The timeline (`task_events` — a NEW additive table superseding the dead `stage_log`).**
`stage_log` shipped with the right shape but zero production writers and no author column. It is
NOT renamed (a rename would split-brain older binaries on the worktree-shared DB and break
`exportState`'s `SELECT * FROM stage_log`): `task_events` is created via
`CREATE TABLE IF NOT EXISTS`, any existing `stage_log` rows are backfilled once, and `stage_log`
is retained read-only/deprecated. `EXPECTED_TABLES` and `schemaIsCurrent()` gain `task_events` in
the same commit; `exportState` gains an additive `task_events` key while keeping `stage_log`. One
stream for everything that happens to a card:

```
task_events: task_id · kind(comment|move|claim|release|block|unblock|report)
           · note · author_kind · author · created_at
```

`genie task comment <id> "..."` appends; `genie task release <id>` (and `task done`, and a
reassigning checkout) emit the `release` event; `task status` renders the timeline; the board
render shows a `💬 n` badge. **Reassignment is first-class:** a card released by Claude Code and claimed
by Codex (or Hermes, or a human) carries its whole timeline — the claiming agent reads it at
checkout as briefing context. All three runtimes speak the same CLI verbs (`task checkout`,
`comment`, `move`, `done`), so genie state is shared and never forks per-runtime.

**3. The meeseeks worker contract.** Workers are ephemeral and single-purpose (the original genie
inspiration): spawn with one card, execute, and *poof* — leaving a concise **final report
appended to the card as a `report` event**. Long-form evidence still belongs in git
(`wishes/<slug>/reports/`, qa/) per TAXONOMY; the card's `report` event is the distilled outcome
plus pointers. `/work` is the motion verb: invoking it claims the card (claim event), dispatches
the appropriate ACP agent with minimal context (card + timeline + linked wish docs), and the
worker's completion appends the report and releases or completes the card.

### Board blueprint (validated by Felipe 2026-07-21)

```
  IDEA           BRAINSTORM       WISH            WORK             REVIEW          DONE
  → /brainstorm  → /wish          → /work         → /review        → merge
───────────────┬────────────────┬───────────────┬────────────────┬───────────────┬──────────────
 ┌────────────┐│ ┌────────────┐ │ ┌────────────┐│ ┌────────────┐ │ ┌────────────┐│ ┌────────────┐
 │genie spend ││ │boards      │ │ │stable      ││ │codex plugin│ │ │routing     ││ │agent-sync  │
 │            ││ │first-class │ │ │release gate││ │update      │ │ │delivery fix││ │   done     │
 │ unclaimed  ││ │▶ claude-code│ │ │⛔ human:   ││ │handoff     │ │ │⏸ claude-code│ └────────────┘
 └────────────┘│ │@team-lead  │ │ │ "G2 is mine"││ │▶ codex     │ │ │@reviewer   ││
               │ │ 💬 4 · 2h  │ │ └────────────┘│ │@eng-C · 12m│ │ │ 💬 7 · 3h  ││
               │ └────────────┘ │               │ │ 💬 12      │ │ └────────────┘│
               │                │               │ └────────────┘ │               │
               │                │               │ ┌────────────┐ │               │
               │                │               │ │omni drift  │ │               │
               │                │               │ │sync        │ │               │
               │                │               │ │☠ hermes    │ │  ← stale claim renders as a
               │                │               │ │@wt-3 · 9d  │ │    corpse, not "in progress"
               │                │               │ └────────────┘ │
```

Card anatomy: title · liveness+agent_kind · worker+heartbeat-age · optional ⛔ with provenance ·
`💬 n`. Timeline sample (`task status`):

```
  ── Timeline ──
  Jul 21 14:02  claim    ▶ codex @eng-C-delivery
  Jul 21 15:10  comment  codex @eng-C-delivery: "Group C rewire done, starting D"
  Jul 21 15:11  move     Work → Review  (claude-code @team-lead)
  Jul 21 16:40  block    ⛔ human @felipe: "hold for stable gate"
  Jul 21 18:03  report   codex @eng-C-delivery: "C+D shipped; 1514 pass; see reports/…"
```

## Approach

Assigned-lane model on top of the existing engine: boards optionally carry an ordered lane list;
tasks carry a nullable `lane` that is only meaningful within a board that defines lanes.
`genie board` picks its grouping axis per board — lane when defined, status otherwise. The
"no stored view state" doctrine is deliberately and locally relaxed: a lifecycle lane is real
operational state (a human decision), not view preference, so storing it is honest.

Migration follows the repo's real additive pattern — `CURRENT_SCHEMA_VERSION` stays `1`
("bump on breaking change only", `genie-db.ts:34-35`). The safety property is **no version bump +
`EXPECTED_TABLES`/`schemaIsCurrent()` updated in lockstep** — not "no new table". Concretely:
`ensureTaskColumns` gains the five nullable task columns (`lane`, `agent_kind`, `heartbeat_at`,
`blocked_by`, `blocked_reason`); a sibling `ensureBoardColumns` adds `boards.lanes`; `task_events`
is a new `CREATE TABLE IF NOT EXISTS` added to `EXPECTED_TABLES` and covered by
`schemaIsCurrent()` in the same commit (`genie-db.ts:105,114-125`, `sqlite-open.ts:122-124`), so
already-initialized DBs (including the live roadmap board's) don't short-circuit past the
backfill. A new table at `user_version = 1` is invisible to older binaries — each binary checks
only its own `EXPECTED_TABLES` — so the worktree-shared contract holds.

**JSON projection rule:** board `--json` (`mapTask`/`TaskRow`) deliberately does NOT gain the
runtime fields — its payload stays byte-identical; the board render and `task status` read the
runtime layer through a separate projection, while `task export` and MCP carry the new
columns/table additively (`exportState` reads raw rows, so this is automatic).

Alternatives considered: **derived lanes** (saved query rules — preserves doctrine but cards
cannot be moved by hand, which kills the "got an idea, drop it in" flow), **per-board status
machines** (collides with ready-set/checkout semantics; 10× the blast radius for no additional
user value), and **a `board_lanes` table** (a JSON column models a per-board ordered list exactly,
so the extra table buys nothing — note the objection is uselessness, not table surgery per se:
`task_events` DOES take the `EXPECTED_TABLES`/`schemaIsCurrent` surgery because an append-only
event stream genuinely needs a table). All lost.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Lanes are the genie lifecycle contract, not arbitrary labels; default set `Idea, Brainstorm, Wish, Work, Review, Done` (canonical 6), extendable per board | Ratified by Felipe 2026-07-21: "brainstorm wish work review are the basic ones... new ones can be added, like idea" |
| 2 | Lane is assigned manually (`genie task move --to`), never inferred | Predictable; matches every kanban tool; keeps rules engine complexity out |
| 3 | Execution status machine untouched; lane is a separate board-local axis | Status is load-bearing (ready-set, checkout); two authorities would corrupt execution semantics |
| 4 | `genie idea` writes to the roadmap board's Idea lane | The capture flow that motivated the wish must be one verb, zero ceremony |
| 5 | Unification targets `.genie/INDEX.md` (the real jar); board owns placement, INDEX keeps prose; drift lint in `genie doctor`, never auto-rewrite | Reviewer verified `.genie/brainstorm.md` is legacy; docs-in-git/state-in-SQLite contract (TAXONOMY.md) forbids the CLI rewriting hand-written ledger prose |
| 6 | Execution-board rework is presentation-only; enum values and JSON keys frozen | The rename/badge change is a UI fix; contracts (MCP, `--json`, tests, hooks) must not churn — `--json` already keys on the enum (`v5-board.ts:88`) |
| 9 | Blocked is a badge on the card, never a lane/column | Ratified by Felipe 2026-07-21: lanes are places, blocked is a movability state; v4 precedent — its pipeline columns never included blocked |
| 10 | Lanes are `{name, label?, action?}` objects; `action` is a display-only skill hint | The useful kernel of v4's column model without its workflow engine (gates/transitions/auto-advance declined in Scope OUT) |
| 11 | One append-only `task_events` stream (NEW table; `stage_log` retained deprecated, rows backfilled once) carries comments, moves, claims, releases, blocks, and reports, each with `author_kind` + `author` | `stage_log` was dead code with the right shape but renaming it would split-brain older binaries; one stream means the card's history is one query and the reassignment briefing is free |
| 15 | Agent/human blocks are enforced at `task checkout` (`blocked_by IS NULL` gate) — the one carved exception to Scope OUT | A block that doesn't block is a lie; the exception is single, explicit, and regression-tested |
| 12 | Cross-runtime state sharing by contract: Claude Code, Codex, and Hermes all mutate state only through the same genie CLI verbs | Guarantees mixed-runtime work never forks state; the timeline is runtime-neutral because every author goes through the same door |
| 13 | Meeseeks worker contract: ephemeral, single-purpose workers append a concise `report` event to the card on completion; long-form evidence stays in git per TAXONOMY | The card carries the distilled outcome + pointers; markdown keeps the durable narrative — no duplication of authority |
| 14 | Liveness is heartbeat-derived, never self-reported; a stale claim renders `☠` | A dead session must look dead — today's 9-day-old `in_progress` rows are exactly the lie this kills |
| 7 | New axis named `lane`; every move appends a `task_events` row (`kind='move'`) | `stage` already means the audit-trail concept; lane moves are audit-worthy transitions so they join the card's one timeline instead of forking vocabulary |
| 8 | All schema changes additive at `user_version = 1` — nullable columns via ensure-helpers, `task_events` via `CREATE TABLE IF NOT EXISTS`, with `EXPECTED_TABLES` + `schemaIsCurrent()` updated in lockstep | A version bump would make `sqlite-open.ts:88-90` refuse the worktree-shared DB for every older binary; new tables/columns at the same version are invisible to old binaries |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Status vs lane drift confuses which surface is truth | Medium | Documented axis split: lane = lifecycle (macro boards), status = execution (task boards); board render shows only its own axis |
| 2 | Schema change breaks worktree-shared DBs read by older binaries | Medium | No `user_version` bump; nullable additive columns via `ensureTaskColumns`/`ensureBoardColumns`; `schemaIsCurrent()` updated in the same commit; regression test opening a pre-change DB fixture |
| 3 | INDEX.md drift lint misfires on entries with no card, or on the Ready boundary | Medium | Lint only checks entries whose slug-join chain resolves (see entry↔card join key); unresolvable entries report `unlinked`, never drift; Ready accepts Brainstorm or Wish; lint is a warning in `doctor` (never `ok: false`) for the first release |
| 3b | A brainstorm renamed at pour time (slug changes) breaks the slug join | Low | Rename is already ledger-visible (e.g. sessionstart-hook-reliability → codex-plugin-update-handoff was recorded in INDEX); the card's `wish` field is updated in the same move; stale slug reports `unlinked`, which surfaces the miss |
| 4 | Skill references break when `.genie/brainstorm.md` is retired in this repo | Medium | Grep-verified reference sweep across `skills/brainstorm`, `skills/dream`, `skills/review` (+ plugin copies) is an acceptance criterion; migrate-away path for other repos preserved |
| 5 | Relabel leaks into JSON/MCP consumers despite freeze | Low | Regression test asserting `--json` and MCP payloads byte-stable across the relabel |

## Success Criteria

- [ ] `genie board create roadmap` succeeds and defaults to the 6 lifecycle lanes; `genie board create x --lanes "A,B"` honors custom sets; duplicate board names fail with exit ≠ 0
- [ ] `genie task move <id> --to Wish` is reflected on the next `genie board --board roadmap` render AND appends a `task_events` row (`kind='move'`); moving to an undefined lane fails with exit ≠ 0 and a clear error
- [ ] `genie board list` shows every board with its lane count and card count
- [ ] `genie idea "try X"` creates a card in the roadmap Idea lane in one command, creating the board if missing
- [ ] Boards without defined lanes render three columns (`Ready / In Progress / Done`) with ANY blocked card (`blocked_by` set — deps, agent, or human) badged `⛔` inside its column; `--json` output is byte-identical to today (all four status keys, no runtime fields, regression-tested)
- [ ] `genie task checkout` refuses a card whose `blocked_by` is set (exit ≠ 0, reason shown) — the carved exception, regression-tested; all other checkout semantics unchanged
- [ ] Lane headers render their `action` hint when defined (e.g. `Brainstorm → /wish`); no code path ever executes an action
- [ ] `genie task comment <id> "..."` appends a timeline event with author + author_kind; `task status` renders the full timeline; the board shows a `💬 n` badge on cards with comments
- [ ] A card released by one agent runtime and checked out by another surfaces the prior timeline in the checkout output (reassignment briefing)
- [ ] A worker completion can append a `report` event (`genie task report <id> "..."` or equivalent); the event renders in the timeline with the author's runtime
- [ ] A claimed card with a heartbeat older than the staleness threshold renders `☠` on the board; a card blocked by an agent shows `⛔` with provenance and reason; deps-blocked auto-clears when the dependency completes
- [ ] `task_events` is a new table (`stage_log` retained; existing rows backfilled once into `task_events`; `exportState` keeps its `stage_log` key and gains `task_events` additively); `EXPECTED_TABLES` + `schemaIsCurrent()` cover it; no `user_version` bump; an older-binary fixture still opens the DB
- [ ] A pre-change `.genie/genie.db` fixture opens under the new binary with columns backfilled (no `user_version` bump; `schemaIsCurrent` covers the new columns); the 13 existing roadmap cards survive with no data loss
- [ ] MCP server and `genie task export` payloads remain backward-compatible (additive fields only), regression-tested
- [ ] `genie doctor` reports lane↔INDEX-section agreement per the mapping table (warning-level), resolving entries via the lifecycle-slug join (a pre-wish brainstorm entry with a card on the roadmap board IS checked; a linkless entry reports `unlinked`, not drift), and `.genie/brainstorm.md` is retired in this repo with zero dangling references in brainstorm/dream/review skills (grep-verified)

## Next Step

Run `/wish` to convert this design into an executable plan.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `6d1ff5b13b6e22989b8bda3d0b8203c60c3e56390c219f89e7bf8d89a7e7686b`
- **Reviewer:** genie:reviewer subagent a93069f66c1512e41 (plan review, 3 fix loops, closure verified)
- **Reviewed at:** 2026-07-21T18:20:00.000Z
<!-- genie-design-review:end -->
