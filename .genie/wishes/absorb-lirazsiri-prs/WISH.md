# Wish: Absorb lirazsiri PR goodies, close #2737/#2738 with credit

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `absorb-lirazsiri-prs` |
| **Date** | 2026-08-07 |
| **Author** | Felipe + genie orchestrator (session 228b9f91) |
| **Appetite** | small |
| **Branch** | `wish/absorb-lirazsiri-prs` |
| **Repos touched** | automagik-dev/genie |
| **Design** | [DESIGN.md](../../brainstorms/absorb-lirazsiri-prs/DESIGN.md) |

## Summary

Close community PRs #2737 (db-sync — review BLOCKED 2026-08-07: premise conflicts with the canonical roadmap.json/`task sync` channel) and #2738 (fix-loop budgets — sound but stale-based) with respectful credit-bearing notes, and absorb the approved portions as small focused commits: the re-authored fix-loop budget (A1), the `hireAgent` race fix (B1), a verify-only pass on the already-landed determinism fix (B2), and the umask test-fixture hardening (B3).

## Scope

### IN

- **A1** — Re-author #2738: fix-loop budget `B` resolved once per group (default 2; only an explicit higher-priority user/workspace instruction may set another positive integer; overrides never expand scope, permit unchanged retries, or skip diagnosis/independent re-review) in every file that states a fix-loop budget — `skills/{fix,review,work,pm,dream}/SKILL.md` plus `skills/genie/reference/lifecycle.md` (line 57: "escalate after 2 failed loops") — and their `plugins/genie/skills/` mirrors; update `scripts/release-docs.test.ts` wording assertions (line 974 asserts `'up to 2 loops'` today). The `.kimi-plugin` command `description:` frontmatter lines stay unchanged (deliberate: no lint mirrors them; default stays 2).
- **B1** — Fix the `hireAgent` race (`src/lib/v5/task-state.ts`, function `hireAgent`; main: line 1312): eliminate the post-write `getHire(...) as HireRosterRow` non-null cast (read inside the write transaction or construct the return row); add a concurrency regression test.
- **B2** — Verify the `selection: 'all'` determinism fix (issue #2732) in `src/genie-commands/__tests__/update.test.ts` against current main (pre-checked 2026-08-07: present at lines 2617, 3014, 3043 — probably a no-op; report "already-fixed" if confirmed).
- **B3** — Port the umask-hardening of test fixtures from #2737 (explicit modes as in #2737 — `0o755` dirs / `0o644` files, `0o700` for the isolated-home dirs in `local-delivery-repair.test.ts`, chmod helper for frozen-skill copies) as one test-infra commit, dropping hunks already landed on main.
- **Close notes** — Draft two close comments crediting @lirazsiri by item; Felipe approves the text before anything is posted; then post and close both PRs.

### OUT

- Merging or rebasing either PR branch itself.
- Any DB-to-DB sync mechanism: snapshot store, libc FFI locking, roster tombstones, schema fingerprinting, WAL bootstrap, the `db sync` command (rejected by PR review).
- The `codex-dogfood-harness` `ownsRoot` mkdir change (declined — shared-test-infra behavior change motivated only by the rejected feature).
- Sandbox guest hand-back docs (dropped by Felipe 2026-08-07).
- `task sync` diverged-state conflict reporting (deferred; trigger: recurring operator pain resolving `diverged` warnings).
- `plugins/genie/references/review-criteria.md:75-78` max-3/max-2 fix-loop drift — pre-existing, already owned by the `genie-token-efficiency-program` and `control-plane-contract` brainstorms; do not touch it here.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Close both PRs; absorb approved portions (Felipe, 2026-08-07) | #2737 is BLOCKED on premise, not fixable in place; consistent disposition for both PRs |
| 2 | A1 re-authored, not cherry-picked | Both branches stale (main +104 commits; skills drifted since 2026-07-30); mirrors are hand-mirrored byte-identical git-tracked copies (no generator) |
| 3 | B1 fixed transactionally (or constructed row) + regression test | Removes the unsound non-null cast; the test permanently owns the scenario |
| 4 | B2/B3 carry `Co-authored-by: lirazsiri` where hunks are ported near-verbatim | Accurate, cheap credit; A1/B1 credit him in prose (re-authored) |
| 5 | Close notes posted only after Felipe approves text | Outward-facing communication to a valued contributor (3 merged PRs) |

## Simplicity Case

- **Simplest complete design:** four focused commits (one per absorption, B2 possibly a no-op report) plus two human-approved close comments. No new mechanisms, durable state, or configuration.
- **Added machinery:** none. A1 is instruction-layer prose (explicitly user-approved); B1 is a bug fix; B2/B3 are test-only.
- **Deferred until measured:** diverged-state reporting for `task sync` — trigger: recurring manual-resolution pain on `diverged` warnings.
- **Complexity removed:** the entire ~13.7k-line #2737 apparatus, rejected rather than kept dormant.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] Both PRs closed with posted notes whose text Felipe approved, each naming the absorbed items and crediting @lirazsiri.
- [ ] A1: every budget-stating file (fix, review, work, pm, dream SKILL.md + `genie/reference/lifecycle.md`) and its plugin mirror uses the resolved-budget wording; default 2 unchanged; `scripts/release-docs.test.ts` passes; `diff -r skills plugins/genie/skills` empty; `bun run check` green.
- [ ] B1: `hireAgent` has no post-write non-null-cast read; a concurrency regression test (hire vs concurrent unhire) passes.
- [ ] B2 verified against main and reported (expected: already-fixed); B3 landed with `Co-authored-by: lirazsiri` on ported hunks.
- [ ] No file from the rejected #2737 apparatus enters the tree.

## Execution Strategy

### Wave 1 (parallel — groups are independent)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| a1-fix-loop-budget | engineer | 2 (prompt-skill change +1, multi-file mirror discipline +1) | engineer-standard / medium | Re-author #2738 wording across six budget-stating files + mirrors + test assertions |
| b1-hireagent-race | engineer | 2 (stateful work +2) | engineer-standard / medium | Transactional fix + concurrency regression test in v5 core |
| b2-b3-test-ports | engineer | 1 (test-only, deterministic) | engineer-trivial / low | Verify B2 (expect no-op); port B3 umask hardening |

### Wave 2 (sequential, after Wave 1 lands)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| close-notes | orchestrator + Felipe | 2 (subjective acceptance +2, human gate) | orchestrator-owned | Draft notes → Felipe approves text → post comments → close both PRs |

## Execution Groups

### Group a1-fix-loop-budget: Re-author the fix-loop budget (A1)

**Goal:** Every file under `skills/` that states a fix-loop budget uses the resolved-budget wording with default 2 and all safety rails, in both `skills/` and `plugins/genie/skills/`.

**Deliverables:**
1. Resolved-budget wording in `skills/{fix,review,work,pm,dream}/SKILL.md`, `skills/genie/reference/lifecycle.md` (line 57 states "escalate after 2 failed loops"), and their six mirror files (budget `B` resolved once per group; default 2; only an explicit higher-priority user/workspace instruction may override with a positive integer; overrides never expand scope, permit unchanged retries, or skip diagnosis/independent re-review). `.kimi-plugin` command `description:` lines unchanged (deliberate).
2. Updated `scripts/release-docs.test.ts` assertions covering the new wording.
3. One conventional commit crediting @lirazsiri in the body (re-authored from #2738).

**Acceptance Criteria:**
- [ ] Default of 2 unchanged everywhere; no new frontmatter, config file, or env var introduced.
- [ ] `diff -r skills plugins/genie/skills` exits 0 with no output.
- [ ] `scripts/release-docs.test.ts` asserts the resolved-budget wording (not `'up to 2 loops'`) and passes.

**Validation:**
```bash
bun run skills:lint && bun test scripts/release-docs.test.ts && diff -r skills plugins/genie/skills
```
Scope rationale: prose-only skill/doc change; skills lint + the release-docs content contract are the repo's checks for this surface, and the explicit content-diff covers the mirror gap the named gates cannot detect (design Risk 2). The aggregate `bun run check` gate runs before PR (see QA Criteria).

**depends-on:** none

---

### Group b1-hireagent-race: Fix the hireAgent race (B1)

**Goal:** `hireAgent` never returns a `null` disguised as `HireRosterRow` under concurrent unhire.

**Deliverables:**
1. `src/lib/v5/task-state.ts` `hireAgent`: read inside the write transaction or construct the return row from inputs; no post-write non-null cast remains. Update the function's doc comment — its "a single statement is atomic on its own" reasoning covers the INSERT and conceals the unguarded trailing SELECT.
2. Concurrency regression test in `src/lib/v5/task-state.test.ts` following the existing cross-process pattern (lines ~770-980: `Bun.spawn` children on a shared DB, `Promise.allSettled` over exits) with a repeat count sufficient to exercise the INSERT→SELECT window; both outcomes correctly typed.
3. One conventional commit crediting @lirazsiri's PR #2737 review trail for surfacing the race.

**Acceptance Criteria:**
- [ ] No `as HireRosterRow` (or equivalent non-null cast) after the write in `hireAgent`; doc comment no longer asserts single-statement atomicity covers the return read.
- [ ] Regression test demonstrated to fail on the old implementation over N iterations (N recorded in evidence), or asserts the deterministic post-fix property; passes on the fix without flake.
- [ ] `HireRosterRow` return shape unchanged for the success path.

**Validation:**
```bash
bun test src/lib/v5/task-state.test.ts && bun run check
```
Scope rationale: shared runtime/core behavior in the v5 state engine → focused behavior test plus the repository full gate, per the repo's documented escalation rule.

**depends-on:** none

---

### Group b2-b3-test-ports: Verify B2, port B3 (test infra)

**Goal:** Confirm the #2732 determinism fix is already on main (B2) and land the umask-hardening of test fixtures (B3).

**Deliverables:**
1. B2: verification result for `selection: 'all'` in `src/genie-commands/__tests__/update.test.ts` on current main; if present (expected), record "already-fixed" in the group's evidence — no code change.
2. B3: explicit modes ported from #2737 — `0o755` dirs / `0o644` files, `0o700` for the isolated-home dirs in `local-delivery-repair.test.ts`, and the frozen-skill chmod helper (the `copyFrozenHistoricalSkill` wrapper around `cpSync` in the `Codex fallback ownership planning` describe, `agent-sync.test.ts` ~4273 on the current tree) — into the affected test files (`src/genie-commands/__tests__/update-command-publication.test.ts`, `src/genie-commands/local-delivery-repair.test.ts`, `src/lib/agent-sync.test.ts`, `tests/support/update-current-boundary-runner.ts`), dropping hunks already landed on main. Explicitly excluded: `tests/support/codex-dogfood-harness.ts` (`ownsRoot` change — declined) and `scripts/release-docs.test.ts` (its #2737 hunks are rejected-apparatus assertions, zero umask hunks — that file is owned solely by Group a1-fix-loop-budget).
3. One conventional commit with `Co-authored-by: lirazsiri` for the ported hunks.

**Acceptance Criteria:**
- [ ] B2 disposition recorded with evidence (line references on main).
- [ ] B3: every ported hunk applies to a test file or test support file only; the touched test files pass under the default umask and under `umask 027`.

**Validation:**
```bash
bun test src/genie-commands/__tests__/update-command-publication.test.ts src/genie-commands/local-delivery-repair.test.ts src/lib/agent-sync.test.ts src/genie-commands/__tests__/update-current-boundary.test.ts
```
Scope rationale: test-only changes; running the touched suites is the narrowest check that can disprove them. Full gate runs at the aggregate stage.

**depends-on:** none

---

### Group close-notes: Close both PRs with approved notes

**Goal:** Both PRs closed with credit-bearing notes whose exact text Felipe approved.

**Deliverables:**
1. Draft note for #2737: thanks + names B1–B3 as absorbed with commit references, explains the architecture reasoning (canonical roadmap.json/`task sync` channel conflict, proportion), invites brainstorm-first collaboration.
2. Draft note for #2738: thanks + names A1 as absorbed re-authored with commit reference.
3. After Felipe's explicit approval of both texts: post each as a PR comment and close both PRs (`gh pr comment` + `gh pr close`).

**Acceptance Criteria:**
- [ ] Felipe approved both note texts verbatim before posting (approval recorded in this wish's Review Results or the group's task evidence).
- [ ] Both PRs show state CLOSED with the approved comment posted.

**Validation:**
```bash
gh pr view 2737 --repo automagik-dev/genie --json state --jq .state | grep -qx CLOSED && gh pr view 2738 --repo automagik-dev/genie --json state --jq .state | grep -qx CLOSED
```
Scope rationale: outward-facing communication; the check confirms the terminal state. The human approval gate is the real acceptance boundary.

**depends-on:** a1-fix-loop-budget, b1-hireagent-race, b2-b3-test-ports

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Aggregate gate: `bun run check` green on the wish branch before PR (covers A1 + B1 + B3 together).
- [ ] Functional: a workspace instruction raising the budget changes only the loop cap wording behavior; absent any instruction, skills still state default 2.
- [ ] Regression: `genie task` hire/unhire lifecycle unaffected except the removed race; existing task-state tests pass.
- [ ] Integration: both PRs closed, notes visible on GitHub, no #2737 apparatus file present in the tree (`git log --stat` inspection).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Close notes read as dismissal of a valued contributor | Medium | Credit by item with commit references; Felipe approves text verbatim before posting |
| Mirror drift undetected by named gates (`skills:lint`, release-docs tests, `bun run check` read only `skills/`; CI mirror check compares entry names only) | Medium | Explicit `diff -r skills plugins/genie/skills` in A1's validation |
| B3 hunks overlap fixes already landed since 2026-07-30 | Low | Verify each hunk against current main; drop and note already-fixed hunks in the commit body |
| B1 constructed-row path changes return semantics | Low | Preserve exact `HireRosterRow` shape; regression test asserts typed outcomes |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — 2026-08-07T20:15Z — FIX-FIRST (loop 1)

- **Reviewer:** absorb-plan-review@session-228b9f91 (read-only)
- **Verdict:** FIX-FIRST — 2 HIGH, 2 MEDIUM, 3 LOW; plan shape sound, two factual repo claims wrong.
- **Gaps:** HIGH-1 `scripts/release-docs.test.ts` wrongly listed under B3 (zero umask hunks in #2737; its #2737 hunks are rejected-apparatus; also a Wave-1 parallel-edit collision with A1). HIGH-2 `skills/genie/reference/lifecycle.md:57` DOES state a numeric budget ("escalate after 2 failed loops"), contradicting the plan (and the design's "(today it does not)" — design left untouched to preserve its digest-bound SHIP evidence; the wish is the corrected downstream truth). MEDIUM-1 B3 mode spec missing `0o700` isolated-home dirs. MEDIUM-2 B1 old-code-failure criterion needed a named mechanism (cross-process pattern, N iterations). LOW-1 review-criteria.md drift → explicit OUT. LOW-2 kimi `description:` lines → declared unchanged. LOW-3 `hireAgent` doc comment → added to deliverable.
- **Fixes applied by orchestrator (fix loop 1):** all seven, per the reviewer's exact instructions — Scope IN A1/B3, OUT list, success criteria, Group a1/b1/b2-b3 deliverables + acceptance + validation, Files list.
- **Evidence basis:** reviewer's read-only command log (diff -r mirrors clean; codex-plugin-only-smoke name-list-only check; release-docs.test.ts:974; origin/main task-state.ts:1312; update.test.ts selection:'all' at 2617/3014/3043; #2737 per-file umask hunk sweep). Orchestrator independently confirmed both HIGHs (lifecycle.md:57 in both trees; zero mode/chmod hunks in #2737's release-docs diff).

### Plan re-review — 2026-08-07T20:20Z — SHIP (fix loop 1 clean)

- **Reviewer:** absorb-plan-review@session-228b9f91 (read-only; second pass on the amended wish)
- **Verdict:** SHIP — both HIGHs verified resolved (Wave-1 file sets re-derived and confirmed disjoint; lifecycle.md added in all four required places). All checklist items PASS. Remaining advisories folded in by the orchestrator post-verdict: MEDIUM-3 (added `update-current-boundary.test.ts` to B3's validation — its runner file previously had no group-level coverage), LOW-4 (name-anchored the agent-sync helper locator, ~4273 current tree, replacing the stale #2737 post-image line 3959), LOW-5 (Wave-1 table wording), LOW-6 (Group a1 Goal wording).
- **Status transition:** DRAFT → APPROVED persisted by the orchestrator with this block. Next: `work` may claim Wave-1 groups; close-notes group remains gated on Felipe's verbatim approval of both note texts.

---

## Files to Create/Modify

```
skills/fix/SKILL.md                                        (A1)
skills/review/SKILL.md                                     (A1)
skills/work/SKILL.md                                       (A1)
skills/pm/SKILL.md                                         (A1)
skills/dream/SKILL.md                                      (A1)
skills/genie/reference/lifecycle.md                        (A1 — line 57)
plugins/genie/skills/fix/SKILL.md                          (A1 mirror)
plugins/genie/skills/review/SKILL.md                       (A1 mirror)
plugins/genie/skills/work/SKILL.md                         (A1 mirror)
plugins/genie/skills/pm/SKILL.md                           (A1 mirror)
plugins/genie/skills/dream/SKILL.md                        (A1 mirror)
plugins/genie/skills/genie/reference/lifecycle.md          (A1 mirror — line 57)
scripts/release-docs.test.ts                               (A1 assertions only)
src/lib/v5/task-state.ts                                   (B1)
src/lib/v5/task-state.test.ts                              (B1 regression test)
src/genie-commands/__tests__/update-command-publication.test.ts  (B3)
src/genie-commands/local-delivery-repair.test.ts           (B3)
src/lib/agent-sync.test.ts                                 (B3)
tests/support/update-current-boundary-runner.ts            (B3)
```
