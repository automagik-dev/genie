# Wish: The wish gate runs the repository's own check and accepts any live hook system

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `wish-gate-any-repo` |
| **Date** | 2026-10-02 |
| **Author** | Felipe Rosa |
| **Appetite** | medium |
| **Branch** | `wish/wish-gate-any-repo` |
| **Repos touched** | automagik-dev/genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

At v6.261002.2, `.claude/workflows/wish.js` is shaped around Bun and husky, and dev has the same code. `CHECK_COMMAND = 'bun run check'` and `INSTALL_COMMAND = 'bun install --frozen-lockfile'` are hardcoded. The gate's liveness test is `test -f .husky/_/pre-push` for every hook system, and the darwin tolerance and its `node_modules` base re-confirm are genie's own. So a first `/wish` in an ordinary Node, Python or other repository that has git hooks ends `blocked` at the gate. This wish changes that. The scout discovers the check and install commands from the repository's own files and quotes what each one runs. The script writes them into the frozen contract at the judge step and refuses one that would push or publish. Any hook manager passes liveness with a live `pre-push` or `pre-commit` hook. A repository with hooks but no discoverable check falls back to the frozen validation command, and the report says so. Genie's own runs resolve to exactly the commands they run today.

## Scope

### IN

- The scout proposes `checkCommand` and `installCommand` from evidence at the repository root: package.json scripts plus the lockfile, or a Makefile, justfile or Taskfile target. It quotes what each command runs in `commandEvidence`.
- The script writes the scout's two commands into the frozen contract at the judge step, next to `validationCommand`. The blind judge never authors one. The new caller args `check` and `install` override both.
- The executor runs the frozen install command before its first commit when the contract has one, and installs nothing when it does not.
- The gate runs the frozen check command when the repository has a hook system and a check command. It runs the frozen validation command when there is no hook system, or a hook system but no check command. The script picks the command, never the gate.
- Generalized hook liveness. With any hook system, the gate requires an executable `pre-push` or `pre-commit` (not `.sample`) in the hooks directory git resolves from the worktree, and that directory must sit inside the worktree or the repository's own git directory. When that directory is husky 9's `.husky/_`, `pre-push` must exist there too. Husky 6 to 8 is covered by the general rule. The check is one command, held once in `wish.js` and tested against real git repositories.
- The darwin tolerance, its five names and the `node_modules` base re-confirm appear in the gate prompt and apply script-side only when the frozen check is `bun run check`.
- The run report names the command the gate ran in every mode, plus the frozen check and install commands and where each came from. When no check command was discovered, the report and the PR body both say so and name CI as the authority.
- Front-door and in-repo text that describes the gate: `skills/wish/SKILL.md`, the `wish` row of `.claude/workflows/README.md`, and the gate block of `skills/merge/SKILL.md`.
- Behavior, logic, parity and real-git tests. End-to-end runs of the saved workflow against three throwaway fixture repositories, verified from each run's own workflow record.

### OUT

