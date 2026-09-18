# Wish: Global workflows and mikro runtime, repo-local mikro agents

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `global-workflows-local-mikro` |
| **Date** | 2026-09-18 |
| **Author** | Felipe Rosa (delegated from a khal-base session; orchestrated autonomously) |
| **Appetite** | large |
| **Branch** | `wish/global-workflows-local-mikro` (one stacked branch per group: `wish/global-workflows-local-mikro-g<n>`) |
| **Repos touched** | automagik-dev/genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Observed 2026-09-18 from `/home/genie/workspace/repos/khal-base` on genie v5.260918.8: `Workflow name=council` answered `Workflow "council" not found. Available: deep-research`, because the workflow catalog exists only in this repository's project scope, and `wish.js` hardcodes `bun scripts/mikro/call.ts`, a path only genie has — so every other repository silently falls to the skills' by-hand path and the mikro offload never runs. This wish makes the workflow catalog and the mikro runtime global (shipped by the genie install, on PATH), while mikro agents stay local to the repository and specialize per repository behind a trust boundary that a PR cannot cross. The owner's direction, verbatim: "workflows and runtime global; mikro agents local, expanding specialized per repo".

## Scope

### IN

- `genie mikro call <agent> ...`: the `scripts/mikro/call.ts` runtime (with `facts`, `schemas`, `boundary`, `phoenix`, `status`) bundled into the shipped binary; `wish.js` `MIKRO_CALL` points at it; the graceful "unavailable" branch stays.
- A generic default agent set (`wish-context`, `review-prep`) shipped inside the existing `templates/` payload member, so a repository with no `.mikro/` still gets a working agent.
- The workflow catalog (`.claude/workflows/*.js`) shipped inside `templates/` and installed by `genie install` / `genie update` to `~/.claude/workflows/`, with per-file sha256 digests in `skills-install.json`; `genie doctor` reports missing, stale and hand-edited copies; `genie uninstall` removes only digest-proven copies.
- Every front-door skill invokes its workflow by explicit script path (project copy when present, else the user-scope copy), never by bare name; the parity tests pin that.
- Repo-first agent resolution with the trust boundary kept: agents and `.mikro/` configuration are read from the repository's object store at the base ref, never from the working tree of a PR or executor worktree; an adversarial test proves a PR cannot rewrite the prompt of the agent that reviews it.
- `genie mikro bench` / `genie mikro coach` runnable against another repository's `.mikro/agents` and fixtures; fixtures buildable from commits (for repositories with no PRs); `genie mikro init` seeds `wish-context` and `review-prep` into a new repository, documented.

### OUT

