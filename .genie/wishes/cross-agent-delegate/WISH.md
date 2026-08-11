# Wish: Declared Agent Routing on the Board (cross-agent W1)

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `cross-agent-delegate` |
| **Date** | 2026-08-11 |
| **Author** | Felipe + genie orchestrator |
| **Appetite** | small-medium |
| **Branch** | `wish/cross-agent-delegate` |
| **Repos touched** | genie only |
| **Design** | [DESIGN.md](../../brainstorms/cross-agent-delegate/DESIGN.md) |

## Summary

Wave 1 of the SHIP-reviewed cross-agent-delegation design: declare on the board card *which* coding agent (claude, codex, pi, hermes, prime) works a task and *why*, with NULL meaning the current orchestrating agent. This is the routing substrate the delegate bridge (follow-on wish, blocked on remotty `headless-turn-open`) consumes, and it alone unblocks remotty's client-rendering ask. Fully mechanical, no external dependencies.

## Scope

### IN

- Additive nullable `tasks.assigned_agent` + `assigned_reason` columns: CREATE TABLE + additive-backfill path + `EXPECTED_SCHEMA.tasks`/`schemaIsCurrent` lockstep + `TaskRow` mapping.
- Roster allowlist (`claude`, `codex`, `pi`, `hermes`, `prime`) as a typed constant; non-roster names rejected with a named error at every write path.
- `genie task create --agent <name> --why <reason>` (`--agent` requires `--why`; `--why` alone is rejected).
- New `genie task assign <id> --agent <name> --why <reason>` verb for existing cards, with `--clear` to remove an assignment (mirrors the `set-wish`/`--clear` precedent); each assign/clear appends a timeline note so the routing history rides the card thread.
- Assignment surfaced in `genie task status` and serialized on the **lane-path** `genie board --json` only (`enforcedBlock` precedent); the laneless `--json` shape stays byte-frozen.
- Roadmap-sync lockstep: `task export` payload, hand-enumerated `insertSnapshotRows`, older-snapshot null backfill (`?? null` pattern), and three-way `task sync` baseline coverage — assignment must survive export → import → sync.

### OUT

