# Wish: Board contract asks from remotty — set-wish, blocked state, delete, lint links

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `remotty-board-asks` |
| **Date** | 2026-08-07 |
| **Author** | felipe (from remotty's `brainstorm-stage-cards` handoff) |
| **Appetite** | medium |
| **Repos touched** | genie |
| **Design** | _No brainstorm — direct wish_ |

> Source: the remotty repo's brainstorm `brainstorm-stage-cards` produced a handoff of five
> measured asks for genie ([HANDOFF-from-remotty.md](HANDOFF-from-remotty.md), copied here for
> traceability). Ask 0 ("derive lanes from WISH.md status") was already resolved and withdrawn;
> this wish covers the remaining four workstreams (asks 2 and 3 are one workstream).

## Summary

remotty renders genie's roadmap board read-only from `genie board --board <ref> --json` and found
four gaps by building against it: a card can never gain a wish slug after creation, enforced
blocks are invisible in the board JSON (and conflate "work is blocked" with "do not claim"),
cards are undeletable, and the `jar: index-lane drift` doctor lint passes dangling links while
silently skipping linkless entries. This wish closes all four on the genie side, providing the
source remotty's already-built blocked badge and wish-join need — remotty must then switch its
badge predicate from `status == "blocked"` to reading `enforcedBlock` (a one-line client change;
their handoff's ask #2 explicitly offered the field-pair option).

## Scope

### IN

- A `genie task set-wish` verb that attaches (or clears) `wish`/`group` on an **existing** card, preserving `id`, `createdAt`, and the card timeline (`task_events`).
- A block **kind** distinguishing *work is blocked* (`work`) from *do not claim* (`hold`) on `genie task block`, persisted as an additive nullable column and synced.
- Additive serialization of enforced-block state — a single nullable `enforcedBlock: { reason, kind }` field — on cards in the **lane-grouped** `board --json` projection only.
- A scoped `genie task delete <id>` that refuses when other tasks depend on the card, plus a regression test proving the existing hash-based `task sync` already propagates deletions.
- `jar: index-lane drift`: resolve each entry's link target on disk via an injected resolver, report a dangling target as a new warning state (`broken`), and surface `unlinked`/`broken` entries in human output instead of silence.
- `src/lib/v5/TAXONOMY.md` updated for every contract change above; roadmap export/import/sync carries `block_kind` within `schemaVersion: 1`.

### OUT

- Any remotty-side change (this wish ships no remotty edits; their one-line badge-predicate switch is theirs to make — see Summary).
- Deriving card lanes from `WISH.md` status — explicitly withdrawn in the handoff.
- Any change to the byte-frozen surfaces: `TaskRow`, the laneless `--json` columns shape, MCP tool output, and `task export` tasks (WISH Decision 7, `task-state.ts:98-110`) stay byte-identical.
- Any `user_version` / `schemaVersion` bump — there is no migration ladder (`sqlite-open.ts` throws `ForeignDbError` on unknown versions) and a bump would brick every existing DB and split the tracked `roadmap.json`.
- New row-level sync/reconcile logic — the whole-snapshot hash model in `roadmap-sync.ts` already handles deletions.
- An archive/soft-delete/tombstone subsystem — delete is a hard, scoped removal.
- Making `jar: index-lane drift` flip doctor `ok:false` — it stays warning-level per the existing contract.
- New write surfaces on the read-only MCP server (`genie mcp` stays read-only).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Blocked state ships as **one additive nullable field `enforcedBlock: null \| { reason: string, kind: 'work' \| 'hold' }`** on cards in the **lane-grouped `--json` projection only** (`renderLaneBoard` → `listTasksWithLane` → `LaneTaskRow`) — never on `TaskRow`, the laneless `--json`, MCP, or `task export` | WISH Decision 7 byte-froze `TaskRow` and names `blockedBy`/`blockedReason` as fields it never gains (`task-state.ts:98-110`, test-enforced by `v5-board.test.ts`'s exact-key guard). The lane projection is a separate, already-additive shape (remotty's measured key list includes `lane`) and is exactly the path remotty reads (`--board roadmap --json`). A single nullable object also avoids serializing `blocked: false` on a card whose dependency-driven `status` is `"blocked"` — one field, one meaning: enforced block present or not. |
| 2 | Block kind is an **additive nullable column** `block_kind TEXT` on `tasks` (null ⇒ `work`), set via `genie task block <id> --hold`, following the house pattern used for `blocked_by`/`blocked_reason` (`genie-db.ts` `ensureTaskColumns`: "All nullable ⇒ no user_version bump") | The handoff's own sample shows 1-of-2 blocks is administrative. One mechanism with a kind beats two verbs: the claim machine's "blocked refuses checkout" behavior is identical for both; only presentation differs. Nullable-additive keeps `user_version = 1` and same-version snapshots from older builds importable. |
| 3 | New verb `genie task set-wish <id> --wish <slug> [--group <name>]` (and `--clear`), rather than overloading `task move`; the change is recorded on the card timeline via `task_events` (`appendTaskEvent`), **not** the retained-for-compat `stage_log` | `move` changes lanes; wish attachment is identity, not placement. `set-wish` avoids the naming collision with the `wish` skill and the `--wish` filters. `task_events` is the source of truth that `task status` renders; `stage_log` is kept only for older binaries and has no non-test writers. |
| 4 | `task delete <id>` refuses when any other task depends on the card; **no new sync logic** — the whole-snapshot hash reconcile already propagates deletions (`dbChanged && !fileChanged` → export republishes without the row) | Refusal is the safe default: with `PRAGMA foreign_keys = ON` and `ON DELETE CASCADE` on `task_dependencies`, deleting a depended-on card erases the edge, and the next ready-set recompute (`recomputeReady`, `task-state.ts:674-687`, reached via `task done`) silently promotes the dependent to `ready` — a **delayed silent unblock** at an arbitrary later moment. The refusal prevents that silent promotion. Deletion-sync needs a regression test, not machinery. Two narrow holes are documented rather than engineered around: plain `task import` **without** `--replace` merges as a superset and can resurrect a deleted row from an older snapshot; and deleting the last task takes the import branch only when no board or wish-group rows remain either (`hasOperationalState` gate, `roadmap-sync.ts:151,183`). |
| 5 | Dangling link targets become a distinct `broken` per-entry state, warning-level; **`broken` takes precedence over `drift`** when both apply; target existence is checked via an **injected resolver** so `evaluateIndexLaneDrift` stays pure | Inverting the current behavior (broken passes, linkless skips) without changing doctor's `ok` contract. A dangling link means the entry's evidence is rotten — fix the link first, then drift is re-evaluable. Injection preserves the documented purity contract and the existing unit-test calling convention. `broken` rides `--json` under `checks[].indexLane.entries` beside `ok`/`drift`/`unlinked`. |

## Simplicity Case

- **Simplest complete design:** one new nullable column (`block_kind`), two new verbs (`task set-wish`, `task delete`), one additive nullable field on the lane-projection cards, and an injected target-exists check in an existing lint. No version bumps, no new reconcile logic, no new subsystems, daemons, or config surfaces.
- **Added machinery:** the `block_kind` column is the only schema addition — required because the only existing sample of blocks is 50% administrative and remotty cannot ship a blocked badge that is wrong half the time.
- **Deferred until measured:** archive/soft-delete (no caller has asked to recover a deleted card); a generic `task edit` verb (only `wish`/`group` have a demonstrated consumer); exposing dependency-based `blocked` status detail beyond what `status` already carries; row-level sync reconcile (the hash model has no demonstrated failure inside its gates).
- **Complexity removed:** no second block verb; no status-enum change (avoids touching the claim machine and every frozen surface); no `user_version`/`schemaVersion` bump (avoids a fleet-wide lockstep upgrade); no reconcile logic in the lint (it stays a pure read-and-compare check).

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] `genie task set-wish <id> --wish <slug> --group <name>` sets both fields on an existing card; `id` and `createdAt` are unchanged and a `task_events` timeline entry (visible in `task status`) records the change; `--clear` removes both; `--group` without `--wish` fails with the same message as `create`; no slug format validation, matching `create`.
- [ ] On a lane-defining board, `genie task block <id> --reason r` yields a card whose `board --json` serialization contains `enforcedBlock: { reason: "r", kind: "work" }`; with `--hold`, `kind: "hold"`; an unblocked card serializes `enforcedBlock: null`.
- [ ] Frozen surfaces unchanged: `v5-board.test.ts`'s exact-key guard passes unmodified; the laneless `--json`, MCP tool output, and `task export` tasks are byte-identical to before; `status` still reads `ready` on an enforced-blocked ready card.
- [ ] A `--hold` block refuses `task checkout` exactly like a `work` block.
- [ ] `genie task delete <id>` removes a card and its dependency edges; deleting a card another task depends on exits non-zero naming a dependent and changes nothing; a regression test proves the existing hash-based `task sync` republishes `roadmap.json` without the deleted row (no resurrection).
- [ ] `task export` / `import` / `sync` round-trip `block_kind` within `schemaVersion: 1`; a same-version snapshot from an older build (no `block_kind`) still imports.
- [ ] `jar: index-lane drift` reports an entry whose first link's resolved target does not exist as `broken` (warning, precedence over `drift`), still lane-checks resolving links (including `#anchor` and directory links), lists `unlinked` and `broken` entries in human output, and never flips doctor `ok:false`.
- [ ] `src/lib/v5/TAXONOMY.md` documents the set-wish verb, block kinds, delete semantics, the `enforcedBlock` lane-projection field, and the frozen surfaces that deliberately do not carry it.
- [ ] `bun run check` passes.

## Execution Strategy

Wave 1 runs two groups in parallel — they touch disjoint areas (block model + lane serializer vs
doctor lint). Wave 2 is sequential (`depends-on`-chained) because Groups 1, 3, and 4 all edit
`task-state.ts`/`v5-task.ts` verb-registration and state-machine regions and would conflict in
parallel worktrees. The in-flight `harness-audit-landing` diff touches the same files (identity
resolution + completion fence — no schema overlap), so this wish's branch rebases after it lands;
the collision is textual, not semantic.

### Wave 1 (parallel)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| block-model | engineer | 2 — stateful work (+2): additive column + claim-machine-adjacent state, deterministic tests | engineer-standard / medium | `block_kind` column + `--hold` flag + `enforcedBlock` on lane-projection JSON |
| index-lane-links | engineer | 1 — bounded lint change, deterministic tests, no state | engineer-trivial / low | Injected link-target resolution in `jar: index-lane drift`, `broken` state, surface `unlinked` |

### Wave 2 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| task-wish-verb | engineer | 2 — stateful work (+2): mutates card identity fields with timeline event + sync round-trip | engineer-standard / medium | `task set-wish` verb attaching wish/group to an existing card |
| task-delete | engineer | 2 — stateful work (+2): hard delete against the claim machine; sync behavior is test-only | engineer-standard / medium | Scoped `task delete` with dependency refusal + deletion-sync regression test |

## Execution Groups

### Group 1: block-model

**Goal:** Make enforced-block state (including its kind) visible to the lane-grouped board JSON consumers without touching any frozen surface.

**Deliverables:**
1. `block_kind TEXT` as an **additive nullable column** in `ensureTaskColumns` (`src/lib/v5/genie-db.ts`), alongside `blocked_by`/`blocked_reason`; add `'block_kind'` to `EXPECTED_SCHEMA.tasks` so `schemaIsCurrent` stays in lockstep (the omission is exactly the bug commit `872719005` fixed). **No `user_version` bump.**
2. `genie task block <id> --reason <r> [--hold]` sets the kind (null/absent ⇒ `work`); `task status` renders it; `unblock` clears it with the block.
3. The lane-grouped `--json` path (`renderLaneBoard` → `listTasksWithLane` → `LaneTaskRow`) additively gains `enforcedBlock: null | { reason, kind }` on every card; `TaskRow`, the laneless `--json`, MCP, and `task export` are untouched. Note: `TaskCardRow extends LaneTaskRow`, so the human-render projection structurally inherits the field — `card-render.ts` keeps reading `blockedBy`/`blockedReason`, and `TaskCardRow` is never serialized.
4. Update the now-inaccurate comment at `v5-board.ts:202-203` ("no runtime fields … matching the frozen laneless `--json`'s runtime-free contract") to name the one deliberate addition.
5. `insertSnapshotRows` inserts `t.block_kind ?? null`; `task export`/`import`/`sync` carry `block_kind` within `schemaVersion: 1`; TAXONOMY.md updated.

**Acceptance Criteria:**
- [ ] Enforced-blocked card on a lane board serializes `enforcedBlock: { reason, kind }`; unblocked card serializes `enforcedBlock: null`; kind defaults to `work`, `--hold` yields `hold`.
- [ ] `v5-board.test.ts`'s exact-key guard on the frozen shapes passes **unchanged**; laneless `--json` byte-identical; `status` unchanged by enforced blocks.
- [ ] `--hold` block still refuses `task checkout` exactly like a `work` block.
- [ ] Opening a pre-existing v1 DB adds the column idempotently with no version change; a same-version snapshot lacking `block_kind` imports cleanly.

**Validation:**
```bash
bun test src/lib/v5/task-state.test.ts src/term-commands/v5-task.test.ts src/term-commands/v5-board.test.ts && bun run check
```
Scope: `task-state.ts`/`genie-db.ts` are shared core state touched by every worktree — CLAUDE.md escalates shared runtime/core behavior to the repo full gate; the focused tests disprove the changed serialization and column backfill first.

**depends-on:** none

---

### Group 2: index-lane-links

**Goal:** Close the two silent blind spots in `jar: index-lane drift` — dangling link targets counting `ok`, and `unlinked` entries vanishing from human output — without breaking the check's purity contract.

**Deliverables:**
1. `INDEX_ENTRY_LINK` (`doctor.ts:1788`) captures the directory segment (`brainstorms|wishes` — today a non-capturing group) and the path remainder (today an uncaptured `[^)]*`) — or simply the whole href — so `evaluateIndexLaneDrift` can reconstruct `<brainstorms|wishes>/<slug>/<remainder>` to hand the injected resolver.
2. Target existence is supplied to `evaluateIndexLaneDrift` via an **injected resolver** (like the existing `laneForSlug`), preserving the documented purity and the unit-test calling convention; the resolver strips `#anchor` suffixes and treats directory links as existing when the directory does.
3. A missing target yields per-entry state `broken` (warning-level); `broken` takes precedence over `drift`; entries with resolving links keep the existing lane-drift comparison unchanged.
4. Human doctor output lists `unlinked` and `broken` entries by name; the check line's `status` becomes `warn` when `drift > 0` **or** `broken > 0` (today: `drift` only) and the summary counts line gains a `broken` count; `--json` carries `broken` beside the existing states under `checks[].indexLane.entries`; fix the `doctor.ts:1761` state-count comment (the addition makes "four state names" correct).
5. TAXONOMY.md / the CLAUDE.md gotcha line updated to describe the new state and precedence.

**Acceptance Criteria:**
- [ ] An INDEX entry linking to a deleted `WISH.md` reports `broken`, not `ok`; one linking to `wishes/x/WISH.md#section` or `brainstorms/x/` with an existing target stays `ok`/drift-checked.
- [ ] An entry that is both dangling-target and lane-mismatched reports `broken`.
- [ ] A linkless entry still reports `unlinked` and now appears in human output.
- [ ] Doctor `ok` is unaffected by any mix of `broken`/`unlinked`/`drift`; `evaluateIndexLaneDrift` performs no filesystem IO itself.

**Validation:**
```bash
bun test src/genie-commands/doctor.test.ts && bun run check
```
Scope: doctor is runtime behavior with an existing focused suite; the repo-documented full gate covers type/lint/dead-code boundaries.

**depends-on:** none

---

### Group 3: task-wish-verb

**Goal:** Let an existing card gain (or shed) its wish identity without delete-and-recreate.

**Deliverables:**
1. `genie task set-wish <id> --wish <slug> [--group <name>]` and `genie task set-wish <id> --clear`; `--group` requires `--wish` (mirrors `create`); no slug format validation, matching `create`.
2. A card timeline event (`task_events` via `appendTaskEvent`, with `EventAuthor`) records old → new; `task status` renders it. (**Not** `stage_log`, which is retained only for older binaries and has no live writers.)
3. `id`, `createdAt`, claim state untouched; `updatedAt` advances.
4. Round-trips through `export`/`import`/`sync`; TAXONOMY.md + `task --help` updated.

**Acceptance Criteria:**
- [ ] Attaching a wish to a wishless card preserves `id`/`createdAt` and appends a `task_events` entry visible in `task status`.
- [ ] `--clear` removes wish and group; `--group` without `--wish` fails with the same message as `create`.
- [ ] `task list --wish <slug>` finds the card after attachment.

**Validation:**
```bash
bun test src/lib/v5/task-state.test.ts src/term-commands/v5-task.test.ts && bun run check
```
Scope: same shared-core escalation as Group 1 — the verb mutates `task-state.ts` rows consumed by board, sync, and MCP reads.

**depends-on:** block-model

---

### Group 4: task-delete

**Goal:** Make a mistakenly created card removable without whole-DB export/hand-edit/import surgery.

**Deliverables:**
1. `genie task delete <id>` removes the card, its dependency edges, and its timeline; exits non-zero with a named-dependent message when any other task `depends-on` it (with FK cascade the edge would vanish and the next `recomputeReady` — called from `task done` — would silently promote the dependent to `ready`; the refusal prevents that delayed silent unblock).
2. A regression test proving the **existing** hash-based `task sync` propagates the deletion (`dbChanged && !fileChanged` → export republishes `roadmap.json` without the row; no resurrection). **No new reconcile logic.**
3. `task --help` and TAXONOMY.md document delete semantics: hard delete, dependency refusal (preventing the delayed-silent-unblock above), no archive; plus the two documented holes — plain `task import` without `--replace` merges as a superset and can resurrect from an older snapshot, and deleting the last task takes the import branch only when no board or wish-group rows remain either (`hasOperationalState` gate).

**Acceptance Criteria:**
- [ ] Deleting a leaf card succeeds; `task status <id>` then fails with not-found.
- [ ] Deleting a card with dependents exits non-zero, names a dependent, and changes nothing.
- [ ] The deletion-sync regression test passes: after delete, `task sync` writes `roadmap.json` without the card and a later `sync` does not resurrect it.

**Validation:**
```bash
bun test src/lib/v5/task-state.test.ts src/term-commands/v5-task.test.ts && bun run check
```
Scope: deletion touches the claim machine's tables — shared core, full gate per CLAUDE.md; the sync-regression acceptance test is the narrowest check that can disprove the risky behavior.

**depends-on:** task-wish-verb

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] From the remotty repo: `genie board --board roadmap --json | jq -c '[.lanes[]|(.cards//[])[]][0]|keys'` includes `enforcedBlock` alongside the original eleven lane-path keys (twelve total after this change).
- [ ] remotty's two sample blocks distinguish: `app-auto-update` serializes `enforcedBlock.kind: "work"` (after re-blocking with the new flag) and a `--hold` block serializes `kind: "hold"`.
- [ ] End-to-end lifecycle: create a card without a wish, attach a slug with `task set-wish`, see it join in `board --json`, delete a throwaway probe card on the real board, confirm `task sync` keeps it gone.
- [ ] `genie doctor` on remotty reports its dead-link INDEX entries as `broken`/`unlinked` visibly, with doctor overall still `ok`.
- [ ] Regression: `genie task checkout` still refuses blocked cards of both kinds; laneless boards, MCP reads, and `task export` output are byte-identical to before.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| A strict lane-`--json` consumer rejects the unknown `enforcedBlock` key | Low | Additive-only on the already-additive lane projection; remotty (the only known consumer of that path) requested it; all frozen surfaces are untouched and test-guarded |
| `task import` without `--replace` resurrects a deleted card from an older snapshot | Low | Documented as a known hole (Group 4 deliverable 3) rather than engineered around; `task sync` — the path git hooks actually run — is regression-tested |
| Textual merge collision with in-flight `harness-audit-landing` edits to `task-state.ts`/`v5-task.ts` | Medium | Rebase this wish's branch after harness-audit-landing lands; no schema overlap (that diff adds no columns), so the collision is mechanical |
| `hold` semantics prove to be a workaround for "placeholder cards" rather than a durable concept | Low | The column is nullable and additive; if placeholders disappear, `hold` blocks simply stop being created — no migration debt |
| remotty's blocked badge stays dark until they switch their predicate | Low | Deliberate: `status` stays untouched, so remotty must change `status == "blocked"` to reading `enforcedBlock` — a one-line client change their handoff anticipated; noted in the Summary so nobody expects the badge to light up on genie's release alone |