- Any change to the tarball's top-level member set (`INSTALL_PAYLOAD_MEMBERS` stays the frozen 8; the previous release's promoter validates it as an exact set).
- Shipping the `mikro` binary itself, a DeepSeek key, or `~/.mikro/gate-env.sh`: `genie mikro call` degrades to the unavailable answer when `mikro` is not on PATH.
- Per-repository answer schemas. The registry (`schemas.ts`) stays global: a repository specializes what an agent knows, never the answer shape or the set of agent names.
- Moving `triage.ts`, `adversarial.ts` and the genie-specific fixtures out of `scripts/mikro/`; a nightly coach job; a coach `--apply`.
- Installing workflows into any product home other than Claude Code's `~/.claude/workflows/`; the DSH body keeps reading the repository catalog through `dsh-workflow-fork`.
- A public operator page under `docs/` (the `automagik-dev/docs` submodule): a second repository and a sixth PR; the repo-local README section and `genie mikro init`'s own output carry the documentation.
- Editing anything in khal-base other than the delegation status file named in the task.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Command name `genie mikro` with verbs `call`, `bench`, `coach`, `fixtures`, `init`. | Matches the CLI's group pattern (`task`, `omni`); one PATH command satisfies the workflow contract's "no absolute path in a script". |
| 2 | The runtime stays where it is. `src/term-commands/mikro.ts` imports `scripts/mikro/call.ts` (and, in Group 5, `bench.ts` / `coach.ts`) in place; the entry code under `import.meta.main` becomes exported `run*Cli(argv)` functions that the guard and the CLI both call. Relocating `scripts/mikro/` under `src/` is a deferred refactor wish. | Measured by the plan reviewer: under the `src/**` Biome rules the moved files score 29, 55 and 33 (`call.ts:129`, `call.ts:242`, `facts.ts:547`) and `score.ts:71` scores 38, against a ratcheted budget of `maxScore: 42` — a move is a decomposition project, not a delivery step, and it would also hide `triage.ts` / `adversarial.ts` consumers from knip. `tsc` follows the import (strict typecheck is gained), Biome overrides are path-based (unchanged), and knip reports only `src/**` project files (unchanged). |
| 3 | Workflows and default agents ship INSIDE the existing `templates/` member: `scripts/build-binary.sh` stages `.claude/workflows/*.js` to `templates/workflows/` and `.mikro/agents/{wish-context,review-prep}/{agent.yaml,SYSTEM.md}` to `templates/mikro/agents/`. No second tracked copy in the repository. | The top-level set is frozen (the 5.260901.1 incident); `templates/` already converges to `<GENIE_HOME>/templates` through `convergeAuxiliaryTree` on both install and update, executed by old and new binaries alike. A tracked duplicate would drift. |
| 4 | The install record gains ONE optional field, `workflows?: {dir, ref, files: Record<name, sha256>}`, in `skills-install.json`. | Optional for the same reason as `source`/`dirDigests`: a required field invalidates every record on disk and disarms `genie uninstall`. One record keeps doctor and uninstall on one authority. With no readable install record after the skills channel ran (consent `none`, skills failure, malformed record), the workflows channel installs NOTHING and says `workflows: skipped (no install record — run genie update)`: a file genie cannot record is a file `genie uninstall` can never remove. |
| 5 | A user-scope workflow file that matches neither the recorded digest nor the delivered one is archived under `<GENIE_HOME>/state-backups/workflows-collision-<compact ISO>/` and then replaced, with one transcript line naming it. A file that matches the recorded digest is replaced silently; one that already matches the delivered digest is left alone. A catalog name this release drops is archived only when its digest still matches the record, otherwise preserved and reported. | Backup-first is the house rule; the 2026-09-15 stale `council.js` shadowed the repository copy, so leaving a stale file in place is the failure being fixed. Catalog names are genie's namespace. |
| 6 | The workflows channel obeys consent `none` (skipped, nothing written) and never creates `~/.claude`: with no `~/.claude` directory it reports `workflows: skipped (no ~/.claude)`. | Same contract as the skills channel: genie creates no product home. |
| 7 | Front-door skills name the path rule, not the saved name: "run the script at `<repository root>/.claude/workflows/<name>.js` when that file exists, otherwise `~/.claude/workflows/<name>.js`; pass it as the explicit script path, never the bare name". The by-hand section stays as the fallback when neither file exists. | Shadowing order between scopes is undocumented and once resolved to a stale copy; after this wish the genie repository carries every name in both scopes. Verified 2026-09-18 before planning: a zero-agent probe run by explicit script path from a directory outside the project returned `{ok: true}` (run `wf_f01915ef-42a`), so the runtime accepts a user-scope path. The sentence must fit inside existing paragraph lines: `skills/wish/SKILL.md` is 85 lines against a 90-line lint ceiling, and `wish` stays runtime-neutral. `skills/workfly/SKILL.md:42`, which tells future authors to name "the saved name", is part of the edit set. |
| 8 | The trusted source of agent files and `.mikro/` configuration is a git REF read in the INVOKING checkout (the git toplevel of the process cwd) — never in `--dir`, which is the tree under review and may be a separate clone with an attacker-chosen `origin`. `--agents-ref <ref>` names it; the default is `<base>` = the target of the invoking checkout's `origin/HEAD`, taken as the LOCAL branch `<base>` when `origin/<base>` is an ancestor of it (so a committed-but-unpushed agent on a commit-to-base repository is used) and as `origin/<base>` otherwise; with no resolvable base the repository agents are not used and the shipped default is, with the reason reported. Agent files are materialized with `git archive <ref> .mikro/agents/<name>` into a 0700 temp dir that is removed after the run. Without the flag, `untrustedConfig` compares `<dir>/.mikro/{mikro.yaml,TOOLS.md,SYSTEM.md,CRITERIA.md}` against the blobs at that ref in the invoking checkout for EVERY `--dir`, the invoking checkout included, and on every agent source, `shipped` included: a file absent from `<dir>` is fine, a file present in `<dir>` and absent or different at the ref is refused. This deliberately removes today's same-directory exemption (`call.ts:801`, asserted at `call.test.ts:347`) on the no-flag path: a session started inside a PR checkout must not trust that checkout's `TOOLS.md`. The consequence is stated, not hidden: an UNCOMMITTED edit to those four files in the invoking checkout refuses every no-flag call with the `config:` error, whose text names the escape — `--agents-dir <checkout>/.mikro/agents`, the operator-typed flag whose semantics Decision 9 keeps (trusted root = that checkout, same-directory exemption intact), which is the operator's authoring path. The measuring tools are operator tools over the operator's own working tree, not reviews of untrusted content, so they take that path explicitly: `bench.ts` with no `--agents-dir` passes `<dir>/.mikro/agents` to `runAgent` (the bench RECORD still omits the key, so a no-flag record stays byte-identical), and therefore the coach's BEFORE bench (`coach.ts:596`, which passes no flag today) keeps measuring the same working-tree `SYSTEM.md` its printed diff is computed from, while AFTER keeps passing the patched copy. Only `genie mikro call` without the flag — the path `wish.js` uses — resolves through the ref. A refusal is REMOVED by this, and is stated rather than hidden: today a no-flag `bench --dir <other repo>` compares that repository's four configuration files against the invoking genie checkout and refuses a differing `TOOLS.md` (Python injected into the REPL); on the measuring path the synthesized trusted root equals `--dir`, the same-directory exemption applies, and that tree's configuration is loaded and executed. `bench` and `coach` must therefore only be pointed at a tree the operator trusts — never at a PR checkout or an unaudited clone; reviewing untrusted content is `genie mikro call`'s job. The local-base rule trusts every commit on the operator's local base branch, including one merged locally from an unreviewed PR; `wish.js` never relies on it (it passes `--agents-ref origin/<base>`), and the README says so. Outside any git repository the trusted root is the cwd, only `--dir` = cwd is accepted with configuration, and agents are the shipped ones. | "Primary checkout at the base branch" as a directory is unreliable (the primary checkout may sit on any branch, or be dirty). A ref in the common object store is exactly "the base branch", is identical from every worktree, and cannot be changed by editing a PR worktree. |
| 9 | An explicit `--agents-dir` keeps today's semantics byte for byte (trusted root derived from the directory two levels up). `MIKRO_AGENTS_DIR` is NOT an input, and already is not: `call.ts` only WRITES it into the child environment (`:777`, `:920`). The change is a README correction (`scripts/mikro/README.md:26`, `:349`), not a code removal. | The coach loop and every recorded bench rely on the explicit flag; an operator-typed flag is operator trust. An environment variable is ambient and would let a contaminated shell redirect the reviewer's prompt; the README sentence claiming it is corrected. |
| 10 | Resolution order without the flag: repository agent at the trusted ref → shipped default `<GENIE_HOME>/templates/mikro/agents/<name>` → `ok: false` "no agent". The answer names which source won in `agentSource: 'flag' \| 'repo@<ref>' \| 'shipped'`. | Repo-first per the owner's direction; the source must be visible so a silent fallback cannot hide a broken repository agent. |
| 11 | The run ledger goes to `<repo primary root>/.mikro/runs` when the repository tracks a `.mikro/` directory, else to `<GENIE_HOME>/mikro/runs/<basename>-<sha256(root)[:8]>/`. | A repository that never opted into mikro must not grow untracked files; genie's own history stays where it is. |
| 12 | Fixtures resolve `--fixtures` → `<dir>/.mikro/fixtures/<agent>.json` → `<dir>/scripts/mikro/fixtures/<agent>.json` (genie's legacy location, unchanged). `genie mikro fixtures --from-commits <range> --agent <wish-context\|review-prep>` derives truth mechanically: files = `git show --name-only`, prompt = the commit subject (wish-context) or "Prepare the review of commit <sha> against <sha>^" (review-prep); commits whose files no longer exist at HEAD are skipped and counted. | khal-base commits straight to main; the PR-derived recipe is hand-executed prose today and cannot apply there. |
| 13 | The catalog ships whole (every `.claude/workflows/*.js`, including `pm-ledger-verify` and `observability-review`, which have no front-door skill). | A filter is a second list to keep in parity; a workflow without a front door is still invocable by path, and the static contract test already covers every file. |
| 14 | Delivery is five PRs against `dev`, one per group, in two stacks off Group 1 (1 → 2 → 3 and 1 → 4 → 5), each independently reviewed at its exact SHA; nothing is merged by this wish. | Task instruction: never push to dev or main, never merge; groups 1 and 2 unblock every non-genie repository and reach a PR first. |

## Simplicity Case

- **Simplest complete design:** one new command group over code that already exists; one staging step into a payload member that already converges; one optional record field; one path sentence in each front-door skill; one ref-based lookup replacing a directory-based one.
- **Added machinery:** the `workflows` record field (required by "a stale copy is detectable"); the `git archive` materialization (required by "a PR cannot rewrite the prompt of the agent that reviews it"); the commit-fixture builder (required by khal-base having no PRs).
- **Deferred until measured:** per-repository schemas; a shape-tolerant promoter; workflows for non-Claude product homes; coach `--apply`; any nightly loop. Adoption trigger: a second repository whose agents cannot be expressed under the global schemas.
- **Complexity removed:** no new tarball member; no second tracked copy of the catalog; no name-shadowing reliance; no relocation of 4,700 lines under `src/`; no `import.meta.url`-relative agent lookup (it cannot work inside a compiled binary).

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] From a repository that is not genie and has no `.claude/workflows/`, the `council` and `wish` skills run the saved workflow by explicit path, and a wish run reports a mikro offload with `ok: true`.
- [ ] `genie install` / `genie update` report, and `genie doctor` warns about, a stale or hand-edited `~/.claude/workflows/<name>.js`.
- [ ] With `.mikro/agents/wish-context/SYSTEM.md` present at the base ref, that prompt is used (`agentSource: 'repo@<ref>'`); with the same file changed only in a PR worktree or in a separate clone passed as `--dir`, the base-ref prompt of the invoking checkout is still the one used, and an adversarial test proves it.
- [ ] `genie mikro bench` and `genie mikro coach` run against another repository's agents and commit-derived fixtures.
- [ ] Gate: every group passes its Validation locally (`check:fast` plus its focused tests); the authoritative full gate (`bun run check`, i.e. the Quality Gate) is CI on the dev-targeting PR, because this host cannot run the full `bun test` beside another agent. Every PR carries an independent review verdict recorded under Review Results.
- [ ] The old-binary update hop accepts the new tarball (`"outcome":"committed"`), proven with the hop oracle.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | High: first `src/` → `scripts/` import, compiled-binary behaviour, a release script | opus | `genie mikro call`, shipped default agents, `wish.js` MIKRO_CALL |

