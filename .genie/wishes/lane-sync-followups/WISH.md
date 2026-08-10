# Wish: Lane-sync follow-ups — one write path, one parser, honest reads

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `lane-sync-followups` |
| **Date** | 2026-08-10 |
| **Author** | Felipe (decisions) + Fable orchestrator |
| **Appetite** | small-medium |
| **Branch** | `wish/lane-sync-followups` (branched from `dev` — `setTaskWish`/`formatWishRef` exist only there) |
| **Repos touched** | automagik-dev/genie only |
| **Design** | [DESIGN.md](../../brainstorms/lane-sync-followups/DESIGN.md) |

## Summary

Closes the four design seams the PR #2756 xhigh review left open in the board/wish lane-sync layer:
two write paths for one card mutation with different audit policy, an undocumented lane-source rule,
a triplicated WISH.md status parser, and reconcile writes on reads whose output cannot show them.
The design was SHIP-reviewed over four rounds (digest `94a157aa…`, stamped 2026-08-10); this wish
adds the reviewer's two non-blocking notes (L10 path-based read contract, L11 legacy-form opt-in +
fifth fixture row) as requirements.

## Scope

### IN

- **D1:** `linkTaskToWish` delegates to `setTaskWish`; a full no-op (from == to) skips BOTH the row
  write and the timeline event in both verbs; additive signatures (link threads `EventAuthor` —
  CLI passes `resolveEventAuthor()`; `setTaskWish` gains injectable `now`); `setTaskWish` moves to
  `BEGIN IMMEDIATE`. Test edits, exactly three: the link test's real-change no-event assertion is
  inverted (exactly one event) and the test retitled; the no-op stanza's events assertion is
  rebased onto a post-link baseline (row assertions pass verbatim).
- **D2:** `src/lib/v5/TAXONOMY.md` documents the lane-source rule — lanes follow the primary
  checkout's working tree (checked-out branch, uncommitted edits included); linked worktrees
  inherit the primary checkout's view.