---

## Review Results

### Plan review #1 — 2026-08-07 — verdict: FIX-FIRST

- **Reviewer:** independent plan reviewer (read-only), uncommitted working tree on `wish/harness-audit-landing`; advisory questioner lens ran in parallel and independently corroborated the two top gaps.
- **Evidence:** verified verb surface (`v5-task.ts`), frozen-shape contract (`task-state.ts:98-110`, `v5-board.ts:57-66`, `v5-board.test.ts` exact-key guard — 26 tests green), block storage (`genie-db.ts:608-609`), sync model (`roadmap-sync.ts` whole-snapshot hashes), lint contract (`doctor.ts:1761-1890`, `:2083`); `.genie/roadmap.json` `schemaVersion: 1`.
- **Gaps:** CRITICAL-1 `user_version` bump would throw `ForeignDbError` on every existing DB and split the tracked roadmap (fix: additive nullable column, no bump). HIGH-1 Decision 1's premise false — Decision 7 froze exactly `blockedBy`/`blockedReason` on `TaskRow`; fix: scope the addition to the lane-grouped projection. HIGH-2 Group 4 specified row-level sync machinery that neither exists nor is needed; fix: regression test only. MEDIUM-1 `depends-on: none` contradicted the wave order; MEDIUM-2 `stage_log` is dead terminology (live timeline is `task_events`); MEDIUM-3 "slug validation identical to `create`" resolves to no validation; MEDIUM-4 lint purity/regex/precedence constraints unstated. LOW: `doctor.ts:1761` state-count comment; summary length.
- **Disposition:** all gaps amended into this document on 2026-08-07 (plan-document fixes; no code was written). Questioner-lens advisories additionally adopted: verb renamed `task set-wish`; blocked fields collapsed to one nullable `enforcedBlock` object to avoid `blocked: false` on dependency-`blocked` cards.