### Wave 2 (parallel, isolated worktrees, both after Group 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | High: installer, record schema, update convergence | opus | Workflow catalog install channel with digests |
| 4 | engineer | High: trust boundary; adversarial proof required | opus | Repo-first resolution at a trusted ref |

### Wave 3 (parallel, isolated worktrees)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | Medium: observation paths plus seven skills and their parity tests; after Group 2 | opus | Doctor, uninstall, explicit-path skills |
| 5 | engineer | Medium: tooling over stable interfaces; after Group 4 | opus | Portable bench/coach, commit fixtures, `mikro init`, README section |

**Global constraints:**
- Never push to `dev` or `main`, never force, never merge, never bypass a hook; every PR targets `dev`.
- `INSTALL_PAYLOAD_MEMBERS` stays exactly `['.agents', '.claude-plugin', 'LICENSE', 'VERSION', 'genie', 'plugins', 'skills', 'templates']`; nothing staged under `templates/` is a symlink or a special file.
- Workflow scripts contain no absolute or home-relative path, no `import`, `require`, `process`, `fs`, `fetch`, timers, `Date.now()` or `Math.random()` (`scripts/workflows-meta.test.ts`).
- New record fields are optional; an unreadable record fails closed; nothing under `<GENIE_HOME>/state-backups/` written by an earlier run is ever removed.
- Genie creates no product home; consent `none` skips every channel.
- Doctor is read-only, including under `--fix`.
- `scripts/mikro/` files are not relocated; `scripts/complexity-budget.ts` ceilings are not raised.
- `src/` style: `.js` import specifiers for `src/` modules, no `console.log`, cognitive complexity ceiling 25, Biome single quotes / 2 spaces / 120 columns; tests colocated, `bun:test`, tmpdir fixtures, real git repositories, `GENIE_HOME` isolated to a tmpdir.
- `release-docs.test.ts` derives the command list from `genie --help`: a new top-level command updates README.md ("17 CLI commands" plus its table row) and CLAUDE.md ("Seventeen top-level commands" plus its table row) in the same group.
- Never assert a spawn-failure transcript against one runtime's wording (`ENOENT` vs Bun's `Executable not found in $PATH`).
- This host: `umask 022` before any gate; never run the full `bun test` concurrently with another agent.
- The registry decides the agent NAME and answer schema; a directory or ref decides only WHERE the agent's files are read from.
- Every git call in new code uses `git -C <dir>` with an argv array; a ref is validated with `git check-ref-format` and refused when it starts with `-`.

