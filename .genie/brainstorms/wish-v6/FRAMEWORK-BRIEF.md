# Framework brief: one saved workflow for "objective → discovery → sufficiency → autonomous work → green PR"

Read at worktree `.claude/worktrees/genie-v6-workflow`, dev `1b6ae7e6d`, 2026-09-16. All paths repo-relative.

## 1. Lifecycle stages (what the framework already encodes)

Canonical spine: `brainstorm → design review → wish → plan review → work → implementation review` (`skills/README.md:16-23`); each review is a distinct artifact gate, never one generic step. Author and reviewer are different agents (`AGENTS.md:39`, `skills/README.md:27`). Caller persists state; reviewer only returns evidence (`skills/review/SKILL.md:10`, `:71-77`).

| Stage | Skill | Inputs | Outputs | User-in-the-loop? | Subagents | Gate ("green") |
|---|---|---|---|---|---|---|
| Route | `genie` | request text, `.genie/wishes`, `.genie/brainstorms` | chosen route; precedence: explicit skill > resumable wish > safety route (investigate→plan→execute→verify) > narrower (`genie/SKILL.md:18`) | Only when no request text (`:42`) | none | none; "quick" word alone never selects `quick` — needs decided change + merge authority + 60-min read-back (`:40`) |
| Explore | `brainstorm` | ambiguous idea | classification (spike/bounded/architectural, `brainstorm/SKILL.md:16-18`), `DRAFT.md`, `DESIGN.md` from `references/design-template.md`, INDEX.md entry | YES, structurally: frontier of decisions put to the user in rounds (`:22`), "Decisions are the user's" (`:24`), bounded path stops "until the user accepts" (`:17`) | read-only `scout` for facts (`:24`); independent `review` agent for the design (`:36`) | design review SHIP stamped by `references/design-review-evidence.mjs stamp/verify` with reviewer's own sha256 (`:39-44`) |
| Plan | `wish` | settled decisions or SHIP design | `.genie/wishes/<slug>/WISH.md` from template with fixed sections + per-group Goal/Deliverables/Interfaces/Acceptance/Validation/depends-on (`wish/SKILL.md:44`); task rows; base SHA via `genie context --wish` (`:72`) | No mid-run asks by design ("Plan only"); unresolved decisions reroute to brainstorm (`:10`) | independent plan `review` (`:63`) | `bun run wishes:lint` passes (`:59`); plan review SHIP → APPROVED on disk; every group has a non-zero validation command (`:46`) |
| Execute | `work` | WISH.md at APPROVED/IN_PROGRESS | commits per group, `## Review Results` evidence, card timeline, PR | Stop only for irreversible/destructive/security/side-effect-outside-worktree/plan-so-broken (`work/SKILL.md:39`); everything else is a recorded `Ruling:` | one worker per independent group via native delegation (`:18`), different reviewer via `review` (`:48`), `fix` on FIX-FIRST with budget B (`:49`), separate quality pass (`:50`) | per-group: SHIP + validation that can disprove the change; shared runtime/schema/deps/build/CI/broad-refactor need the full gate (`:51`); delivery = integrated PR review + CI; SHIPPED only after authorized merge + QA (`:80`) |
| Assess | `review` | target path/diff/SHA, criteria, validation contract | verdict SHIP/FIX-FIRST/BLOCKED, findings with provenance, `reviewed-sha256` for designs | No | itself a read-only agent; two-call blind pattern: criteria frozen before the artifact is seen (`review/SKILL.md:20`) | SHIP = no CRITICAL/HIGH and required validation passes (`:63`); zero validation insufficient (`:16`); unjustified stateful machinery is HIGH → `overdesigned-plan` BLOCKED (`:61`) |
| Repair | `fix` | FIX-FIRST evidence, criteria, validation, budget | resolved/remaining gaps, `attempts=<used>/B`, `effort_escalations=<used>/2`, `budget_source` (`fix/SKILL.md:41`) | `ambiguous-spec` cause requires the user or plan owner (`:26`); promotion gate needs a human ruling for release/backup/record/outside-worktree changes (`:37`) | a fixer + a different re-reviewer (`:10`) | B from `genie config get budgets.maxEscalationsPerGroup`, default 2 (`:14`); repeat only with changed approach (`:19`); at most two effort escalations (`:31`) |
| Prove | `verify` | a completion claim | command, exit status, claim it supports (`verify/SKILL.md:55`) | No | none | repo green = `bun run check` exit 0 read this turn (`:33`); mergeable = remote's checks read back from the PR (`:39`); shippable = reviewer's SHIP (`:40`); delegated report ≠ evidence, re-read diff and re-run gate (`:45`) |
| Diagnose | `report` | failure description (+ traces) | diagnosis block: root cause/evidence/causal chain/correction/scope/confidence (`report/SKILL.md:29-36`); optional GH issue | Asks only for what the investigation needs (`:21`); issue creation only when asked (`:42`) | read-only `scout` (`:23`) | a red loop exists before any theory (`:22`); every symbol in the correction verified with `rg -n` (`:38`) |
| Fast path | `quick` | one decided, tiny, reversible change | `quick-shipped` / `quick-refused` / `quick-missed` blocks (`quick/SKILL.md:48-74`) | Requires pre-existing merge grant (`:14`, `:22`) | one executor, one worktree (`:28`); independent reviewer (`:33`) | focused test + affected checks, independent review, required CI green, merge, deployed read-back, all inside 60 min (`:10`, `:40`) |

