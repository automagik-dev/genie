# Wish: The wish gate validates a repository with no hook system instead of blocking it

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `wish-gate-no-hook-system` |
| **Date** | 2026-09-22 |
| **Author** | Felipe Rosa |
| **Appetite** | small |
| **Branch** | `wish/wish-gate-no-hook-system` |
| **Repos touched** | automagik-dev/genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

The Gate stage of `.claude/workflows/wish.js` assumes every repository uses husky: it requires `.husky/_/pre-push` and a `core.hooksPath` inside the worktree, and ends the run `blocked` when either is missing. A repository with no hook system at all, one that verifies in its CI workflow, can therefore never publish: every `/wish` run there stops right after the executor commits. This wish teaches the gate to tell "no hook system" apart from "a hook system whose hooks are dead". With no hook system, the gate runs the frozen contract's validation command once and leaves full verification to the remote CI checks that read-back already requires. A repository that has a hook system, genie included, behaves exactly as it does today.

## Scope

### IN

- The gate classifies the repository's hook system as `husky`, `other` or `none` from tracked content, git config and the resolved hooks directory, and reports the evidence.
- The frozen contract carries a `validationCommand` (the judge's, falling back to the scout plan's), and the gate prompt interpolates it.
- `hookSystem: 'none'` makes the gate run that validation command once instead of `bun run check` and skip the hook-liveness assertion. Script side, `!hooksLive` is not a stop in that case, but a missing validation command is `blocked`.
- Every other answer, including a missing or unknown `hookSystem`, keeps today's rule on the first gate and on every repair-round gate: hooks not live means `blocked` and nothing pushed.
- The report and the PR body's gate line say explicitly that there was no hook system, which command ran, and that the remote CI checks are the authority. The publisher reports `pending`, never `pass`, for a PR with no reported check.
- The front door (`skills/wish/SKILL.md`) and `meta.phases` Gate detail describe the no-hook path. Behavior and logic tests pin both paths.

### OUT

- Proving hooks live for a non-husky hook manager (lefthook, pre-commit, a bare `.git/hooks` script, a global `core.hooksPath`). `other` keeps today's outcome, `blocked`. Widening it is a separate decision.
- Making the executor's `bun install --frozen-lockfile` step or `CHECK_COMMAND` language-agnostic for repositories that are not bun projects.
- The admission-scout crash on an early return (a separate wish).
- Any change to `.claude/hooks/git-safety.sh`, the denylist, the read-back comparisons, or the darwin tolerance roster.
- Filing or linking an upstream issue that names any specific downstream repository.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | "No hook system" is `none` only when ALL of these are absent: a tracked `.husky/` or `.githooks/` path; a tracked hook-manager config (`lefthook.*`, `.lefthook.*`, `.lefthook/`, `.pre-commit-config.yaml`, `.simple-git-hooks*`); a `core.hooksPath` at any scope (`git config --get core.hooksPath`); and any non-`.sample` file in `git rev-parse --git-path hooks` | Conservative: any sign of hooks means the hooks must be live. Genie tracks `.husky/` and sets `core.hooksPath`, so it can never classify as `none` |
| 2 | `hookSystem` is an OPTIONAL gate field; a missing or unknown value is treated as a hook system (fail closed) | Keeps the `GATE_SCHEMA` required list pinned by `scripts/wish-workflow-parity.test.ts` unchanged. An older or short answer cannot open the no-hook path |
| 3 | `other` keeps today's husky assertion, so it ends `blocked` | The operator's direction covers "no hook system". Liveness for other managers is not evidenced yet |
| 4 | The validation command lives on the frozen contract: `text(judged.contract.validationCommand) \|\| text(scout.plan.validationCommand)` | The scout already returns `plan.validationCommand` as a required field (wish.js SCOUT_SCHEMA). The judge may narrow it. The script freezes it before any code exists, so the gate cannot choose its own command |
| 5 | In the no-hook path, darwin tolerance never applies and `pass` means exit 0 of the validation command | The six tolerated names are genie's own tests. They mean nothing in another repository |
| 6 | Read-back is unchanged: `merge-ready` still requires checks `pass`; the publisher reports a PR with no check as `pending` | CI becomes the authority, so an absent CI must never read as green |
| 7 | In the no-hook path the gate runs the validation command only inside its read-only brief: a command that would push, merge, publish, or write outside the worktree is not run, and the gate answers `pass: false` naming it | The command is repository-derived text frozen by the scout and judge; the gate must never become a second route to the remote |

## Simplicity Case