Each PR's description names the PR it stacks on. Shared appended files across groups: `CLAUDE.md` (Groups 1, 3, 5) and `scripts/mikro/README.md` (Groups 1, 4, 5), where each group appends its own section; the Wave 2 pair (2, 4) is fully disjoint. Shared code files (`scripts/mikro/call.ts`, `bench.ts`, `src/term-commands/mikro.ts`, `wish.js`, `scripts/wish-workflow-mikro.test.ts`) all sit inside the sequential 1 → 4 → 5 chain. Expected merge order is 1, 2, 3, 4, 5; a later PR rebases its appended section over the earlier one (rebase of the group branch before its PR leaves draft, never of `dev`). `checkWorkflowsChannel` stays linear or extracted: `doctor.ts` already carries a function at 26 against the ceiling of 25.

## Execution Groups

### Group 1: Global mikro runtime (`genie mikro call`)

**Goal:** Any repository on a host with genie installed can run `genie mikro call wish-context ...` and get a verified answer, and `wish.js` uses it.

**Deliverables:**
1. `scripts/mikro/call.ts`: the `import.meta.main` block becomes exported `runCallCli(argv: string[]): Promise<number>`; the guard calls it. A built-bundle test proves `dist/genie.js --version` and `dist/genie.js mikro call` (no agent) do not execute another module's entry block.
2. `src/term-commands/mikro.ts` exporting `registerMikroCommands(program)`, registered in `src/genie.ts`; `genie mikro call <agent> [flags]` forwards argv untouched to `runCallCli` (`allowUnknownOption`, `passThroughOptions`) and exits with its code (0 ok, 1 not ok, 2 usage).
3. Agents-dir resolution without `import.meta.url` (it resolves inside `/$bunfs` in a compiled binary): `--agents-dir` → `<git toplevel of cwd>/.mikro/agents` when it holds `<agent>/agent.yaml` → `<GENIE_HOME>/templates/mikro/agents`. Trusted root: with the flag, unchanged (two levels above the agents dir); otherwise the git toplevel of cwd, whatever the agent source — never `<GENIE_HOME>/templates`. Ledger per Decision 11. `RunResult.agentSource` added. `mikro` missing from PATH yields `ok: false` JSON with an `unavailable:` error and exit 1, detected by error `code`, not by message text.
4. `scripts/build-binary.sh` stages `.mikro/agents/{wish-context,review-prep}/{agent.yaml,SYSTEM.md}` into `${STAGE}/templates/mikro/agents/`; `.github/workflows/build-tarballs.yml` paths filter and `scripts/release-docs.test.ts` cover the new input class (`.mikro/agents/**`, `scripts/mikro/**`).
5. `.claude/workflows/wish.js`: `const MIKRO_CALL = 'genie mikro call'`; the unavailable sentences say "no genie or no mikro on PATH"; the reviewer line drops "the checkout that carries scripts/mikro" but keeps "run it from the directory you were started in". `scripts/wish-workflow-mikro.test.ts`, `.claude/workflows/README.md`, `scripts/mikro/README.md`, README.md and CLAUDE.md (command count and table rows; README.md:158's bundle-size sentence re-measured from `bun run build`) updated.

**Interfaces:**
- Consumes: none
- Produces: `runCallCli(argv: string[]): Promise<number>`; `registerMikroCommands(program: Command): void`; `resolveAgentsDir(options: {agentsDir?: string; cwd: string; genieHome: string; agent: AgentName}): {dir: string; trustedRoot: string; source: 'flag' | 'repo' | 'shipped'} | null`; `shippedAgentsRoot(genieHome: string): string` = `<genieHome>/templates/mikro/agents`; `RunResult.agentSource?: string`.

**Acceptance Criteria:**
- [ ] `genie mikro call --help` lists the flags; an unregistered agent name exits 2.
- [ ] A test runs `runCallCli` from a tmp git repository with no `.mikro/` and a fake `GENIE_HOME` carrying `templates/mikro/agents/wish-context`, with an injected MCP opener: `agentSource` is `shipped`, the trusted root is the tmp repository, and nothing is written under `GENIE_HOME/templates`.
- [ ] A test proves that with `mikro` absent from PATH the command prints `ok: false` JSON and exits 1, under Bun's spawn-error wording.
- [ ] `bun scripts/mikro/call.ts` still works and `bench-options.test.ts`, `call.test.ts`, `coach.test.ts` are green unchanged.
- [ ] `bun run typecheck`, `bun run dead-code` and `bun run lint:complexity-budget` pass with `scripts/mikro/*` imported from `src/`.
- [ ] `bash scripts/build-binary.sh` output contains `templates/mikro/agents/wish-context/SYSTEM.md`, the top-level member set is unchanged, and the hop oracle prints `"outcome":"committed"` with the currently installed binary as promoter.
- [ ] `scripts/wish-workflow-mikro.test.ts` pins `genie mikro call`; `scripts/release-docs.test.ts` passes with 17 commands.

**Validation:**
```bash
umask 022 && bun run check:fast && bun run build && bun test src/term-commands/mikro.test.ts scripts/mikro scripts/wish-workflow-mikro.test.ts scripts/workflows-meta.test.ts scripts/release-docs.test.ts src/lib/install-promotion.test.ts
```

**depends-on:** none

---

### Group 2: Workflow catalog install channel

**Goal:** `genie install` / `genie update` deliver the catalog to `~/.claude/workflows/` with recorded digests.

**Deliverables:**
1. `scripts/build-binary.sh` stages every `.claude/workflows/*.js` (never `README.md`) into `${STAGE}/templates/workflows/`; release-docs pins and the tarball paths filter updated.
2. `src/lib/workflows-installer.ts`: `runWorkflowsChannelConvergence` per Decisions 4–6 and 13 — plan (digest every delivered and every existing same-named file), archive-first replace, retire dropped names, write the `workflows` field through the existing atomic record writer, emit aggregated `workflows:` lines with the summary last.
3. `skillsInstallRecordSchema` gains the optional `workflows` field; the skills channel carries an existing `workflows` value forward when it rewrites the record.
4. Wired after the skills channel in `install.ts` and in the update post-delivery convergence path (where `<GENIE_HOME>/templates` is already converged); a failure is non-fatal, sets `process.exitCode = 1` and prints the `genie update` remedy. `runManualUpdateConvergence`'s return gains a `workflows` leg, so the exact-shape assertions in `src/genie-commands/__tests__/update.test.ts` (`:2467`, `:2469-2471`) change in this group. Insertion ceiling for the group: 1,500 — the channel is a flat per-file plan over one directory, not the skills channel's multi-home discovery; its test covers the classification table and the five transcripts named below, nothing more.

**Interfaces:**
- Consumes: the Group 1 staging block in `build-binary.sh` (adjacent lines); `writeSkillsInstallRecord`, `inspectSkillsInstallRecord` (existing).
- Produces: `runWorkflowsChannelConvergence(options: {selection: IntegrationSelection; version: string; genieHome: string; home?: string}): Promise<{status: 'installed' | 'skipped' | 'failed'; warnings: string[]}>`; record field `workflows?: {dir: string; ref: string; files: Record<string, string>}` (file name → sha256 hex); `shippedWorkflowsRoot(genieHome: string): string` = `<genieHome>/templates/workflows`; `classifyWorkflowFile(args: {recorded?: string; delivered?: string; onDisk: string | null}): 'current' | 'replace' | 'modified' | 'missing' | 'foreign'`.

**Acceptance Criteria:**
- [ ] Fresh tmp HOME with `~/.claude`: every catalog file is installed and recorded; a second run is a no-op that creates no backup root.
- [ ] A hand-edited file is archived under `workflows-collision-<ts>`, replaced, and named in the transcript.
- [ ] Consent `none` writes nothing; no `~/.claude` writes and creates nothing; no readable install record installs nothing and says why.
- [ ] A dropped catalog name is archived only when its digest matches the record.
- [ ] A record without the `workflows` field still parses, and a skills-channel rewrite keeps an existing `workflows` value (regression tests).
- [ ] `bash scripts/build-binary.sh` output contains `templates/workflows/wish.js`; the top-level member set is unchanged.

**Validation:**
```bash
umask 022 && bun run check:fast && bun test src/lib/workflows-installer.test.ts src/lib/skills-installer.test.ts src/genie-commands/install.test.ts src/genie-commands/__tests__/update.test.ts scripts/release-docs.test.ts src/lib/install-promotion.test.ts
```

**depends-on:** Group 1

---

### Group 3: Workflow drift observation and explicit-path skills

**Goal:** Doctor and uninstall read the recorded digests, and every front-door skill runs its workflow by explicit path.

**Deliverables:**
1. `genie doctor`: `checkWorkflowsChannel` after `checkSkillsChannel` — one `workflows: <present>/<total> @ <ref>` line; warn naming up to five `modified`, `missing` or `stale` (record ref ≠ running binary) files with the `genie update` remedy; `not detected` without `~/.claude`; `(unrecorded)` without the field.
2. `genie uninstall`: removes recorded files whose digest still matches, preserves and reports the rest, removes `~/.claude/workflows` only when it is empty afterwards; a preserved file keeps GENIE_HOME and the record, as a preserved skill dir does.
3. The six front-door skills `council`, `wish`, `workfly`, `docs`, `research` and `skill-audit` (which is also the skill-intake front door, `scripts/skill-intake-workflow-parity.test.ts:12`) adopt the Decision 7 sentence; the seven parity tests (`council`, `docs-audit`, `research-sweep`, `skill-audit`, `skill-intake`, `wish`, `workfly`) replace the `` saved name `X` `` assertion with: contains the project path, contains `~/.claude/workflows/<name>.js`, contains `explicit script path`, and does not instruct a bare-name run. `wish` stays runtime-neutral and within the 90-line ceiling.
4. `.claude/workflows/README.md` Discovery section rewritten (both scopes legitimately carry the same names; explicit path is the rule; doctor is the drift detector); CLAUDE.md gotcha added.

**Interfaces:**
- Consumes: record field `workflows`, `classifyWorkflowFile`, `shippedWorkflowsRoot` from Group 2.
- Produces: `checkWorkflowsChannel(options?): CheckResult[]`; `removeWorkflowsChannelInstall(genieHome: string): {removed: string[]; preserved: {file: string; reason: string}[]}`.

**Acceptance Criteria:**
- [ ] Doctor warns `modified` on a hand-edited file, `missing` on a deleted one, `stale` on a record from another release, and passes on a clean install; it writes nothing.
- [ ] Uninstall removes digest-matching files only; an edited file survives and is reported.
- [ ] All seven parity tests and `bun run skills:lint` pass with the explicit-path wording.

**Validation:**
```bash
umask 022 && bun run check:fast && bun test src/genie-commands/doctor.test.ts src/genie-commands/uninstall.test.ts $(ls scripts/*-workflow-parity.test.ts)
```

**depends-on:** Group 2

---

### Group 4: Repo-first agent resolution behind a trusted ref

**Goal:** A repository's own `.mikro/agents/<name>/` wins over the shipped default, and only as it exists at the base ref of the invoking checkout.

**Deliverables:**
1. `scripts/mikro/trusted-source.ts` per Decision 8: resolve the trusted ref in the invoking checkout, materialize `.mikro/agents/<name>/{agent.yaml,SYSTEM.md}` with `git archive` into a 0700 temp dir removed in `finally`, read `.mikro/<config>` blobs with `git show`. It asserts the materialized files are non-empty and byte-equal to `git show <ref>:<path>`, so a future `export-ignore` / `export-subst` attribute cannot silently alter an agent.
2. `resolveAgentsDir` order becomes flag → repository at the trusted ref → shipped; `agentSource` reports `repo@<ref>`. `untrustedConfig` follows Decision 8 on every source; the flag path is unchanged.
3. `--agents-ref <ref>` on `genie mikro call`; `wish.js` passes `--agents-ref origin/${job.base}` on both offload lines; pins updated.
4. Adversarial tests with real git repositories, asserting through the injected opener the agents dir content AND that the child environment's `MIKRO_AGENTS_DIR` is the materialized dir (mikro's own project-agent discovery in `--dir` is overridden): (a) base carries `SYSTEM.md` = A; a linked worktree on a PR branch commits B and leaves an uncommitted C; run with `--dir <worktree>` and with cwd = the worktree → A. (b) the PR changes `.mikro/TOOLS.md` → refused with the `config:` error at zero cost, on the `repo` and on the `shipped` source. (c) `--dir` is a SEPARATE clone whose own `origin/HEAD` carries `SYSTEM.md` = D → A, never D. (d) a committed-but-unpushed agent on the local base branch is used; a local base branch that diverged from `origin/<base>` is not. (e) a ref beginning with `-` or failing `check-ref-format` exits 2.
5. `scripts/mikro/bench.ts` passes the working-tree agents dir to `runAgent` when no `--agents-dir` is given, without recording it (Decision 8); `coach.ts` is unchanged and inherits it on BEFORE.
6. README trust-boundary section rewritten, including which commands read the ref (`genie mikro call`) and which read the working tree (`bench`, `coach`), and that the measuring commands skip the configuration comparison by the `--dir`-equals-root exemption and so must only be pointed at a trusted tree; the `MIKRO_AGENTS_DIR` sentences corrected (Decision 9).

