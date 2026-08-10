# Design: Lane-sync follow-ups — one write path, one parser, honest reads

| Field | Value |
|-------|-------|
| **Slug** | `lane-sync-followups` |
| **Date** | 2026-08-10 |
| **WRS** | 100/100 |

## Problem

The board/wish lane-sync layer shipped by roadmap-truth and remotty-board-asks left four seams —
two write paths for the same card mutation with different audit policy, an undocumented lane-source
rule, a triplicated WISH.md status parser, and reconcile writes on reads whose output cannot show
them. Each seam is a drift generator: the PR #2756 review surfaced all four as findings that could
not be patched without decisions, which Felipe has now made.

## Scope

### IN
- `src/lib/v5/task-state.ts`: `linkTaskToWish` delegates to `setTaskWish`; a full no-op
  (from == to) skips BOTH the row write (no `updated_at` bump) and the timeline event — in both
  verbs. This deliberately changes `set-wish`'s current no-op behavior (today: unconditional
  `updated_at` write + `(none)→(none)` event), which is exactly remotty LOW-1's defect.
  Signatures change additively: `linkTaskToWish` threads an `EventAuthor` (CLI passes
  `resolveEventAuthor()`), `setTaskWish` gains an injectable `now` — existing call sites
  (including link's three `now`-passing test sites) stay valid. `setTaskWish` moves to
  `BEGIN IMMEDIATE` (`.immediate()`), matching link's current transaction mode.
  Test impact, stated precisely (mirror of D4's inverted stanza): in
  `task-state.test.ts`'s `linkTaskToWish changes only wish metadata and updated_at`, the
  REAL-CHANGE stanza's `getTaskEvents(...) === beforeEvents` assertion (no event after a genuine
  link) is deliberately inverted — a real link now appends exactly one event — and the test is
  retitled to match. In the NO-OP stanza, `updatedAt === 3_000` and the row-equality assertion
  pass verbatim; its events assertion reuses the pre-link `beforeEvents` baseline, so it is
  REBASED onto a snapshot captured after the real link (the invariant it encodes — a no-op
  appends nothing — is preserved; only the baseline moves).
- `src/lib/v5/TAXONOMY.md`: the lane-source rule — lanes follow the primary checkout's working
  tree (its currently-checked-out branch, uncommitted edits included); linked worktrees inherit
  the primary checkout's view.
- New `src/lib/wish-status.ts` (node-only APIs — it bundles into the hook script): the shared
  READ/EXTRACT mechanics with per-consumer interpretation left in place. Contract:
  slug pattern (single source; `wishes-lint.ts`'s `QUALIFIED_SLUG_PATTERN` derives from it),
  bounded read using the union-strictest primitive (v5-board's `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`
  open + `fstatSync` re-validation) with a caller-supplied byte budget (per-file 256KB for
  v5-board; session-context passes its cumulative remaining budget), and raw status-cell
  extraction with an explicit caller-chosen CELL BOUNDARY — the two consumers genuinely disagree
  on where the cell ends (v5-board anchors the closing `|` at end-of-row and lets the capture
  span internal pipes; session-context stops at the first `|` with no row anchor), and boundary
  is extraction, not interpretation, so one regex cannot be a superset of both. The shared
  extractor takes a boundary mode (`'row-end'` | `'first-pipe'`); each consumer passes its
  current mode, preserving today's behavior byte-for-byte. The legacy `**Status:**` form remains
  a session-context-only input handled through the shared entry point.
  Charset filters, vocabulary sets (`ACTIVE_STATUSES`), normalization (em-dash/paren stripping),
  and the lane prefix ladder ALL stay per-consumer — they are interpretation and differ on
  purpose. Consumers: `src/term-commands/v5-board.ts` and
  `plugins/genie/scripts/src/session-context.ts` import read+extract+slug;
  `scripts/wishes-lint.ts` imports the slug pattern only (its generic `metadataValue` helper
  serves Date/Design fields and stays). `session-context.cjs` regenerated via
  `bun scripts/hook-bundle-parity.ts --write` in the same commit.
- `src/term-commands/v5-board.ts`: `reconcileWishLanes` gated on exactly
  `opts.json && board?.lanes && board.lanes.length > 0` (the human lane render keeps never
  reconciling, as the shipped regression test asserts); `handleBoard` resolves the repo root once
  and threads it to both `openDb` and the reconcile — the surviving single `git rev-parse` is
  handleBoard's. The shipped test assertion that UNSCOPED `--json` reconciles
  (`v5-board.test.ts`, "does not reconcile a non-JSON human board read", final stanza) is
  deliberately inverted as part of this change.
- `plugins/pi-genie/extension.ts`: `genie_wish_status` description becomes unconditionally
  read-only; `genie_board`'s stays conditional (it accepts `--board`, which may still reconcile).
  Reference docs updated to match: `plugins/pi-genie/references/native-surface.md`,
  `plugins/hermes-genie/references/mutation-gates.md`. `plugins/hermes-genie/schemas.py`
  ("Read-only.") becomes accurate under D4 — verify, no edit expected.

### OUT
- MCP surface changes (`genie mcp` stays read-only per roadmap-truth Decision 7).
- The frozen laneless `--json` output shape (byte-identical).
- Any change to per-consumer status semantics (the board's wide prefix ladder,
  session-context's strict vocabulary + normalization, and wishes-lint's normalization all
  survive byte-for-byte).
- A wish-skill prose note (TAXONOMY.md is the single canonical statement of the lane-source rule;
  skill copies ship separately and are not touched here).
- remotty-side scanner changes; worktree-copy WISH.md discovery; monotonic lane guards;
  new daemons, config surfaces, or version bumps.
- Deprecating either verb name (`task link` stays; remotty scripts call it).

## Approach

Four independent, individually-shippable corrections sharing one theme: make the existing design's
intent mechanical instead of conventional.

1. **One write path (D1).** `linkTaskToWish` becomes a thin wrapper over `setTaskWish` — one
   validation chain, one write idiom, a `task_events` entry for every real identity change,
   satisfying remotty-board-asks' invariant. roadmap-truth deferred rather than forbade the event
   ("make that a deliverable first" — this is that deliverable). A full no-op (from == to) skips
   the row write AND the event: link's conditional-UPDATE idempotency (asserted by
   `task-state.test.ts`'s `updatedAt`-unchanged check) is preserved through delegation, and
   remotty LOW-1's `(none)→(none)` noise is removed rather than inherited. Error compatibility
   holds (both paths throw `UnknownTaskError`). One shipped assertion is deliberately inverted:
   the link test's real-change stanza asserts NO event today — under D1 it asserts exactly one —
   the same in-scope-inversion treatment D4 gives the unscoped-reconcile stanza. The no-op
   (idempotency) stanza's row assertions survive verbatim; its events assertion is rebased onto a
   post-link baseline (both stanzas share `beforeEvents` today). Alternatives lost: a link-local event (two paths
   keep drifting); status quo (invariant stays violated); event-only no-op guard (would bump
   `updated_at` on repeated links and break the shipped idempotency stanza).
2. **Document the lane-source rule (D2).** Investigation reframed the review finding: `resolveRepoRoot`
   already follows the primary checkout's working tree — plain-checkout users (the common case,
   e.g. remotty + genie as sibling checkouts) get live lanes today; only the `genie launch`
   worktree-cockpit flow lags, seeing the primary checkout's view (its checked-out branch plus any
   uncommitted WISH.md edits there) until the wish branch lands. That behavior is coherent and imposes no branch
   policy on any codebase; the defect is that it is written nowhere. Alternatives lost: monotonic
   guard (breaks true reverts for a cockpit-only symptom); worktree-copy preference (machine-
   dependent lanes, discovery machinery — fails the simplicity gate).