References carried: brainstorm `references/{design-template.md, design-review-evidence.mjs}`; wish `references/design-review-evidence.mjs` + `templates/wish-template.md`; work `references/orca-coordinator.md` (Orca mode only); review `references/lenses/{architecture,code-quality,dx,perf,qa,repo-hygiene,supply-chain}.md` (advisory, load on request); report `references/issue-template.md`; fix/verify/quick/genie carry none (genie cites `reference/lifecycle.md`).

Lifecycle vocabulary the workflow must preserve: WISH statuses `DRAFT|FIX-FIRST|APPROVED|IN_PROGRESS|BLOCKED|SHIPPED` (`genie/SKILL.md:46-53`); verdicts `SHIP|FIX-FIRST|BLOCKED`; portable roles `scout|reviewer|fixer|implementor-low/mid/high` (banned-token list `scripts/skills-lint.ts:71-104`).

## 2. Quick: keep / drop

`skills/quick/SKILL.md` promises a "request → deployed-dev read-back within 60 minutes" contract (`:10`). Three tests pin its wording today: `scripts/release-docs.test.ts:970-972` expects the 60-minute string, `existing merge authority`, and `quick-missed`; `skills/genie/SKILL.md:30,40` and `skills/README.md:76` name it.

| Promise (line) | Verdict | Why |
|---|---|---|
| Fixed deadline recorded at minute 0, never moves; stage windows 0-5/5-35/35-50/50-60 (`:20`, `:26-40`) | DROP | Scripts have no clock: `Date.now()`, argless `new Date()` are forbidden and throw (`workflows-meta.test.ts:13-15`, authoring ref). A timestamp arrives once via args; elapsed time cannot be measured mid-run. |
| Deployed-dev read-back: compare deployed revision + changed-file set, exercise the behavior live (`:40`) | DROP | Nothing in genie CI deploys anything (`ci.yml` jobs are scan/pins/unit/e2e/parity/gate). No deployment target exists to read back. |
| Merge to `dev` inside an "existing merge grant"; "Quick never requests or manufactures authority" (`:14`, `:22`, `:40`) | DROP | Merge is an operator decision outside the workflow: `AGENTS.md:42` ("agents merge to dev; main humans-only" is operator policy carried in briefs), and `work/SKILL.md:80` says only an authorized merge establishes SHIPPED. A workflow cannot verify a grant; it can only report a merge-ready PR. |
| Refuse when "CI, deployment and read-back conservatively fit inside 60 minutes" (`:14`) | DROP | Unmeasurable without a clock; replace with a scope-size admission judged by consequence/reversibility/oracle (`:16` is the part worth keeping). |
| Wait for every required check (`:36`) | KEEP, bounded | An agent can poll `gh pr checks` with `gh pr checks --watch` inside one agent call (bounded by the agent's own timeout); the script itself has no timers. Report `unknown` if the watch ends without a verdict. |
| Eligibility list: one repo, one existing behavior, reversible, objective check; never migrations/auth/billing/destructive/public API/infra/multi-repo/unknown cause (`:14-16`) | KEEP as the sufficiency gate | This is exactly "decide whether the provided context is sufficient": the decision maps to `report` (unknown cause), `brainstorm` (open decision), `wish` (needs a durable plan). |
| One executor, one isolated worktree cut from the base, no fan-out (`:28`) | KEEP | `agent(..., {isolation: 'worktree'})` exists; `AGENTS.md:37` forbids shared-workspace HEAD moves by subagents. One writer, one worktree, sequential. |
| Stage only task-owned paths, never the whole worktree; inseparable hunks stop the run (`:28`) | KEEP | Directly expressible as an executor rule plus a reviewer check on the changed-file set. |
| Independent review of the exact diff by an agent other than the executor; self-review is not evidence (`:33`) | KEEP | `AGENTS.md:39`, `review/SKILL.md:10`. Reviewer gets the SHA and the diff, read-only. |
| At most one bounded correction (`:34`) | KEEP, parametrize | Mirrors `fix` budget B (default 2, `fix/SKILL.md:14`) and workfly's `maxRepairs` loop (`workfly.js:334-349`). Cap it. |
| Push, then read the remote back: remote head == pushed commit; PR base/head/changed-file set checked against the contract's core (`:35`) | KEEP | `verify/SKILL.md:39`: mergeable = the remote's checks read back. One agent runs `git ls-remote`, `gh pr view --json baseRefName,headRefOid,files`. |
| Explicit stop states with preserved artifacts: `quick-shipped/refused/missed` (`:46-74`), never partial delivery claims (`:44`) | KEEP, rename | Return `{ok, state: 'shipped'|'refused'|'blocked'|'missed', pr, head, checks, review, notConvened}`; "missed" without a clock means "budget spent". |
| Never bypass or weaken checks (`:36`) | KEEP | `.claude/hooks/git-safety.sh:23,42` already blocks `--no-verify` and `--force`; the workflow's executor prompt restates it. |

Why quick is malformed as a workflow: it is a procedure with a stopwatch, not stages with inputs and outputs. Every section header is a minute range, the admission step's first act is "record the start time" (`:20`), and both terminal states are defined by elapsed time (`:36`, `:44`, `:69`). Its success condition (deployed read-back, `:10`) names an oracle the repository does not have, and its authority condition (`:22`) names a fact only a human holds. Strip the clock, the deployment and the merge, and what remains is a clean single-goal pipeline: admit → isolate → implement → gate → review → correct once → publish → read back → report.

## 3. Catalog contract checklist

Static rules (`scripts/workflows-meta.test.ts`, applied to every `.claude/workflows/*.js`):
- File starts with pure-literal `export const meta = {...}` (`:9`, `:32-40`); `meta.name` equals the filename stem (`:47`); non-empty `description` (`:49`).
- Forbidden in the body (`:10-23`): `import`, `require(`, `Date.now`, `Math.random`, argless `new Date()`, `process.`/`process[`, `fs`/`node:fs`, `child_process`/`exec(`/`execFile(`/`spawn(`, `fetch(`/`WebSocket`/`XMLHttpRequest`, timers, `eval`/`Function(`/`.constructor`/`__proto__`/`globalThis[`, any quoted absolute path under `/Users|/home|/opt|/var|/tmp`.
- Body must parse as an async function body with exactly the globals `agent, parallel, pipeline, phase, log, workflow, budget, args` (`:56`); top-level `await` and `return` are the contract (`README.md:15`).
- Comments are stripped before the forbidden scan (`:25-27`), so a comment may mention `spawn` but code may not.

README contract (`.claude/workflows/README.md`):
- Everything arrives through `args` — paths, slugs, timestamps, entropy (`:16-18`); never stamp an absolute path.
- `agent()` returns `null` on failure/skip; `.filter(Boolean)` and report what did not respond, never average it in (`:21-22`).
- `workflow()` nests one level only (`:23`); schema root `{type:'object', properties}` with `required ⊆ properties` (`:24-25`).
- Keep names unique across project and user scope; a stale `~/.claude/workflows/council.js` shadowed the project copy on 2026-09-15 (`:30-35`).
- Add one Entries row per workflow (`:41-48`) and record measured runs (`:52-63`).

Authoring reference (`workflow-authoring` skill):
- `agent(prompt, {label, phase, schema, model, effort, isolation:'worktree', agentType})`; with `schema` returns the validated object, without it the final text. Omit `model` unless highly confident; `effort` in `low|medium|high|xhigh|max`; `isolation:'worktree'` is expensive, only for parallel mutators, auto-removed if unchanged.
- `pipeline(items, ...stages)` is the default (no barrier); `parallel(thunks)` is a barrier and never rejects; `phase(title)` groups the progress display and titles must equal `meta.phases[].title`; `log()` narrates; `budget.{total,spent(),remaining()}` is a hard ceiling; `workflow(name|{scriptPath}, args)` runs a child.
- Agents have the full tool set (Read/Grep/Bash/Edit/git, MCP via ToolSearch), so an agent CAN run `git commit`, `git push`, `gh pr create`, `gh pr checks`; the script itself cannot. Subagents get CLAUDE.md/AGENTS.md injected, so the `git-safety.sh` PreToolUse hook and husky hooks apply to them.
- Plain JS only; no TS syntax. Concurrency cap min(16, CPUs-2); 1000 agents per run; 4096 items per call.
- Resume: `{scriptPath, resumeFromRunId}` replays the longest unchanged prefix of `agent()` calls; that is why clocks and entropy are banned. Read `journal.jsonl` before diagnosing an empty result.
- Structured results: schema is a request, not a post-condition (`workfly.js:79`); guard every field with `list()`/type checks.

Template idioms from `workfly.js` and `council.js`: `normalizeInput(raw)` accepting an object or a JSON string and returning `null` on a missing required key (`council.js:77-94`, `workfly.js:99-120`); `section(title, items)` (`council.js:96-98`); a single `notConvened[]` holding only agents that returned null, everything else through `error` (`workfly.js:218-220`); early `return {ok:false, error, notConvened}` on missing inputs (`workfly.js:216,237`); a barrier only where the next stage needs all readings (`workfly.js:226-237`); bounded repair `while (blocking.length && repairs < maxRepairs)` with the repairer allowed to edit exactly one target (`workfly.js:334-349`, `:209-211`); a repair round that gets no response is not spent (`:338-342`); `ok` computed from gate pass AND no blocking AND every lens having run (`:351-357`); quorum before synthesis (`council.js:202-204`); `render()` for a markdown report next to the raw object (`council.js:152-187`). Effort tiers: readers/refuters `high`, mechanical gate `low` (`workfly.js:229-231`, `291-293`).

## 4. Green PR definition for this repository

Local gate, from `package.json`:
- `bun run check` = typecheck (root + `plugins/dsh-genie-board`), `biome check .`, `knip`, `skills:lint`, `wishes:lint`, `lint:complexity-budget`, `lint:orca-bundle`, `bun test`.
- `bun run check:fast` = the same minus `bun test`; it is what `.husky/pre-push` runs.
- `bun run typecheck` fails on a checkout whose `node_modules` predates the `react-dom` devDependency until `bun install --frozen-lockfile` (#2926); run install first.

CI (`.github/workflows/ci.yml`, on push/PR to `main` and `dev`): jobs `Secrets Scan (GitGuardian)` (`:28`), `Action Pin Resolvability` (`:53`), `Unit (build + typecheck + lint + dead-code + test)` (`:72`, steps: install, build, typecheck, biome, knip, skills lint, wishes lint, complexity budget, orca bundle parity, fresh-install smoke, `bun test`), `E2E (v5 lifecycle)` (`:133`), `Skills Inventory Parity (skills.sh --list)` (`:168`), and `Quality Gate (typecheck + lint + test)` (`:221`) which `needs: [unit, e2e]` and verifies sub-jobs. Treat the Quality Gate plus the two scans as required; read them back with `gh pr checks <n>`.

Hooks:
- `.husky/pre-commit`: blocks a commit when the branch's last CI run concluded `failure` (override `SKIP_CI_CHECK=1` for a CI fix); runs `genie task sync` in the main checkout only; `biome check --staged`.
- `.husky/commit-msg`: commitlint, `@commitlint/config-conventional` (`commitlint.config.ts:2`); header ≤100 chars including GitHub's ` (#NNNN)` squash suffix; no `wip:`/`merge:`/`wish:` types.
- `.husky/pre-push`: refuses any push to `main`/`master` (`:6-10`), then runs `bun run check:fast`.
- `.claude/hooks/git-safety.sh` (PreToolUse on Bash, `.claude/settings.json:9`): blocks `--no-verify` (`:23`) and `git push --force`/`-f` without `--force-with-lease` (`:42`).
- Operator rules (`~/.claude/CLAUDE.md`): never `git stash`/`checkout <branch>`/`reset` in the shared workspace, use a worktree; `gh pr create --base dev`; never push to main.

PR conventions: base `dev` (`AGENTS.md:42`, CLAUDE.md), conventional-commit title (squash subject is linted), body states what changed, validation command and result, review verdict. A worker's notification is never delivery evidence (`work/SKILL.md:80`).

Known darwin-only failures (#2926, dev `1b6ae7e6d`, Bun 1.3.14): `src/lib/orca-orchestration-adapter.test.ts:269`, `src/genie-commands/doctor.test.ts` (WAL backup), `src/genie-commands/__tests__/update.test.ts` (other-platform release name), `scripts/release-archive-safety.test.ts` (escaping member), `scripts/skills-retirement-restore.test.ts` (documented command 0), `scripts/design-review-evidence.test.ts` (wish copy with no sibling skill). A darwin gate agent must list the failing test names and pass only when the set is a subset of these six; anything else is red. Ubuntu CI is the authority.

## 5. Pitfalls from #2916–#2921

- **Guard on reader output is not a guard** (#2921 §1): workfly's overwrite refusal rests on an agent's `existingNames[]`; a non-empty but incomplete list lets the author overwrite. Put the existence check in the writing agent's prompt ("if the target exists, write nothing and return an empty path") and treat an empty path as an error in the script.
- **Model default contradicts the authoring rule** (#2921 §2): all four scripts pin `model: 'opus'` while the authoring guidance says omit. Default `model` to empty and spread it only when the caller pins one (`...(MODEL ? {model: MODEL} : {})`).
- **Frozen inputs must stay frozen** (#2918 §2): a planner narrowed the caller's source list and the run still returned `ok:true`. Never let an agent drop or widen a caller-supplied objective, scope, or path list; re-append omissions or fail.
- **Containment tests are weak** (#2918 §3): a parity test using `toContain` passes when a clause is lost; pin verbatim text with normalized equality.
- **Semantic gates need every key** (#2918 §1): a conflict check matched on source+locator but not topic, so composed claims passed as attributed. Match on every field the comment promises.
- **All-invalid list silently widens scope** (#2919 §1): `{skills:['reveiw']}` became a full sweep. Distinguish "no list" from "a list with no valid entry" and fail the latter.
- **Environment-sensitive probes misread inside Claude Code** (#2919 §2, memory `darwin-review-env-quirks`): `skills-inventory-parity` reports `--list named []` under `CLAUDECODE`; run the CI form or `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT`.
- **Mutation allowlists, not judgement** (#2920, #2919 §3): a read-only auditor was told to run "failing invocations" of genie with no allowlist; `--write` was not forbidden. Every read-only agent prompt enumerates the exact commands it may run; every writing agent names the one path or file set it may touch.
- **Shipped skills must not point at repo-local files or a client tool name** (#2916, #2917): `.claude/workflows/` ships in no tarball, and `AGENTS.md:33` bans hardcoded client tool names. A front door says "run the saved workflow if the host lists it, otherwise the by-hand section" and carries no roster of its own (`council-workflow-parity.test.ts:26-37` pins that shape).
- **Cosmetic**: `slugify` truncation produces a false "renamed" log; `maxRepairs` has no upper cap (#2921 §3). Cap every budget arg.

## 6. Constraints a single-goal workflow must satisfy

1. Args are the only input: `{objective, context?, base?='dev', repairBudget?≤2, model?, timestamp?}`; `normalizeInput` returns null without an objective; every key is frozen for the run and never re-asked, narrowed or widened by an agent.
2. No clock, no entropy, no absolute path, no FS/process/network in the script; every read, write, git and gh call happens inside an agent (`workflows-meta.test.ts:10-23`).
3. Admission is a sufficiency decision, not a stopwatch: a read-only discovery stage returns `{sufficient, missing[], route}` where route ∈ `report|brainstorm|wish|proceed`; anything but `proceed` returns `{ok:false, state:'refused', route, evidence}` with no mutation.
4. Discovery agents are read-only with an enumerated command allowlist (`git log/diff/status`, `grep`, `bun run --help`, `genie --help`, `genie config get`); mutating genie verbs are named and forbidden (#2920).
5. Exactly one executor, in `isolation:'worktree'` cut from the base ref; no parallel writers; it never runs `checkout/switch/reset/stash/rebase` on the shared checkout (`AGENTS.md:37`).
6. The executor may edit only the file set it declares up front; it stages by path, never `git add -A`; an inseparable unrelated hunk stops the run as `blocked` before any publish (`quick/SKILL.md:28`).
7. Gate is mechanical and grounded in output: `bun install --frozen-lockfile && bun run check`, pass only on exit 0 and a `0 fail` summary; on darwin the failing set must be a subset of the six #2926 names or the gate is red; the gate agent quotes every failing line into `problems[]` (`workfly.js:200-204` pattern).
8. Review is by a different agent than the executor, read-only, against the exact commit SHA, with criteria written before the diff is opened (`review/SKILL.md:20`); the verdict enum is `SHIP|FIX-FIRST|BLOCKED`; the reviewer returns provenance for every finding and posts nothing.
9. Repair is bounded: `while (blocking.length && repairs < budget)`, the fixer edits only the executor's declared set, re-gate and re-review after each round, a non-responding fixer spends no round, and unchanged failure ends the loop (`fix/SKILL.md:19`, `workfly.js:334-349`).
10. Publish is an agent step with a fixed recipe: conventional-commit message, `git push -u origin <branch>` (never `--force`, never `--no-verify`, never to main), `gh pr create --base dev` with a body naming the objective, validation command + result and the reviewer verdict; the same agent reads the remote back (`git ls-remote` head == local head; `gh pr view --json baseRefName,headRefOid,files`) and reports any mismatch as `blocked`, never `shipped`.
11. CI read-back is a bounded agent call over `gh pr checks`; a check that has not concluded is reported as `pending`, never inferred green (`verify/SKILL.md:39`).
12. Merge is out of scope: the terminal success state is `merge-ready` (PR open to dev, checks green, SHIP recorded); merging, deployment, and SHIPPED remain with the operator (`work/SKILL.md:80`, `AGENTS.md:42`).
13. Every `agent()` result is null-checked; `notConvened[]` holds only agents that returned null; every other stop is an `error`; `ok` is true only when gate, review and read-back all ran and passed (`workfly.js:351-357`).
14. `model` defaults to empty and is spread only when pinned (#2921 §2); effort is `low` for the mechanical gate and read-back, `high` for executor, reviewer and fixer; `meta.phases` titles equal the `phase()` calls.
15. The front door skill replacing `quick` carries no roster, says "run the saved workflow if the host lists it, otherwise the by-hand section", names no client tool (`AGENTS.md:33`, #2916/#2917), and the pinned strings in `scripts/release-docs.test.ts:970-972` plus `skills/genie/SKILL.md:30,40` and `skills/README.md:76` are updated in the same change with a verbatim-equality parity test.