- **Simplest complete design:** one optional enum field plus one evidence list on the gate answer, one optional contract field, one branch in the gate prompt, and one guarded condition at the two existing `hooksLive` stops. No new stage, no new agent call, no script-side IO.
- **Added machinery:** the `hookSystem` classification. It is required because today's single boolean cannot tell "absent" from "dead", which is the whole bug.
- **Deferred until measured:** liveness proofs for non-husky managers (trigger: a real run blocked on a repository whose `other` hooks are demonstrably live), and latching the first gate's classification across repair rounds (trigger: an observed classification flip).
- **Complexity removed:** no language detection and no per-ecosystem check command. The contract's validation command is the only thing run in the no-hook case.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] A gate answer `{hookSystem: 'none', hooksLive: false, exitCode: 0, pass: true}` with remote checks `pass` ends the run `merge-ready`, and with checks `pending` ends it `pr-open`
- [ ] A gate answer with `hooksLive: false` and `hookSystem` `husky`, `other` or absent still ends the run `blocked` at the first gate and at a repair-round gate, with no review or publish label dispatched after it
- [ ] The `gate:check` prompt contains the frozen contract's validation command verbatim, and still contains `test -f .husky/_/pre-push` and `bun run check` for the hook path
- [ ] `hookSystem: 'none'` with an empty validation command ends the run `blocked` naming the missing command, with nothing pushed
- [ ] The rendered report's gate block names the hook-system verdict and, for `none`, the command that ran and that CI is the authority
- [ ] `scripts/wish-workflow-parity.test.ts` passes unchanged (GATE_SCHEMA required list, CHECK_COMMAND pin, nine model spreads, SKILL.md at most 95 lines)

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | Medium: one workflow file with two gate call sites, the prompt and report text pinned by parity tests, fail-closed semantics on a push boundary | inherit (medium effort) | Add the hook-system classification, the contract validation command, the no-hook gate path, front-door text and tests |

**Global constraints:**
- Base is `dev`; the branch is `wish/wish-gate-no-hook-system`; one PR against `dev`.
- A repository with a hook system whose hooks are not live must still end `blocked` with nothing pushed. Genie's own gate behavior must not change.
- Never bypass a hook (`--no-verify`, `HUSKY=`, `-c core.hooksPath`), never force-push, never merge.
- Do not run the full `bun test` or `bun run check` locally. Run focused test files and `bun run check:fast`; CI is the authority.
- `skills/wish/SKILL.md` stays at most 95 lines, and public text names no private repository, project or person.
- `GATE_SCHEMA`'s required list stays `['hooksLive', 'exitCode', 'pass', 'problems', 'summaryLine']`.

## Execution Groups

### Group 1: Gate validates a no-hook repository and still blocks dead hooks

**Goal:** A repository with no hook system passes the gate on the contract's validation command and relies on CI at read-back, while any repository with a hook system keeps the dead-hooks block.

**Deliverables:**
1. `.claude/workflows/wish.js`:
   - `GATE_SCHEMA` gains optional `hookSystem: enumOf(['husky', 'other', 'none'])` and `hookEvidence: notes(...)`.
   - `JUDGE_SCHEMA.contract` gains optional `validationCommand`.
   - The contract build sets `validationCommand: text(judgedContract.validationCommand) || text(scoutPlan.validationCommand)`.
   - `gatePrompt(job, contract, worktree, branch, headSha)` asks first for the read-only classification commands (`git ls-files -- .husky .githooks .lefthook .pre-commit-config.yaml 'lefthook.*' '.lefthook.*' '.simple-git-hooks*'`, `git config --get core.hooksPath`, `ls "$(git rev-parse --git-path hooks)"`). For `husky`/`other` it keeps today's liveness assertion and `CHECK_COMMAND`. For `none` it runs the contract's validation command once, under the same foreground/timeout rule.
   - `normalizeGate` returns `noHookSystem` (`text(value.hookSystem) === 'none'`) and `hookEvidence`, and never tolerates darwin failures when `noHookSystem`.
   - Both stops (first gate, repair round) become `if (!gate.noHookSystem && !gate.hooksLive)`. A new `blocked` stop fires when `gate.noHookSystem && !contract.validationCommand`.
   - `gateSection`, `contractSection` and the publish gate summary name the hook-system verdict and "CI is the authority".
   - `publishPrompt` states that a PR with no reported check is `pending`, and its "the gate proved the hooks live" sentence reads correctly in the no-hook case.
   - The `meta.phases` Gate detail describes the no-hook path.
2. `skills/wish/SKILL.md`: the by-hand gate clause and the `blocked` relay line describe the no-hook path, and the file does not grow past 95 lines.
3. `scripts/wish-workflow-behavior.test.ts`: new cases:
   - husky dead hooks blocks at `gate:check`.
   - A missing `hookSystem` with dead hooks blocks.
   - Dead hooks at `gate:round-1` block after a FIX-FIRST round.
   - `none` reaches `merge-ready` with checks `pass`, `pr-open` with `pending`, and `blocked` with `fail`.
   - `none` with no validation command is `blocked`.
   - The `gate:check` prompt carries the contract validation command.
4. `scripts/wish-workflow-logic.test.ts`: `normalizeGate` cases showing that `hookSystem: 'none'` never sets `darwinTolerated`, and that a non-zero exit is red.
5. `.genie/wishes/wish-gate-no-hook-system/WISH.md`: this plan, status advanced by the orchestrator.