### Plan re-review #2 — 2026-08-07 — verdict: FIX-FIRST

- **Reviewer:** fresh independent plan reviewer (read-only), uncommitted working tree; verified all eight prior gaps against source and with empirical probes (fresh-repo key dump, FK-cascade + `recomputeReady` experiment, `hasOperationalState` probe).
- **Prior gaps:** 7 of 8 cleanly CLOSED (CRITICAL-1, HIGH-1, HIGH-2, MEDIUM-1/2/3, LOW); MEDIUM-4 mostly closed. Both deliberate amendments (`task set-wish` rename, single nullable `enforcedBlock` object) judged sound and kept. Standard plan checklist: all PASS.
- **New gaps:** HIGH-3 — the Decision 4 rewrite inverted the FK-cascade consequence: empirically the dependent is *silently promoted to ready* on the next `recomputeReady` (`task-state.ts:674-687`), not stuck-blocked; the wrong rationale was routed toward TAXONOMY.md/`task --help`. MEDIUM-5 lane-path key count is eleven, not twelve; MEDIUM-6 plan implied remotty needs no change (their badge predicate must move to `enforcedBlock`); MEDIUM-7 the regex deliverable couldn't reconstruct a resolvable path (directory segment non-capturing). LOW-a..f: `TaskCardRow` inheritance ripple; `appendEvent`→`appendTaskEvent`; overstated `hasOperationalState` hole; stale `v5-board.ts` line ref; `CLAUDE.md` missing from manifest; `broken` warn semantics unstated.
- **Disposition:** all ten amended into this document on 2026-08-07 (fix loop 2; document edits only).