3. **Shared read, per-consumer meaning (D3).** Four mechanics exist across the three copies:
   slug validation, bounded read, status extraction, and normalization. The first three converge
   into `src/lib/wish-status.ts` — with extraction returning the RAW status cell under a
   caller-chosen boundary mode (`'row-end'` | `'first-pipe'`), because the consumers' cell-end
   rules genuinely differ and no single regex is a superset of both — while normalization and all
   status→meaning mapping stay per-consumer (session-context's `extractStatus` fuses extraction
   with its `ACTIVE_STATUSES` vocabulary and em-dash normalization; that fused tail is
   interpretation and stays in session-context, rebuilt on top of the shared raw extractor, with
   its charset filter re-implemented as a FULL-CELL test, not a prefix match). The bounded read
   takes a caller-supplied budget because the two consumers' caps are structurally different
   (v5-board: 256KB per file; session-context: one cumulative budget across ≤8 files) — a
   parameter, not new machinery. The session-context bundle regenerates through the existing
   parity gate (esbuild `bundle: true`; the module stays node-only). Note: `plugins/**` sits
   outside `tsc --noEmit`'s `include` and neither esbuild nor `bun test` typechecks, so the
   fixture corpus test guards BEHAVIOR at that call site; type safety comes from the shared
   module itself living in typechecked `src/`. Alternatives lost: parity-test-only (drift
   detected, not impossible); full semantic unification (changes SessionStart behavior for no
   present requirement).
