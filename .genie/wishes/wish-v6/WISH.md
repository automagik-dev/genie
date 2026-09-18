# Wish: `/wish` is one task delivered — the V6 single workflow

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `wish-v6` |
| **Date** | 2026-09-16 |
| **Author** | Claude (session 8e0382e3) for Felipe |
| **Appetite** | small |
| **Branch** | `wish/wish-v6` |
| **Repos touched** | automagik-dev/genie |
| **Design** | [DESIGN.md](../../brainstorms/wish-v6/DESIGN.md) |

## Summary

Land the saved workflow `wish` (`.claude/workflows/wish.js`) that delivers one task end to end — admit, one executor in one worktree, mechanical gate, blind review, bounded repair, publish and read back — and make the `wish` skill its front door, with `quick` retired to a one-release deprecation stub. This is the `plan`-route delivery the design prescribes for a change that touches a denylisted path (`.claude/hooks/git-safety.sh`).

## Scope

### IN

- `.claude/workflows/wish.js` drafted by workfly from the design, renamed from its draft name (file stem, `meta.name` and the README row change together — the meta test fails on any one drifting), args `{objective, issue?, context?, base?, repairBudget?, model?, timestamp}`, states `merge-ready | pr-open | refused | blocked | missed`.
- `skills/wish/SKILL.md` as the front door (council pattern) with the direct `plan` entry and the verbatim machine-consumed fence, template name and verify command; `skills/wish/agents/openai.yaml` description; frontmatter `mutates: repo`.
- `skills/quick/SKILL.md` reduced to the one-line deprecation stub the design names, with its frontmatter description changed to match; `skills/quick/agents/openai.yaml` description likewise (both still carry the one-hour wording today).
- Routing and docs: `skills/genie/SKILL.md` rows, `skills/genie/reference/lifecycle.md`, `skills/README.md`, `README.md` skill table row.
- Tests: `scripts/wish-workflow-parity.test.ts` (enums, by-hand stage list, three skill-clause pins); `scripts/release-docs.test.ts` quick test replaced by a wish-front-door test.
- `.claude/hooks/git-safety.sh`: prefilter widened to `gh`; exit 2 on `gh pr merge`, a `gh api` mutation that merges or moves a protected ref, `HUSKY=` disabling hooks, `core.hooksPath` in override or mutation form only (the read-only `git config --get core.hooksPath` stays allowed), and any push aimed at `main`/`master`. **Amended 2026-09-17** from the original "`gh api -X PUT|POST|PATCH|DELETE`, … refspecs ending `:main`/`:dev`/`:master`": PR #2931's review narrowed it twice, and the plan was not amended with it, so the criterion below failed against the code that shipped. The narrowing stands as the operator's decision — a blanket `gh api` mutation block refused review-thread replies, and `dev` refspecs are operator policy with no client-side guard (`AGENTS.md`, #2705). Within that scope the guard now refuses the spellings the probe suite enumerates, including the ones that used to walk through it (`gh -R … pr merge`, `git -C … push --force`, `-XPUT`, `--method=PUT`, the implicit POST of `gh api … -f`, a GraphQL merge mutation, `merge-upstream`, a quoted key or endpoint, a tab-separated invocation, a lowercase `core.hookspath`, an empty value, `--unset` and the dashless `unset`, `HEAD:refs/heads/main`, `+main`, `-uf`, `commit -n`), and allows a command that only QUOTES one as data. It is a guardrail, not a boundary: it matches text, so an alias, a token list handed to another interpreter or a name split across quotes still gets past it, and a bare `git push origin main` is deliberately left to the pre-push hook, which sees refs rather than command lines and refuses `main`/`master` for every `git push` spelling once `bun install` has materialised it (`git send-pack` bypasses that hook entirely — verified reaching `main` with hooks live while `git push origin main` was refused — so the guard refuses that verb outright and the delegation is for `git push` alone; a direct write to `.git/config` is refused for the same reason). `DESIGN.md` keeps the original wording: it carries a stamped content digest and is the record of what was designed, not of what was later decided.
- `.claude/workflows/README.md`: entry row now; measured-runs row after the first live run.

### OUT

