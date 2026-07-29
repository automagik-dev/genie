# Wish: Roadmap single-source — CLI-only board, INDEX retired

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `roadmap-single-source` |
| **Date** | 2026-07-29 |
| **Author** | Felipe + orchestrator (Fable 5) |
| **Appetite** | medium |
| **Branch** | `wish/roadmap-single-source` |
| **Repos touched** | automagik-dev/genie only |
| **Design** | [DESIGN.md](../../brainstorms/roadmap-single-source/DESIGN.md) |

## Summary

End the INDEX.md↔roadmap-board duplication by going CLI-only: delete `.genie/INDEX.md` and its `genie init` write path, retire the `jar: index-lane drift` lint in favor of four warn-only referential/contract checks, seed the `roadmap` board in every `genie init`, add `genie board --shipped` generated from the archive dir, and reconcile skills + contract docs to "genie.db single source, roadmap.json save-state". Design SHIP after 1 fix loop (digest `a891526b…`); all five direction decisions Felipe-ratified.

## Scope

### IN

- `src/term-commands/init.ts`: remove `INDEX_SKELETON`, `scaffoldIndex`, `InitResult.index`, the report line, and the docblock mention; add idempotent roadmap-board seeding via `createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES)` (acknowledged contract change: init now creates `.genie/genie.db`; docblock updated).
- `src/genie-commands/doctor.ts`: remove `evaluateIndexLaneDrift`, its registration, and the `indexLane` payload rider; add warn-only checks `roadmap-board-missing`, `dangling-slug`, `orphan-doc`, `legacy-index-present` (none can flip `ok:false`); fixtures in `doctor.test.ts` replaced accordingly.
- `src/term-commands/v5-board.ts`: `genie board --shipped` — on-demand listing of `.genie/wishes/archive/` (slug + archived WISH path; date from the WISH.md `**Date**` header when parseable, else omitted).
- Gates asserting the old contract: `tests/e2e/v5-lifecycle.sh` (INDEX assertions → board assertions), `src/term-commands/init.test.ts` (10 INDEX assertions incl. idempotency), `scripts/release-docs.test.ts` (:941-943, all three brainstorm-contract assertions — deliberate contract edit).
- Skills (verified census): `skills/brainstorm/SKILL.md` (11 refs — Index section + legacy-jar migration rewritten to board-card flow), `skills/genie/reference/lifecycle.md:73`, `skills/repo-hygiene/SKILL.md:24` (INDEX-tracked contract → board contract); vocabulary sweep in `skills/review/SKILL.md:131`; semantic rule replacement in `skills/dream/SKILL.md:27` (board-based skip/report rule — see G2 deliverable 3). Plugin mirrors regenerated; `scripts/sync-plugin-skills.ts --check` green.
- Contract docs reconciled to Decision 1: `src/lib/v5/roadmap-sync.ts:2` docblock, `CLAUDE.md` (:70, :123, :185 gotcha bullet), `src/lib/v5/TAXONOMY.md` (:26, :101), `.genie/repo-profile.md:30`, `scripts/backfill-roadmap-wish.ts:5-6` comment.
- Delete `.genie/INDEX.md` (last step; nothing redistributed first — caveats live in wish docs, umbrellas in brainstorm dirs, work order = lane order, shipped = archive dir).

### OUT