**Interfaces:**
- Consumes: `resolveAgentsDir`, `runCallCli`, `RunResult.agentSource` from Group 1.
- Produces: `resolveTrustedRef(invokingRoot: string, explicit?: string): {ref: string; reason: string} | {ref: null; reason: string}`; `materializeAgent(invokingRoot: string, ref: string, agent: AgentName): {agentsDir: string; dispose(): void} | null`; `readTrustedBlob(invokingRoot: string, ref: string, path: string): string | null`. The parameter is the invoking checkout, never `--dir`.

**Acceptance Criteria:**
- [ ] Cases (a)–(e) pass, and (a) and (c) are watched failing when the lookup is pointed at the working tree / at `--dir` (recorded in the PR body).
- [ ] No agent at the ref → `shipped`; no resolvable ref → `shipped` with the reason in the result.
- [ ] Temp material is removed on success, failure and thrown error.
- [ ] A bench test with an injected runner, in a real git repository whose working-tree `SYSTEM.md` differs from the committed one, proves the no-flag bench hands `runAgent` the working-tree agents dir (so the coach's BEFORE/AFTER pair and its printed diff describe the same change) that the written record carries no `agentsDir` key, and that the configuration comparison is skipped BECAUSE the trusted root equals `--dir` (asserted, so the exemption reads as chosen); `boundary.test.ts` stays green unchanged; `call.test.ts` CHANGES: the same-directory assertion at `:347` splits into flag path (still `null`) and no-flag path (compared against the ref), and a new test proves the refusal message names `--agents-dir`.

**Validation:**
```bash
umask 022 && bun run check:fast && bun test scripts/mikro src/term-commands/mikro.test.ts scripts/wish-workflow-mikro.test.ts
```

**depends-on:** Group 1

---

### Group 5: Per-repository growth (bench, coach, fixtures, init)

**Goal:** Another repository can seed, measure and improve its own agents with the installed genie alone.

**Deliverables:**
1. `genie mikro bench` and `genie mikro coach` registered over exported `runBenchCli` / `runCoachCli`. Fixture resolution per Decision 12; the coach prompt's `system`, `evidence` and `fixtures` paths derive from the resolved locations instead of the hardcoded `scripts/mikro/fixtures`.
2. `genie mikro fixtures --from-commits <range> --agent <wish-context|review-prep> [--out <path>] [--max <n>]` per Decision 12: deterministic order, merge commits skipped, skipped commits counted with a reason.
3. `genie mikro init [--dir <repo>]`: copies the shipped `wish-context` and `review-prep` into `<repo>/.mikro/agents/`, refuses to overwrite an existing agent, adds `.mikro/runs/` to `.gitignore` when absent, writes nothing outside `<repo>`, and prints the next commands in order: commit on the base branch, PUSH it (or rely on the local-base rule of Decision 8 and say which applies), build fixtures from commits, bench. It also prints the provider prerequisite below.
4. Docs, repo-local only: a `## Growing agents in another repository` section in `scripts/mikro/README.md` (seed → commit → push → fixtures from commits → bench → coach; why an uncommitted or PR-only agent is ignored; the host prerequisites: `mikro` ≥ 1.260909.1 on PATH, a `deepseek-api` provider with `deepseek-flash` in `~/.mikro/settings.json`, `DEEPSEEK_API_KEY`) and the CLAUDE.md gotcha. `genie mikro init` prints the same sequence, because an installed host has no README. A public page under `docs/` is a separate PR in `automagik-dev/docs` plus a submodule bump and is OUT.

**Interfaces:**
- Consumes: `resolveAgentsDir`, `resolveTrustedRef`, `shippedAgentsRoot`, `registerMikroCommands`.
- Produces: `buildCommitFixtures(options: {dir: string; range: string; agent: 'wish-context' | 'review-prep'; max?: number}): {fixtures: Fixture[]; skipped: {sha: string; reason: string}[]}`; `seedAgents(options: {dir: string; genieHome: string}): {written: string[]; refused: string[]}`.

**Acceptance Criteria:**
- [ ] In a tmp repository with three commits, `fixtures --from-commits` yields fixtures whose `truth.files` equal `git show --name-only`, skips a commit whose file was later deleted, and is byte-stable across two runs.
- [ ] `mikro init` twice: the second run refuses every agent and changes nothing; its output names the push step.
- [ ] `genie mikro bench wish-context --dir <other repo> --fixtures <built file>` runs end to end against an injected runner in tests; genie's own no-flag bench still resolves `scripts/mikro/fixtures`.
- [ ] `bun run lint:complexity-budget` passes (no `scripts/mikro` file moved under `src/`).

**Validation:**
```bash
umask 022 && bun run check:fast && bun test scripts/mikro src/term-commands/mikro.test.ts
```

**depends-on:** Group 4

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] On the dogfood host after `genie update --dev`: `ls ~/.claude/workflows` lists the catalog, `genie doctor` prints a passing `workflows:` line, and hand-editing one file turns it into a `modified` warning.
- [ ] From `/home/genie/workspace/repos/khal-base`: the `council` skill runs the saved workflow, and a `wish` run reports `Offload: wish-context ok`.
- [ ] `genie update` from the previous stable release to the release carrying this wish commits (hop), and `genie uninstall` on a scratch HOME removes the installed workflows.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| The previous binary's aux-tree convergence or promoter rejects nested content under `templates/` | Medium | The plan reviewer verified `verifyPayloadLayout` is top-level only and `payloadContentDigest`, `fingerprintAuxiliaryTree` and `copyTree` recurse; the hop oracle stays a Group 1 acceptance criterion. Fallback: embed the files in the binary as text imports. |
| `tsc` strictness or the bundler rejects `scripts/mikro/*` once imported from `src/` (extensionless specifiers, `import.meta.main` inside a bundle) | Medium | `moduleResolution: bundler` accepts the specifiers; type errors are fixed in place; the built-bundle test in Group 1 proves no foreign entry block runs. |
| The shipped agents name `deepseek-api/deepseek-flash`, a provider genie's own `.mikro/mikro.yaml` declares; a repository without `.mikro/` depends on the host's `~/.mikro/settings.json` declaring it (this host does, verified 2026-09-18) | Medium | Assumption recorded; a missing provider surfaces as `ok: false` with mikro's own error; documented as a prerequisite in Group 5 and printed by `mikro init`. |
| Both scopes now carry the same workflow names in the genie repository | Medium | Explicit-path invocation (Decision 7, runtime verified) removes reliance on shadowing; doctor reports drift. |
| A seeded agent is committed but not pushed on a commit-to-base repository | Medium | Decision 8's local-base rule uses it when the local base branch contains `origin/<base>`; `mikro init` and the docs name the push; adversarial case (d) pins both directions. |
| A repository with no `origin/HEAD` cannot name a base ref | Low | Falls back to the shipped agent and says so; `--agents-ref` is the operator override (`git remote set-head origin -a` is the documented fix). |
| A developer iterating on a prompt sees their uncommitted edit ignored | Low | Documented; `--agents-dir` is the explicit iteration path, as the coach already uses. |
| An executor with shell access could move a ref in the shared store | Low | Out of the threat model: the boundary defends against PR CONTENT, not against a process that already runs commands as the operator; stated in the README. |
| `mikro` or the provider key absent on a host | Low | Unchanged graceful `ok: false`; out of scope to ship them. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### 2026-09-18 — plan review, round 1 — FIX-FIRST