- **D3:** new `src/lib/wish-status.ts` owning slug pattern + bounded read + raw status-cell
  extraction. Contract per the design plus reviewer notes: the read is **path-based**
  (`(path, budget) => string | null`) — file discovery stays per-consumer (v5-board's
  `physicalDirectory`-guarded join vs session-context's `opendirSync` enumeration + lowercase
  `wish.md` fallback); union-strictest primitive (`O_RDONLY|O_NOFOLLOW|O_NONBLOCK` +
  `fstatSync` re-validation); caller-supplied byte budget (per-file 256KB for v5-board,
  cumulative for session-context); caller-chosen cell boundary (`'row-end'` | `'first-pipe'`);
  legacy `**Status:**` fallback is an explicit **opt-in** only session-context passes.
  Charset filters, vocabularies, normalization, and the lane ladder stay per-consumer
  (session-context's charset filter re-implemented as a full-cell test). `wishes-lint.ts` derives
  its slug patterns from the shared one. `session-context.cjs` regenerated in the same commit.
  A five-row fixture corpus proves each consumer's status→meaning output byte-for-byte unchanged.
- **D4:** `reconcileWishLanes` gated on exactly `opts.json && board?.lanes && board.lanes.length > 0`;
  `handleBoard` resolves the repo root once (its own `resolveRepoRoot`) and threads it to both
  `openDb({ path })` and the reconcile; the shipped unscoped-reconcile test stanza is inverted and
  the test retitled; a seeded-divergence test proves unscoped `--json` performs zero writes; a
  PATH `git`-shim test counts exactly one `git rev-parse` per invocation.
- **Surface honesty:** pi `genie_wish_status` description becomes unconditionally read-only,
  `genie_board`'s stays conditional; `plugins/pi-genie/references/native-surface.md` and
  `plugins/hermes-genie/references/mutation-gates.md` updated; hermes `schemas.py` verified
  accurate (no edit expected — its `genie_board` never passes `--board`).

### OUT

- MCP surface changes (`genie mcp` stays read-only per roadmap-truth Decision 7).
- The frozen laneless `--json` output shape (byte-identical).
- Any change to per-consumer status semantics (wide prefix ladder, strict vocabulary,
  normalizations all survive byte-for-byte — proven by the fixture corpus).
- A wish-skill prose note (TAXONOMY.md is the single canonical lane-source statement).
- remotty-side scanner changes; worktree-copy WISH.md discovery; monotonic lane guards; new
  daemons, config surfaces, or version bumps; deprecating either verb name.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | `linkTaskToWish` delegates to `setTaskWish`; full no-op skips row write AND event in both verbs | One validation chain and audit policy; preserves link's tested conditional-UPDATE idempotency; fixes remotty LOW-1 at the root |
| 1a | Additive signatures (link + `EventAuthor`, setTaskWish + `now`); `BEGIN IMMEDIATE` on setTaskWish | Event-evidence parity needs an author on link's path; link's tests inject clocks; one transaction mode (link's current) for one mutation |
| 2 | Lane-source rule documented, not changed | Behavior is already correct for plain checkouts and coherent for worktrees; imposes no branch policy; symptom is cockpit-only |
| 3 | Shared module owns mechanics (path-based bounded read, budget, boundary mode, opt-in legacy form); interpretation stays per-consumer | Mechanics drifting is accidental, interpretations differing is deliberate; boundary/budget/discovery genuinely differ per consumer, so they are parameters, not policy |
| 4 | Reconcile gate `opts.json && board?.lanes?.length > 0`; repo root resolved once in `handleBoard` | A read whose output cannot show lanes must not write them; sole consumer of the old behavior is a test assertion, inverted in-scope; designed freshener (scoped probe) unaffected |

## Simplicity Case

- **Simplest complete design:** one delegation, one no-op guard, one shared-module consolidation
  (three copies → one), one moved call + threaded parameter, documentation. No new tables,
  columns, states, daemons, config, or version bumps.
- **Added machinery:** five additive parameters, each paid for by a present, cited requirement —
  `EventAuthor` on link (attribution parity), injectable `now` on setTaskWish (link's tests
  inject clocks), byte budget (two structurally different existing caps), boundary mode (two
  genuinely different existing cell-end rules), legacy-form opt-in flag (one consumer parses the
  legacy form today; unconditional fallback would change v5-board's `null` on legacy-only files).
- **Deferred until measured:** worktree-copy lane freshness and monotonic guards — reconsider only
  on a reported incident of an operator acting on a stale cockpit lane.
- **Complexity removed:** one whole write path, one subprocess spawn per read, write transactions
  on all laneless reads, two of three parser copies. Three shipped test edits are named, not
  silent: two inverted stanzas (with retitles) and one rebased no-op events baseline.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] `task link` and `task set-wish` produce identical DB effects and identical `task_events`
  evidence (kind, note, author, author_kind) for identical mutations; a no-op writes no event and
  leaves `updated_at` untouched; `task status` renders the change once.
- [ ] The link test's real-change no-event assertion is inverted (exactly one event) and retitled;
  the no-op stanza's row assertions pass verbatim with its events assertion rebased.
- [ ] `src/lib/v5/TAXONOMY.md` states the lane-source rule.
- [ ] `src/lib/wish-status.ts` is the single source of slug pattern + path-based bounded read +
  raw-cell extraction (boundary mode in the contract; legacy form opt-in); v5-board and
  session-context carry no local copy; wishes-lint derives its slug patterns;
  `bun scripts/hook-bundle-parity.ts --check` passes; the five-row fixture corpus (charset,
  trailing-content, 3-column, in-cell charset violation, legacy-form-only file asserting
  v5-board `null` / session-context `DRAFT`) proves per-consumer output byte-for-byte unchanged.
- [ ] Unscoped `genie board --json` performs zero writes (seeded-divergence test); scoped
  lane-board reads still reconcile; the non-JSON lane render still never reconciles; the shipped
  unscoped stanza is inverted and the test retitled.
- [ ] Exactly one `git rev-parse` per `board --json` invocation (PATH `git`-shim count in the
  spawn harness); `reconcileWishLanes` spawns none.
- [ ] `bun run check` green; pi descriptions match the new reality; `native-surface.md` and
  `mutation-gates.md` updated; hermes `schemas.py` verified accurate.

## Execution Strategy

### Wave 1 (parallel)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 2 — stateful work (+2): card-identity mutation semantics + timeline audit + transaction mode | engineer-standard / medium | task-state unify: link→setTaskWish delegation, no-op guard, signatures, three named test edits |
| 2 | engineer | 2 — multi-package (+1: src + plugins + scripts), CI / release work (+1: session-context.cjs parity is a release gate). The "no deterministic test" modifier is read as "acceptance cannot be mechanically proven" and applies to neither G2 nor G3 — both ship their own deterministic proof tests | engineer-standard / high | shared `wish-status.ts` module + three consumers + bundle regeneration + five-row fixture corpus |
| 4 | engineer | 0 — docs-only, mechanically checkable | engineer-trivial / low | TAXONOMY.md lane-source rule |

### Wave 2 (after Group 2 — both edit `v5-board.ts`)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | 3 — stateful work (+2: write-path gating on shared db), multi-package (+1: pi/hermes docs); same modifier reading as G2 (its two new tests are deterministic proofs, not a scoring modifier) | engineer-standard / high | reconcile gate + root threading + inverted stanza + seeded-divergence and spawn-count tests + surface descriptions |

## Execution Groups

### Group 1: One write path for card identity (D1)

**Goal:** `task link` and `task set-wish` share one mutation path with one audit policy; no-ops are fully silent.

**Deliverables:**
1. `setTaskWish` (dev's `src/lib/v5/task-state.ts`): full no-op (from == to) skips the row write and
   the event; gains trailing injectable `now`; transaction via `.immediate()`.
2. `linkTaskToWish` becomes a thin wrapper over `setTaskWish`, threading a trailing `EventAuthor`;
   existing call sites (including the three `now`-injecting test sites) remain valid;
   `UnknownTaskError` behavior preserved.
3. `handleLink` (`src/term-commands/v5-task.ts`) passes `resolveEventAuthor()`; output keeps using
   `formatWishRef`.
4. The three named test edits in `task-state.test.ts`, all inside the shipped test titled
   `linkTaskToWish changes only wish metadata and updated_at`: real-change no-event assertion
   inverted to exactly-one-event + test retitled; no-op events assertion rebased onto a post-link
   baseline (both stanzas share the pre-link `beforeEvents` snapshot today).
5. Pre-landing verification: grep the remotty scanners (`../remotty`, `scanners/`) for
   timeline-event-count or `updated_at` assertions that would observe the no-op silencing or the
   new link event; record the result (expected: none) in the group's completion report.

**Acceptance Criteria:**
- [ ] Identical mutations via link and set-wish yield identical rows and identical event
  kind/note/author/author_kind; `task status` renders one entry.
- [ ] Repeated link and repeated set-wish: no event, `updated_at` untouched.
- [ ] No-op stanza row assertions unmodified; only the named assertions changed.
- [ ] remotty scanner grep performed and result recorded (no event-count/updated_at consumer
  observes the change, or the finding is escalated before landing).

**Validation:**
```bash
bun test src/lib/v5/task-state.test.ts src/term-commands/v5-task.test.ts && bun run check
```
Scope: `task-state.ts` is shared core state machinery — the repository-documented full gate applies
(CLAUDE.md); focused suites first for the tight loop.

**depends-on:** none

---

### Group 2: Shared WISH.md read/extract module (D3 + L10 + L11)

**Goal:** One implementation of the parsing mechanics; every consumer's observable behavior byte-for-byte unchanged.

**Deliverables:**
1. `src/lib/wish-status.ts`: slug pattern export; path-based bounded read
   (`(path, budget) => string | null`, `O_NOFOLLOW` + `fstat` re-validation); raw-cell extraction
   with boundary mode (`'row-end'` | `'first-pipe'`) and explicit opt-in legacy `**Status:**`
   handling. Node-only APIs (bundles under esbuild).
2. `src/term-commands/v5-board.ts` consumes it (mode `'row-end'`, per-file 256KB, no legacy);
   discovery (`physicalDirectory` guards) stays local.
3. `plugins/genie/scripts/src/session-context.ts` consumes it (mode `'first-pipe'`, cumulative
   budget, legacy opt-in); discovery (opendir + lowercase fallback) stays local; charset filter
   re-implemented as a full-cell test; `session-context.cjs` regenerated same commit.
4. `scripts/wishes-lint.ts` derives `QUALIFIED_SLUG_PATTERN` from the shared slug pattern
   (its `metadataValue` helper stays).
5. Fixture corpus test (colocated `wish-status.test.ts` + consumer assertions) with the five rows:
   `SHIP-READY (wave 2)`, trailing content after closing pipe, 3-column status row, in-cell
   charset violation (`DRAFT extra`), legacy-form-only file (v5-board `null` /
   session-context `DRAFT`).

**Acceptance Criteria:**
- [ ] All five corpus rows: each consumer's status→meaning output identical before/after (none
  intentionally change).
- [ ] No local copy of the slug pattern, bounded read, or cell extraction remains in v5-board or
  session-context.
- [ ] `bun scripts/hook-bundle-parity.ts --check` passes.

**Validation:**
```bash
bun test src/lib/wish-status.test.ts src/term-commands/v5-board.test.ts && bun scripts/hook-bundle-parity.ts --check && bun run wishes:lint && bun run check
```
Scope: touches a generated, release-gated executable artifact (`session-context.cjs`) and a lint
script — parity check + wishes-lint + the full gate per the escalation rule. The standalone
parity and wishes-lint invocations are DELIBERATE duplicates of legs `bun run check` chains —
they fail fast with a focused signal before the multi-minute gate.

**depends-on:** none

---

### Group 3: Honest reads — reconcile gate + single spawn (D4)

**Goal:** Reconcile writes happen only on reads whose output renders lanes; one git spawn per invocation.

**Deliverables:**
1. `handleBoard`: gate `reconcileWishLanes` on `opts.json && board?.lanes && board.lanes.length > 0`;
   resolve the repo root once and thread it to `openDb({ path })` and the reconcile
   (`reconcileWishLanes` takes the root as a parameter; no internal `resolveRepoRoot`).
2. Invert + retitle the final (unscoped-reconcile) stanza of the shipped test titled
   `does not reconcile a non-JSON human board read` in `v5-board.test.ts` (its first stanza —
   human render never reconciles — keeps passing under the new gate).
3. Seeded-divergence test: seed a lane divergence, run unscoped `--json`, assert stored lane
   untouched and no move event; scoped lane-board read still reconciles; non-JSON lane render
   still never reconciles.
4. PATH `git`-shim test in the spawn harness counting exactly one `git rev-parse` per
   `board --json` invocation.
5. Surface honesty: pi `genie_wish_status` description read-only, `genie_board` conditional;
   `native-surface.md` + `mutation-gates.md` updated; hermes `schemas.py` verified (no edit
   expected).

**Acceptance Criteria:**
- [ ] Unscoped `--json`: zero writes, proven by the seeded-divergence test.
- [ ] Scoped lane-board `--json`: reconcile unchanged (existing scoped tests pass).
- [ ] Spawn count = 1, proven by the shim test.
- [ ] Descriptions/docs match behavior.

**Validation:**
```bash
bun test src/term-commands/v5-board.test.ts && bun run check
```
Scope: gates a write path on the shared per-repo db consumed by pi/hermes/remotty probes — full
gate per the shared-runtime escalation rule; the board suite carries the new contract tests.

**depends-on:** 2

---

### Group 4: Lane-source rule documentation (D2)

**Goal:** The lane-source rule is written where agents and operators will find it.

**Deliverables:**
1. `src/lib/v5/TAXONOMY.md` section: lanes follow the primary checkout's working tree
   (checked-out branch, uncommitted edits included); linked worktrees inherit the primary
   checkout's view; consequence named (cockpit wishes read as merged truth until the branch
   lands); pointer to `resolveRepoRoot` (git-common-dir parent) as the mechanism.

**Acceptance Criteria:**
- [ ] The rule, the worktree consequence, and the mechanism pointer are all present in TAXONOMY.md.

**Validation:**
```bash
grep -q 'lane-source' src/lib/v5/TAXONOMY.md && grep -qi 'git-common-dir' src/lib/v5/TAXONOMY.md && grep -qi 'worktree' src/lib/v5/TAXONOMY.md
```
Scope: documentation-only group — content-contract greps covering all three AC elements (rule,
worktree consequence, mechanism pointer) are the narrowest checks that can disprove the
deliverable; no runtime surface is reached.

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: `genie task link <id> --wish w` on a real board appends one timeline entry
  visible in `task status`; repeating the identical link appends nothing.
- [ ] Integration: from a pi/hermes session start (unscoped board read), the `task_events` row
  count and every card's stored lane are unchanged (logical probes — file mtime is NOT a valid
  zero-write signal under WAL, where writes land in `-wal` and pure reads can move the main-db
  mtime via on-close checkpoint); a scoped `genie board --board roadmap --json` still moves a
  card whose WISH.md status diverged.