- Public docs pages under `docs/` (automagik.dev). The `genie-launch` wish rewrites them after the new stable.
- A per-repository config file for the check or install command.
- Language-specific runners inferred without a tracked task target at the root, such as `pytest`, `cargo test`, `go test`, tox or nox guessed from file extensions. With no tracked target, the validation command runs and CI is the authority.
- Scripts of workspace packages in a monorepo. Only the root package.json and the root task files are read.
- A hooks directory outside both the worktree and the repository's git directory, such as a global `core.hooksPath`. It stays `blocked`, failing closed.
- Any change to `.claude/hooks/git-safety.sh`, the `DENYLIST`, the read-back comparisons, the size band, the nine agent calls and their model routing, or the five darwin test names.
- `scripts/mikro/triage.ts` and `scripts/mikro/triage.test.ts`. They lift only `DENYLIST` and the band constants from `wish.js`, and neither changes. The `bun run check` literal in `narrowerThanGate` is that provisional scout's own heuristic and is not wired into `wish.js`.
- `scripts/workflow-yaml-parse.test.ts`. Its `bun run check` mention is a comment about the legacy-skills catalog CI step, not the wish gate.
- `src/lib/legacy-skills-catalog.ts`. It records the descriptions of retired skills, and no shipped skill's description changes here.
- `AGENTS.md` and `CLAUDE.md`. They give genie contributors genie's own commands, which do not change.
- The historical run rows of `.claude/workflows/README.md`, and teaching the `wish-context` mikro offload to discover commands.
- Promotion to `main` and a new stable, which are the operator's.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Owner, 2026-10-02.** Check and install commands come from the repository. The scout discovers them from repository evidence and proposes `checkCommand` and `installCommand`. Both are frozen in the contract at the judge step, next to `validationCommand`, as the scout wrote them (Decision 7), and the caller overrides both with the args `check` and `install`. In genie they resolve to exactly `bun run check` and `bun install --frozen-lockfile` | Hardcoded Bun commands are why a non-Bun repository cannot pass. Genie has `bun.lock` and a `check` script, so the discovery rules (Decision 6) yield today's two commands |
| 2 | **Owner, 2026-10-02.** Hook liveness is generalized. With any hook system, the gate requires a live `pre-push` or `pre-commit` hook (not `.sample`) in the resolved hooks directory: `core.hooksPath`, or `git rev-parse --git-path hooks`. The `.husky/_/pre-push` file check applies only when that directory is `.husky/_` (husky 9), as amended by Decision 15 | lefthook, pre-commit, `core.hooksPath` and `.githooks` repositories have live hooks that are not husky's file |
| 3 | **Owner, 2026-10-02.** When a repository has hooks but no discoverable check command, the gate runs the frozen validation command, the same path as no hook system. The run report and the PR body say so, and CI is the authority | Read-back already requires green remote checks before `merge-ready`, so a narrower local gate cannot ship a red branch |
| 4 | **Owner, 2026-10-02.** Delivery is by plan: this wish, then `work`, then a PR to `dev`. Promotion and a new stable are the operator's, and the wish ends at a merge-ready PR to `dev` | `/wish` refuses to edit its own file, a trust-boundary path |
| 5 | **Owner-ratified, 2026-10-02.** The hooks directory must be inside the worktree or the repository's git directory. It is the directory `git rev-parse --path-format=absolute --git-path hooks` resolves to when run from the worktree, which honours `core.hooksPath`, compared after `pwd -P`. A global hooks path, `/dev/null` and foreign directories stay refused | Probed on 2026-10-02 with git 2.55. In a linked worktree, pre-commit and lefthook install into `<common-dir>/hooks`, which is outside the worktree, and those hooks fire on commit there. A literal "inside the worktree" would block every pre-commit and lefthook repository, the bug this wish fixes. Husky resolves inside the worktree, as before |
| 6 | Discovery reads the repository ROOT only; in a monorepo or pnpm workspace, only root scripts count.<br><br>**Manager**, from the root lockfile: `bun.lock`/`bun.lockb` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json`/`npm-shrinkwrap.json` → npm.<br><br>**Install** is that manager's frozen install: `bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `yarn install --immutable` with `.yarnrc.yml` or `yarn install --frozen-lockfile` without, `npm ci`. With no lockfile there is no install command, even when package.json declares dependencies. The operator then sees `Install command: (none discovered — the executor installs nothing)`, and the run fails in one of two ways:<ul><li>Husky 9: liveness prints `dead: the hooks directory git resolves does not exist`, because nothing materialised `.husky/_` in the fresh worktree, and the run ends `blocked`.</li><li>Otherwise: the check fails on missing modules and the gate is red.</li></ul>The remedy is to commit a lockfile or pass `install`.<br><br>**Check** is the first match in this order:<ol><li>a package.json `check` script → `<manager> run check`, with npm when there is no lockfile;</li><li>a Makefile `check` target → `make check`;</li><li>a justfile `check` recipe → `just check`;</li><li>a Taskfile `check` task → `task check`;</li><li>a package.json `test` script → `<manager> run test`, unless it is npm's placeholder `echo "Error: no test specified" && exit 1`;</li><li>a Makefile `test` target → `make test`.</li></ol>A hook manager's config is never the check, and a command no tracked root file names is never proposed | Covers the owner's examples and both fixture shapes, and gives genie's commands byte for byte. An explicit `check` anywhere beats any `test`, because a target named `check` is the repository saying "this is the aggregate gate". The placeholder `test` script exits 1 by design, so taking it would make every gate red |
| 7 | The blind judge never authors a command. `plan.checkCommand` and `plan.installCommand` are REQUIRED scout fields, `''` meaning none. The judge's contract may echo them, and the script accepts a judged value only when it equals the scout's. Otherwise the script takes the scout's value and logs the mismatch. Precedence is the caller's arg, then the scout's value as written into the contract at the judge step | The judge sees no repository, so a command it wrote would be invented. A required scout field forces an explicit answer, and an omitted one would silently downgrade genie's gate to its validation command. The top-level `SCOUT_SCHEMA` required list, which a parity test pins, does not change |
| 8 | The refusal sees what a command runs. For each repository-sourced command, the scout quotes in `commandEvidence` what it runs:<ul><li>for a package.json check, the script body, plus its `pre<name>`/`post<name>` bodies when defined;</li><li>for a Makefile, justfile or Taskfile check, the target's own recipe lines, plus those of prerequisite targets it names in the same file;</li><li>for an install, the lockfile path, plus the root `preinstall`, `install`, `postinstall` and `prepare` script bodies.</li></ul>`freezeCommand(proposed, evidence, fromRepository)` runs `validationRefusal` (a git push, a gh verb that changes the remote, a package publish) over the command plus that evidence. A repository command that arrives with no evidence is frozen empty. A refused or unevidenced check is frozen empty, so the gate falls back to validation and names why. A refused or unevidenced install is frozen empty, so the executor installs nothing. A caller-set command is checked as written. The validation command keeps today's literal check. Deeper indirection, such as a script calling another script or a tool reading its own config, is the repository's own code, trusted the way its hooks are | One function and one rule set covering three commands. Checking the command text alone would pass `npm run check` whose body pushes. Going one level deep covers what the invocation itself runs, and anything past that the repository already runs on every commit through its hooks. The gate's read-only brief still refuses a command that would write outside the worktree |
| 9 | The darwin tolerance is genie-shaped: it keys on `contract.checkCommand === GENIE_CHECK_COMMAND` (`'bun run check'`) plus genie's exact test names. The five names and the `node_modules` base re-confirm item are rendered into the gate prompt only for that check, and `normalizeGate(raw, darwinInScope)` refuses tolerance otherwise | Another Bun repository whose check is also `bun run check` sees the section, but can never match genie's file-qualified names, and its base re-confirm would fail. The re-confirm assumes Bun and `node_modules`. Genie's gate prompt keeps the section unchanged |
| 10 | `const CHECK_COMMAND` becomes `const GENIE_CHECK_COMMAND = 'bun run check'`, used only for the darwin scope, and `const INSTALL_COMMAND` is deleted. The parity pin moves with it. This is the one parity pin that changes | Decision 1 makes the check command contract data, so a constant named as the default would mislead |
| 11 | Liveness is one verbatim POSIX `sh -c` command, `HOOKS_LIVE_COMMAND`, which prints `live: <hook>` and exits 0, or prints `dead: <reason>` and exits 1. It holds Decision 5's containment test, husky 9's `.husky/_/pre-push` file check (Decision 15) and the executable `pre-push`/`pre-commit` test. The gate runs it and quotes its line in `hooksReason`, and the gate prompt's separate `test -f .husky/_/pre-push` item is removed | Decision 2 is a multi-part predicate run by a low-effort worker gate. As code it runs against real git on both CI legs, and the probe showed the traps: linked-worktree resolution, and macOS `/var` vs `/private/var`, handled with `pwd -P` |
| 12 | The script picks the gate's command with `gateCommand(contract, noHookSystem)`, which returns the check, the validation for no hook system, or the validation for no check command. The stops, the report's `Ran:` line, the PR body's gate line and a new `gateCommand` field on the returned result all read that one choice | The report names the command from the frozen contract, not from the gate's own account. The result field lets a verifier read the choice from the run record |
| 13 | A hook system with no check command and no validation command ends `blocked` with nothing pushed, at the first gate and at every repair-round gate | This extends the existing "no hook system and no validation command" stop |
| 14 | `skills/merge/SKILL.md`'s gate block names the repository's own aggregate check, with genie's `bun run check` as one example | It is a shipped skill that runs in any repository. Leaving the hardcoded Bun command there is the same defect |
| 15 | **Owner, 2026-10-02.** Husky 6 to 8 is covered. Those versions use `core.hooksPath=.husky`, with hooks at `.husky/pre-commit` and `.husky/_` holding only `husky.sh`, so the general predicate applies. The `.husky/_/pre-push` file check applies only when the resolved hooks directory is `.husky/_` (husky 9). The hooks test carries a case for each | Probed on 2026-10-02. husky 8.0.3's directory resolves to `.husky` and is live through `.husky/pre-commit`; a non-executable `pre-commit` is dead. husky 9.1.7's directory resolves to `.husky/_` and is live through `pre-push`; with `pre-push` removed it is dead |
| 16 | **Owner, 2026-10-02.** The Group 3 end-to-end runs are approved with two belts. Each nested `claude -p` session gets a `--settings` file that wires genie's `.claude/hooks/git-safety.sh` by absolute path. The procedure asserts `test -z "$GH_REPO$GH_HOST"` before any run. The runs stay out of the ledger, with no `genie wish report --append` | A fixture session is outside genie's checkout, so genie's project hooks would not load. `GH_REPO`/`GH_HOST` could hand `gh` a real repository. Fixture runs are proofs, not deliveries, and would skew the ledger's per-workflow averages |
| 17 | Group 3 verifies from each run's own workflow record, `<claude>/projects/*/<session>/workflows/<runId>.json`, where `<claude>` is `$CLAUDE_CONFIG_DIR` or `~/.claude`. It reads `result.state`, `result.contract`, `result.gate`, `result.gateCommand` and `result.report` with `jq`, and the session id is pinned with `--session-id`. It never greps text a model printed | The record is what the script returned, so a model's retelling can neither invent nor drop a line. Pinning the session id makes the record's path known before the run |

## Simplicity Case