Independent read-only reviewer (Opus, not the author), plan at worktree `161ebd391`. Verified against code: `install-promotion.ts`, `auxiliary-trees.ts`, `update.ts`, `build-binary.sh`, `release-docs.test.ts`, `scripts/mikro/call.ts`, all workflow parity tests, `biome.json`, `knip.json`, `complexity-budget.ts`. Confirmed Decision 3 (nested `templates/` content is safe for the old binary; convergence precedes `--post-delivery-converge`). Nine required changes, all accepted:

| # | Finding | Resolution in this revision |
|---|---------|-----------------------------|
| R1 | Moving the runtime under `src/` breaks `lint:complexity-budget` (measured 29 / 55 / 33, `score.ts` 38 vs `maxScore: 42`) | Decision 2 reversed: runtime imported in place, relocation deferred; constraint added |
| R2 | A 17th command fails `release-docs.test.ts` unless README.md changes | README.md and CLAUDE.md count + rows in Group 1; global constraint added |
| R3 | The trusted ref's repository was unspecified; a linked-worktree test cannot catch a `--dir` lookup | Decision 8: invoking checkout only; adversarial case (c) separate clone; interface parameter renamed `invokingRoot` |
| R4 | Group 2 exceeded the 25-file / 2,000-insertion band | Split into Group 2 (channel) and Group 3 (observation + skills); Group 1 shrank with R1 |
| R5 | knip exposure of moved exports | Moot with R1; `dead-code` is a Group 1 acceptance criterion |
| R6 | `untrustedConfig` undefined on the shipped source | Decision 8 rule covers every source; Group 1 pins the trusted root; case (b) covers `shipped` |
| R7 | Default `origin/HEAD` ignores a committed-but-unpushed seeded agent | Local-base rule in Decision 8; case (d); `mikro init` names the push; risk row |
| R8 | Unrecorded workflow files would be orphaned | Decision 4: no record, no install |
| R9 | Out-of-project script path was an unverified premise | Verified before execution (run `wf_f01915ef-42a`), recorded in Decision 7 |