### Plan re-review #3 — 2026-08-07 — verdict: SHIP

- **Reviewer:** fresh independent plan reviewer (read-only), uncommitted working tree; static source verification (empirical probes already run in re-review #2; no code changed since).
- **Evidence:** all ten re-review-#2 gaps verified CLOSED against source with file/line basis — HIGH-3's corrected delayed-silent-unblock direction confirmed by `recomputeReady`'s actual SQL (`task-state.ts:674-687`), the FK-cascade declarations (`genie-db.ts:526-530`, `sqlite-open.ts:190`), and the single production call site (`completeTask`, `task-state.ts:816`); lane-path key count independently confirmed at eleven; `hasOperationalState` qualification confirmed complete (cascades leave only `boards`/`wish_groups`). No previously closed gap reopened. Standard plan checklist: all PASS.
- **Residual:** two non-blocking LOWs — LOW-g ("and release" was not a real `recomputeReady` caller; struck) and LOW-h (Scope OUT parenthetical contradicted the amended Summary; reworded). Both applied by the orchestrator on 2026-08-07 as the reviewer's own one-line fixes.
- **Status transition:** plan SHIP → `APPROVED` persisted by the orchestrator. Next stage: `work` (after the in-flight `harness-audit-landing` branch lands, per the rebase note in Execution Strategy).

### Execution review — group block-model — 2026-08-07 — verdict: SHIP

- **Target:** commit `d5c71e0f6` on `wish/remotty-board-asks-block-model` (base `73ac11a14`), task `t_msiyp3ua4e038e63`, engineer `block-model-eng`, independent reviewer.
- **Evidence:** 12/12 acceptance criteria PASS. Reviewer re-ran focused tests (151 pass) and `check:fast` (exit 0), verified full-suite failure parity independently via read-only `git archive` extraction of base (the same 14 pre-existing failures name-for-name; +17 tests added, none lost); live CLI verification of block/hold/unblock/checkout-refusal and real lane-JSON shapes; SQL all bound-parameter; the `enforcedBlock`-presence-keyed-on-`blocked_by` invariant confirmed consistent with the checkout gate in both directions.
- **Findings:** LOW ×2 (the one-line out-of-scope `card-render.test.ts` fixture is unavoidable mechanical fallout — accepted; the engineer's "`bun run check` green" claim overstated — precise form: `check:fast` exit 0, full-suite test leg fails only on the 14 proven pre-existing failures). NIT: unreachable `?? 'work'` fallback left as-is.
- **Orchestrator validation:** re-ran focused tests (151 pass, 0 fail) and `check:fast` (all static gates OK) in the group worktree. Scope rationale: shared-core group ⇒ repo full gate; the full `check` test leg carries 14 pre-existing failures proven identical on base by two independent runs, so `check:fast` + focused suites + reviewer parity evidence stand as the gate. `genie task done` recorded.

### Execution review — group index-lane-links — 2026-08-07 — verdict: SHIP

- **Target:** commit `4dfd87686` on `wish/remotty-board-asks-index-lane` (base `73ac11a14`), task `t_msiyp3x10655eab9`, engineer `index-lane-eng`, independent reviewer.
- **Evidence:** all acceptance criteria PASS with per-criterion test citations. Reviewer re-ran doctor suite (127 pass + 1 latency flake proven pre-existing at base under identical load, with an independent 0.233ms median benchmark of the changed code), typecheck/lint/complexity-budget clean (doctorCommand 41 → 35 under the unchanged 42 ceiling; extraction verified presentation-only), and reconciled the full-suite failure sets between base and worktree name-for-name (zero failures attributable to the diff; the two per-checkout extras explained: uncommitted main-repo edits at base, Darwin worktree file-mode quirk at HEAD). TAXONOMY.md non-update verified correct.
- **Findings (non-blocking):** MEDIUM-1 fresh-clone human output gains 49 `· unlinked` noise lines on a passing check (contract consequence, not execution error); LOW-1 `indexTargetExists` lacks containment — a `..`-traversing INDEX link becomes a path-existence oracle in `--json`; LOW-2 the default-permissive `targetExists = () => true` fails open for future callers.
- **Disposition (index-lane-links):** fixer applied all three corrections in commit `2f50f4287` (containment check with escape-proof test, required resolver parameter with five explicit test call sites, unlinked-output cap at 5 with unconditional broken naming; CLAUDE.md bullet corrected to match). Orchestrator validation: 129/130 doctor tests pass — the single failure is the pre-existing 120ms latency-budget miss, proven identical on unmodified base by three independent measurements (engineer under load, reviewer at base, fixer via base-file restore; the changed code benchmarks at 0.233ms median). Typecheck clean, complexity budget intact (35/42). `genie task done` recorded. Wave 1 merged into `wish/remotty-board-asks` at `9a93a188a` (fast-forward + clean ort merge, disjoint files).

### Execution review — group task-wish-verb — 2026-08-07 — verdict: SHIP

- **Target:** commit `b5178937a` on `wish/remotty-board-asks` (base `9a93a188a`), task `t_msiyp3zr6f65f0fc`, engineer `set-wish-eng`, independent reviewer on a pinned detached snapshot (torn down after the verdict).
- **Evidence:** all acceptance criteria and deliverables PASS, verified by the reviewer's own CLI runs (attach/re-point/clear/guards with exit codes, byte-identical `--group requires --wish.` parity, timeline rendering, independent export → fresh-clone import → sync round-trip). Focused suites 139 pass; consumer suites (v5-board 28, mcp 28, mcp-tools 23) pass; Wave-1 `enforcedBlock` spot-check pass. `check:fast` legs all pass individually — the one aborting leg was the known umask-000 snapshot mode quirk on a file the diff never touches (committed mode `100755` correct). The whole-identity semantic (re-point drops stale group, clear clears both, orphan group normalized) judged SOUND: `wish_groups` is keyed `(wish, name)`, the drop is visible in CLI output and timeline, and `setTaskWish`'s normalization is the first state-layer enforcement of the group-requires-wish invariant anywhere.
- **Findings (all LOW, recorded as follow-ups, none applied now):** LOW-1 no-op `--clear` writes a `(none)→(none)` event (pattern-faithful with `moveTask`); LOW-2 `set-wish` trims where `create` doesn't (stricter side; create-path parity belongs to another group); LOW-3 pre-existing: import path never enforced group-requires-wish (candidate follow-up card: DDL CHECK); LOW-4 one inline wish-ref format duplicate in `v5-board.ts:107` (other group's file).
- **Orchestrator validation:** re-ran focused suites in the snapshot (139 pass, 0 fail) and `check:fast` to completion after repairing the snapshot's materialized modes to match `git ls-files -s` (exit 0). `genie task done` recorded.

### Execution review — group task-delete — 2026-08-07 — verdict: SHIP

- **Target:** commit `2c5960bf8` on `wish/remotty-board-asks` (base `b5178937a`), task `t_msiyp42ib277f60a`, engineer `task-delete-eng`, independent reviewer in the stable integration worktree (clean tree verified).
- **Evidence:** all acceptance criteria PASS via the reviewer's own CLI smoke in an isolated temp repo (dependent refusal names both dependents and changes nothing — 4 tasks + 2 edges intact; leaf delete then not-found; sync propagates the deletion and a second sync does not resurrect; `task done` on a survivor promotes nothing). Reviewer re-ran focused suites (152 pass) and `check:fast` (exit 0). Judged sound: claimed-card delete without a guard (every claim-holder follow-up fails loudly with not-found), no-`recomputeReady` reasoning verified on both task and wish-group axes (exactly three tables reference `tasks(id)`, all three deleted explicitly in one `BEGIN IMMEDIATE` transaction — no TOCTOU, rollback-on-refusal proven), and the `.addHelpText('after')` layering (listing carries the headline safety fact, detail page carries the full rationale and both holes). `roadmap-sync.ts` absent from the diff — the no-new-reconcile-logic constraint holds literally.
- **Findings (all LOW/informational, recorded, none applied):** TAXONOMY's second hole describes one of its two cited branches (reword candidate); no CLI path constructs dependency edges (pre-existing); a hand-imported self-edge yields a safe self-naming refusal; success message prints titles verbatim (pre-existing CLI-wide); the CLAUDE.md subcommand table was already a curated 9-of-18 subset — `delete` (the only destructive verb) worth a line at orchestrator discretion.
- **Orchestrator validation:** re-ran focused suites (152 pass, 0 fail) and `check:fast` (exit 0) in the integration worktree. `genie task done` recorded.

---

## Files to Create/Modify

```
src/lib/v5/genie-db.ts            ensureTaskColumns: block_kind (nullable, additive); EXPECTED_SCHEMA.tasks
src/lib/v5/task-state.ts          setTaskWish, deleteTask, block-kind read/write, insertSnapshotRows block_kind
src/lib/v5/task-state.test.ts     coverage for all three state changes + deletion-sync regression
src/term-commands/v5-task.ts      verbs: set-wish, delete; block --hold
src/term-commands/v5-task.test.ts CLI-level coverage incl. exit codes and stderr
src/term-commands/v5-board.ts     lane-projection enforcedBlock serialization + comment fix (:202-203)
src/term-commands/v5-board.test.ts
src/genie-commands/doctor.ts      INDEX_ENTRY_LINK capture, injected target resolver, broken state, human output
src/genie-commands/doctor.test.ts
src/lib/v5/TAXONOMY.md            contract updates for every change above
CLAUDE.md                         index-lane drift gotcha line: broken state + precedence
```