- Everything under the design's OUT: merge, deployment, SHIPPED, skill renames, #2916, #2917, per-agent model tiers, parallel executors, Orca mode, a durable `.genie/` trace per run.
- The public docs submodule (`.docs-vendor`): a `gh search code` on 2026-09-16 found no `quick` skill page, but `genie/skills/wish.mdx`, `genie/concepts/wishes.mdx`, `genie/skills/genie.mdx`, `genie/quickstart.mdx` and `genie/onboarding.mdx` describe `/wish` as the planning step; owner: this session files the docs PR to `automagik-dev/docs` before the stub ships in a release.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | One execution group, executed by the session, not by the workflow it introduces | The change touches a denylisted path, so the workflow would refuse it; the design's `plan` route is this document. |
| 2 | The workflow file is authored by workfly and landed by hand | Workfly's refuters verify the script against the catalog contract; the README row, the front door and the parity test are the caller's landing steps. |
| 3 | The measured-runs row is written only after the #2921 dogfood run | The row records agents, tokens, wall clock, estimate and real diff; nothing is invented before the run. |

## Simplicity Case

- **Simplest complete design:** the six-agent script plus a front door and one parity test.
- **Added machinery:** the git-safety extension (the merge rule is prompt-level only today); the deprecation stub (CLAUDE.md release discipline).
- **Deferred until measured:** every item under the design's "Deferred until measured"; trigger: three measured runs.
- **Complexity removed:** the 60-minute contract, the deployment oracle, the merge grant, per-agent model pins.

## Dependencies

**depends-on:** none
**blocks:** none

_Ordering outside the wish graph, all run by this session in a Claude Code session with the workflow surface: design SHIP stamped → workfly drafts the script → Group 1 lands it on `wish/wish-v6` → dry runs A and B on that branch → the #2921 dogfood run on that branch → the measured-runs row committed to the same PR → PR review and merge. QA below reads the row back on dev._

## Success Criteria

- [ ] `bun test scripts/workflows-meta.test.ts scripts/wish-workflow-parity.test.ts scripts/release-docs.test.ts scripts/fresh-install-smoke.test.ts` exits 0 with `0 fail`.
- [ ] `bun run check` is green except the six #2926 darwin names re-confirmed at the base.
- [x] `grep -rn '60 minutes\|within one hour' skills scripts | grep -vE 'scripts/(release-docs|wish-workflow-parity)\.test\.ts:'` returns nothing, and `skills/quick/SKILL.md` is frontmatter plus the one-line retirement stub (amended 2026-09-18 after the #2935 review: as first written the grep also matched the two tests that pin the phrase's ABSENCE — `scripts/release-docs.test.ts` and `scripts/wish-workflow-parity.test.ts` — so it could never return nothing while those tests existed, though its intent, no duration contract in shipped prose, was already met).
- [x] `bun test scripts/wish-workflow-parity.test.ts` proves the hook by probe (amended 2026-09-17, see Scope IN): exit 2 for each enumerated form — `gh pr merge` with or without leading flags, a `gh api` mutation aimed at a merge endpoint or a protected ref in each mutating spelling, `HUSKY=`, every `core.hooksPath` write including an empty value and the dashless `unset`, `:main`/`:refs/heads/main`/`+main`, `git -C … push --force`, `-uf`, `commit -n`, and any of these inside `bash -c`, `/bin/sh -c`, `node -e` or `eval` — and exit 0 for `gh pr create --base dev`, `git config --get core.hooksPath` (chained or redirected), a push to `:dev`, a review-thread reply whose body quotes an endpoint, another program's `-f` on the same line, a read-only `show-ref`/`fetch` naming `main`, and any command that only QUOTES a forbidden form as data. A third test records what the guard deliberately does NOT catch — a bare `git push origin main`, a branch in a variable, `--all`, `--mirror` — because that is the pre-push hook's job.
- [ ] Dry run A (oversized objective) returns `refused`/`plan` with `git worktree list` unchanged; dry run B (denylisted path) returns `refused` with no worktree.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | medium: one script, one skill rewrite, one hook, three tests, four doc rows; no runtime code | inherit | Land wish.js, front door, stub, hook, tests and doc rows on `wish/wish-v6` against dev |

**Global constraints:** plain JS in `.claude/workflows/*.js` (no TS syntax, no clock/entropy/FS/process/network, `meta` pure literal, `meta.name` equals the file stem); biome single quotes, 120 width; conventional commit headers ≤100 chars; base branch `dev`; hooks never bypassed; no shipped skill names a client tool or a repo-local path (`AGENTS.md:33`).

## Execution Groups

### Group 1: Land the wish workflow and its front door

**Goal:** the `wish` workflow, its front door, the quick stub, the hook extension and the tests are on one branch with the full gate green.

**Deliverables:**
1. `.claude/workflows/wish.js` (from the workfly draft, renamed) and its README entry row.
2. `skills/wish/SKILL.md`, `skills/wish/agents/openai.yaml`, `skills/quick/SKILL.md`, `skills/quick/agents/openai.yaml`.
3. `skills/genie/SKILL.md`, `skills/genie/reference/lifecycle.md`, `skills/README.md`, `README.md`.
4. `scripts/wish-workflow-parity.test.ts`, `scripts/release-docs.test.ts`.
5. `.claude/hooks/git-safety.sh`.

**Interfaces:**
- Consumes: `.genie/brainstorms/wish-v6/DESIGN.md` (SHIP-stamped), the workfly draft script and its SPEC.
- Produces: the `wish` workflow's args and result contract as named in the design's IN list; the front door's route and state enums, pinned by the parity test.

**Acceptance Criteria:**
- [ ] Every success criterion above holds on the branch head.
- [ ] `scripts/wish-workflow-parity.test.ts` fails when any enum value, the by-hand stage list, or one of the three pinned skill clauses drifts between `wish.js` and `skills/wish/SKILL.md` (verified by a deliberate local edit, reverted).
- [ ] The PR body names the objective, the validation command and result, and the review verdict.

**Validation:**
```bash
bun install --frozen-lockfile && bun run check
```
On this darwin host the gate is green when the only failing tests are the six #2926 names re-confirmed at the base (`git merge-base HEAD origin/dev`); Ubuntu CI on the PR is the authority.

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] `/wish` on a Claude Code session in the repo runs the saved workflow and returns one of the five states.
- [ ] The #2921 dogfood run (recorded in `.claude/workflows/README.md`) reached `merge-ready` or `pr-open` with a `SHIP` verdict from an agent other than the executor.
- [ ] `genie` routing sends a fast-delivery request to `wish`; a multi-group request reaches the plan route directly.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| The workfly draft needs hand fixes beyond the repair budget | Medium | Land the fixes by hand and record each as an advisory in the PR body, as the skill-audit-sweep conversion did. |
| Release-docs pins elsewhere reference `quick` wording not yet found | Low | `grep -rn quick scripts skills README.md` before the commit; extend the replacement test. |
| CI red on darwin-only names | Low | Ubuntu CI is the authority; the six #2926 names are listed in the PR body. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — 2026-09-16T20:16:43Z — SHIP