- Everything W2/W3 of the design: the delegate bridge, the seam spike, `task fan`, adapter cards, briefs, and the remotty `headless-turn-open` verb — follow-on wish (design Decision 13).
- Checkout enforcement: assignment is declaration only; `task checkout --worker` remains ungated, and `claimed_by`/`agent_kind` stay observed identity. The W2 bridge is what links them.
- Any change to the laneless `board --json` shape (byte-frozen by the boards-first-class WISH decision).
- Routing config files, WISH.md agent pins, stage-level defaults — routing is board-card-driven only.
- Remotty-side rendering of the new fields (remotty-repo work, tracked there).
- kimi in the allowlist (not in the requested five; the constant is a one-line extension when wanted).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Two additive nullable TEXT columns, no `user_version` bump | Matches the `lane`/`agent_kind` additive precedent and the documented `?? null` snapshot-compat pattern in `insertSnapshotRows` |
| 2 | Allowlist is a typed in-code constant of the five roster names | Design Decision 11 (injection surface: assigned text reaches a shell and another agent's prompt in W2); constant-as-data keeps extension a one-line change |
| 3 | `--agent` requires `--why` | The design's routing semantics: an assignment *carries its rationale*; a why-less assignment is exactly the invisible routing this wish exists to kill |
| 4 | `task assign` gets `--clear`; assign/clear write timeline notes | Mis-assignments need correction without delete-and-recreate (the remotty-handoff lesson); notes make routing history part of the card thread the teammate channel will read |
| 5 | Lane-path-only serialization | Design Decision 10; laneless byte-freeze is a standing contract with its own regression tests |

## Simplicity Case

- **Simplest complete design:** two nullable columns + one constant + one flag pair on `create` + one new verb + lane-path serializer additions + sync lockstep. No new tables, no config surface, no enforcement, no migration bump.
- **Added machinery:** `--clear` (justified: correcting a wrong assignment must not require delete-and-recreate; follows the shipped `set-wish --clear` precedent); timeline notes on assign/clear (justified: design Decision 4 makes the card timeline the durable thread — routing changes are thread events).
- **Deferred until measured:** checkout gating on assignment (trigger: the W2 bridge, which claims via `checkout --worker`); roster as configuration (trigger: first roster change that can't wait for a release); any stage-level routing defaults (trigger: Felipe reverses the board-only decision).
- **Complexity removed:** no enforcement states, no config file, no WISH.md routing dialect, no laneless-shape change, no cross-repo work.

## Dependencies

**depends-on:** none
**blocks:** none

Forward pointer (not yet a DAG edge — the wish linter requires existing slugs): `delegate-bridge`, the planned W2/W3 follow-on wish (design Decision 13), consumes these columns and must declare `depends-on: cross-agent-delegate` when poured; it is additionally blocked on the remotty `headless-turn-open` wish, recorded as a `task block` on its card per the design's cross-repo mechanism.

## Success Criteria

- [ ] `genie task create --title x --agent codex --why "dissent on parser"` persists both fields; `genie task status` displays them.
- [ ] `genie task assign <id> --agent pi --why "…"` sets and overwrites on an existing card; `--clear` nulls both; each writes a timeline note.
- [ ] A non-roster name (`--agent gpt6`) is rejected with exit ≠ 0 and an error naming the allowed roster; `--agent` without `--why` is rejected.
- [ ] Lane-path `genie board --json` carries `assignedAgent`/`assignedReason`; the laneless shape is proven byte-identical to pre-change output on a fixture board (leak lists in `v5-board.test.ts`/`mcp.test.ts` extended).
- [ ] `task export` → `task import` → three-way `task sync` round-trip preserves both fields; importing an older snapshot without the keys succeeds with null backfill.
- [ ] `bun run wishes:lint` passes on this wish and the full gate `bun run check` passes on the branch.

## Execution Strategy

### Wave 1 (sequential gate — schema core only, kept small on purpose)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| A1 | engineer | 3 — stateful SQLite schema (+2), documented `EXPECTED_SCHEMA`/`schemaIsCurrent` silent-skip trap (+1) | `engineer-standard` / high | Columns, additive backfill, lockstep, `TaskRow` mapping, roster constant + rejection error |

### Wave 2 (parallel — all depend only on A1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| A2 | engineer | 2 — two CLI surfaces over a settled state API (+2 routing-semantics surface) | `engineer-standard` / medium | `create --agent/--why`, `task assign [--clear]`, timeline notes, `status` display, CLI docs |
| B | engineer | 2 — deterministic serialization against a byte-freeze contract (+2 contract-sensitive presentation) | `engineer-standard` / medium | Lane-path `board --json` fields + lane-path exact-key and laneless byte-freeze regressions |
| C | engineer | 3 — stateful three-way sync (+2), snapshot-compat trap (+1 prior-rework) | `engineer-standard` / high | `insertSnapshotRows`/sync-baseline lockstep + round-trip tests |

Group A was split per plan-review MEDIUM-1: A1 is the only sequential gate, so a stumble in CLI surfaces (A2) no longer stalls B and C.

## Execution Groups

### Group A1: Schema core — columns, lockstep, roster

**Goal:** The state engine carries validated assignment fields, upgrades existing DBs additively, and exposes them on `TaskRow`.

**Deliverables:**
1. `assigned_agent`/`assigned_reason` nullable TEXT columns: CREATE TABLE, additive backfill for existing DBs, `EXPECTED_SCHEMA.tasks` + `schemaIsCurrent` lockstep, `TaskRow`/row-mapping updates (`src/lib/v5/genie-db.ts`, `src/lib/v5/task-state.ts`).
2. `ROSTER` allowlist constant (`claude|codex|pi|hermes|prime`) with a typed rejection error exported for every write path.
3. State-layer assign/clear functions (used by A2's verbs) enforcing allowlist + reason-required invariants at the API boundary.

**Acceptance Criteria:**
- [ ] Assignment fields persist and round-trip through `TaskRow`.
- [ ] Non-roster agent and agent-without-reason are rejected at the state API (typed errors).
- [ ] A pre-existing DB (columns absent) upgrades additively on open — no `user_version` bump, no data loss; `schemaIsCurrent` returns false for the pre-upgrade shape so backfill cannot be skipped.

**Validation:**
```bash
bun test src/lib/v5/task-state.test.ts src/lib/v5/genie-db.test.ts && bun run check
```
Scope: the two files carrying the schema change, then the repository full gate — required because this group changes shared runtime schema (the wish skill's schema-change escalation rule; `bun run check` is the repo-documented gate).

**depends-on:** none

---

### Group A2: CLI verbs, timeline notes, and docs

**Goal:** Assignment is settable at creation or later from the CLI, with history on the timeline and the verb documented where consumers look.

**Deliverables:**
1. `task create --agent/--why` and new `task assign <id> --agent <name> --why <reason> [--clear]` in `src/term-commands/v5-task.ts`, calling the A1 state API; assign/clear append timeline notes; `task status` shows the assignment.
2. Docs (plan-review MEDIUM-2): add `task assign` and the `create` flags to the Task subcommands table in `CLAUDE.md`, noting the lane-path-only serialization consequence (non-lane/laneless readers do not see assignment, by design); if the `.docs-vendor` submodule is checked out in the execution worktree, update the CLI reference under `docs/_internal/` the same way.

**Acceptance Criteria:**
- [ ] Create-with-assignment persists; assign overwrites; `--clear` nulls both fields.
- [ ] Non-roster agent and `--agent`-without-`--why` are rejected (exit ≠ 0, named errors).
- [ ] Assign/clear work at any card status — claimed, in-progress, done, blocked — with no status gate (declaration only; plan-review LOW-4).
- [ ] Assign/clear each append a visible timeline note; `task status` displays agent + why.
- [ ] `CLAUDE.md` Task subcommands table documents the new verb and flags.

**Validation:**
```bash
bun test src/term-commands/v5-task.test.ts && grep -q 'task assign' CLAUDE.md
```
Scope: the CLI surface's own test file plus a docs presence check; schema reach was already full-gated in A1, and the wish-level Success Criteria re-run `bun run check` on the branch.

**depends-on:** group-a1

---

### Group B: Lane-path serialization + byte-freeze regression

**Goal:** Any lane-board client can read assignments from `board --json`; laneless consumers see byte-identical output.

**Deliverables:**
1. `assignedAgent`/`assignedReason` on lane-path card payloads in `src/term-commands/v5-board.ts` (alongside `enforcedBlock`).
2. The lane-path exact-sorted-key assertion (`v5-board.test.ts:350-363`, currently 12 keys) updated to include both fields — making "exactly these runtime fields on this path" an explicit, updated statement (plan-review LOW-1).
3. Laneless leak lists in `src/term-commands/v5-board.test.ts` and `src/term-commands/mcp.test.ts` extended with both fields; a byte-identical laneless regression against a fixture board.

**Acceptance Criteria:**
- [ ] Lane-path `board --json` exposes both fields on assigned cards and omits nothing for unassigned ones (null semantics documented in the payload test).
- [ ] Laneless `--json` output for a fixture board is byte-identical to pre-change output; leak tests fail if either field escapes.

**Validation:**
```bash
bun test src/term-commands/v5-board.test.ts src/term-commands/mcp.test.ts
```
Scope: presentation-boundary change fully covered by the two serializer test files (the freeze contract's own regression home); the wish-level full gate in Group A's validation and the Success Criteria covers type/lint reach.

**depends-on:** group-a1

---

### Group C: Roadmap-sync lockstep

**Goal:** Assignments survive the canonical roadmap.json round-trip and three-way sync — Decision 1 of the design ("syncs via roadmap.json") becomes true.

**Deliverables:**
1. `insertSnapshotRows` enumeration extended; older-snapshot imports backfill null via the documented `?? null` pattern (`src/lib/v5/task-state.ts`). Note: `exportState` is column-blind (`SELECT *`), so export needs no change (plan-review LOW-2) — verify with a test rather than editing it.
2. Three-way `task sync` baseline handling covers the new fields (no false diverged-state from their introduction). Disposition for `src/lib/v5/roadmap-sync.ts` (plan-review LOW-3): the existing pre-backfill-baseline pattern (`task-state.ts:1663`, test at `task-state.test.ts:1028`) likely already covers column introduction — verify, and either change it or record in the group's report that no change was needed.
3. Round-trip tests: export → import → sync preserves assignment; importing a pre-change snapshot succeeds.

**Acceptance Criteria:**
- [ ] Export/import/sync round-trip preserves `assigned_agent`/`assigned_reason` exactly.
- [ ] A snapshot produced by an older build (keys absent) imports cleanly with nulls.
- [ ] Introducing the columns does not flip an in-sync repo to diverged on the next `task sync`.

**Validation:**
```bash
bun test src/lib/v5/task-state.test.ts src/lib/v5/genie-db.test.ts && bun run check
```
Scope: sync is shared runtime/core behavior touching the git-hook path — focused state-engine tests plus the repository full gate per the wish skill's escalation rule.

**depends-on:** group-a1

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: in a real repo, `genie task create --title t --agent codex --why w` then `genie board --board <lane-board> --json` shows both fields; `task assign --clear` removes them.
- [ ] Integration: commit → pull cycle through the git-hook `task sync` path preserves an assignment across two checkouts of the same repo.
- [ ] Regression: laneless `genie board --json` output on an existing board is unchanged byte-for-byte from the prior release.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Laneless byte-freeze violated by accident | Medium | Dedicated byte-identical regression + extended leak lists fail the build |
| `EXPECTED_SCHEMA`/`schemaIsCurrent` omission lets initialized DBs skip backfill (documented trap) | Medium | Group A acceptance criterion tests the pre-existing-DB upgrade path explicitly |
| Sync-baseline false-diverged on column introduction | Medium | Group C acceptance criterion covers first-sync-after-upgrade |
| Allowlist too rigid for future roster changes | Low | Constant-as-data; one-line change, kimi already identified as first candidate |
| First `task export --write` after upgrade adds two null keys to every card in git-tracked `.genie/roadmap.json` | Low | Expected one-time diff (export is column-blind) — noted here so PR reviewers expect it rather than question it (plan-review LOW-2) |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — SHIP (2026-08-11T00:21:16Z)

- **Reviewer:** design-review-cross-agent-delegate (read-only; same reviewer as the design's two fix loops)
- **Verdict:** SHIP — "a faithful, complete W1 pour of the SHIP'd design"; mechanics verified against the repo (all named test files exist; `wishes:lint` passes; leak-list/freeze assertions located at `v5-board.test.ts:744-780`, `mcp.test.ts:419-436`; full-gate escalation correctly applied to schema/sync groups and withheld from the presentation group; scope fidelity confirmed in both directions; no conflict with the five W2/W3 design residuals).
- **Findings and dispositions (all applied in-document before status flip):**
  - MEDIUM-1 (Group A under-routed as sequential gate) → **split into A1 (schema core, sole gate) + A2 (CLI verbs/docs, parallel with B/C)** — the reviewer's preferred resolution.
  - MEDIUM-2 (new verb undocumented) → docs deliverable added to A2 (`CLAUDE.md` Task subcommands table + lane-path consumer consequence; `docs/_internal/` CLI reference if the submodule is checked out).
  - LOW-1 (lane-path exact-key assertion) → named as Group B deliverable 2 (`v5-board.test.ts:350-363`).
  - LOW-2 (`exportState` column-blind; one-time roadmap.json null-key diff) → Group C deliverable reworded; expected-diff row added to Risks.
  - LOW-3 (`roadmap-sync.ts` unlisted) → verify-only disposition added to Group C and Files (pre-backfill-baseline pattern at `task-state.ts:1663` likely covers it).
  - LOW-4 (assign vs card status unspecified) → A2 acceptance criterion: assign/clear allowed at any status, no gate (declaration only).
  - LOW-5 (design line 37 stale on the cross-repo mechanism — wish is right, design stale) → reconciliation note added to the DRAFT residual list; the design edit lands with the W2/W3 residual application and its fresh review.
- **Kept from the review:** W1's allowlist is declaration-time only, so a hermes single-turn scoping in W2 requires no W1 rework — declaration and turn capability are independent (design Decision 9).

---

## Files to Create/Modify

```
src/lib/v5/genie-db.ts            # columns, EXPECTED_SCHEMA, schemaIsCurrent, backfill
src/lib/v5/genie-db.test.ts
src/lib/v5/task-state.ts          # TaskRow, ROSTER allowlist, assign API, insertSnapshotRows
src/lib/v5/task-state.test.ts
src/lib/v5/roadmap-sync.ts        # verify only — pre-backfill baseline likely covers column introduction (LOW-3)
src/term-commands/v5-task.ts      # create --agent/--why, assign verb, status display
src/term-commands/v5-task.test.ts
src/term-commands/v5-board.ts     # lane-path serialization
src/term-commands/v5-board.test.ts # lane-path exact-key list + laneless leak lists
src/term-commands/mcp.test.ts     # leak-list extension
CLAUDE.md                         # Task subcommands table: assign verb + create flags (MEDIUM-2)
```

### Execution review — SHIP (2026-08-11T01:56:19Z)

- **Reviewers:** reviewer-a1, reviewer-a2, reviewer-b, reviewer-c (per-group, all independent of the engineers), reviewer-quality (whole-branch security/maintainability/perf pass). Reviewer ≠ engineer held throughout.
- **Verdicts:** A1 schema core SHIP · A2 CLI verbs+docs SHIP · B lane-path serialization SHIP · C sync lockstep SHIP · Quality pass SHIP — zero must-fix findings across all five reviews.
- **Branch:** `wish/cross-agent-delegate` (base `8211b56ac` = dev HEAD). Commits: `5bd2cbaaa` (A1), `f8f3c5de6` (A2), `91cead7de` (B), `c69ae7c27` (C), on top of `c08aba486` (wish docs).
- **Validation evidence (orchestrator-run):** focused suites — A1 `131 pass/0 fail`, A2 `75 pass/0 fail`, B `69 pass/0 fail`, C `134 pass/0 fail`; combined quality-pass run `278 pass/0 fail`; `bun run wishes:lint` OK (76 files). Full gate `bun run check`: **3192 pass / 14 fail — all 14 are the pre-existing environment set** (local-delivery-repair ×3, doctor 120ms latency budget ×1, agent-sync ×4, update-command ×4, codex dogfood ×2), proven at base `c08aba486` by a detached-baseline re-run (13 reproduce identically; the 14th is a timing flake); zero wish-related failures. The 4 B-owned presentation assertions that were red after A1 are green after B landed.
- **Executed as planned, with two authorized deviations, both verified legitimate:**
  1. `src/lib/v5/mcp-tools.ts` added to B's file set — `genieTask` returns the raw `TaskRow` so the laneless byte-freeze requires stripping the two fields there (A1 engineer finding, confirmed by reviewer-b).
  2. `src/lib/v5/card-render.test.ts` 2-line fixture tweak in A1 — `TaskRow` fields are required, so the hand-built `TaskCardRow` fixture needed nulls; typecheck-forced, behavior-neutral (confirmed by reviewer-a1).
- **Dispositions per plan-review residuals:** LOW-2 confirmed — `exportState` is column-blind (`SELECT *`), no edit needed, verified by test; LOW-3 confirmed — `roadmap-sync.ts` needed NO change (hash-based sync: db gains two null keys per card → `dbChanged && !fileChanged` → export branch, never diverged; first sync `exported`, second `none`), verified by reviewer-c; LOW-4 confirmed — assign/clear work at any card status (claimed/in_progress/done/blocked tested). A1's assign/clear timeline events are appended in-transaction by the state API; CLI verbs do not double-append (A2 criterion, verified).
- **Non-blocking INFO items recorded (no action required for W1):** roster case-sensitivity not pinned; identical-pair no-op is a pre-transaction TOCTOU (duplicate audit event possible under concurrent identical assigns — cosmetic, matches `setTaskWish` precedent; W2 bridge should read-modify-write inside the transaction); pre-existing stale `listTasksWithLane` docstring ('export stays byte-identical') now superseded by design — export intentionally gains the two keys; imported snapshots store assignment raw (declaration-only by design, `block_kind` precedent) — the W2 bridge must validate at consumption (design Decision 2 contract).
- **QA Criteria handoff:** functional/integration/regression criteria from the wish's QA section remain to be verified on dev after merge by the QA agent; the laneless byte-identity regression is already enforced in-tree by B's fixture test.