- **Simplest complete design:** two contract fields, two caller args, one scout rule list with quoted evidence, one liveness command, one script-side command choice and one parameter on `normalizeGate`. No new stage, no new agent call, no script-side IO, and the nine agent calls and their model routing are unchanged.
- **Added machinery:**
  - `checkCommand` and `installCommand` on the scout plan and the contract. Decision 1 requires them.
  - `commandEvidence`, so the admission refusal sees what a repository command runs (Decision 8). Without it, `npm run check` with a pushing body passes.
  - `HOOKS_LIVE_COMMAND`. Decision 2's predicate is a containment test, a husky 9 file test and an executable-file test. The probe found a linked-worktree trap and a macOS path trap, and only a real-git test on both legs catches those.
  - `gateCommand` and its result field, so the report, the PR body and the run record name the command that ran from the contract.
- **Deferred until measured:**
  - A per-repository config file. Trigger: a real repository whose check the rule list cannot express.
  - Runner inference without a tracked root target. Trigger: a real run whose validation fallback passes while its CI fails.
  - Workspace-package scripts. Trigger: a real monorepo whose root defines no check while its CI runs a workspace one.
  - Following indirection past one level. Trigger: a real repository whose check reaches the remote through a script it calls.
  - Hooks directories outside the repository. Trigger: a real run blocked on demonstrably live global hooks.
  - A darwin roster per repository. Trigger: another repository with platform-known failures.
  - Latching the hook classification across repair rounds, carried over from `wish-gate-no-hook-system`. Trigger: an observed classification flip.
  - A repository-neutral `narrowerThanGate` in `scripts/mikro/triage.ts`. Trigger: triage is wired into `/wish`.
- **Complexity removed:** two constants that posed as defaults. The script detects no language. No executor-side discovery. The judge authors no command. One refusal function covers three commands.

## Dependencies

**depends-on:** none
**blocks:** none

This wish blocks `genie-launch` (owner, 2026-10-02), because the public docs pages that wish rewrites describe this gate. The edge is not written as a `blocks` slug yet. `genie-launch` has no WISH.md on `dev`, only `.genie/brainstorms/genie-launch/DESIGN.md`, and the wish linter refuses a `blocks` slug that names no wish. `bun run check` runs that linter, so a dangling slug would fail CI. The edge lands with whichever wish reaches `dev` second: either the `genie-launch` WISH.md lists `wish-gate-any-repo` under depends-on, or this wish's blocks key changes to `genie-launch` in the commit that adds that WISH.md.

## Success Criteria

- [ ] With a live hook system and a discoverable check, the gate runs that check, for example `npm run check` or `make check`, and the report's Gate section names it in a `Ran:` line.
- [ ] With a hook system and no discoverable check, the gate runs the frozen validation command. The run report and the PR body both say `no check command was discovered in this repository` and that CI is the authority.
- [ ] Liveness passes on an executable `pre-push` or `pre-commit` in the hooks directory git resolves from the worktree, inside the worktree or the repository's git directory. When that directory is husky 9's `.husky/_`, `pre-push` must also exist; husky 6 to 8 passes on the general rule. Any other answer, with a hook system, ends `blocked` with nothing pushed.
- [ ] The caller's `check` and `install` override discovery. The blind judge never authors a command.
- [ ] A check or install command is refused at admission when it, or the evidence of what it runs, pushes, changes the remote or publishes. A repository command with no quoted evidence is frozen empty.
- [ ] In genie, the contract resolves to `bun run check` and `bun install --frozen-lockfile`, and the executor's install sentence is byte-identical to today's. The darwin tolerance and its base re-confirm appear only for that check.
- [ ] Three throwaway fixtures under `S/gate-fixtures/` each reach the gate and pass it on a trivial change: npm + husky, pre-commit + Makefile with no package.json, and lefthook with no discoverable check. `verify.sh` proves it from the run records and exits 0.
- [ ] `bun run check` exits 0 on the branch head, and the linux and darwin CI legs are green.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | High: trust-boundary workflow file, prompt text pinned by parity tests, fail-closed stops on a push boundary, an admission refusal over quoted evidence, real-git tests that must hold on linux and darwin; ~5 files, ~650 insertions | reasoner · high effort (5.5 generation) | Contract-carried check and install with evidence, generalized liveness, validation fallback, darwin scope, report lines, tests |

### Wave 2 (parallel, disjoint files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | Low: prose in three shipped or in-repo texts under a 95-line cap and existing parity pins; ~3 files, ~25 insertions | worker · medium effort (5.5 generation) | Front door, workflow README row, merge skill gate block |
| 3 | qa | Medium: three live workflow runs (~20 min and ~400k tokens each) depending on npm, PyPI via `uvx`, `jq` and a nested session; no repository file | worker · medium effort (5.5 generation); each run routes its own stages by `TIERS` | End-to-end proof on three throwaway fixtures, read from the run records |

**Global constraints:**
- Base `dev`; branch `wish/wish-gate-any-repo`; one PR against `dev`. Promotion and a new stable are the operator's.
- Run `umask 022` in every shell and `bun install --frozen-lockfile` once per worktree. Never run two full `bun test` runs concurrently on this host.
- Never push over dead hooks. Never bypass a hook (`--no-verify`, `HUSKY=`, `-c core.hooksPath`), never force-push, never merge.
- A discovered or caller-set check or install command that would push, merge, publish or write outside the worktree is refused, by the same rule the validation command already has.
- The trust-boundary `DENYLIST` is unchanged.
- The darwin tolerance applies only to genie's own check (`bun run check`).
- Every existing genie behavior stays byte-equivalent where the parity tests pin it, unless a decision above changes it. In genie, the commands resolve to exactly `bun run check` and `bun install --frozen-lockfile`.
- `GATE_SCHEMA`'s required list stays `['hooksLive', 'exitCode', 'pass', 'problems', 'summaryLine']`. `SCOUT_SCHEMA`'s top-level required list stays `['facts', 'plan', 'estimate', 'injectionAttempts']`. The nine labelled agent calls keep their model options.
- `skills/wish/SKILL.md` stays at most 95 lines. Public text names no private repository, project or person.
- Lint with `./node_modules/.bin/biome`, never a bare `bunx biome`. `bun run check` is required wherever `wish.js`, skills or tests change.
- Linux and macOS are both stable targets. Add no platform literal to a test without checking it against both CI legs.
- Docs pages under `docs/` are out of scope. In-repo READMEs and skill text that describe the gate are in scope.
- Models: the 5.5 generation only.

Group 1 owns `wish.js` and every test file. Group 2 owns only prose, and Group 3 owns no repository file. They run in parallel after Group 1 because their files are disjoint and neither changes `wish.js`. If a repair changes `wish.js` after Group 3 has run, Group 3 runs again on the new head.

Size against the study's band: 9 files and about 675 code and test insertions, plus this WISH.md (about 630 lines), about 1,300 in all. That is inside the 25-file and 2,000-insertion maximum and above the 800-insertion ideal, and the excess is the plan itself. No group alone exceeds the ideal.

## Execution Groups

### Group 1: The gate runs the repository's own commands over any live hook system

**Goal:** `wish.js` carries the repository's discovered check and install commands in the frozen contract, refuses one whose quoted body would push or publish, accepts any live hook system, falls back to the validation command when no check is discoverable, scopes the darwin tolerance to genie's check, and names the command it ran — with tests that pin every path.

