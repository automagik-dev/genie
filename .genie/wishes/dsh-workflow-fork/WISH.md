# Wish: Fork `dsh_workflow` to consume genie's canonical `.claude/workflows/` catalog

| Field | Value |
|-------|-------|
| **Status** | FIX-FIRST |
| **Slug** | `dsh-workflow-fork` |
| **Date** | 2026-09-15 |
| **Author** | Felipe + Genie (split from the combined `workflows-multibody` plan, whose three plan-review loops this wish inherits; fork target analysed at `omdsh-dev/dsh_workflow@44b83c1`) |
| **Appetite** | medium |
| **Branch** | `wish/dsh-workflow-fork` |
| **Repos touched** | new repository `automagik-dev/dsh_workflow`, a fork of `omdsh-dev/dsh_workflow` (package name `@dsh-external/workflow`, git-only, not published on npm; MIT); `automagik-dev/genie` only for this document |
| **Design** | _No brainstorm — direct wish_ |

## Summary

**Problem:** a workflow saved at `.claude/workflows/<name>.js` runs only on Claude Code; a DeepSeek Harness (DSH) body can neither discover nor execute it. This wish forks the `dsh_workflow` DSH plugin into a genie-owned repository and rewrites its front-end so the same files are discovered from the same two paths (`<cwd>/.claude/workflows/` project, `~/.claude/workflows/` personal) and executed unmodified, so Felipe can run a genie workflow from Claude Code or from DSH. The 2026-09-15 analysis established that the fork target's engine already matches the native `pipeline` (no barrier, `(prev, item, index)`), `parallel` (null on throw), `runAgent` null-on-failure and one-level nesting semantics; it already bans the clock in its QuickJS bootstrap (`Math.random`, `Date.now`, argless `new Date` throw; the ban is not in its source-policy token list, which is why an earlier review missed it), requires `async function run(wf, args)` and rejects `export` at parse time, and needs adapters for `effort` and `isolation: 'worktree'`. The recorded council run of 2026-09-15 (see `workflows-catalog`) also found that DSH 0.1.x ships a first-party workflow engine (`@deepseek-ai/dsh-workflow`, `ctx.workflowEngine`, `WorkflowStartRequest{script, meta, args}`) with the same body-style `agent` / `pipeline` / `parallel` / `phase` / `log` vocabulary, no catalog, no `budget` / `workflow()` / `effort` / `isolation`, and a parse-time rejection of `export const meta`. A thin loader over that seam may be cheaper than this fork, so a written comparison gates all fork work (Group 0).

## Scope

### IN

