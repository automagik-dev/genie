# Design: `/wish` is one task delivered — the genie V6 single workflow

| Field | Value |
|-------|-------|
| **Slug** | `wish-v6` |
| **Date** | 2026-09-16 |
| **Revision** | 3 — council `revise` applied ([COUNCIL.md](COUNCIL.md), run `wf_f4a43c6d-b1f`), then design review FIX-FIRST findings 1–9 applied |

## Problem

Genie's lifecycle is six skills and three review gates around a unit of work whose delivery time is explained by its
size, not by its process: across 50 shipped wishes with a slug-named PR (v4+v5), wish lines correlate 0.67 with
branch hours and PR insertions 0.70; every wish under 150 lines merged within 3 hours, while wishes over 400 lines took
a median 10 hours and a p90 of 63 ([study §5](WISH-DURATION-STUDY.md)). Code has become a commodity — the frontier
model writes it — so the framework's remaining value is to bound one objective, prove the context is sufficient, and
deliver a green PR with evidence a different agent produced. `/quick` was meant to be that path and is malformed as a
workflow: every section is a minute range, its oracle is a deployment the repo does not have, and its authority is a
merge grant a script cannot verify ([brief §2](FRAMEWORK-BRIEF.md)). Genie V6 makes `/wish` mean "one task delivered,
as soon as possible"; every other skill is auxiliary to that.

**Claim, stated precisely.** Recomputed from `wishes.csv` with the maximum band below, 34 of 50 historical shipped
wishes would route `plan` ([council dissent](COUNCIL.md)). This design therefore proves that the *single-task slice*
of the framework runs as one saved workflow with every gate the lifecycle demands, and that the multi-group path
stays reachable as the `plan` route. It does not claim the whole framework is one workflow yet; widening is deferred
until three measured runs exist.

## Scope