Round-1 advisories A5–A12 folded in (README-only `MIKRO_AGENTS_DIR` correction, `workfly/SKILL.md:42`, 90-line ceiling, provider prerequisite, authoritative gate named, `git archive` fidelity assertion, `MIKRO_AGENTS_DIR` override assertion, whole-catalog Decision 13).

### 2026-09-18 — plan review, round 2 — FIX-FIRST (three local edits, no design change)

Same reviewer, revised text. All nine round-1 findings verified resolved against code. Verified by execution: `tsc --noEmit` over the mikro closure under the repository's strict options exits 0; `import.meta.main` is false in a non-entry module under both `bun build --target bun` and `--compile`; `lint:complexity-budget` reads 2/7, max 29/42; knip and Biome are unaffected by an in-place import; the local-base rule is not exploitable by PR content; every group is inside the 25-file band; every Validation test file exists or is created by its group. The orchestrator's own spike agreed (`tsc` clean and a bundle importing `scripts/mikro/call` ran without firing the entry block).

| # | Finding | Resolution |
|---|---------|------------|
| N1 | `__tests__/update.test.ts` pins `runManualUpdateConvergence`'s exact return shape and was in no group | Added to Group 2's deliverable 4, file list and Validation |
| N2 | Decision 8 silently removed the same-directory exemption, contradicting a Group 4 criterion | Decision 8 states the removal, its consequence and the `--agents-dir` escape; the criterion now names `call.test.ts` as changed |
| N3 | `docs/mikro.mdx` lives in a submodule of another repository and had no real lint gate | Documentation is repo-local plus `mikro init` output; the public page is OUT |