**Deliverables:**
1. `.claude/workflows/wish.js`:
   - Constants. Delete `CHECK_COMMAND` and `INSTALL_COMMAND`. Add `GENIE_CHECK_COMMAND`, `HOOKS_LIVE_COMMAND` (exact text under Interfaces) and `COMMAND_DISCOVERY`, one string per Decision 6 rule plus the Decision 8 evidence rule. Add `check?, install?` to `INTAKE_ERROR` before `timestamp`, and to the header comment's FROZEN list.
   - `normalizeInput` returns `check: text(input.check)` and `install: text(input.install)`.
   - `SCOUT_SCHEMA.plan` gains the required `checkCommand` and `installCommand` (`''` = none) and the optional `commandEvidence`. `scoutPrompt` interpolates `COMMAND_DISCOVERY` as one section.
   - `JUDGE_SCHEMA.contract` gains the optional `checkCommand` and `installCommand`, described as an echo of the scout's value, never authored. Its `oracle` and `validationCommand` descriptions stop naming a fixed command.
   - `judgePrompt`'s oracle sentence reads `job.check || scout.plan.checkCommand`, or `the repository check` when both are empty, and tells the judge to echo the scout's two commands or leave them out.
   - The contract build follows Decisions 7 and 8. For each of check and install:
     - log a judged value that differs from the scout's, and ignore it;
     - take `job.<arg>` as caller-set, or else the scout's value as repository-sourced with that command's `commandEvidence` quotes;
     - freeze it with `freezeCommand`.

     `validationCommand` goes through `freezeCommand(proposed, [], false)`, so its behavior is unchanged. The contract also carries `commandSource` and `commandEvidence`.
   - `WORK_DISCIPLINE` and `VERIFY_CHANGE` become `workDiscipline(contract)` and `verifyChange(contract)`. For a genie-shaped contract, their text is byte-identical to today's. Without a check command, the brief says the gate runs the frozen validation command. Without an install command, the remedy line says none was frozen and never offers sudo or a system package manager.
   - `executorPrompt`'s install item runs `contract.installCommand` before the first commit. With none, the item says install nothing and set `installed` false.
   - `gatePrompt`:
     - Adds a `Frozen check command:` header line.
     - The install item appears only when one was frozen.
     - `HOOKS_LIVE_COMMAND` runs with a hook system only. The separate `test -f .husky/_/pre-push` item and the old "configured hooks path must resolve inside this worktree" item are removed.
     - The selected-command sentence follows `gateCommand`.
     - The darwin section and the base re-confirm item render only when `darwinInScope`.
     - The no-hook paragraph's refusal sentence is unchanged, and the same refusal covers the check command.
   - Script side:
     - `const darwinInScope = contract.checkCommand === GENIE_CHECK_COMMAND`, and both `normalizeGate` call sites pass it.
     - Both gate stops apply `gateCommand`: an empty selected command ends `blocked`, with the existing wording when there is no hook system and Decision 13's wording when there is no check. The dead-hooks stop is unchanged.
     - `publishPrompt` takes `gateMode` in place of `noHookSystem`.
     - The publish gate summary is prefixed per mode.
     - `contractSection` and `gateSection` render the lines under Interfaces.
     - The no-hook line says "in place of a repository check".
     - `finish` returns `gateCommand`: the last gate's `{command, mode}`, or `null` when no gate answered.
   - `meta.phases` Admit, Work and Gate details and `meta.whenToUse` describe discovery with evidence, the install-when-frozen rule, generalized liveness, the fallback and the darwin scope. Phase titles do not change.
2. `scripts/wish-workflow-behavior.test.ts`:
   - The `canned()` scout plan gains:
     - `checkCommand: 'bun run check'` and `installCommand: 'bun install --frozen-lockfile'`;
     - `commandEvidence`: `{command: 'check', path: 'package.json', quote: '<genie's check script body>'}` and `{command: 'install', path: 'bun.lock', quote: 'bun.lock'}`.
   - The judge contract echoes the two commands.
   - Cases (1)–(27) keep their assertions, except (19)'s `test -f .husky/_/pre-push` assertion. That assertion becomes "the gate prompt contains `HOOKS_LIVE_COMMAND`", because the owner's Decision 15 moves the husky 9 file check inside it.
   - New cases cover each Acceptance Criterion below that a canned run can show.
3. `scripts/wish-workflow-logic.test.ts`:
   - Lift `freezeCommand` and `gateCommand`, and change the `normalizeGate` lift to the new signature. Existing darwin cases pass `true`.
   - New cases: `normalizeGate(answer, false)` never tolerates; `normalizeInput` returns `check` and `install`, trimmed, `''` when absent; `freezeCommand` covers the refusals and the missing-evidence rule; `gateCommand` returns all three modes.
4. `scripts/wish-workflow-parity.test.ts`:
   - The pin moves to `const GENIE_CHECK_COMMAND = 'bun run check'`, and no `const CHECK_COMMAND` or `const INSTALL_COMMAND` remains.
   - The failing-checks mismatch pin and the required-list pins are unchanged.
   - In the git-safety describe, `HOOKS_LIVE_COMMAND`, lifted from `wish.js`, is allowed (exit 0).
5. `scripts/wish-gate-hooks.test.ts` (new): executes the lifted `HOOKS_LIVE_COMMAND` with `spawnSync('sh', ['-c', …])` in real git repositories under a temp dir.
   - Every spawned git and sh gets `GIT_CONFIG_GLOBAL` set to an empty temp file and `GIT_CONFIG_NOSYSTEM=1`. Hook modes are set with `chmodSync`, never left to umask.
   - Fixture `core.hooksPath` values are written by the test through `spawnSync('git', ['config', …])`, never typed into an agent's shell, which the git-safety hook rightly refuses.
   - The husky layouts are built by hand (files plus config), with no npm install, so the test needs no network.