- [ ] Regression: SessionStart briefing lists the same active wishes before/after on the same
  repo state; `bun run check` green on dev.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| A consumer counts timeline events / `updated_at` bumps and notices no-op writes disappearing or real links now appending | Low | remotty review recorded LOW-1 as a defect; link's no-op stanza asserts the new behavior; grep remotty scanners for event-count assertions before landing |
| Known unscoped-read consumers (pi `before_agent_start`/`genie_wish_status`/`genie_review_context`, hermes `session_context.py`) lose the lane-freshening side effect | Medium | They are session-start context reads under 5s timeouts; freshness-on-next-scoped-read is the designed model (roadmap-truth ACs use the scoped probe); descriptions + docs updated in-scope; release note names the change |
| Shared-module extraction changes an edge-case parse | Medium | Boundary-mode + opt-in legacy + per-consumer filters preserve behavior; five-row corpus is the proof, covering every known divergence axis |
| `session-context.cjs` parity forgotten or type drift at the plugin call site (outside `tsc --noEmit` include) | Low | Regeneration in the same commit; `bun run check` enforces byte/mode parity; fixture corpus guards behavior; the shared module itself lives in typechecked `src/` |
| Execution targets dev while this planning branch is `wish/harness-audit-landing` | Low | Branch `wish/lane-sync-followups` from `dev`; planning artifacts merge independently of code |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Group 4 (lane-source-doc) execution review — SHIP after 1 fix loop (2026-08-10)