**Interfaces:**
- Consumes: none
- Produces:
  - `GATE_SCHEMA.properties.hookSystem: {type:'string', enum:['husky','other','none']}` (optional).
  - `GATE_SCHEMA.properties.hookEvidence: string[]` (optional).
  - `JUDGE_SCHEMA.properties.contract.properties.validationCommand: string` (optional).
  - `contract.validationCommand: string`.
  - `normalizeGate(raw) → {…existing, noHookSystem: boolean, hookEvidence: string[]}`.
  - `gatePrompt(job, contract, worktree, branch, headSha): string`.

**Acceptance Criteria:**
- [ ] A behavior test drives `gate:check` = `{hookSystem:'none', hooksLive:false, exitCode:0, failCount:0, pass:true}` and gets `merge-ready` with checks `pass`, `pr-open` with checks `pending`, and `blocked` with checks `fail`
- [ ] Behavior tests with `hooksLive:false` and `hookSystem` `'husky'` or absent get `blocked` with `hooks are not live` in `blockedReason`, and no `review:diff` prompt is recorded
- [ ] A behavior test with a FIX-FIRST first review and `gate:round-1` `{hookSystem:'husky', hooksLive:false}` gets `blocked` naming `repair round 1`
- [ ] A behavior test asserts `prompts['gate:check'][0]` contains the contract's validation command string, `test -f .husky/_/pre-push` and `bun run check`
- [ ] A behavior test with `hookSystem:'none'` and empty validation commands in both the judge contract and the scout plan gets `blocked` with nothing published (no `publish:pr` prompt)
- [ ] A logic test shows `normalizeGate({...sixKnownFailures, darwinTolerated:true, hookSystem:'none'})` returns `pass:false, darwinTolerated:false`
- [ ] `scripts/wish-workflow-parity.test.ts` passes with no edit to its GATE_SCHEMA required-list or CHECK_COMMAND assertions
- [ ] The gate prompt's no-hook branch states Decision 7's refusal (a validation command that would push, merge, publish or write outside the worktree is not run and answers `pass: false`), and a behavior test asserts that sentence is in the `gate:check` prompt

**Validation:**
```bash
bun test scripts/wish-workflow-behavior.test.ts scripts/wish-workflow-logic.test.ts scripts/wish-workflow-parity.test.ts scripts/wish-workflow-mikro.test.ts scripts/workflows-model-policy.test.ts && bun run check:fast
```

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] A `/wish` run against a scratch repository with no hook system and a CI workflow reaches `pr-open` or `merge-ready`. Its report says no hook system was found, names the validation command that ran, and states that CI is the authority
- [ ] A `/wish` run in genie still asserts `.husky/_/pre-push` and runs `bun run check` at the gate, and ends `blocked` when the hooks are removed from the worktree
- [ ] The focused wish workflow test files pass on both the linux and darwin CI legs

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| A gate agent misclassifies a repository with hooks as `none` and skips the full check | Medium | Classification lists four independent signals and returns `hookEvidence`, which the report renders. Read-back still requires green remote checks before `merge-ready` |
| The validation command is scout-authored text that the gate now executes | Medium | It is frozen in the contract before any code exists, the gate stays under its read-only brief, and the command is rendered in the report and PR body for the operator |
| A no-hook repository with no CI checks reads `pass` from an empty checks list | Medium | The publisher prompt states that no reported check is `pending`, never `pass`, so the run ends `pr-open` |
| A non-bun repository still fails the executor's `bun install --frozen-lockfile` step | Low | Out of scope here. A repository that reaches the gate today already got past it |
| Prompt wording pinned by parity tests drifts | Low | The required list and CHECK_COMMAND stay untouched, and focused parity tests run in validation |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — 2026-09-22T17:24:10Z

- **Verdict:** SHIP → status APPROVED (orchestrator plan review of the triage draft; the reviewer did not author the plan).
- **Evidence:** triage reproduced the block under the behavior harness (an otherwise green gate answer with `hooksLive:false` ends `blocked`, dispatching only admit:scout, admit:judge, work:executor and gate:check); the husky lines trace to 75cc17f3c (#2931) and `.genie/brainstorms/wish-v6/DESIGN.md` Risk 4, which targeted unmaterialised husky hooks in a fresh worktree, never a repository without a hook system; duplicate sweep found no open PR or issue.
- **Edits at review:** added Decision 7 (the gate never runs a validation command that pushes, merges, publishes or writes outside the worktree) with its acceptance criterion; removed a leftover template instruction.
- **Open decisions settled:** `other` stays blocked; `hookSystem` optional and fail-closed; validation command on the contract with the scout fallback; no-reported-check is `pending`; non-bun portability and a repair-round latch stay out.
- **Base:** `origin/dev` @ `4b3cf03ed85a65d4f50157fbbe887984cee4775a` (recorded here: `genie context` resolves the local `dev`, which is behind the remote on this host).


---

## Files to Create/Modify

```
.claude/workflows/wish.js
skills/wish/SKILL.md
scripts/wish-workflow-behavior.test.ts
scripts/wish-workflow-logic.test.ts
.genie/wishes/wish-gate-no-hook-system/WISH.md
```