- Reviewer: `plan-review@session-8e0382e3` (read-only, different agent from the author), worktree head `296db0509`.
- Evidence: design digest `d23d7ff9…` verified; `wishes-lint: OK (95 files scanned, 0 broken brainstorm links, template validator green)`; 11 of 13 listed paths exist, the two absent are the new files; every design anchor resolves.
- Findings: 0 CRITICAL/HIGH; 3 MEDIUM (darwin gate tolerance missing from the Validation block; ordering of workfly draft, dry runs, dogfood and row unplaced; hook probe read JSON on stdin) and 3 LOW (new files unmarked, rename scope, docs follow-up owner) — all applied in-document before this block; status DRAFT → APPROVED.

### Execution — 2026-09-16 — Group 1 landed, PR #2931 open against dev

- Branch `wish/wish-v6` (stacked on `docs/wish-v6-design`, PR #2930); head after review round 1 `0ef761ca7`. 13 code files, 1,560 insertions in the landing commit `75cc17f3c`.
- Script: workfly run `wf_93b90188-3d0` (16 agents, 1.74M tokens, 59 min) drafted `wish-v6.js`; static gate green; 4 blocking refuter findings landed by hand (review path union, hook liveness on every gate, ancestor-based worktree adoption, darwin tolerance re-confirmed at the base) and re-verified by an independent reader (`script-check`), which found one more (`<base>` placeholder) — fixed.
- Gate on darwin: `bun run check` green except `bun test` 2536 pass / 6 fail = the six #2926 names; `bun test scripts/workflows-meta.test.ts scripts/wish-workflow-parity.test.ts scripts/release-docs.test.ts scripts/fresh-install-smoke.test.ts` green; `skills:lint`, `wishes:lint` OK.
- Dry run A (`wf_d1251eed-383`): `refused`/`plan`, 26 files and 5 units over the band, nothing created, 2 agents, 152k, 7.3 min. Dry run B (`wf_f0fbb70a-b4f`): `refused`/`plan` on `.github/`, nothing created, 2 agents, 110k, 1.4 min.
- Live run (`wf_7218c974-893`): attempt 1 `missed` at Gate (gate agent backgrounded the check and returned nothing → prompt now says foreground under a timeout); resume adopted the same commit and reached `merge-ready`: PR #2932 closes #2921, 13/13 checks, review SHIP 11/11 criteria, darwin six tolerated after base re-confirmation, estimate 5/95/2 vs real 5/117; 4 + 6 agents (3 replayed), 284k + 192k tokens, 6.4 + 10.9 min.
- PR review round 1 (Codex, 3 threads) accepted and landed in `dbc6ab8ed`; the widened `gh api` guard then blocked a review-thread reply and was narrowed to merge endpoints and protected refs in `0ef761ca7`.
- Stays IN_PROGRESS through PR and CI; SHIPPED only after an authorized merge.

### PR review — 2026-09-17 — PR #2935 (dev → main) — FIX-FIRST

- Reviewer: read-only, a different agent from the author; target `automagik-dev/genie#2935` at head `ddc1d6f1bf`, merge-base `1b6ae7e6d`, read in an isolated clone. Blind criteria first: a second agent wrote 86 acceptance criteria from WISH.md, DESIGN.md and issues #2927/#2921 without seeing the code, and the scoring pass declared every criterion added after the diff was read.
- Score: 68 met, 3 HIGH not met, 13 MEDIUM not met or partly met, 2 not applicable, 0 CRITICAL → FIX-FIRST.
- Validation: full gate at head on darwin (typecheck, biome, knip, `skills:lint`, `wishes:lint`, complexity budget, orca-bundle green; `bun test` 2554 pass, 1 skip, 6 fail = the six #2926 names), the same six re-confirmed failing at the merge-base, every GitHub check green on head including the ubuntu unit job, a 6/6 mutation check of the parity test, and `design-review-evidence verify` on DESIGN.md (digest `25af2eae…`).
- The three HIGH findings: the hook did not match the approved plan (criterion 4 promised exit 2 on `gh api -X POST|PATCH|DELETE` and on a push to `…:dev`, which the #2931 review round had deliberately narrowed without amending the plan, while merges still passed through an implicit POST, `-XPUT`, `--method=PUT`, the GraphQL mutation, `HEAD:refs/heads/main`, a lowercase `core.hookspath` and `config --unset`); the darwin tolerance matched whole test FILES rather than the six named tests, so a new failure inside one of them would ship a red commit; and the workflow's input contract had drifted — an undeclared `slug`, an optional `timestamp`, and only the exact strings `main`/`master` refused as a base.
- Disposition — three PRs against dev, each gated and independently reviewed by an agent that did not write it: #2938 the delivery workflow's own correctness (exact test names, `failCount`, base refusal, repair-exit wording), #2939 the pre-record retirement of #2927 (an unreadable leftover is retried rather than frozen, legacy retirements are counted apart from recorded ones, `genie init` ignores its own `.codex` backup), #2940 the merge guard in every spelling plus the contract amendments below. Docs: automagik-dev/docs#83. Filed rather than fixed: #2941 (`design-review-evidence.mjs` fails open through a symlinked path — pre-existing, out of this wish's scope) and #2942 (the catalog `--check` is gated by nothing).
- Operator decision, 2026-09-17: the hook stays narrow. It keeps refusing every merge spelling and every push that lands on main or master, and deliberately does not guard `dev`, so Scope IN and Success Criterion 4 above are amended to the narrower rule and `AGENTS.md` now calls the hook a guardrail against accident rather than a boundary — husky's pre-push, which sees refs instead of command lines, and server-side branch protection are the enforcement.
- Stays IN_PROGRESS: SHIPPED only after an authorized merge of the three PRs and the promotion.

---

## Files to Create/Modify

```
.claude/workflows/wish.js                (new)
.claude/workflows/README.md
.claude/hooks/git-safety.sh
skills/wish/SKILL.md
skills/wish/agents/openai.yaml
skills/quick/SKILL.md
skills/quick/agents/openai.yaml
skills/genie/SKILL.md
skills/genie/reference/lifecycle.md
skills/README.md
README.md
scripts/wish-workflow-parity.test.ts    (new)
scripts/release-docs.test.ts
```