4. **Reconcile only where lanes render (D4).** The reconcile gate becomes exactly
   `opts.json && board?.lanes && board.lanes.length > 0`: unscoped/laneless `--json` becomes a
   pure read (pi/hermes session-start probes under 5s timeouts stop paying write transactions),
   the human lane render keeps never reconciling, and remotty's scoped `--board roadmap --json`
   probe — the freshener roadmap-truth actually designed (its ACs use the scoped form) — keeps
   reconciling. This deliberately inverts the final stanza of the shipped regression test that
   asserts unscoped `--json` reconciles; that assertion is the one consumer of the old behavior,
   and flipping it is in-scope work, not collateral. `handleBoard` resolves the repo root once
   and passes it to both `openDb` (via explicit db path) and the reconcile, eliminating the
   second `git rev-parse`. Alternative lost: global freshening (writes on reads that cannot
   display them).

## Simplicity Case

- **Simplest complete design:** one delegation, one no-op guard, one shared module extraction, one
  moved call + threaded parameter, and documentation. No new tables, columns, states, daemons,
  config, or version bumps.
- **Added machinery:** four additive parameters — an `EventAuthor` on link (event attribution
  parity), an injectable `now` on setTaskWish (link's tests inject clocks), a byte budget and a
  cell-boundary mode on the shared read/extract (two structurally different existing caps; two
  genuinely different existing cell-end rules) — each paid for by a present, cited requirement.
  Two shipped test stanzas are deliberately inverted and retitled (link's real-change no-event
  assertion; board's unscoped-reconcile assertion) — named edits, not silent breakage. Everything
  else removes a duplicate path or a wasted write; the shared module is consolidation, not
  abstraction (three existing copies → one).
- **Deferred until measured:** worktree-copy lane freshness for the cockpit flow — reconsider only
  if cockpit operators demonstrably misread merged-truth lanes (e.g. a reported incident of acting
  on a stale lane); monotonic guard likewise.
- **Complexity removed:** one whole write path (link's), one subprocess spawn per unscoped read,
  write transactions on all laneless reads, and two of three parser copies.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | `linkTaskToWish` delegates to `setTaskWish`; a full no-op (from == to) skips row write AND event, in both verbs | One validation chain and audit policy for one mutation; preserves link's tested conditional-UPDATE idempotency; fixes remotty LOW-1 at the root instead of inheriting it |
| 1a | Signatures change additively (link threads `EventAuthor`; setTaskWish gains injectable `now`); setTaskWish moves to `BEGIN IMMEDIATE` | Event-evidence parity requires an author on link's path; link's tests inject `now`; one transaction mode for one mutation (link is immediate today) |
| 2 | Lane-source rule is documented, not changed: the primary checkout's working tree | Existing behavior is correct for plain checkouts and coherent for worktrees; imposes no branch policy on other codebases; symptom is cockpit-only |
| 3 | Shared module owns slug pattern + bounded read (budget-parameterized, union-strictest primitive) + raw-cell extraction with a caller-chosen boundary mode (`'row-end'` \| `'first-pipe'`); normalization and all status→meaning mapping stay per-consumer | Mechanics drifting is accidental, interpretations differing is deliberate; the consumers' cell-end rules genuinely differ, so the boundary is a parameter — the only contract that preserves both behaviors byte-for-byte |
| 4 | Reconcile gate is exactly `opts.json && board?.lanes?.length > 0`; the shipped unscoped-reconcile test assertion is deliberately inverted; repo root resolved once in `handleBoard` | A read whose output cannot show lanes must not write them; the sole consumer of the old behavior is that test assertion; designed freshener (scoped probe) unaffected |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | A consumer counts timeline events (or `updated_at` bumps) and notices no-op link/set-wish writes disappearing — or notices real links now appending events | Low | remotty review recorded LOW-1 as a defect to fix, not behavior to keep; link's no-op stanza asserts exactly the new no-op behavior, and the real-change no-event assertion is inverted in-scope; grep remotty scanners for event-count assertions before landing |
| 2 | Known consumers of unscoped reads lose the lane-freshening side effect: the shipped test assertion (inverted in-scope), pi `before_agent_start`/`genie_wish_status`/`genie_review_context` probes, hermes `session_context.py` | Medium | Those probes are session-start CONTEXT reads under 5s timeouts — freshness-on-next-scoped-read is the designed model (roadmap-truth ACs use `--board roadmap --json`); descriptions + reference docs updated in-scope; release note names the change |
| 3 | Shared-module extraction subtly changes one consumer's parsing on edge-case WISH.md files | Medium | The boundary-mode parameter preserves each consumer's cell-end rule exactly; per-consumer filters stay byte-identical; a fixture corpus test asserts each consumer's status→meaning output is unchanged against samples covering the four known divergence axes: charset (`SHIP-READY (wave 2)`), trailing content after the closing pipe (`\| DRAFT \|   <!-- x -->`), a 3-column status row (`\| **Status** \| DRAFT \| note \|`), and a charset violation inside the cell (`\| **Status** \| DRAFT extra \|` — session-context yields null today; catching this requires the re-implemented filter to be a full-cell test, not a prefix match) — each declaring which consumer (if either) intentionally changes (none do) |
| 4 | `session-context.cjs` parity gate fails if regeneration is forgotten; type errors in the plugin source escape `tsc --noEmit` (outside its `include`), and neither `bun test` nor esbuild typechecks | Low | Regeneration in the same commit; `bun run check` enforces byte/mode parity; the fixture corpus test catches BEHAVIOR drift (not type drift) at the call site — acceptable because the shared module itself lives in `src/` and is fully typechecked; only the thin plugin call site is not |
| 5 | A caller depends on `linkTaskToWish`/`setTaskWish` exact signatures or transaction mode | Low | Changes are additive (new trailing params); all existing call sites — including link's three `now`-injecting test sites — remain valid; `BEGIN IMMEDIATE` is strictly earlier lock acquisition, the mode link already uses |

## Success Criteria

- [ ] `genie task link <id> --wish w` and `genie task set-wish <id> --wish w` produce identical DB
  effects and identical `task_events` evidence (kind, note, author, author_kind) for identical
  mutations; a repeated (no-op) link or set-wish writes no event AND leaves `updated_at`
  untouched — the link test's real-change no-event assertion is inverted (exactly one event) and
  the test retitled; the no-op stanza's row assertions pass verbatim and its events assertion is
  rebased onto a post-link baseline; `task status` renders the change once.
- [ ] `src/lib/v5/TAXONOMY.md` states the lane-source rule (lanes follow the primary checkout's
  working tree; linked worktrees inherit that view).
- [ ] `src/lib/wish-status.ts` is the single source of the slug pattern and of the bounded
  read + raw status-cell extraction, whose contract includes the caller-chosen boundary mode
  (`'row-end'` | `'first-pipe'`) with each consumer passing its current mode; `v5-board.ts` and
  `session-context.ts` contain no local copy of either (their filters/ladders remain;
  session-context's charset filter re-implemented as a full-cell test); `wishes-lint.ts` derives
  its slug patterns from the shared one; `bun scripts/hook-bundle-parity.ts --check` passes; a
  fixture corpus test covering all four divergence axes named in Risk 3 (charset,
  trailing-content, 3-column row, in-cell charset violation) proves each consumer's
  status→meaning output is byte-for-byte unchanged.
- [ ] Unscoped `genie board --json` performs zero writes (seeded-divergence test in the
  roadmap-truth style: seed a lane divergence, run unscoped read, assert the stored lane is
  untouched and no move event appended); scoped `--board <lane-board> --json` still reconciles;
  the non-JSON lane render still never reconciles; the shipped test's unscoped-reconcile stanza
  is inverted to assert the new contract and the test retitled to match its content.
- [ ] Exactly one `git rev-parse` subprocess per `board --json` invocation — `handleBoard`'s own
  resolution, threaded to both `openDb` and the reconcile — verified via a PATH `git` shim in the
  existing spawn-based CLI test harness counting invocations.
- [ ] `bun run check` green; pi-genie descriptions match the new reality (`genie_wish_status`
  read-only, `genie_board` conditional); `native-surface.md` and `mutation-gates.md` updated;
  hermes `schemas.py` verified accurate.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `94a157aaccecac9a68175a753c7631ac25bd9bde54df63a6787a7478538518dd`
- **Reviewer:** genie:reviewer a253c1a06f495c8c1 (design-review subagent, Claude Opus 5 1M)
- **Reviewed at:** 2026-08-10T19:31:07.000Z
<!-- genie-design-review:end -->