**Interfaces:**
- Consumes: none
- Produces:
  - `normalizeInput(raw) → {objective, issue, context, slug, slugTruncated, base, rejection, repairBudget, model, gateModel, publishModel, check: string, install: string, timestamp} | null`
  - `freezeCommand(proposed: string, evidence: string[], fromRepository: boolean) → {command: string, refused: string}`. `refused` takes one of four shapes:
    - `''`
    - `'<proposed> — <rule>'`, the rule found in the command itself
    - `'<proposed> — <rule> in what it runs'`, found only in the evidence
    - `'<proposed> — no command evidence was quoted'`

    `<rule>` is one of `validationRefusal`'s three rule names.
  - `gateCommand(contract, noHookSystem: boolean) → {command: string, mode: 'check' | 'no-hook-system' | 'no-check-command'}`
  - `normalizeGate(raw, darwinInScope: boolean) → {…existing fields unchanged}`
  - `workDiscipline(contract) → string[]` and `verifyChange(contract) → string`
  - `publishPrompt(job, contract, worktree, branch, headSha, gateSummary, verdict, gateMode)`
  - `const GENIE_CHECK_COMMAND = 'bun run check'`
  - `const COMMAND_DISCOVERY: string[]`
  - `SCOUT_SCHEMA.properties.plan`:
    - `required = ['approach', 'files', 'validationCommand', 'focusedTest', 'checkCommand', 'installCommand']`
    - optional `commandEvidence: [{command: 'check' | 'install', path: string, quote: string}]`, where `quote` is verbatim text from `path`.
  - `JUDGE_SCHEMA.properties.contract.properties` gains `checkCommand: string` and `installCommand: string`, both optional and echo-only.
  - The contract gains:
    - `checkCommand`, `checkRefused`, `installCommand`, `installRefused`: strings
    - `commandSource: {check, install}`, each `'caller' | 'repository' | 'none'`
    - `commandEvidence: string[]` of `'<path> (<check|install>)'`. Paths only; the quotes stay in the scout result.
  - The returned result gains `gateCommand: {command: string, mode: string} | null`.
  - Report lines, exact. The contract section:
    - `Check command:` takes one of four shapes:
      - `Check command: <cmd> (discovered in the repository)`
      - `Check command: <cmd> (set by the caller)`
      - `Check command: (none discovered — the gate runs the validation command in its place)`
      - `Check command: (none frozen — refused at admission: <refused>)`
    - `Install command:` takes the same four shapes, its none form being `Install command: (none discovered — the executor installs nothing)`.
    - `Command evidence: <contract.commandEvidence joined by '; '>` appears when any was quoted.

    The gate section has one line in every mode:
    - check: `Ran: <cmd> — the repository check frozen at admission`
    - no hook system: `Ran: <cmd> — the frozen validation command: no hook system was found`
    - no check command: `Ran: <cmd> — the frozen validation command: no check command was discovered in this repository. CI is the authority: the remote checks must pass at read-back`
  - PR body gate prefixes:
    - check: `ran <cmd> — `
    - no hook system: `no hook system — ran <cmd> in place of a repository check; CI is the authority — `
    - no check command: `no check command was discovered in this repository — ran <cmd>; CI is the authority — `
  - `HOOKS_LIVE_COMMAND`, exactly. It was probed on 2026-10-02 against husky 9.1.7, husky 8.0.3, pre-commit, lefthook and genie's own worktree:

```sh
sh -c 'd=$(cd "$(git rev-parse --path-format=absolute --git-path hooks)" 2>/dev/null && pwd -P) || { echo "dead: the hooks directory git resolves does not exist"; exit 1; }; w=$(cd "$(git rev-parse --show-toplevel)" && pwd -P); c=$(cd "$(git rev-parse --path-format=absolute --git-common-dir)" && pwd -P); case "$d/" in "$w/"*|"$c/"*) ;; *) echo "dead: $d is outside the worktree and the repository git directory"; exit 1;; esac; case "$d" in */.husky/_) [ -f "$d/pre-push" ] || { echo "dead: the husky 9 hooks directory $d has no pre-push"; exit 1; };; esac; for h in pre-push pre-commit; do if [ -f "$d/$h" ] && [ -x "$d/$h" ]; then echo "live: $d/$h"; exit 0; fi; done; echo "dead: no executable pre-push or pre-commit in $d"; exit 1'
```

**Acceptance Criteria:**
- [ ] A genie-shaped canned run (check `bun run check`, install `bun install --frozen-lockfile`, with evidence):
  - It ends `merge-ready`.
  - The executor prompt contains, byte for byte, `Run bun install --frozen-lockfile in the worktree BEFORE your first commit, so the repository prepare step materialises the git hooks — a commit made before that runs is a commit no hook saw.`
  - The gate prompt contains every `DARWIN_TOLERATED` test name and `ln -s <this worktree>/node_modules`.
  - The report contains `Ran: bun run check — the repository check frozen at admission`, and `result.gateCommand` equals `{command: 'bun run check', mode: 'check'}`.
  - Behavior cases (9) and (10) pass with no edit to their assertions. Case (19) passes with its one husky assertion replaced, as Deliverable 2 states.
- [ ] An npm-shaped canned run (`npm run check`, `npm ci`, with evidence):
  - It ends `merge-ready`.
  - The executor prompt contains `Run npm ci in the worktree BEFORE your first commit` and no `bun install`.
  - The gate prompt contains `npm run check`, none of the five `DARWIN_TOLERATED` test names, and no `node_modules`.
  - The report contains `Check command: npm run check (discovered in the repository)`, `Install command: npm ci (discovered in the repository)` and `Ran: npm run check`.
- [ ] A hook-system run with `checkCommand: ''` and validation `bun test src/lib/fixture.test.ts --bail`:
  - The gate prompt says the validation command runs in place of a check.
  - The report contains `no check command was discovered in this repository`, the validation command and `CI is the authority`.
  - The `publish:pr` prompt's Gate line contains `no check command was discovered in this repository`.
  - `result.gateCommand.mode` is `no-check-command`.
- [ ] A hook-system run with no check command and no validation command ends `blocked`, at `gate:check` and at `gate:round-1` after a FIX-FIRST. `blockedReason` contains `no check command` and `no validation command`, and no `publish:pr` prompt is recorded.
- [ ] A dead-hooks answer still ends `blocked` with `hooks are not live` for `hookSystem` `husky`, `other` and absent, whatever the contract's commands are.
- [ ] Caller `check: 'make ci'` and `install: 'make deps'`, against a scout that discovered `npm run check` and `npm ci`:
  - The gate prompt and the executor prompt carry the caller's commands.
  - The report says `(set by the caller)`.
- [ ] Judge echo: a judge contract with `checkCommand: 'npm run lint'`, against a scout's `npm run check`, freezes `npm run check`, and a log line names both values.
- [ ] Refusals at admission:
  - `npm run check && git push origin HEAD` as the command is refused.
  - `npm run check` whose `check` evidence quote is `node --test && git push origin HEAD` is refused, the report saying `a git push in what it runs`.
  - In both cases, the gate falls back to the validation command, and no gate, executor or publish prompt contains `git push origin`.
  - An install whose `prepare` evidence quote contains `npm publish` is refused, and the executor prompt says to install nothing.
- [ ] Missing evidence: a scout check `npm run check` with no `check` entry in `commandEvidence` is frozen empty. The report contains `no command evidence was quoted`, and the gate falls back to the validation command. A caller-set `check` needs no evidence.
- [ ] The scout prompt carries the discovery rules:
  - the root-only rule;
  - the order package.json `check`, Makefile `check`, `just check`, `task check`, package.json `test`, Makefile `test`;
  - the exclusion of `echo "Error: no test specified" && exit 1`;
  - the no-lockfile no-install rule;
  - the Decision 8 evidence rule.
- [ ] The gate prompt contains `HOOKS_LIVE_COMMAND` verbatim. It no longer contains `the configured hooks path must resolve inside this worktree`, or a standalone `test -f .husky/_/pre-push` item.
- [ ] Logic tests:
  - `normalizeGate(fiveKnownFailuresAnswer, false)` returns `pass: false, darwinTolerated: false`, and the same answer with `true` still tolerates.
  - `gateCommand` returns all three modes.
  - `freezeCommand` behaves as follows:
    - It refuses each of the three rules in the command and in the evidence.
    - It returns the missing-evidence refusal only when `fromRepository` is true.
    - It keeps `bun run check` with genie's evidence.