- **Engineer:** `lane-doc-eng` (engineer-trivial, worktree wish/lane-sync-followups); **Reviewer:** independent `genie:reviewer` subagent (g4-review)
- **Verdict:** FIX-FIRST round (1 MEDIUM: the section named plain `genie board` as the command reading WISH.md, but the reconcile is `opts.json`-gated at v5-board.ts:277; 1 LOW: trigger unstated) → both fixed → **SHIP**.
- **Evidence:** Verified the *Lane source* section (TAXONOMY.md, 30 added lines) against committed code: `readWishStatus` reads `<repoRoot>/.genie/wishes/<slug>/WISH.md` through the filesystem with every failure path returning null; `reconcileWishLanes` imports the same `resolveRepoRoot` (genie-db.ts:61-73) the database uses; the cited *Worktree sharing* cross-reference is accurate; MCP `genieBoard` (mcp-tools.ts) contains no reconcile call. Post-fix, the worktree sentence is command-free and the new trigger sentence ("runs only inside CLI `--json` board reads") is an upper bound that survives Wave-2's narrowing. Validation greps pass (`lane-source`, `git-common-dir`, `worktree`). One residual optional LOW recorded, not applied: "serve stored lanes" clause slightly implies MCP emits lanes (TaskSummary has no lane field).
- **Validation (orchestrator-run):** all three content-contract greps exit 0. Task `t_msnmry4999f70843` marked done.