### IN
- `.claude/workflows/wish.js`: one saved workflow whose `args` are `{objective, issue?, context?, base?, repairBudget?, model?, timestamp}` (`base` defaults to `dev`; `main`/`master` are rejected in `normalizeInput`; `repairBudget` defaults to 2, capped at 3), with phases **Admit → Work → Gate → Review → Repair (bounded) → Publish → Read-back** and terminal states `merge-ready | pr-open | refused | blocked | missed`.
- **Admit** = a read-only scout plus a blind judge. The scout, the judge and the executor carry the research-sweep `INJECTION_FENCE` verbatim with objective, issue body and context framed as data; every read-only agent (scout, gate, reviewer) enumerates the exact commands it may run and names the forbidden mutating genie verbs (#2920). The scout reads the objective, the issue (`gh issue view`), the context, and the repo, and returns facts, a candidate plan (approach, declared file set, validation command, focused test) and an a-priori estimate `{files, insertions, units}` plus `injectionAttempts[]`; when `.genie/brainstorms/<slug>/DESIGN.md` exists for a slug found in `context`, in the issue body or in the objective text, it runs the design preflight (`design-review-evidence.mjs verify`) and reports the verdict. The **threshold arithmetic is script-side** on the scout's estimate: maximum `files ≤ 25`, `insertions ≤ 2000`, `units ≤ 3` (the study's PR columns), ideal `files ≤ 10`, `insertions ≤ 800`, `units ≤ 2` reported as advice. The judge sees only the objective, the contract shape, the scout's structured result and the consequence denylist, and returns `route ∈ proceed | report | brainstorm | plan`, the reason, and the **frozen contract**: core, cuttable, oracle, declared file set, and the acceptance criteria the reviewer will score against, written before any code exists. Denylisted paths (`.github/`, `.husky/`, `.claude/hooks/`, `.claude/settings*.json`, `package.json` scripts, `biome.json`, `commitlint.config.ts`, `scripts/release-*`, `release-guard.sh`, `version.yml`, auth/secrets/permission surfaces, `delivery-evidence-verify.ts`) route `plan`; an open product decision routes `brainstorm`; an unknown cause routes `report`; a failed design preflight routes `brainstorm`. Anything but `proceed` returns `refused` with the evidence, and nothing has been created.
- **Work** = one executor. It derives the worktree parent from `git rev-parse --path-format=absolute --git-common-dir` (never cwd), **adopts** an existing `<parent>/.claude/worktrees/wish-<slug>` only when it is on branch `wish/<slug>` with a clean status and its head equals the remote branch head (or the remote branch is absent) — that is the retry after `missed`/`blocked` — and otherwise refuses as `blocked` naming the cleanup command (`git worktree remove <path> && git branch -D wish/<slug> && git push origin --delete wish/<slug>`); with no existing worktree it cuts one from `origin/<base>`, runs `bun install --frozen-lockfile` before its first commit so husky's `prepare` materialises the hooks, edits only the declared file set, stages by path, and commits with a conventional message. It never touches the shared checkout's HEAD, stash or index.
- **Gate** = a mechanical, low-effort agent: asserts the hooks are live (`.husky/_/pre-push` exists, `core.hooksPath` resolves inside the worktree) else `blocked` before any push; runs `bun run check`; passes only on exit 0 and a `0 fail` summary; on darwin a failing set that is a subset of the six #2926 names (re-confirmed at the branch's real base) is tolerated locally, and the Ubuntu Quality Gate remains the authority at read-back. Every failing line is quoted into `problems[]`.
- **Review** = a different, read-only agent scoring the exact commit SHA against the judge's frozen criteria; verdict `SHIP | FIX-FIRST | BLOCKED`, provenance per finding, `BLOCKED` whenever the real diff touches a denylisted path or leaves the declared set. It posts nothing.
- **Repair** = `while ((gate red || FIX-FIRST) && repairs < budget)`: a fixer edits only the declared set, then gate and review run again; a silent fixer spends no round; an unchanged failure ends the loop as `missed`.
- **Publish + Read-back** = one agent under a command allowlist: `git push -u origin <branch>`, `gh pr create --base <base>`, `git ls-remote`, `gh pr view --json`, one bounded `gh pr checks` under `gtimeout`. Forbidden and named as such: `gh pr merge`, `gh api` mutations, `HUSKY=`, `-c core.hooksPath`, any `--force*` flag, any hook bypass, any push to `dev` or `main` directly. The PR body is composed from the frozen contract, the gate summary line, the verdict and the issue link only. `merge-ready` requires checks `pass` AND remote head == local head AND PR base/head/file set == contract AND verdict `SHIP`; checks still running yield `pr-open` with `checks: pending`; any mismatch yields `blocked`.
- **Exception safety**: every stage after Admit runs inside a guard; a budget-ceiling throw or a null agent returns `missed` with branch, head SHA, PR URL if any, worktree path and the stage reached. The run never ends by exception after a push.
- **Result** `{ok, state, route?, contract, estimate, diff: {files, insertions}, head, branch, worktree, pr?, checks, review, gate, repairs, injectionAttempts, notConvened}`; the token bill is read from the run record (as the catalog's measured-runs table does today), not from `budget`.
- `skills/wish/SKILL.md` rewritten as the front door in the council pattern: names the script path and saved name; states what is relayed unchanged and what stays with the operator (merge, SHIPPED, promotion, worktree and branch removal after merge with the cleanup command above; retry after `missed`/`blocked` is a rerun with the same objective, which adopts the named worktree when it is clean and in sync and is otherwise `blocked` with that command; on `pr-open` the front door names the re-read command, `gh pr checks <n>`); offers a **direct plan entry** that skips admission when the operator already declares a multi-group objective; keeps verbatim the `wish-scaffold-command` fence, the `templates/wish-template.md` name, the design-review verify command and the plan-route phrases `scripts/release-docs.test.ts` and `scripts/fresh-install-smoke.ts` pin; states that the by-hand section is the only working path on installed hosts until #2916 lands, and makes it complete enough to deliver a PR; names no client tool and carries no repo-local command strings or darwin test names (#2917, `AGENTS.md:33`). Frontmatter `mutates: repo`.
- `skills/quick/SKILL.md` kept for one release as a deprecation stub whose body is the single line `Retired: \`quick\` is superseded by \`wish\` (one task delivered); this stub is removed after three measured runs.` (CLAUDE.md release discipline: a breaking change needs a deprecation story); the replacement test pins that line; deleted after the three-run trigger below. `skills/wish/agents/openai.yaml`, `README.md:143`, `skills/genie/SKILL.md` rows, `skills/genie/reference/lifecycle.md:35`, `skills/README.md:70/76` updated in the same change; `scripts/release-docs.test.ts:963-980` replaced by a wish-front-door test; `scripts/wish-workflow-parity.test.ts` pins the route and state enums and the by-hand stage list by normalized equality, and pins the script's blind-criteria, repair-budget and delivery-evidence clauses to the `review`, `fix` and `work` skill text.
- `.claude/hooks/git-safety.sh` extended to exit 2 on `gh pr merge`, `gh api -X (PUT|POST|PATCH|DELETE)`, `HUSKY=0`, `core.hooksPath`, and refspecs ending in `:main`/`:dev`/`:master`; its prefilter today matches only commands containing `git`, so it widens to `gh ` as well.
- Two PRs, in order: **(1) docs-only** — this directory (DESIGN, STUDY, `wishes.csv`, BRIEF, TIMELINE, COUNCIL) and the INDEX entry; **(2) code** — the twelve files above. The code change touches `.claude/hooks/git-safety.sh`, a denylisted path, so by this design's own rule it is a `plan`-route change: it is delivered through `.genie/wishes/wish-v6/WISH.md` (one group, plan-reviewed) and executed by the session, not by the workflow it introduces.
- Dogfood: the first live run resolves #2921 with Decision 6 and the exact four-script file set passed as frozen `context` so admission routes `proceed`; the #2921 PR owns no README row (row ownership: the code PR owns the entry row and the measured-runs row, written after the run); the row records the scout's estimate next to the real diff.

### OUT
- Merging, deployment, SHIPPED status and dev→main promotion: operator decisions, reported as `merge-ready`.
- Renaming or deleting `brainstorm`, `work`, `review`, `fix`, `verify`, `report`, `dream`: auxiliary skills; `work` still executes multi-group wishes.
- Shipping `.claude/workflows/` in the release tarball (#2916) and client-neutral front-door wording (#2917): separate issues.
- A durable `.genie/` trace per run (roadmap card, `tasks.wish` slug): deferred, see below.
- Any per-agent model tier in the front door; parallel executors; per-group fan-out; Orca mode.

## Approach

One script, sequential on the happy path, fan-out nowhere: the 1-hour band is 3 groups / 9 files / 311 insertions,
work a single executor does faster than a coordinator can shard it, and each extra agent pays roughly 14k tokens of
`CLAUDE.md`/`AGENTS.md` injection before it works. **Six agents on the happy path**: scout, judge, executor, gate,
reviewer, publisher; a fixer per repair round. The criteria writer the framework's blind rule asks for is the judge:
a contract written before any code exists is blinder than a post-hoc criteria call.

Alternatives considered:
- **Repair `quick` as a skill.** Keeps the stopwatch shape and leaves the procedure to the session model's discipline; the POC needs a body-independent script.
- **Compose the existing catalog** (`council` for admission). Five lenses for a decision, not a sufficiency check; costs more than the work it admits.
- **Route everything through `work` with a one-group wish.** Needs an APPROVED WISH.md and a plan review first — two documents and two gates for a change that merges in under an hour.
- **Single admission agent.** The agent that proposes the file set should not rule it eligible (security lens); the judge is kept for the denylist, the brainstorm/report judgement and the frozen criteria, while the size arithmetic is script-side so the judge never re-does it.
- **Name the workflow `deliver`/`ship` and leave `wish` meaning the planning document** (dissent). Recorded, not taken: the operator's decision is that `/wish` means one task delivered; the identifier concern (`tasks.wish`, `genie context --wish`, status vocabulary) is addressed by leaving every CLI/DB meaning of "wish slug" untouched and pinning the front door's plan-route strings.

## Simplicity Case

- **Simplest complete design:** admit, one executor, gate, review, publish, read back — five stages, six agents, one bounded loop.
- **Added machinery:** the separate judge (denylist independence and blind criteria); the exception guard (a push must never end in an exception); the hook-liveness assertion (a fresh worktree has no hooks until `prepare` runs); the git-safety extension (the merge rule is prompt-level only for this runner today).
- **Deferred until measured:** a durable `.genie/` trace per run; Orca-mode dispatch; parallel executors for `plan`-sized objectives; a better size estimator; deleting `skills/quick`; widening the claim to the whole framework. Trigger: three measured runs recorded in the catalog table.
- **Complexity removed:** the clock and the four minute windows; the deployment oracle; the merge and the merge grant; WISH.md and plan review for a single-task objective; `quick`'s three output blocks; `budget.spent()` in the result; the separate criteria writer; any per-agent model tier.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | The workflow is named `wish` and the `wish` skill is its front door | Operator's framing: `/wish` = one task delivered; the council precedent pairs a skill and a script by name. Workfly refuses a taken name, so the script is drafted under a free name and renamed at landing, `meta.name` included. Dissent recorded in COUNCIL.md. |
| 2 | Admission refuses by route and by script-side size arithmetic, never by clock | A script has no clock. Maximum `files ≤ 25 / insertions ≤ 2000 / units ≤ 3` and ideal `≤ 10 / ≤ 800 / ≤ 2` are the study's PR columns (§8); the earlier draft's "12 files" was the wish-document cap, the wrong unit. |
| 3 | A consequence denylist routes `plan`, and the reviewer blocks on it | Size alone would admit a two-line edit to `release-guard.sh`; the paths listed are the repo's trust boundaries (security lens). |
| 4 | The old planning content stays inside the `wish` front door as the `plan` route, with a direct entry | The skill is machine-consumed (`fresh-install-smoke.ts` fence, `release-docs.test.ts` pins), so the plan route carries the old text nearly verbatim; a rename touches more files than the band allows. |
| 5 | Merge stays with the operator; success is `merge-ready`; `pr-open` names checks still pending | `AGENTS.md` makes dev merges an operator policy; a script can read a PR back, not verify a grant; CI wall clock on PRs is 3–5 min but pending is a real outcome. |
| 6 | `model` is spread only when the caller pins it | #2921 §2: the authoring rule says omit; four scripts pinning `opus` is the drift this catalog is fixing. |
| 7 | The executor works in a real worktree it creates from `origin/<base>` under the git common dir | The branch must outlive the agent; `isolation:'worktree'` is auto-removed; deriving the parent from the common dir prevents nesting a worktree under a worktree. |
| 8 | The dogfood target is #2921, with Decision 6 as frozen context | Bounded to four scripts and their tests, inside the maximum band, and self-referential: the new workflow fixes the guard rule its own script obeys. |
| 9 | `quick` ships one more release as a deprecation stub | Host-side skill deletion is one-way (`retireRemovedSkills`); a stub is the deprecation story CLAUDE.md requires. |
| 10 | The token bill comes from the run record, not the script | The authoring reference describes `budget.spent()` as the shared-turn output pool and `budget.total` as a throwing ceiling (unverified in the live runtime — no catalog script calls either); the README's measured-runs column is already the run record, so the script needs neither. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | The scout's a-priori estimate does not track the real diff | Medium | Every run records estimate next to real diff; the maximum band bounds the damage; three rows recalibrate the thresholds. |
| 2 | Token bill on run one lands above the cheapest recorded run (316k, five read-only readers) | Medium | Reframed: the first run is a calibration row against the 361k–454k six-agent runs; 316k is a number to beat over three runs, not a gate. |
| 3 | A budget ceiling or a null agent after a push | Medium | The exception guard returns `missed` with branch, head, PR and worktree; nothing is retried or deleted. |
| 4 | Husky hooks absent in a fresh worktree | Low | `bun install --frozen-lockfile` before the first commit; gate asserts hook liveness before any push. |
| 5 | Resume replays a cached publisher and opens a duplicate PR | Low | Publisher checks `gh pr list --head <branch>` first and reuses an open PR; evidence gap recorded. |
| 6 | Orphaned worktrees and branches | Low | Result names the worktree; a rerun adopts a clean, in-sync worktree and is otherwise `blocked` with the cleanup command; removal after merge is the operator's, with the same command named in the front door. |
| 7 | The front door drifts from the script | Low | Parity test with normalized equality on enums, stage list and the three skill-clause pins. |
| 8 | `/wish` on installed hosts has no script (#2916) | Medium | The front door says so and its by-hand section is complete; the fix is #2916's. |
| 9 | Two PRs racing on `.claude/workflows/README.md` | Low | The code PR owns both rows; the #2921 PR touches no README. |
| 10 | The public docs (`.docs-vendor`, absent in this worktree) name `quick` or describe `/wish` as the planning step | Medium | Before the `quick` stub ships, grep the docs submodule for `quick` and `/wish` and file the docs change as a follow-up PR to `automagik-dev/docs`; unmeasured here. |

## Success Criteria

- [ ] `bun test scripts/workflows-meta.test.ts scripts/wish-workflow-parity.test.ts scripts/release-docs.test.ts scripts/fresh-install-smoke.test.ts` pass and `bun run skills:lint` is clean; `bun run check` is green on the branch except the six #2926 darwin names re-confirmed at the base.
- [ ] Dry run A: an objective the maximum band rejects returns `refused` with route `plan`, `git status` clean and `git worktree list` unchanged.
- [ ] Dry run B: an objective naming a denylisted path, or an issue body carrying an instruction, returns `refused` (route `plan` / `injectionAttempts` non-empty) with no worktree created.
- [ ] Live run: #2921 resolved to a PR against dev with checks `pass`, verdict `SHIP` from an agent other than the executor, and a measured-runs row recording agents, subagent tokens, wall clock, estimate and real diff.
- [ ] `skills/quick/SKILL.md` is the one-line deprecation stub above, `genie` routes fast delivery to `wish`, and `grep -rn '60 minutes\|within one hour' skills scripts` returns nothing.
- [ ] This design carries SHIP evidence with a verified digest before any `wish.js` is written.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `d23d7ff9a2faff16c5e5436f8f7f59c52f3cde6ee4528a2a515ba27e4420c413`
- **Reviewer:** design-review@session-8e0382e3
- **Reviewed at:** 2026-09-16T20:12:24.000Z
<!-- genie-design-review:end -->