- [ ] `scripts/wish-gate-hooks.test.ts` passes on linux and darwin.

  It asserts `live:` and exit 0 for:
  - husky 9: `core.hooksPath .husky/_` with `.husky/_/pre-push` and `pre-commit`
  - husky 6 to 8: `core.hooksPath .husky`, an executable `.husky/pre-commit`, and `.husky/_` holding only `husky.sh`
  - `.git/hooks/pre-commit` seen from a linked worktree
  - a tracked `.githooks` with `core.hooksPath .githooks`

  It asserts `dead:` and exit 1 for:
  - husky 9 with `.husky/_` absent
  - husky 9 with `.husky/_` holding `pre-commit` but no `pre-push`
  - husky 6 to 8 with a non-executable `.husky/pre-commit`
  - only `.sample` hooks
  - a non-executable `pre-push`
  - `core.hooksPath /dev/null`
  - `core.hooksPath` at a directory outside the repository that holds an executable `pre-push`
- [ ] The parity test pins `const GENIE_CHECK_COMMAND = 'bun run check'` and the absence of `const CHECK_COMMAND` and `const INSTALL_COMMAND`. It proves the git-safety hook allows `HOOKS_LIVE_COMMAND`. Its required-list, nine-call routing and failing-checks pins pass unedited.

**Validation:**
```bash
umask 022 && bun test scripts/wish-workflow-behavior.test.ts scripts/wish-workflow-logic.test.ts scripts/wish-workflow-parity.test.ts scripts/wish-gate-hooks.test.ts scripts/wish-workflow-mikro.test.ts scripts/workflows-meta.test.ts scripts/workflows-model-policy.test.ts scripts/workflow-routing.test.ts && ./node_modules/.bin/biome check scripts/wish-workflow-behavior.test.ts scripts/wish-workflow-logic.test.ts scripts/wish-workflow-parity.test.ts scripts/wish-gate-hooks.test.ts && bun run check
```

**depends-on:** none

---

### Group 2: The front doors describe the gate any repository gets

**Goal:** The wish front door, the workflow catalog row and the merge skill describe a gate that runs the repository's own check over any live hook system, with no Bun- or husky-only wording left.

**Deliverables:**
1. `skills/wish/SKILL.md`:
   - **Invoke:** list `check?, install?` in `INTAKE_ERROR`'s order, plus one sentence. The scout discovers the repository's check and install commands from its own root files and quotes what they run; the script freezes them at the judge step; these two args override them.
   - **Relay:** the `blocked` line names a hook system with no check or validation command to run.
   - **By-hand section:**
     - The scout reports the discovered check and install commands with the evidence of what each runs.
     - The executor runs the frozen install command, when there is one, before its first commit.
     - The gate asserts a live `pre-push` or `pre-commit` hook and runs the repository's check once. With no hook system or no discoverable check, it runs the contract's validation command once and leaves full verification to CI.
   - The file stays at most 95 lines.
2. `.claude/workflows/README.md`: the `wish` row's `args` gain `check?, install?`, plus one clause on discovery and the validation fallback. The historical run rows are untouched.
3. `skills/merge/SKILL.md`, "Re-run the gate":
   - It runs the repository's own full gate: the aggregate check its hooks and CI run. Examples: `bun run check` in genie, `npm run check` or `make check` elsewhere.
   - It no longer states that one Bun command is typecheck, lint, dead-code and tests.
   - The "only proof the merge is sound" rule is kept.

**Interfaces:**
- Consumes: from Group 1, the arg names `check` and `install` and their place in `INTAKE_ERROR` (before `timestamp`); the phrase `no check command was discovered in this repository`; the liveness rule "an executable `pre-push` or `pre-commit` in the hooks directory git resolves from the worktree".
- Produces: none

**Acceptance Criteria:**
- [ ] `skills/wish/SKILL.md`'s Invoke key list equals `INTAKE_ERROR`'s key list in `wish.js`, in order, `check?` and `install?` included.
- [ ] The by-hand section still lists its seven stage phrases in parity order. It names discovered check and install commands with their evidence, a live `pre-push` or `pre-commit` hook, and the validation fallback for no hook system or no discoverable check.
- [ ] `skills/wish/SKILL.md` is at most 95 lines, and `scripts/wish-workflow-parity.test.ts` and `scripts/release-docs.test.ts` pass unedited by this group.
- [ ] The README `wish` row lists `check?, install?` and states the fallback in one clause. Every other row is byte-identical.
- [ ] `skills/merge/SKILL.md` names the repository's own aggregate check with `bun run check` as genie's example, and `bun run skills:lint` passes.

**Validation:**
```bash
umask 022 && bun test scripts/wish-workflow-parity.test.ts scripts/release-docs.test.ts scripts/skills-lint.test.ts scripts/front-door-workflow-parity.test.ts && bun run check
```

**depends-on:** 1

---

### Group 3: End-to-end proof on three throwaway fixture repositories

**Goal:** Run the saved workflow from Group 1's `wish.js` against three throwaway repositories and prove from each run's own workflow record that the gate was reached and passed on a trivial change, that it ran the expected command over live hooks, and that nothing left the fixture's local bare origin.

**Deliverables:**
1. `S/gate-fixtures/build-fixtures.sh`, verbatim below and run once. `S` is the orchestrator's scratch directory, outside every checkout, exported as `S` before any command below; a reviewer sets their own. A dry run of this exact script on 2026-10-02 built all three fixtures, with their hooks firing on the seed commits.
2. Three sequential runs of the saved workflow, one per fixture, each from a nested `claude -p` session whose working directory is the fixture.
   - Each session has a pinned `--session-id`, recorded in `S/gate-fixtures/sessions/<fixture>`.
   - Each session has a `--settings` file that wires genie's `git-safety.sh` by absolute path.
   - The session's own reply goes to `S/gate-fixtures/logs/<fixture>.txt` and is never used as evidence.
3. `S/gate-fixtures/verify.sh`, verbatim below, exiting 0. It reads the three run records with `jq`.
4. An evidence summary for the orchestrator to append under Review Results, one line per fixture, taken from the record with `jq`: `runId`, `result.state`, `result.stageReached`, `result.contract.checkCommand` and `.installCommand`, `result.gate.hookSystem`, `.hooksLive` and `.pass`, `result.gateCommand`, and `totalTokens`. Add `genie wish report <runId>` printed WITHOUT `--append` (Decision 16).

Build the fixtures. Each has a bare local origin carrying `main` and `dev`, so the workflow can cut from `origin/dev` and push with no forge:

```sh
#!/bin/sh
# Builds the three throwaway gate fixtures of wish-gate-any-repo under $1. Needs git >= 2.31, node + npm,
# python3, make and uvx on PATH, and network access to the npm registry and PyPI.
set -eu
umask 022
mkdir -p "$1"
F=$(cd "$1" && pwd -P)

seed() {
  rm -rf "${F:?}/$1" "${F:?}/$1.git"
  git init -q --bare -b main "$F/$1.git"
  git init -q -b main "$F/$1"
  git -C "$F/$1" config user.name 'Gate Fixture'
  git -C "$F/$1" config user.email 'fixture@example.invalid'
  git -C "$F/$1" remote add origin "$F/$1.git"
}

publish() {
  git -C "$F/$1" add -A
  git -C "$F/$1" commit -q -m 'chore: seed the fixture'
  git -C "$F/$1" push -q origin main main:dev
  git -C "$F/$1" fetch -q origin
  git -C "$F/$1" remote set-head origin main
}

# 1. npm + husky, with a `check` script: discovery must give `npm ci` and `npm run check`.
seed npm-husky
cd "$F/npm-husky"
cat > package.json <<'EOF'
{
  "name": "gate-fixture-npm-husky",
  "version": "1.0.0",
  "private": true,
  "scripts": { "prepare": "husky", "check": "node --test", "test": "node --test" },
  "devDependencies": { "husky": "9.1.7" }
}
EOF
printf 'node_modules/\n' > .gitignore
printf 'exports.greet = (name) => `Hello, ${name}`;\n' > greet.js
mkdir -p test
cat > test/greet.test.js <<'EOF'
const test = require('node:test');
const assert = require('node:assert');
const { greet } = require('../greet.js');

test('greet names the person', () => assert.strictEqual(greet('Ada'), 'Hello, Ada'));
EOF
npm install --no-audit --no-fund --silent
printf 'npm run check\n' > .husky/pre-commit
printf 'npm run check\n' > .husky/pre-push
publish npm-husky

# 2. pre-commit + a Makefile `check` target, no package.json: discovery must give `make check`, no install.
seed precommit-make
cd "$F/precommit-make"
printf '.PHONY: check\ncheck:\n\tpython3 -m unittest discover -s tests\n' > Makefile
printf '__pycache__/\n' > .gitignore
printf 'def greet(name):\n    return f"Hello, {name}"\n' > greet.py
mkdir -p tests
printf 'import unittest\n\nfrom greet import greet\n\n\nclass GreetTest(unittest.TestCase):\n    def test_names_the_person(self):\n        self.assertEqual(greet("Ada"), "Hello, Ada")\n' > tests/test_greet.py
cat > .pre-commit-config.yaml <<'EOF'
repos:
  - repo: local
    hooks:
      - id: make-check
        name: make check
        entry: make check
        language: system
        pass_filenames: false
EOF
uvx --quiet pre-commit install
publish precommit-make

# 3. lefthook, no package.json, no Makefile, no task runner: no discoverable check, so the gate falls back.
seed lefthook-nocheck
cd "$F/lefthook-nocheck"
printf 'greet() {\n  printf "Hello, %%s\\n" "$1"\n}\n' > greet.sh
printf 'pre-commit:\n  commands:\n    syntax:\n      run: sh -n greet.sh\n' > lefthook.yml
printf '# Greeting\n\nSource greet.sh and call greet with a name.\n' > README.md
uvx --quiet lefthook install
publish lefthook-nocheck

for name in npm-husky precommit-make lefthook-nocheck; do
  printf '%s: dev=%s hooks=%s\n' "$name" "$(git -C "$F/$name" rev-parse --short origin/dev)" \
    "$(git -C "$F/$name" rev-parse --path-format=absolute --git-path hooks)"
done
```

Run the workflow against each fixture, one at a time. `WT` is the worktree holding `wish/wish-gate-any-repo` at the head under review. A print-mode session exposes the workflow surface; this was probed on 2026-10-02. Each session runs only inside its throwaway fixture, whose one remote is a local bare repository, and under genie's git-safety hook:

```sh
umask 022
: "${S:?export S as the scratch directory}" "${WT:?export WT as the worktree holding wish/wish-gate-any-repo}"
F=$S/gate-fixtures
test -z "$(git config --global --get core.hooksPath)"   # a global hooks path resolves outside every fixture, by design
test -z "$GH_REPO$GH_HOST"                              # gh must have no repository to fall back on
command -v jq >/dev/null                                # verify.sh reads the run records with jq
sh "$F/build-fixtures.sh" "$F"
mkdir -p "$F/sessions" "$F/logs"
cat > "$F/claude-settings.json" <<EOF
{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "bash '$WT/.claude/hooks/git-safety.sh'", "timeout": 5}]}]}}
EOF
run() {
  sid=$(python3 -c 'import uuid; print(uuid.uuid4())')
  printf '%s\n' "$sid" > "$F/sessions/$1"
  ( cd "$F/$1" && claude -p --session-id "$sid" --settings "$F/claude-settings.json" \
      --permission-mode bypassPermissions --add-dir "$WT/.claude/workflows" \
      "Run the saved workflow at the explicit script path $WT/.claude/workflows/wish.js with args {\"objective\": \"$2\", \"slug\": \"farewell\", \"base\": \"dev\", \"repairBudget\": 1, \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}. Wait until it returns, then reply with its run id and state only." \
  ) > "$F/logs/$1.txt" 2>&1
}
run npm-husky "Add a farewell(name) function to greet.js that returns 'Goodbye, <name>', exported beside greet, with a test in test/greet.test.js."
run precommit-make "Add a farewell(name) function to greet.py that returns 'Goodbye, <name>', with a test in tests/test_greet.py."
run lefthook-nocheck "Add a farewell function to greet.sh that prints 'Goodbye, <name>' the way greet prints its greeting."
sh "$F/verify.sh"
```

If print mode exits before a fixture's run record appears, rerun that fixture interactively. Use `claude --session-id <new uuid> --settings "$F/claude-settings.json"` in the fixture with the same prompt, and write the new id to `sessions/<fixture>`. Each run is expected to end `blocked` at Read-back, because a fixture has no forge and no pull request can open there. That is not a failure of this wish. A run that ends `refused`, or `missed` before its first gate answered, is a failure, and the run is repeated.

`S/gate-fixtures/verify.sh`:

```sh
#!/bin/sh
# Reads each fixture run's own workflow record (never a model's retelling) with jq, and exits non-zero unless
# the run was admitted, its gate ran the expected command over live hooks and passed, and nothing left the
# fixture's local bare origin.
F=$(cd "$(dirname "$0")" && pwd -P)
C=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
status=0
fail() { echo "FAIL $1: $2"; status=1; }
expect() { [ "$(jq -r "$2" "$record")" = true ] || fail "$1" "record fails: $2"; }

for name in npm-husky precommit-make lefthook-nocheck; do
  sid=$(cat "$F/sessions/$name" 2>/dev/null) || { fail "$name" 'no session id recorded'; continue; }
  set -- "$C"/projects/*/"$sid"/workflows/*.json
  if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then fail "$name" "expected exactly one run record for session $sid"; continue; fi
  record=$1
  expect "$name" '.workflowName == "wish"'
  expect "$name" '.result.state != null and .result.state != "refused"'
  expect "$name" '.result.gate.hooksLive == true and .result.gate.pass == true'
  case $name in
    npm-husky)
      expect "$name" '.result.contract.checkCommand == "npm run check" and .result.contract.installCommand == "npm ci"'
      expect "$name" '.result.gate.hookSystem == "husky"'
      expect "$name" '.result.gateCommand.mode == "check" and .result.gateCommand.command == "npm run check"'
      expect "$name" '.result.report | contains("Ran: npm run check")' ;;
    precommit-make)
      expect "$name" '.result.contract.checkCommand == "make check" and .result.contract.installCommand == ""'
      expect "$name" '.result.gate.hookSystem == "other"'
      expect "$name" '.result.gateCommand.mode == "check" and .result.gateCommand.command == "make check"'
      expect "$name" '.result.report | contains("Ran: make check")' ;;
    lefthook-nocheck)
      expect "$name" '.result.contract.checkCommand == "" and .result.gate.hookSystem == "other"'
      expect "$name" '.result.gateCommand.mode == "no-check-command" and .result.gateCommand.command == .result.contract.validationCommand'
      expect "$name" '.result.report | contains("no check command was discovered in this repository") and contains("CI is the authority")' ;;
  esac
  # Nothing left the fixture. Checked: its one remote is the local bare origin, no pushurl or url rewrite
  # redirects a push, the bare origin holds only main, dev and the wish branch, and main and dev still sit
  # on the seed commit.
  [ "$(git -C "$F/$name" remote)" = origin ] || fail "$name" "a remote other than origin exists"
  [ "$(git -C "$F/$name" remote get-url --push --all origin)" = "$F/$name.git" ] || fail "$name" 'origin pushes somewhere else'
  [ -z "$(git -C "$F/$name" config --get-regexp '^url\.' 2>/dev/null)" ] || fail "$name" 'a url rewrite is configured'
  extra=$(git -C "$F/$name.git" for-each-ref --format='%(refname)' | grep -v -x -e refs/heads/main -e refs/heads/dev -e refs/heads/wish/farewell)
  [ -z "$extra" ] || fail "$name" "unexpected refs on the bare origin: $extra"
  seed=$(git -C "$F/$name" rev-parse main)
  [ "$(git -C "$F/$name.git" rev-parse main)" = "$seed" ] && [ "$(git -C "$F/$name.git" rev-parse dev)" = "$seed" ] \
    || fail "$name" 'main or dev moved on the bare origin'
  echo "$name: $(jq -r '(.runId // "no-run-id") + " state=" + (.result.state // "none")' "$record")"
done
[ "$status" -eq 0 ] && echo 'all three fixtures reached the gate, passed it, and stayed local'
exit "$status"
```