### Group 1 (write-path) execution review — SHIP (2026-08-10)

- **Engineer:** `write-path-eng` (engineer-standard); **Reviewer:** independent `genie:reviewer` subagent (g1-review); one orchestrator-authorized scope extension (`src/term-commands/v5-task.test.ts` — the wish's Files list omitted the CLI-level link test whose no-event assertion the criterion necessarily inverts).
- **Verdict:** SHIP; 2 LOW fixed post-review (help-text parity on `task link`; dedicated `set-wish --clear` no-op regression test, verified to fail for the right reason by temporarily neutering the guard); 1 LOW recorded as follow-up, not fixed: the unified no-op check reads outside the `BEGIN IMMEDIATE` transaction, so two concurrent identical links can each append a wish event (duplicate audit history only, row state converges; window inherited from shipped `setTaskWish`).
- **Evidence (reviewer-verified):** `linkTaskToWish` is a one-line delegation to `setTaskWish` (trailing injectable `now`, full-no-op early return skipping row write and event, `.immediate()` matching every other writer); `handleLink` threads `resolveEventAuthor()` so link and set-wish emit byte-identical rows and events; exactly one production caller repo-wide; `UnknownTaskError` and group-drop-on-re-point semantics survive; CLI test assertions are CI-safe (`cliIdentity` strips inherited `GENIE_AGENT_*`; `GENIE_AGENT_KIND` outranks all runtime probes; engineer verified under stripped and hostile-ambient envs). Focused suites 160 pass / 0 fail / 641 expects; typecheck, biome, complexity budget clean. remotty grep: zero timeline/`updated_at` consumers — its only genie surface is the 8-field `@@CARD` from `board --json`. Task `t_msnmrxwj2de66cc1` done.

### Group 2 (wish-status) execution review — SHIP, hash-pinned (2026-08-10)

- **Engineer:** `wish-status-eng` (engineer-standard); **Reviewer:** independent `genie:reviewer` subagent (g2-review). Three review rounds with real churn: an initial FIX-FIRST (reviewer's old-vs-new differential against the shipped bundle caught a zero-width-cell regression the engineer's 500k fuzz structurally could not emit — padded-only generator), a reviewer adjudication recommending accept-and-document that the orchestrator briefly adopted (countermand raced the engineer's completed faithful fix, causing an implement→revert→restore cycle the reviewer's BLOCKED verdict correctly halted), and a final SHIP on the frozen restored implementation.
- **Final verdict:** SHIP, pinned to frozen hashes (bundle `eaf71f4c…` byte-identical to the reviewer's independently preserved verified artifact; all six file hashes re-verified by the orchestrator before commit).
- **Evidence (reviewer's final block):** the shipped implementation captures the RAW inter-pipe/post-colon span with the historical `\s*` runs inside the capture group — stripping capture parens yields character-identical matching expressions, so only group boundaries moved — handing the untrimmed span to consumer-supplied accept predicates language-equivalent to the historical inline charsets (what keeps `||` and `|   |` distinguishable). The private scan resumes at match.index+1, load-bearing (3 of 6 probes regress under match-end resumption), no cost (256KB pathological input in 1–2ms). Zero divergences everywhere: 33-probe differential, reviewer's independent 500k adversarial fuzz (`lost=0 invented=0 changed=0`), engineer's corrected-generator 500k + 300k `\r` fuzz, 125-doc and 81-doc real-corpus sweeps; board byte-for-byte unchanged; the engineer's originally disclosed `\r` residual class is CLOSED — the module's contract is full parity with all three pre-consolidation parsers, pinned by a 29-probe corpus captured from the old shipped code. Gates: 102 pass / 0 fail / 294 expects, parity OK bytes+mode, cjs 755, typecheck/dead-code/biome/wishes-lint clean. The reviewer withdrew one mid-run harness artifact (apparent invented statuses — measured across a concurrent edit) and formally accepted the engineer's corrected rationale over its own disproven legacy-continuation counterexample.
- **Process note (accountability):** the mid-group churn was orchestrator-caused — a countermand raced completed work; recorded as a lesson (consolidated end-state instructions on idle only). Both engineer iterations were faithful to instruction.
- **Wave-1 full gate (orchestrator-run):** `bun run check` on the combined G1+G2+G4 tree — 3159 pass / 14 fail, and the 14 are name-for-name a subset of pristine dev's 16 pre-existing darwin failures (dev's 2 extras are scratchpad-ACL mode artifacts); zero new failures. Task `t_msnmrxz3cf89fe61` done.

### Group 3 (reconcile-gate) execution review — SHIP (2026-08-10)

- **Engineer:** `reconcile-eng` (engineer-standard); **Reviewer:** independent `genie:reviewer` subagent (the G2 reviewer, reused deliberately for the G2/G3 boundary check; reviewer ≠ engineer holds).
- **Verdict:** SHIP; 1 pre-existing LOW recorded as follow-up (pi `genie_board` declares `mutation: "none"` while its `board` param makes it reconcile-capable — predates G3); 2 nits (shim git-path quoting; a cosmetic test-slug rename the brief missed).
- **Evidence (reviewer-verified):** the gate is exact in source — reconcile fires iff `--json` on a scoped lane-defining board; the laneless `--json` path renders raw statuses with no lanes, so the removed unscoped reconcile had zero output effect and was a pure hidden write (hermes `session_context.py` triggered it every session start while claiming to write nothing — G3 makes that contract true). Signature narrowing + `listBoards` fallback removal sound and complete (single caller; fallback unreachable under the gate). Root threading preserves the worktree-shared-db invariant (`resolveRepoRoot` = git-common-dir parent ⇒ inlined path ≡ `resolveDbPath()`), halving git spawns 2→1, pinned by a CI-safe PATH-shim test that logs before delegating and asserts the reconciled end state. The shipped test inversion is in-diff proof (`toBe('Done')` → `toBe('Idea')`); seeded-divergence pins exactly one `wish-status-sync` move event; engineer provided watch-it-fail evidence for both new tests. G2 region byte-untouched (five G2 hashes still verify; `readWishStatus` byte-for-byte as shipped). Board suite 39/0, board+pi 54/0, typecheck/biome/complexity clean.
- **Aggregate full gate (orchestrator-run, complete tree):** 3161 pass / 14 fail — failure parity held name-for-name against the pre-existing darwin set (itself a subset of pristine dev's). Zero new failures across the wish. Task `t_msnmry1o4568eb4a` done.

### Plan review — SHIP (2026-08-10T19:42:48Z)

- **Reviewer:** `genie:reviewer` (independent plan-review subagent, Claude Opus 5 1M; session `1ba65588-ea67-48d8-9c03-11d88bcca6eb` — same reviewer identity stamped in the design's SHIP evidence)
- **Verdict:** SHIP after 1 fix loop (FIX-FIRST round: 2 MEDIUM + 4 LOW, all resolved and re-verified)
- **Evidence:** Plan review of WISH.md against DESIGN.md (digest `94a157aa…`, recomputed unchanged and stamped SHIP with matching reviewer and timestamp) returned FIX-FIRST with two MEDIUM and four LOW gaps; after one fix loop all six are resolved. Faithfulness is complete: both design-review notes are carried as requirements (L10's path-based `(path, budget) => string | null` read contract with per-consumer discovery — v5-board's `physicalDirectory`-guarded join versus session-context's `opendirSync` plus lowercase `wish.md` fallback — and L11's legacy `**Status:**` opt-in with the fifth fixture row), as is the third test edit, with no unbacked additions and nothing dropped. Group decomposition is sound: G2 ∩ G3 = `v5-board.ts` with wave-2 serialization of G3 correct, G1/G2/G4 disjoint, G2's full gate does not trip on G3's not-yet-inverted stanza, and the all-`ready` DB task state is the documented doc-only-DAG contract. Complexity scored consistently (G1 = 2, G2 = 2, G3 = 3, G4 = 0), routing correct in every row. Validation right-sized per the skill's escalation rule; both `src/term-commands/v5-task.test.ts` and `wishes:lint` confirmed present on dev so every command runs; Group 4's three content-contract greps cover all three AC elements; Group 2's duplicate legs marked deliberate. The two MEDIUM findings were fixed at the root: the QA `genie.db` mtime clause was replaced by logical probes after the reviewer empirically confirmed WAL makes mtime invalid in both error directions, and the G2/G3 modifier-scoring inconsistency was unified under one stated reading. The remotty-scanner pre-landing grep has an owning deliverable and AC. `wishes-lint` passes; no `<TODO:` markers; all four group tasks exist with expected slugs/groups. Non-blocking observation recorded: G1 deliverable 5's `../remotty` path is relative — an engineer in a launch worktree records a not-found result and moves on.

---

## Files to Create/Modify

```
src/lib/wish-status.ts                          (new)
src/lib/wish-status.test.ts                     (new)
src/lib/v5/task-state.ts                        (modify — dev copy)
src/lib/v5/task-state.test.ts                   (modify — three named edits)
src/lib/v5/TAXONOMY.md                          (modify)
src/term-commands/v5-task.ts                    (modify — handleLink author)
src/term-commands/v5-board.ts                   (modify — gate, threading, imports)
src/term-commands/v5-board.test.ts              (modify — inverted stanza, new tests)
plugins/genie/scripts/src/session-context.ts    (modify)
plugins/genie/scripts/session-context.cjs       (regenerated)
plugins/pi-genie/extension.ts                   (modify — descriptions)
plugins/pi-genie/references/native-surface.md   (modify)
plugins/hermes-genie/references/mutation-gates.md (modify)
scripts/wishes-lint.ts                          (modify — derive slug pattern)
```