Advisories folded in: Group 2 insertion ceiling, six skills not seven, local-base trust stated for the README, merge order named, README bundle-size sentence, `README.md` dropped from Group 5, doctor complexity headroom.

### 2026-09-18 — plan review, round 3 — FIX-FIRST (one contradiction introduced by the N2 edit)

N1, N3 and advisories A1–A7 confirmed applied; the `--agents-dir` escape verified against `call.ts:801/:814-816/:826`. One required finding: the revision claimed the coach loop already passes `--agents-dir`, but `coach.ts:596-597` passes it on the AFTER bench only, so after Group 4 the BEFORE bench would have measured the committed prompt while the printed diff described the working tree, and `coach.test.ts` (pure-unit) could not see it. Resolved by option (a), generalized: the no-flag bench hands `runAgent` the working-tree agents dir without recording it, stated in Decision 8, owned by Group 4 (deliverable 5, file list) and pinned by a criterion that exercises a real before/after difference. Advisories A8–A11 (file-count headers, wave wording, shared-file wording, which commands read the ref) applied.

### 2026-09-18 — plan review, round 4 — FIX-FIRST (one sentence), then SHIP

R-N2's resolution verified implementable against `bench.ts:119/:266-267` and the byte-identity test (`bench-options.test.ts:133-148` asserts on the record only); the coach chain closes with `coach.ts` unchanged. One required finding, R-N4: routing the measuring tools through the flag path removes a configuration refusal that exists today for `bench --dir <other repo>`, and Decision 8 did not say so. Resolved: Decision 8 states the removed refusal and the rule (measure only a trusted tree), Group 4 deliverable 6 carries it into the README, and the bench criterion asserts the exemption is the reason. Advisory A12 (shared code files named) applied. The reviewer's stated condition — "with that added I would return SHIP without further verification; nothing else in the plan is open" — is met by this revision; the confirming verdict is recorded below.

### 2026-09-18 — plan review, round 5 — SHIP (APPROVED for execution)

Same independent reviewer: "SHIP — the plan is approved for execution", given against WISH.md sha256 `47a7dde6730c7a6e37dea7e416799024ba675e9d96011b29b2326090c50d6980` (the text before this block and the Status flip were appended by the orchestrator). R-N4 confirmed stated in Decision 8, carried into Group 4 deliverable 6 and asserted in the bench criterion; A12 applied; no contradiction introduced. One non-blocking wording nit (a missing conjunction in the bench criterion) fixed with this block. Status persisted by the orchestrator: APPROVED. Wave base: `origin/dev` at `1631d16acadbd7d0c91ec26dea03b34ba52a69b2`.

---

## Files to Create/Modify

```
# Group 1 (~17 files)
scripts/mikro/call.ts (+ call.test.ts)   src/term-commands/mikro.ts (+ test)   src/genie.ts
scripts/build-binary.sh   .github/workflows/build-tarballs.yml   scripts/release-docs.test.ts
.claude/workflows/wish.js   .claude/workflows/README.md   scripts/wish-workflow-mikro.test.ts
scripts/mikro/README.md   README.md   CLAUDE.md

# Group 2 (~11 files)
src/lib/workflows-installer.ts (+ test)   src/lib/skills-installer.ts (+ test)
src/genie-commands/install.ts (+ test)   src/genie-commands/update.ts   src/genie-commands/__tests__/update.test.ts
scripts/build-binary.sh   .github/workflows/build-tarballs.yml   scripts/release-docs.test.ts

# Group 3 (~19 files)
src/genie-commands/doctor.ts (+ test)   src/genie-commands/uninstall.ts (+ test)
skills/{council,wish,workfly,docs,research,skill-audit}/SKILL.md
scripts/{council,docs-audit,research-sweep,skill-audit,skill-intake,wish,workfly}-workflow-parity.test.ts
.claude/workflows/README.md   CLAUDE.md

# Group 4 (~11 files)
scripts/mikro/trusted-source.ts (+ adversarial test)   scripts/mikro/call.ts (+ test)   scripts/mikro/bench.ts (+ test)
src/term-commands/mikro.ts   .claude/workflows/wish.js   scripts/wish-workflow-mikro.test.ts
scripts/mikro/README.md

# Group 5 (~14 files)
scripts/mikro/{bench,bench-options,coach}.ts (+ tests)   scripts/mikro/{fixtures-from-commits,init}.ts (+ tests)
src/term-commands/mikro.ts (+ test)   scripts/mikro/README.md   CLAUDE.md
```