**Interfaces:**
- Consumes: from Group 1:
  - `.claude/workflows/wish.js` at the branch head;
  - the returned result fields `state`, `contract.checkCommand`, `contract.installCommand`, `contract.validationCommand`, `gate.hookSystem`, `gate.hooksLive`, `gate.pass`, `gateCommand` and `report`;
  - the report phrases `Ran: <cmd>`, `no check command was discovered in this repository` and `CI is the authority`.
- Produces: the three run records (located through `S/gate-fixtures/sessions/<fixture>`) and the evidence summary in Deliverable 4.

**Acceptance Criteria:**
- [ ] `build-fixtures.sh` exits 0 and prints three `hooks=` lines: `…/npm-husky/.husky/_` and the `.git/hooks` of the other two.
- [ ] Before any run, the procedure's three assertions pass: no global `core.hooksPath`, `test -z "$GH_REPO$GH_HOST"`, and `jq` on PATH. Each session ran with `--settings "$F/claude-settings.json"` and `--session-id` from `sessions/<fixture>`.
- [ ] `npm-husky`'s run record shows:
  - contract `npm run check` / `npm ci`
  - `gate.hookSystem` `husky`, with `hooksLive` and `pass` true
  - `gateCommand` `{command: 'npm run check', mode: 'check'}`
  - a report containing `Ran: npm run check`
- [ ] `precommit-make`'s run record shows:
  - contract `make check` / `''`
  - `gate.hookSystem` `other`, with `hooksLive` and `pass` true
  - `gateCommand` `{command: 'make check', mode: 'check'}`
  - a report containing `Ran: make check`
- [ ] `lefthook-nocheck`'s run record shows:
  - contract check `''`
  - `gate.hookSystem` `other`, with `hooksLive` and `pass` true
  - `gateCommand.mode` `no-check-command` running the frozen validation command
  - a report containing `no check command was discovered in this repository` and `CI is the authority`
- [ ] No record's `result.state` is `refused`. For every fixture:
  - the only remote is the local bare origin, with no push URL or url rewrite;
  - the bare origin holds only `main`, `dev` and `wish/farewell`;
  - `main` and `dev` are unmoved.
- [ ] `verify.sh` exits 0, and no run was appended to the ledger.

**Validation:**
```bash
sh "${S:?export S as the scratch directory holding gate-fixtures}/gate-fixtures/verify.sh"
```

**depends-on:** 1

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] A `/wish` run in genie on `dev` freezes `Check command: bun run check (discovered in the repository)` and `Install command: bun install --frozen-lockfile (discovered in the repository)`. It answers `hookSystem: husky` with `Hooks live: yes`, prints `Ran: bun run check — the repository check frozen at admission`, and ends `merge-ready` or `pr-open`.
- [ ] A forge-backed `/wish` run on a real non-Bun repository with git hooks, a scratch GitHub repository of the owner's choosing, reaches `pr-open` or `merge-ready`. Its report and PR body name the discovered check.
- [ ] The focused wish workflow files and `scripts/wish-gate-hooks.test.ts` pass on both the linux and darwin CI legs.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| The scout answers `''` for genie's check, or quotes no evidence for it, so a genie run gates on its validation command only | Medium | The plan field is required, Decision 6 puts a package.json `check` script first, and the evidence rule is spelled out in `COMMAND_DISCOVERY`. The report and the PR body announce the fallback with its reason, read-back still requires CI to pass, and QA criterion 1 watches genie's run |
| A discovered command is repository text that the executor and the gate now run | Medium | The admission refusal runs over the command and the quoted body of what it runs (Decision 8). A command with no evidence is frozen empty. The gate's read-only brief stays. Both commands are rendered in the report and the PR body, and the caller can override them. Deeper indirection is trusted the way the repository's hooks are |
| The scout misquotes or truncates a script body, so the refusal misses a push | Low | The quote must be verbatim text from the named path, and the reviewer and the operator see the evidence paths in the report. Past admission, the gate's read-only brief and the publisher's allowlist still stand between a command and the remote |
| The blind judge writes a different command | Low | It is ignored and logged (Decision 7); the scout's value stands |
| An install command writes outside the worktree, to the package manager's own cache | Low | `bun install --frozen-lockfile` does the same on every genie run today. The rule targets the repository and the remote, not the package manager's cache |
| macOS path canonicalisation (`/var` vs `/private/var`) fails the containment test and blocks genie on darwin hosts | Medium | `pwd -P` on all three paths, and `scripts/wish-gate-hooks.test.ts` runs on the darwin leg |
| The git-safety hook refuses `HOOKS_LIVE_COMMAND`, so every genie run ends `blocked` | Medium | A parity test runs the hook over the lifted command and requires exit 0. The command reads hooks state and changes none |
| A global `core.hooksPath` outside the repository blocks a repository whose hooks are live | Low | This fails closed by design (owner-ratified Decision 5) and is named in OUT, with a trigger to revisit. The fixture procedure asserts no global hooks path |
| The end-to-end runs cost about 1.2M tokens and an hour, and lean on npm, PyPI, `jq` and a nested session | Low | The runs are sequential with `repairBudget: 1`. Every external tool was probed on 2026-10-02, and an interactive session with a pinned id is the fallback if print mode exits early |
| The `genie-launch` blocks edge is not machine-checked until its WISH.md lands | Low | The edge is recorded in Dependencies prose, and the second wish to reach `dev` carries it |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

---

## Files to Create/Modify

```
.claude/workflows/wish.js
scripts/wish-workflow-behavior.test.ts
scripts/wish-workflow-logic.test.ts
scripts/wish-workflow-parity.test.ts
scripts/wish-gate-hooks.test.ts
skills/wish/SKILL.md
skills/merge/SKILL.md
.claude/workflows/README.md
.genie/wishes/wish-gate-any-repo/WISH.md
```
