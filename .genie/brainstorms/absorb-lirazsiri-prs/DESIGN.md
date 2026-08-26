# Design: Absorb lirazsiri PR goodies, close both PRs with credit

| Field | Value |
|-------|-------|
| **Slug** | `absorb-lirazsiri-prs` |
| **Date** | 2026-08-07 |
| **WRS** | 100/100 |

## Problem

Two open community PRs from @lirazsiri will be closed — #2737 `feat(db-sync)` (review BLOCKED 2026-08-07: 2 CRITICAL / 9 HIGH, premise conflicts with the canonical roadmap.json + `task sync` channel, built 104 commits behind main) and #2738 `feat(skills): configurable fix-loop budgets` (small, coherent) — but they contain verified valuable fragments that should be absorbed deliberately with credit rather than lost or merged as unreviewable bulk.

## Scope

### IN
- **A1** — Re-author #2738 on current `dev`: fix-loop budget `B` resolved once per group; default 2; only an explicit higher-priority user/workspace instruction may set another positive integer; an override never expands scope, permits unchanged retries, or skips diagnosis/independent re-review. Applies to every skill file that states a fix-loop budget (`skills/{fix,review,work,pm,dream}/SKILL.md`) and their `plugins/genie/skills/` mirrors; `skills/genie/reference/lifecycle.md` is updated only if it states a numeric budget (today it does not). Update the `scripts/release-docs.test.ts` wording assertions (note: line 974 currently asserts `'up to 2 loops'`).
- **B1** — Fix the `hireAgent` race (`src/lib/v5/task-state.ts`, function `hireAgent`; main: line 1312): the trailing `getHire(...) as HireRosterRow` is a separate statement outside any transaction, so a concurrent `unhireAgent` DELETE landing between the INSERT and the SELECT returns `null` cast as non-null. Read inside the write transaction or construct the return row from inputs; add a concurrency regression test (`Promise.allSettled` pattern per repo testing conventions).
- **B2** — Verify-then-port the determinism fix (`selection: 'all'`, issue #2732) in `src/genie-commands/__tests__/update.test.ts`. Pre-checked 2026-08-07: origin/main already contains `selection: 'all'` at lines 2617, 3014, 3043 — this item is probably a no-op; the wish sizes it as a verification step, not a port, and reports "already-fixed" if confirmed.
- **B3** — Port the umask-hardening of test fixtures (explicit `mode: 0o755`/`0o644`, chmod helper for frozen-skill copies) as one test-infra commit, verifying each hunk still applies on current main.
- **Close notes** — Draft two respectful close comments crediting @lirazsiri by item (Felipe reviews before posting): #2737 explains the architecture reasoning (canonical channel conflict, proportion) and names B1–B3 as absorbed; #2738 names A1 as absorbed re-authored. Both invite future work to start from a brainstorm/wish.

### OUT
- Merging or rebasing either PR branch itself.
- Any DB-to-DB sync mechanism: snapshot store, libc FFI locking, roster tombstones, schema fingerprinting, WAL bootstrap, the `db sync` command (B7 — rejected by review).
- The `codex-dogfood-harness` `ownsRoot` mkdir change (B4 — shared-test-infra behavior change motivated only by the rejected feature).
- Sandbox guest hand-back docs (B5 — dropped by Felipe 2026-08-07).
- `task sync` diverged-state conflict reporting (B6 — deferred; trigger: recurring operator pain resolving `diverged` warnings).

## Approach

Absorb as four small, independent, conventional commits/PRs through the normal lifecycle — each referencing this slug and crediting @lirazsiri (`Co-authored-by` where his hunks are ported near-verbatim: B2, B3; prose credit for A1 and B1, which are re-authored). Post the two close notes only after Felipe approves their text.

Alternatives considered:
- *Merge #2738 after rebase instead of close+absorb* — viable for that PR alone, but Felipe chose close+absorb for both to keep one consistent disposition and avoid a stale-branch rebase cycle on the contributor's side.
- *Cherry-pick his commits directly* — loses against re-authoring because both branches are stale (main moved 104 commits; skills drifted since 2026-07-30) and his commits mix absorbed and rejected content.

## Simplicity Case

- **Simplest complete design:** four focused commits (one per absorption) plus two human-approved close comments. No new mechanisms, no durable state, no configuration files.
- **Added machinery:** none. A1 is instruction-layer prose in skill files (explicitly user-approved 2026-08-07); B1 is a bug fix; B2/B3 are test-only.
- **Deferred until measured:** B6 diverged-state reporting — reconsider when `task sync` `diverged` warnings cause repeated manual-resolution pain.
- **Complexity removed:** the entire #2737 apparatus (~13.7k lines: snapshot store, FFI locking, tombstones, fingerprint validation, bootstrap) — rejected rather than partially preserved as dormant machinery.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Close both PRs; absorb approved portions (Felipe, 2026-08-07) | #2737 is BLOCKED on premise, not fixable in place; consistent disposition for both PRs |
| 2 | A1 absorbed re-authored, not merged | Skills drifted since his base; the `plugins/genie/skills/` mirror is hand-mirrored and committed (no generator exists — the two trees are byte-identical git-tracked copies); default 2 and all safety rails preserved verbatim |
| 3 | B1 fixed by transactional read (or constructed row) + regression test | Removes the unsound non-null cast; test permanently owns the scenario per QA discipline |
| 4 | B2/B3 ported with `Co-authored-by` credit | Near-verbatim hunks; credit is accurate and cheap |
| 5 | B4 declined, B5 dropped, B6 deferred, B7 rejected | B4 changes shared test infra for a rejected scenario; B5 not wanted; B6 lacks present pain; B7 per review verdict |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Contributor relations — close notes read as dismissal of a valued contributor (3 merged PRs) | Medium | Credit by item, explain #2737 reasoning concretely, invite brainstorm-first collaboration; Felipe approves text before posting |
| 2 | A1 mirror drift — `skills/` vs `plugins/genie/skills/` content drift is undetected by the named gates: `skills:lint`, `release-docs.test.ts`, and `bun run check` all read only `skills/`, and the only mirror check (`scripts/codex-plugin-only-smoke.ts:695-702`, CI-only) compares entry counts, not content | Medium | Edit both trees; add an explicit content-diff acceptance step — `diff -r skills plugins/genie/skills` must be empty — as part of A1's validation |
| 3 | B2/B3 hunks may overlap fixes already landed since 2026-07-30 | Low | Verify each target file on current main before porting; drop already-fixed hunks and say so in the commit body |
| 4 | B1 fix changes `hireAgent` return semantics if constructed-row path chosen | Low | Preserve exact `HireRosterRow` shape; regression test asserts both concurrent outcomes are typed correctly |

## Success Criteria

- [ ] Both PRs closed with posted notes whose text Felipe approved, each naming the absorbed items and crediting @lirazsiri.
- [ ] A1 landed: every skill file that states a fix-loop budget (fix, review, work, pm, dream) and its plugin mirror uses the resolved-budget wording (`lifecycle.md` only if it states a budget); default 2 unchanged; `scripts/release-docs.test.ts` assertions pass; `diff -r skills plugins/genie/skills` empty; `bun run check` green.
- [ ] B1 landed: `hireAgent` has no post-write non-null-cast read; a concurrency regression test (hire vs concurrent unhire) passes.
- [ ] B2 verified against main (probably already-fixed — reported as such) and B3 landed as focused commits with `Co-authored-by: lirazsiri` where hunks are ported.
- [ ] No file from the rejected #2737 apparatus (B7) enters the tree.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `9f06a8e0fbe64a32912130a603c369d54c7c7a98881e1f0230d3a75340524b8e`
- **Reviewer:** absorb-design-review@session-228b9f91
- **Reviewed at:** 2026-08-07T20:06:12.000Z
<!-- genie-design-review:end -->