- Seam comparison (gate): a written comparison in this wish between forking `omdsh-dev/dsh_workflow` and a thin loader plugin over DSH's first-party `ctx.workflowEngine`, with the exact host DSH version recorded (`dsh --version` on the target host is `0.1.1-rc.2` today, below the `0.1.2-rc.1` floor `plugins/dsh-genie-board` declares) and a kill criterion: if neither route can run `council.js` unmodified within this wish's appetite, the fork stops and the catalog stands alone.
- Fork bootstrap: a new `automagik-dev/dsh_workflow` repository detached from the upstream's private DSH snapshot (`link:../test-icetomoyo/*`), with `@deepseek-ai/*` devDependencies pinned to exact versions (no ranges) matching the recorded host version, a regenerated committed lockfile, and its own `pnpm check` green. Group 1 asserts the chosen `ctx.subagents` provider reports `outputSchema` and `depthLimit` capabilities, since every catalog agent call passes `schema`.
- Catalog and dialect: `.claude/workflows` roots classified by root, static `meta` extraction into the DSH manifest, a body transform wrapping the script into the engine's `run(wf, args)` shape, a guest-bootstrap shim defining the bare Claude Code globals over `wf`, the clock ban, a marker-style `phase` bridge, `workflow({scriptPath})`, a `model` alias map onto DSH tiers, an explicit per-option policy that is fail-closed for anything affecting correctness or tool restriction (`isolation`, `disallowedTools`, `bashCommandClamp` refuse to run without an explicit per-run override, matching DSH's own "misused hooks always kill the script" rule) and drop-with-warning only for cosmetic options, finite defaults in interactive profiles (a wall timeout and an agent ceiling stay on; `scriptWallTimeoutMs: 0` and the 1000-agent ceiling exist only in the conformance driver's temporary profile), and a run driver writing normalized journals outside the DSH run root.
- Adapters: a git-worktree isolation adapter for `isolation: 'worktree'`, `effort` accepted as a soft hint when no dispatch adapter is registered, and `AGENTS.md` / `CLAUDE.md` injected into every spawned subagent through the plugin's existing `ctx.inject(['systemPrompt'])` seam.
- Conformance, living in the fork: fixture scripts covering each primitive and semantic, goldens captured from Claude Code with stub agents (normalized result lines plus the script's return value, with provenance), and a comparator; the genie catalog's `council.js` is the integration fixture that must run unmodified.

### OUT

- Benchmarking Claude Code native against the DSH fork with real agents (planted-defect seeds, scorer, recorded run). Successor wish; trigger: this wish's conformance is green.
- Installing catalog scripts into `~/.claude/workflows/` from genie. Belongs to `workflows-catalog`'s deferred list.
- An `agentType` adapter mapping `.claude/agents/*.md` onto DSH subagents: no genie script uses `agentType`, and DSH's `subagentType` is a transport name, not a persona. The shim drops it with a warning.
- Wire compatibility with the `dsh.workflow` v1 capsule format or KodaX capsules; no translation layer in either direction.
- Back-porting DSH-only features (pause / resume, approval classes, durable run graph, `wf.synthesize`, `wf.artifact`, live `send` / `stop`) into the canonical script contract.
- Vendoring the fork into genie's `plugins/`; the upstream is pnpm / vitest and keeping its tooling keeps the diff reviewable. Upstreaming the fork; a later wish may open that PR.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Claude Code's script format is canonical; the fork adapts to it, not the reverse | The native contract (`workflow-authoring`) is documented and stable and genie's catalog already uses it. A genie capsule with per-host emission is a second format to keep in sync. |
| 2 | Fork and change `catalog.ts`, `source-policy.ts`, `runtime.ts`, `engine.ts` in place | The engine already implements the matching semantics; the divergence is in the loader and the guest API surface. A wrapper outside the plugin cannot reach the QuickJS bootstrap. |
| 3 | Claude scripts run in the fork's restricted QuickJS class (`capability-generated`) with the clock ban added | The restricted class already bans imports, filesystem, process, shell, network, timers and dynamic code and adds memory / stack limits. Both script classes are gated by `approvalMode: generated-and-local` by default, so conformance runs use `approvalMode: never`; interactive use approves a dialect script like a capsule. |
| 4 | Goldens come from Claude Code with stub agents; real agents are the successor wish's job | Stub agents make results deterministic, so any diff is an engine bug. |
| 5 | `model` aliases map to DSH tiers by config (haiku→fast, sonnet→balanced, opus / fable→deep) instead of failing preflight | DSH rejects unknown selectors loudly by design; a script naming a model must still run. |
| 6 | Pin to the exact DSH version recorded on the target host, reconciled against the `0.1.2-rc.1` floor `plugins/dsh-genie-board` declares | The host runs `0.1.1-rc.2` today; Group 0 records either an upgrade with the board smoke re-run or a lowered floor with a reason. Re-verifying the `ctx.subagents` seam is the one step that can end BLOCKED, so it is its own group. |
| 8 | A seam comparison against DSH's first-party workflow engine gates the fork | The council run of 2026-09-15 found `ctx.workflowEngine` with the same guest vocabulary; if a loader over it runs `council.js` unmodified, the QuickJS fork, the `run(wf, args)` transform and the snapshot detachment are all unnecessary. Deciding that on paper first is cheaper than discovering it after Group 1. |
| 7 | Conformance fixtures live in the fork and are staged into a temporary project's `.claude/workflows/` to run on either body | Fixtures are not saved workflows and must not pollute a real catalog; the fork is the consumer that has to prove parity. |

## Simplicity Case

- **Simplest complete design:** two catalog roots plus a guest shim, so an unmodified `.claude/workflows/<name>.js` executes on DSH.
- **Added machinery:** (a) the conformance suite, because two executors reading the same path will silently diverge on semantics nobody re-checks; (b) the worktree and effort adapters, because the engine fails preflight on both today and `pm-ledger-verify.js` already passes `effort`; (c) the fork bootstrap group, because the upstream test gate is welded to a private snapshot.
- **Deferred until measured:** `agentType` adapter (trigger: a genie workflow passes `agentType`); benchmark (trigger: conformance green); upstream PR (trigger: conformance green for two fork releases).
- **Complexity removed:** no genie capsule format, no per-host code generation, no `dsh.workflow` migration, no new DSH subagent provider, no vendoring into genie.

## Dependencies

**depends-on:** workflows-catalog
**blocks:** none

Group 0 gates every other group; if it ends BLOCKED the wish stops and `workflows-catalog` stands alone.

## Success Criteria

- [ ] The fork's `pnpm check` passes with devDependencies resolved from npm at `0.1.2-rc.1` or a newer explicitly proven series, no `link:` to the private snapshot, and the upstream engine specs green on that series.
- [ ] The fork lists a script placed in `<cwd>/.claude/workflows/` and one in `~/.claude/workflows/` with project shadowing personal, and a DSH-root / Claude-root name collision is a listing error.
- [ ] Every conformance fixture runs on the fork unmodified with stub subagents and the comparator exits 0 against the Claude Code goldens, including `forbidden-clock` returning the same error message.
- [ ] genie's `.claude/workflows/council.js` runs on the fork from a genie checkout and returns a report in the same shape as the native run recorded in `workflows-catalog`.
- [ ] A fixture using `effort` and `isolation: 'worktree'` runs without a preflight error, and a spawned subagent's system prompt contains the first heading of the repo's `AGENTS.md`.

## Execution Strategy

### Wave 0 (gate)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 0 | engineer | 3 — routing / seam decision (+2), subjective acceptance of a comparison (+1) | `implementor-mid` / high | Seam comparison: fork vs first-party `ctx.workflowEngine` loader, host version, kill criterion |

### Wave 1 (sequential after Wave 0)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 3 — dependency / lockfile on an rc series (+2), prior-rework risk (+1) | `implementor-mid` / high | Fork bootstrap: detach, pin exact versions, green gate, capability assertion |

### Wave 2 (sequential after Wave 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | 5 — orchestration (+2), routing / model tiers (+2), no deterministic test until goldens exist (+1) | `implementor-high` / high | Catalog roots, dialect transform, guest shim, clock ban, phase bridge, journal driver |
| 3 | engineer | 4 — agent lifecycle (+2), effort routing (+2) | `implementor-high` / high | Adapters and shared-context injection |

### Wave 3 (after Wave 2)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 4 | engineer | 3 — orchestration semantics to encode (+2), needs a native capture session (+1) | `implementor-mid` / high | Conformance fixtures, Claude Code goldens, comparator, council integration run |

Complexity scoring rubric: score each group independently and record the total plus a short rationale in **Complexity**. Add:

- **+2** each for orchestration / agent-lifecycle / routing; cost / model / escalation; stateful work; subjective acceptance.
- **+1** each for multi-package work; OTel-label dependency; no deterministic test; prior rework; prompt-skill change; CI / release work.

Route the total in **Model** by portable role and reasoning effort: **0–1** →
`implementor-low` / low; **2–3** → `implementor-mid` / medium or high;
**4–6** → `implementor-high` / high; **7+** → `implementor-high` plus an
independent `final-gate` at the highest justified effort. Each runtime maps
these to its matching native roles. Keep
model and effort in runtime session/agent configuration, never skill frontmatter.

## Execution Groups

### Group 0: seam-comparison — fork or first-party engine

**Goal:** Decide on evidence whether to fork the QuickJS plugin or write a thin loader over DSH's first-party `ctx.workflowEngine`, and pin the host DSH version.

**Deliverables:**
1. `docs/seam-comparison.md` in this wish directory: for each Claude Code hook (`export const meta`, `agent` options incl. `schema` / `effort` / `isolation` / `model`, `pipeline`, `parallel`, `phase`, `log`, `workflow()`, `budget`, clock ban, catalog discovery, resume), what the first-party engine offers at the recorded host version versus the upstream plugin, and the cost of adding each missing hook on each route.
2. A spike: a loader that reads `.claude/workflows/council.js`, splits `export const meta` off the body, and submits `{script, meta, args}` to `ctx.workflowEngine` on the host; record whether it runs and where it fails.
3. Recorded `dsh --version` on the target host, and the floor decision (upgrade to `>= 0.1.2-rc.1` with `scripts/dsh-genie-board-smoke.ts` re-run, or lowered floor with reason).
4. The chosen route written into this wish as a decision; if the loader route wins, Groups 1 to 3 are re-planned against the seam before work starts; if neither route can run `council.js` unmodified within appetite, the wish is marked BLOCKED and the catalog stands alone.

**Acceptance Criteria:**
- [ ] The comparison covers every hook above with a cost on both routes.
- [ ] The spike's outcome (runs / fails at X) is recorded with the host version.
- [ ] The route decision is recorded and the wish re-reviewed before Group 1.

**Validation:**
```bash
# Planning document plus a recorded spike: the wish linter and the presence of the comparison and spike record
test -f .genie/wishes/dsh-workflow-fork/docs/seam-comparison.md && grep -q 'dsh --version' .genie/wishes/dsh-workflow-fork/docs/seam-comparison.md && bun run wishes:lint
```

**depends-on:** none

---

### Group 1: fork-bootstrap — detach from the private DSH snapshot

**Goal:** Create `automagik-dev/dsh_workflow` from `omdsh-dev/dsh_workflow` and make its own gate green against npm-published DSH packages on the series genie deploys.

**Deliverables:**
1. Fork created; `README` states the upstream and the genie purpose; `NOTICE` retains the MIT attribution.
2. `package.json` devDependencies for `@deepseek-ai/*` repointed from `link:../test-icetomoyo/*` to exact npm versions (no `^` / `~`) matching the host version recorded in Group 0, with a regenerated committed lockfile (the plugin itself is git-only, so only the DSH devDependencies come from npm); `vitest.config.ts` no longer requires `../test-icetomoyo` or `DSH_SNAPSHOT_DIR` and resolves `@deepseek-ai/*` from `node_modules`; `scripts/check-compatibility.mjs` and `scripts/check-dsh-workflow-projection.mjs` check the npm version instead of a snapshot git commit; `compatibility.json` records `{npmSeries, version, testedAt}`.
3. The upstream engine, runtime, catalog and plugin specs pass on the pinned version, and a spec asserts the chosen `ctx.subagents` provider reports `SubagentCapabilities.outputSchema === true` and `depthLimit === true`. Any `ctx.subagents` seam change is written up in the fork's `docs/`; if incompatible, the group reports BLOCKED with that note and no dialect work starts.

**Acceptance Criteria:**
- [ ] `pnpm install --frozen-lockfile` succeeds with no `link:` entries in `package.json` or the lockfile.
- [ ] `pnpm check` exits 0 (compatibility, tests, typecheck, build).
- [ ] `compatibility.json` names the npm series and the tested version.

**Validation:**
```bash
# Fork repository gate is the repository-documented gate
pnpm install --frozen-lockfile && pnpm check && node -e "const c=require('./compatibility.json'); if(!c.npmSeries) process.exit(1)"
```

**depends-on:** 0

---

### Group 2: catalog-dialect — read and run Claude Code scripts from the canonical paths

**Goal:** Make an unmodified `.claude/workflows/<name>.js` discoverable, loadable and executable by the DSH engine.

**Deliverables:**
1. `src/catalog.ts`: two new roots, `<cwd>/.claude/workflows/*.js` (project) and `~/.claude/workflows/*.js` (personal). Classification is by root: every `.js` under a Claude root is dialect (`capability-generated`), and a Claude root never yields `trusted-local`. Project shadows personal within the Claude roots; a name present in both a DSH root and a Claude root is a listing error, not a shadow.
2. `src/claude-dialect.ts` (new): static extraction of the `export const meta` literal into a DSH manifest (`readOnly: false`, `maxConcurrency: 10`, `maxAgents: 1000` with the deployment ceiling raised to match, `whenToUse` folded into description) and the body transform that strips `meta` and wraps the remainder as `async function run(wf, args) { ... }`; `source-policy.ts` accepts the dialect while keeping the forbidden-token list unchanged.
3. `src/runtime.ts` guest bootstrap: bare globals `agent`, `parallel`, `pipeline`, `phase`, `log`, `workflow`, `budget` over `wf`; `agent(prompt, opts)` maps `label`→`name`, `phase`, `schema`→`outputSchema`, `model` (alias map), `effort`, `isolation`, returns `structured` when a schema was given else `finalText`, null on null; options are handled per an explicit table: `isolation`, `disallowedTools` and `bashCommandClamp` are fail-closed (refuse to run without an explicit per-run override) because they affect correctness or tool restriction; `agentType` and `isolation: 'remote'` are dropped with one warning per option per run; an `unknown-option` conformance fixture covers both branches; `phase(title)` uses a new sync bridge method over the existing `beginPhase` / `endPhase` internals and the open marker phase is closed at script end; `workflow({scriptPath})` resolves a file path in addition to a name.
4. Clock-ban message alignment: the upstream bootstrap already throws on `Date.now`, `Math.random` and argless `new Date`; align its messages with the native ones captured in the `forbidden-clock` golden.
5. `scriptWallTimeoutMs` schema accepts `0` meaning disabled, but only the conformance driver's temporary profile sets it (and the 1000-agent ceiling, and `approvalMode: never`); a spec asserts the shipped defaults keep a finite wall timeout, a finite agent ceiling and `approvalMode: generated-and-local` for both Claude roots; a run driver `scripts/run-conformance.mjs` stages a fixture directory into a temporary project's `.claude/workflows/`, executes each with the fake subagent runtime (extracted from `tests/engine.spec.ts` into `tests/support/fake-subagents.mjs`) under `approvalMode: never`, and writes `<out>/<fixture>/` in the golden layout to a directory outside the DSH run root (`.dsh/workflow-runs` is enumerated and pruned as runs by `src/store.ts`).

**Acceptance Criteria:**
- [ ] A vitest spec lists a script at `<tmp>/.claude/workflows/` and one at `<tmp-home>/.claude/workflows/`, with the project copy shadowing the personal one, and reports a DSH-root / Claude-root collision as a listing error.
- [ ] The dialect spec invokes `scripts/run-conformance.mjs` on a one-fixture temporary directory: a script containing `export const meta` and top-level `await` runs without modification, and a script calling `Date.now()` returns the native error message.
- [ ] A `.workflow.json` capsule still runs unchanged.

**Validation:**
```bash
# Fork gate plus the dialect spec
pnpm check && pnpm vitest run tests/claude-dialect.spec.ts
```

**depends-on:** 1

---

### Group 3: adapters — worktree, effort, shared context

**Goal:** Remove the preflight failures that stop real genie scripts from running, and give DSH subagents the same repo context Claude Code subagents get.

**Deliverables:**
1. `src/adapters/git-worktree.ts`: a `WorktreeIsolationAdapter` creating a linked worktree per task outside the pruned run root, disposed via `git worktree remove` plus `git worktree prune` (never a plain directory delete), opt-in per run when the host repo is dirty; registered by default and covered by the adapter spec.
2. `effort` handling: when no `WorkflowDispatchAdapter` is registered, `effort` is recorded in the task result as a soft hint and does not fail admission.
3. Subagent context injection through the existing `ctx.inject(['systemPrompt'])` seam in `src/index.ts`: every spawned subagent receives the repo's `AGENTS.md` and `CLAUDE.md` (when present) as collapsed plugin context.

**Acceptance Criteria:**
- [ ] A fixture using `isolation: 'worktree'` runs and the task's cwd is a distinct git worktree that is removed after completion.
- [ ] A fixture passing `effort: 'high'` with no dispatch adapter completes and records the hint.
- [ ] A subagent's system prompt contains the literal first heading of the repo's `AGENTS.md`.

**Validation:**
```bash
# Fork gate plus the adapter specs
pnpm check && pnpm vitest run tests/adapters.spec.ts
```

**depends-on:** 2

---

### Group 4: conformance — fixtures, Claude Code goldens, comparator, council run

**Goal:** Prove parity mechanically and run genie's first canonical workflow on the fork.

**Deliverables:**
1. `conformance/fixtures/<fixture>.js`, one per primitive and semantic: `pipeline-streaming`, `parallel-null-isolation`, `phase-marker-and-opts-phase`, `agent-schema`, `nested-workflow-and-depth-limit`, `budget-visibility`, `forbidden-clock`. Each takes `{stamp}` via `args` and returns a JSON object encoding the semantic under test (phase names seen, arrival order, budget values, the caught `Date.now` error message), because the native `journal.jsonl` records only agent results. Stub-agent prompts instruct the agent to return a fixed literal per label.
2. `conformance/golden/<fixture>/result-lines.jsonl` (native `journal.jsonl` result lines normalized to `label → result`, `key` and `agentId` stripped), `return.json`, and `provenance.json` `{harnessVersion, runId, stamp, capturedAt}`; `conformance/CAPTURE.md` describes staging the fixtures into a temporary project's `.claude/workflows/` and requires a fresh `args.stamp` per capture so the native resume cache cannot replay.
3. `scripts/workflow-conformance.mjs`: normalizes a driver output directory into the same two artifacts, ignores ordering within a parallel group, diffs against the goldens, and exits non-zero on any mismatch or on a golden missing `provenance.json`; a vitest spec proves it accepts the goldens and rejects a mutated return and a golden without provenance.
4. Integration run: genie's `.claude/workflows/council.js` executed on the fork from a genie checkout with real DSH subagents, report saved under `conformance/integration/council-<date>.md`. This is evidence-recorded, like the native run in `workflows-catalog`; the validation checks the report exists.

**Acceptance Criteria:**
- [ ] `node scripts/run-conformance.mjs --fixtures conformance/fixtures --out .dsh/conformance-out && node scripts/workflow-conformance.mjs .dsh/conformance-out` exits 0.
- [ ] The comparator spec's negative cases fail as designed.
- [ ] The council integration report has five lens sections and a synthesis in the skill's shape.

**Validation:**
```bash
# Fork gate plus the driver, comparator and its spec
pnpm check && node scripts/run-conformance.mjs --fixtures conformance/fixtures --out .dsh/conformance-out && node scripts/workflow-conformance.mjs .dsh/conformance-out && pnpm vitest run tests/conformance.spec.ts && ls conformance/integration/council-*.md && (cd "$GENIE_ROOT" && bun run wishes:lint)
```

**depends-on:** 3

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: from a genie checkout, `/workflow list` on DSH shows `council` and `pm-ledger-verify` from `.claude/workflows/`.
- [ ] Integration: `/workflow council {"decision": "..."}` on DSH returns a report in the same shape as the native run recorded in `workflows-catalog`.
- [ ] Regression: a `.workflow.json` capsule in `.dsh/workflows/` still lists and runs.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| The upstream's tests link to a private DSH snapshot (`dsh2026/test-icetomoyo`, not found on GitHub) and its `vitest.config.ts` and compatibility scripts depend on it | High | Group 1 exists solely to detach; it reports BLOCKED with a seam diff note rather than patching around an incompatible `ctx.subagents`. |
| DSH 0.1.x differs from the upstream's `0.0.1-rc.2` seam | High | Group 1 re-runs the upstream engine specs on 0.1.x before any dialect work; `plugins/dsh-genie-board` already proved 0.1.2-rc.1 installs and restarts. |
| DSH's shared concurrency ceiling and one-hour wall timeout differ from Claude Code | Medium | Group 2 sets `maxConcurrency` 10, `maxAgents` 1000 and disables the wall timeout for the dialect. |
| Marker-style `phase()` has no scoped end | Low | The bridge closes the open marker phase at script end; a fixture covers it. |
| Native goldens depend on the Claude Code harness version, and the native resume cache replays unchanged args | Medium | `provenance.json` records version and run id; `CAPTURE.md` requires a fresh `stamp`; the comparator refuses a golden without provenance. |
| The native `journal.jsonl` records only agent results | Accepted | Fixtures encode every semantic under test into their return value. |
| The DSH worker is a different model, so outputs differ | Accepted | Conformance is engine-level with stubs; body-level comparison is the successor benchmark wish. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

- **Provenance:** split on 2026-09-15 from the combined `workflows-multibody` wish. Its three plan-review loops (4 HIGH / 6 MEDIUM / 5 LOW, then 1 HIGH / 2 MEDIUM / 3 LOW, then SHIP) and amendment review verified, against the fork clone at `44b83c1`, every claim carried here: the missing clock ban, the snapshot-welded test gate, the `subagentType`-is-a-provider seam, the `approvalMode` default, the run-root pruning, the fake subagent runtime in the engine spec, and `0.1.2-rc.1` being published on npm. Those findings are applied in this document.

### Plan review — 2026-09-15 — SHIP

- **Context:** plan review of this wish and its sibling by a read-only reviewer subagent; fork claims re-checked against the loop-1 to loop-3 evidence on the clone at `44b83c1`.
- **Commands and outcomes:** `bun run wishes:lint` → OK. Path grep over the wish → conformance, driver and comparator paths consistent across Group 2, Group 4, acceptance criteria, validation and the Files list. `genie task list --json` → 4 cards carry `dsh-workflow-fork`. `ls .genie/wishes/workflows-multibody` → gone.
- **Verdict:** SHIP — 0 HIGH, 0 MEDIUM, 3 LOW (Group 2 AC 2 needed the driver named in its spec; the council integration run is evidence-recorded and its validation checks the report exists; the genie-side document changes get the wish linter in Group 4's validation). All three applied in-document.
- **Orchestrator transition:** DRAFT → **APPROVED**. Wave base recorded with `genie context --wish dsh-workflow-fork`.

### Council evidence — 2026-09-15 — status APPROVED → FIX-FIRST

- **Source:** the recorded native council run in `workflows-catalog` (run id `wf_0fd9c999-aad`, decision `proceed-with-conditions`; dissent `oppose`). Its architecture lens inspected the DSH host and found three facts this wish had wrong or missing: the upstream plugin already bans the clock in its QuickJS bootstrap; `@dsh-external/workflow` is git-only; and DSH 0.1.x ships a first-party `ctx.workflowEngine` with the same guest vocabulary that was never evaluated. Its security lens called the drop-with-warning option policy and the disabled wall timeout a regression. The host runs DSH `0.1.1-rc.2`, below the declared floor.
- **Applied in-document:** all of the above, plus Group 0 (seam comparison, host version, kill criterion) gating Group 1, exact-version pins with a committed lockfile, the `outputSchema` / `depthLimit` capability assertion, fail-closed per-option policy, finite shipped defaults with the permissive settings confined to the conformance driver's temporary profile, worktree disposal via git.
- **Transition:** APPROVED → **FIX-FIRST**: Group 0 is a new gate and the route decision may re-plan Groups 1 to 3, so the plan needs re-review before work; the recorded wave base stands.

---

## Files to Create/Modify

```
# automagik-dev/dsh_workflow (fork of omdsh-dev/dsh_workflow)
README.md, NOTICE                                    (upstream attribution, genie purpose)
package.json, pnpm-lock.yaml, compatibility.json     (npm devDependencies on DSH 0.1.x; {npmSeries, version, testedAt})
vitest.config.ts                                     (resolve @deepseek-ai/* from node_modules)
scripts/check-compatibility.mjs                      (npm version check, no snapshot git)
scripts/check-dsh-workflow-projection.mjs            (same)
scripts/run-conformance.mjs                          (fixture driver: stage into tmp .claude/workflows/, approvalMode never, output outside the run root)
scripts/workflow-conformance.mjs                     (comparator)
src/catalog.ts                                       (two Claude Code roots, by-root classification, collision rule)
src/claude-dialect.ts                                (new: meta extraction + body transform)
src/source-policy.ts                                 (accept the dialect)
src/runtime.ts                                       (bare-global shim, clock ban, phase marker bridge, scriptPath, unknown-option policy)
src/engine.ts                                        (phase marker bridge method, effort soft hint, journal writer)
src/index.ts                                         (config parity defaults, wall timeout 0, adapters, systemPrompt injection)
src/adapters/git-worktree.ts                         (new)
tests/support/fake-subagents.mjs                     (extracted from tests/engine.spec.ts)
tests/claude-dialect.spec.ts, tests/adapters.spec.ts, tests/conformance.spec.ts (new)
conformance/fixtures/*.js, conformance/golden/<fixture>/{result-lines.jsonl,return.json,provenance.json}, conformance/CAPTURE.md
conformance/integration/council-<date>.md            (the council run on DSH)

# automagik-dev/genie
.genie/wishes/dsh-workflow-fork/WISH.md              (this document)
.genie/wishes/dsh-workflow-fork/docs/seam-comparison.md (Group 0 comparison + spike record)
.genie/INDEX.md                                      (entry)
```