- The outward/public browsing surface (`public-roadmap-polish` owns it; becomes the only non-CLI surface).
- Any generated markdown roadmap view in git (deferred behind the design's measured trigger).
- Board schema changes; Done-lane backfill of shipped cards.
- Auto-migration or deletion of legacy INDEX.md in other repos (ignore + doctor warn only).
- Fixing the pre-existing `bun test` failures (**18** on the current tree, measured 2026-07-29: release-asset reconciliation ×3, local-delivery boundaries ×3, updateCommand ×4, Codex fallback ownership ×3, stamp parity ×1, role-agent allowlist ×1, dogfood entry ×1, task-CWD MCP proof ×1, launch cleanup ×1 — several network/timing-shaped).
- `docs/skills/brainstorm.mdx` (public docs submodule; already stale pre-wish — names `.genie/brainstorm.md`. Follows its own PR flow; flagged as a follow-up for public-roadmap-polish).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Inherit DESIGN D1–D8 unchanged (CLI-only, db single source, archive-as-record, init-seeds/doctor-warns, ignore+warn legacy, referential checks, no stub page, init-seed over lazy-seed) | Felipe-ratified; design review SHIP after 1 fix loop, all 11 gaps repaired and re-verified |
| 2 | Three groups: src engine ∥ skills/prompt surfaces → docs + deletion last | INDEX deletion breaks the drift lint and init gates unless they change first; skills and src are file-disjoint and parallelize |
| 3 | Full-suite validation uses a failing-set delta vs the recorded pre-existing baseline; **the ORCHESTRATOR captures the baseline from the clean tree BEFORE dispatching Wave 1** (not any group, never after mutation) | 18 unrelated failures exist pre-wish; a raw exit-0 gate is unsatisfiable, a skipped gate hides regressions, and a G3-time capture would fold G1/G2 regressions into the baseline |
| 4 | Both e2e invocations run with `V5_E2E_BUILD=1` | The script reuses a stale gitignored `dist/genie.js` otherwise — G1's rewritten assertions would test a pre-change bundle |
| 5 | `orphan-doc` excludes brainstorm dirs whose slug matches an archived wish dir | Shipped wishes legitimately leave their brainstorm dir live (8 such today; no `.genie/brainstorms/archive/` exists); without the exclusion the check warns forever and means nothing |
| 6 | Validation scripts assume plain bash without `set -e`; every gate's pass/fail is an explicit exit | Agent harnesses vary; implicit-abort semantics made loop-0's G3 gate silently vacuous |

## Simplicity Case

- **Simplest complete design:** delete one file + its write path, delete one lint, update three gates, add four warn-only checks, one read-only listing, one init seed, skill/doc reconciliation. No new stores, no new sync directions, no schema changes.
- **Added machinery:** one durable item — init creates `.genie/genie.db` (board seed), per ratified D4/D8 (fresh clone's `genie board` renders immediately; lazy-seed explicitly rejected).
- **Deferred until measured:** generated in-git roadmap view (trigger: GitHub-blind browsing demonstrably hurting before public-roadmap-polish ships).
- **Complexity removed:** drift lint + section↔lane mapping + `indexLane` rider, init's INDEX scaffold, brainstorm skill's INDEX write path, hand-maintained Shipped section.

## Dependencies

**depends-on:** none
**blocks:** none

(public-roadmap-polish is downstream; declare the edge there when its wish is poured.)

## Success Criteria

- [ ] `.genie/INDEX.md` absent; `bash tests/e2e/v5-lifecycle.sh` passes with board assertions replacing INDEX assertions
- [ ] `genie doctor --json` output contains neither the `jar: index-lane drift` check nor any `indexLane` key; contains all four new checks as warning-level, fixture-backed, none flipping `ok:false`
- [ ] `genie init` in a fresh tmp repo seeds the `roadmap` board (6 lanes, 0 cards); second run is a no-op; `--json` has no `index` field
- [ ] `genie board --shipped` rows = exactly the set of dirs under `.genie/wishes/archive/`; dates present for all 29 current entries (all have parseable `**Date**` headers)
- [ ] `grep -rn "INDEX.md" skills/ src/ scripts/ tests/ CLAUDE.md .genie/repo-profile.md .genie/release-readiness-5x.md` → every hit carries legacy wording on the same line (`legacy-index-present` check impl/tests included — implementation MUST name its paths on lines containing "legacy"); zero write paths
- [ ] Duplication audit: `grep -rlE '^## (Raw|Simmering|Ready|Poured)$' .genie/ --include='*.md'` → empty; `ls .genie/*.md | xargs -r grep -ln 'wishes/archive/'` → empty
- [ ] Non-test `check` legs green: `bun run typecheck && bun run lint && bun run dead-code && bun run skills:lint && bun run wishes:lint && bun run lint:complexity-budget && bun run lint:council-workflow && bun run lint:hook-bundles && bun run lint:hook-content && bun run lint:plugin-executables` (knip/complexity exposure from doctor/init edits is in-scope to fix)
- [ ] `bun test` failing set ⊆ `qa/pretest-baseline.txt` (orchestrator-captured pre-Wave-1); zero new failures
- [ ] `scripts/sync-plugin-skills.ts --check` green (mirrors byte-identical)
- [ ] `genie doctor --json` orphan-doc entries exclude archived-wish brainstorm dirs; day-one count recorded in qa evidence with each entry dispositioned (real orphan vs expected)

## Execution Strategy

### Wave 1 (parallel)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 3 — stateful init db seed (+2), CI/e2e gate work (+1) | engineer-standard / high | src engine: init rewrite, doctor check swap, board --shipped, gate/test updates |
| 2 | engineer | 2 — prompt-skill change (+1), multi-package mirrors (+1) | engineer-standard / medium | skills + release-docs contract + plugin mirrors |

### Wave 2 (after G1 AND G2)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | 3 — subjective doc reconciliation (+2), no deterministic test for prose (+1) | engineer-standard / medium | contract docs, INDEX deletion, final gates |

**Baseline capture (orchestrator, BEFORE Wave 1):** from the clean pre-change tree, `mkdir -p .genie/wishes/roadmap-single-source/qa && bun test 2>&1 | grep -E '^\(fail\)' | sed 's/\[[0-9.]*m\?s\]//' | sort > .genie/wishes/roadmap-single-source/qa/pretest-baseline.txt` — expected ≈18 lines matching the OUT-scope enumeration.

**Commit discipline:** single commit in G3. Note the pre-commit hook's actual behavior: a red-CI block (`gh run list` on ci.yml; escape `SKIP_CI_CHECK=1` if upstream CI is red for unrelated reasons — record the reason), `task sync` + `git add .genie/roadmap.json`, and `bunx biome check --staged`. It does NOT run the check legs — G3's validation runs them explicitly. G1/G2 leave changes in the working tree.

## Execution Groups

### Group 1: src engine — init, doctor, board --shipped, gates

**Goal:** Retire INDEX's write path and lint, add the new contract checks and shipped listing, and flip the repo gates to the board contract.

**Deliverables:**
1. `init.ts`: remove the five INDEX elements (docblock :5, `INDEX_SKELETON` :64, `scaffoldIndex` :102-107, report line :158, `InitResult.index`); add idempotent `roadmap` board seed — `getBoardByName` guard first (`createBoard` throws `DuplicateBoardError`; the guard pattern exists at `src/term-commands/idea.ts:37`), then `createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES)`; docblock updated to the new contract.
2. `doctor.ts`: delete `evaluateIndexLaneDrift` (:1713), its call site (:1979), registration (:1774), and `indexLane` payload field (:151-155); add `roadmap-board-missing`, `dangling-slug`, `orphan-doc` (spec: live wish dir with no card, or brainstorm dir with no card whose slug does NOT match a dir under `.genie/wishes/archive/` — Decision 5), `legacy-index-present` — all warn-only; every INDEX.md path reference in check impl and tests carries "legacy" on the same line (SC5 contract).
3. `v5-board.ts`: `--shipped` flag rendering `.genie/wishes/archive/` (slug, path, parsed date).
4. Tests: `init.test.ts` rewritten to board-seed assertions (incl. second-run no-op); `doctor.test.ts` drift fixtures → fixtures for the four new checks; `tests/e2e/v5-lifecycle.sh` :124/:139/:145 → assert board exists post-init, stage `.gitignore` only.

**Acceptance Criteria:**
- [ ] Targeted tests green; e2e green
- [ ] Fresh tmp-repo init seeds the board; second init no-op; `init --json` has no `index` field
- [ ] `doctor --json` on this repo: no `indexLane` anywhere; four new check names present (legacy-index-present may WARN while INDEX still exists — expected until G3)

**Validation** (plain bash, no `set -e`; exit is explicit):
```bash
R=$(pwd) && bun test src/term-commands/init.test.ts src/genie-commands/doctor.test.ts && V5_E2E_BUILD=1 bash tests/e2e/v5-lifecycle.sh && T=$(mktemp -d) && git -C "$T" init -q && (cd "$T" && bun "$R/src/genie.ts" init && bun "$R/src/genie.ts" task export > "$T/seed1.json" && bun "$R/src/genie.ts" init && bun "$R/src/genie.ts" task export > "$T/seed2.json" && bun -e 'const fs=require("node:fs");const T=process.argv[1];const a=JSON.parse(fs.readFileSync(`${T}/seed1.json`,"utf8")),b=JSON.parse(fs.readFileSync(`${T}/seed2.json`,"utf8"));const bd=a.boards.find(x=>x.name==="roadmap");if(!bd)process.exit(1);if(JSON.parse(bd.lanes).length!==6)process.exit(1);const bd2=b.boards.find(x=>x.name==="roadmap");if(!bd2||bd2.lanes!==bd.lanes)process.exit(1);if(a.tasks.length!==0||b.tasks.length!==0)process.exit(1);if(a.boards.length!==1||b.boards.length!==1)process.exit(1)' "$T" && bun "$R/src/genie.ts" init --json | bun -e 'const j=JSON.parse(await Bun.stdin.text());process.exit("index" in j?1:0)') && bun src/genie.ts doctor --json 2>/dev/null | bun -e 'const s=await Bun.stdin.text();if(s.includes("indexLane"))process.exit(1);for(const n of["roadmap-board-missing","dangling-slug","orphan-doc","legacy-index-present"])if(!s.includes(n))process.exit(1)'
```
(Doctor's top-level `ok` is NOT asserted — environmental Codex MCP failure pre-exists on this host; the gate asserts check-name presence/absence only. The tmp-repo leg proves: board seeded with export parity across two runs = second-run no-op, 0 tasks, exactly 1 board, no `index` JSON field.)

**depends-on:** none

---

### Group 2: skills, release-docs contract, plugin mirrors

**Goal:** Skills stop reading/writing INDEX anywhere; the brainstorm flow becomes board-card native; mirrors stay byte-identical.

**Deliverables:**
1. `skills/brainstorm/SKILL.md`: rewrite the Index section and legacy-jar migration to the board-card flow (create card in Idea/Brainstorm lane; lifecycle transitions move the card; prose to DRAFT/WISH/card comments; ignore existing INDEX files, never write them). All 11 INDEX refs resolved.
2. `skills/genie/reference/lifecycle.md:73` and `skills/repo-hygiene/SKILL.md:24` updated to the board contract (repo-hygiene: `.genie/` contract = `wishes/`, `brainstorms/`, `roadmap.json` tracked; INDEX.md listed as legacy).
3. Vocabulary sweep in `skills/review/SKILL.md:131` ("brainstorm jar"); **semantic rule replacement** in `skills/dream/SKILL.md:27` — "a Poured entry without an existing approved WISH.md is skipped and reported as drift" loses its referent, so the rule becomes board-based: a card in Wish/Work/Review lane whose slug has no APPROVED WISH.md on disk is skipped and reported (behavior change, not a word swap).
4. `scripts/release-docs.test.ts` :941-**943** updated to the new brainstorm skill contract text — all THREE assertions, including :943 'Legacy migration is idempotent' which binds the rewritten legacy-jar paragraph (deliberate contract edit).
5. Plugin mirrors regenerated (`scripts/sync-plugin-skills.ts`).

**Acceptance Criteria:**
- [ ] `grep -rn "INDEX.md" skills/` → only legacy-tolerance wording, zero write paths
- [ ] `release-docs.test.ts` green; `skills:lint` green; mirror parity green

**Validation:**
```bash
bun test scripts/release-docs.test.ts && bun run skills:lint && bun scripts/sync-plugin-skills.ts --check && [ -z "$(grep -rn 'INDEX.md' skills/ | grep -vi legacy)" ]
```

**depends-on:** none

---

### Group 3: contract docs, INDEX deletion, final gates

**Goal:** Reconcile every remaining document to the board contract, delete INDEX.md, prove the duplication is gone tree-wide.

**Deliverables:**
1. Doc reconciliation: `roadmap-sync.ts:2` docblock (save-state framing), `CLAUDE.md` :70/:123 state-table rows + :185 gotcha bullet rewritten for the new doctor checks + :79 board-flags row gains `--shipped`, `TAXONOMY.md` :26/:101, `.genie/repo-profile.md:30`, `.genie/release-readiness-5x.md:46` (init ritual line → board contract), `backfill-roadmap-wish.ts:5-6` comment.
2. `git rm .genie/INDEX.md`.
3. Run full gates with the failing-set delta vs the orchestrator-captured `qa/pretest-baseline.txt` (pre-Wave-1; ≈18 lines). If the file is absent, that is an orchestration failure — STOP and report blocked; never capture it from the mutated tree.
4. Single commit (pre-commit sync exports the board; `SKIP_CI_CHECK=1` only with recorded reason; verify `task sync` in-sync post-commit).

**Acceptance Criteria:**
- [ ] Both duplication-audit greps empty; INDEX absent
- [ ] `grep -rn "INDEX.md" src/ scripts/ tests/ CLAUDE.md .genie/repo-profile.md .genie/release-readiness-5x.md | grep -vi legacy` → empty
- [ ] Non-test check legs green (SC list); `bun test` delta vs baseline = zero new failures; e2e green with fresh build; `doctor --json`: `legacy-index-present` passes (no INDEX); orphan-doc entries dispositioned in qa evidence

**Validation** (plain bash, no `set -e`; run as a script so every exit is explicit):
```bash
set -u
fail(){ echo "GATE FAIL: $1" >&2; exit 1; }
[ -f .genie/wishes/roadmap-single-source/qa/pretest-baseline.txt ] || fail baseline-missing
[ ! -f .genie/INDEX.md ] || fail index-still-present
[ -z "$(grep -rlE '^## (Raw|Simmering|Ready|Poured)$' .genie/ --include='*.md')" ] || fail lifecycle-headings-remain
[ -z "$(ls .genie/*.md 2>/dev/null | xargs -r grep -ln 'wishes/archive/')" ] || fail toplevel-archive-enum
[ -z "$(grep -rn 'INDEX.md' src/ scripts/ tests/ CLAUDE.md .genie/repo-profile.md .genie/release-readiness-5x.md | grep -vi legacy)" ] || fail index-refs-remain
bun run typecheck && bun run lint && bun run dead-code && bun run skills:lint && bun run wishes:lint && bun run lint:complexity-budget && bun run lint:council-workflow && bun run lint:hook-bundles && bun run lint:hook-content && bun run lint:plugin-executables || fail check-legs
V5_E2E_BUILD=1 bash tests/e2e/v5-lifecycle.sh || fail e2e
W=$(mktemp -d)
bun test > "$W/test.log" 2>&1
grep -qE '^# Unhandled error between tests|^ *[1-9][0-9]* error' "$W/test.log" && fail test-runner-errors
grep -qE '^Ran [0-9]+ tests across [0-9]+ files' "$W/test.log" || fail test-run-incomplete
grep -E '^\(fail\)' "$W/test.log" | sed 's/\[[0-9.]*m\?s\]//' | sort > "$W/fails.txt"
comm -23 "$W/fails.txt" <(sed 's/\[[0-9.]*m\?s\]//' .genie/wishes/roadmap-single-source/qa/pretest-baseline.txt | sort) > "$W/new.txt"
[ -s "$W/new.txt" ] && { cat "$W/new.txt" >&2; fail new-test-failures; }
echo GATE PASS
```

**depends-on:** group-1, group-2

---

## QA Criteria

- [ ] Fresh repo ritual: `git init` + `genie init` → `genie board --board roadmap` renders 6 empty lanes; `genie doctor` shows no roadmap warning
- [ ] A repo WITHOUT `genie init` → `genie doctor` warns `roadmap-board-missing` without flipping ok
- [ ] `genie board` + `genie board --shipped` together read as the complete roadmap of record (Felipe eyeball)
- [ ] Brainstorm skill dry-run in a scratch repo creates a card, touches no INDEX

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Repo gates encode the INDEX contract (e2e, init tests, release-docs test ×3 assertions) | Medium | All enumerated as G1/G2 deliverables; G3 runs check legs + delta + e2e before commit |
| Stale `dist/genie.js` makes e2e test a pre-change bundle | Medium | `V5_E2E_BUILD=1` on every e2e invocation (Decision 4) |
| Pre-existing test failures mask new ones | Medium | Orchestrator-owned pre-Wave-1 baseline (Decision 3); G3 STOPS if baseline absent; zero-new-failures delta |
| `orphan-doc` noise makes the check meaningless | Medium | Archived-wish exclusion (Decision 5); day-one entries dispositioned in qa evidence |
| knip/typecheck/complexity exposure from doctor/init surgery | Medium | Non-test check legs run explicitly in G3 validation; fixes in-scope |
| Skill mirrors drift | Low | `sync-plugin-skills --check` in G2 validation |
| Doctor check-name collisions or payload shape drift for MCP/board consumers | Low | Names are new; `indexLane` removal is a breaking JSON change called out in CLAUDE.md :185 rewrite |
| Pre-commit red-CI block stalls the single G3 commit | Low | `SKIP_CI_CHECK=1` escape with recorded reason |
| This wish's own INDEX entry and drift-lint bookkeeping vanish mid-wish | Low | Expected: the file is deleted in G3; the board card is the surviving tracker |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — loop 0 → FIX-FIRST (2026-07-29T03:35:48Z, reviewer-subagent-opus)

2 HIGH + 5 MEDIUM + 5 LOW, both HIGHs proven by execution. H1: G3's validation `;` detached the delta check — gate exits 0 even when every assertion fails (simulated both failure modes). H2: pretest baseline ownerless, captured post-mutation, and factually wrong (real pre-existing set = **18** failures — release-asset reconciliation, delivery boundaries, updateCommand, fallback ownership, stamp parity, role-agent allowlist, dogfood entry/MCP proof, launch cleanup — NOT codex-delivery/digest-parity, which pass 48/0). M3: both e2e gates run stale `dist/genie.js` (rebuild only if absent or `V5_E2E_BUILD=1`). M4: `bun run check` named by two criteria, executed by none (typecheck/lint/knip/complexity never run; pre-commit doesn't run them either). M5: release-docs gate is three assertions (:941-943, incl. 'Legacy migration is idempotent'). M6: `orphan-doc` ships warning 12 on day one (8 = shipped wishes' live brainstorm dirs) with no bounding criterion. M7: `.genie/release-readiness-5x.md:46` asserts the deleted init contract; CLAUDE.md:79 board-flags row misses `--shipped`; docs/skills/brainstorm.mdx pre-existing stale. L8: doctor-gate tail is a proven no-op. L9: G1 shell gate under-checks SC3. L10: chains assume non-`set -e` bash. L11: `grep -vi legacy` constrains implementation naming. L12: dream:27 is behavior, not vocabulary. Verified sound: design fidelity (all 9 IN items + 6 criteria mapped), G1/G2 file-disjointness, mirror scope, tmp-repo init chain works standalone, duplication greps proven top-level-safe post-deletion, all 29 archive dates parseable, `createBoard` needs a `getBoardByName` guard (DuplicateBoardError).

### Plan review — loop 1 → FIX-FIRST (2026-07-29T03:43:00Z, reviewer-subagent-opus)

Both loop-0 HIGHs re-proven closed by executing the repaired G3 script (4 failure modes all exit 1). One NEW MEDIUM: `grep '^\(fail\)'` extraction is blind to whole-file load failures — reproduced with a broken import (`1 error`, zero `(fail)` lines → GATE PASS). 4 LOW: parity leg didn't prove 6 lanes (`lanes` is a JSON string in export), baseline capture fails on missing `qa/` dir, stale loop-0 text in Scope IN/Files, fixed `/tmp` paths collide across worktrees. M6 effect measured: Decision 5 drops day-one orphan-doc from 12 to 4 real entries (0 orphan wish dirs).

### Plan review — loop 2 → SHIP (2026-07-29T03:46:03Z, reviewer-subagent-opus)

All 5 loop-1 gaps verified closed by execution: broken-import repro now → `GATE FAIL: test-runner-errors`; truncated run → `test-run-incomplete` (bonus close for killed runners); guards proven false-positive-free against the real 2950-test/18-fail run; parity snippet exercised on 4 synthetic export shapes (lane-count, mutation, task-leak all exit 1); argv plumbing verified; mkdir + mktemp fixes in place; no stale text contradicts a deliverable. Carried-forward verifications all re-confirmed (design fidelity 9/9 + 6/6, group disjointness, standalone init chain, grep top-level safety, 29/29 dates, e2e build flag, sed idempotency). Non-blocking orchestrator note: capture the baseline on THIS host immediately before Wave 1 — the 18-fail set includes network/timing-shaped suites and does not transfer across hosts/commits.

**Orchestrator persisted:** status → APPROVED (2026-07-29). Ready for `work` on Felipe's go.

---

## Files to Create/Modify

```
src/term-commands/init.ts                     (INDEX write path out; board seed in)
src/term-commands/init.test.ts                (board-seed assertions)
src/term-commands/v5-board.ts                 (--shipped)
src/genie-commands/doctor.ts                  (drift lint out; 4 warn checks in)
src/genie-commands/doctor.test.ts             (fixtures swapped)
tests/e2e/v5-lifecycle.sh                     (board assertions)
skills/brainstorm/SKILL.md                    (board-card flow)
skills/genie/reference/lifecycle.md           (board contract)
skills/repo-hygiene/SKILL.md                  (board contract)
skills/review/SKILL.md (vocabulary), skills/dream/SKILL.md (semantic rule)
plugins/genie/skills/**                       (regenerated mirrors)
scripts/release-docs.test.ts                  (contract edit)
scripts/backfill-roadmap-wish.ts              (comment)
src/lib/v5/roadmap-sync.ts                    (docblock)
src/lib/v5/TAXONOMY.md, CLAUDE.md, .genie/repo-profile.md, .genie/release-readiness-5x.md  (reconciliation)
.genie/INDEX.md                               (DELETED)
.genie/wishes/roadmap-single-source/qa/pretest-baseline.txt (new, evidence)
```
