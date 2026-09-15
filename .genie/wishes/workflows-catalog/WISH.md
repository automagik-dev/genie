# Wish: `.claude/workflows/` as genie's canonical workflow catalog, council as the first example

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `workflows-catalog` |
| **Date** | 2026-09-15 |
| **Author** | Felipe + Genie (split from the combined `workflows-multibody` plan, whose three plan-review loops this wish inherits) |
| **Appetite** | small |
| **Branch** | `wish/workflows-catalog` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | _No brainstorm — direct wish_ |

## Summary

**Problem:** genie has no declared home for saved workflows: the only ones are an ad-hoc project file (`.claude/workflows/pm-ledger-verify.js`) and an orphaned user-level `~/.claude/workflows/council.js` whose stamped absolute lens path no longer exists. This wish declares the repo's own `.claude/workflows/` the canonical, git-tracked catalog, lands a path-free `council` workflow there as the first example (mirroring `skills/council/SKILL.md`: five independent lenses, then a synthesis, assess-only), and adds a static contract check so every catalog entry stays a valid Claude Code Workflow script. Nothing is installed anywhere: in this repo the tracked file runs by the native project-scope rule, and a DSH body reads the same path through the sibling wish `dsh-workflow-fork`.

## Scope

### IN

- `.claude/workflows/council.js`: a Claude Code Workflow script (`export const meta`, bare `agent` / `parallel` / `phase` / `log` globals, `schema` outputs) that takes a decision statement plus optional constraints, evidence and unknowns through `args`, runs the five council lenses from the skill (architecture, delivery, product, security, dissent) in parallel with the same brief and no cross-contamination, synthesizes a decision in the skill's format, and returns the report plus structured results. No lens files, no absolute paths, no stamping.
- `.claude/workflows/README.md`: the catalog contract in one page — this directory is canonical; a script is one file named `<name>.js` with a pure-literal `meta` whose `name` matches the filename; paths and timestamps arrive via `args`; `Date.now` / `Math.random` / imports / filesystem are forbidden; `agent()` returns null on failure; nesting is one level; project scope shadows `~/.claude/workflows/`.
- `scripts/workflows-meta.test.ts`: the static half of that contract, run over every `.claude/workflows/*.js` by the repo test sweep.
- One recorded native run of `/council` from this repo, as execution evidence in this wish.

### OUT

- Installing catalog scripts into `~/.claude/workflows/` (an install-channel step with a removable record). Deferred: trigger is a second repository needing genie workflows without a genie checkout.
- Release-tarball packaging of the catalog. Same trigger.
- The DSH executor, conformance suite and benchmark: sibling wish `dsh-workflow-fork` and its successor.
- A public docs page: the contract lives in the catalog's README next to the scripts.
- Rewriting `pm-ledger-verify.js`; it is already path-free. One line is corrected (lens attribution indexed after `filter(Boolean)`, found by the recorded council run) and nothing else changes.
- Reviving the old stamped council (routing table, audit mode, repo-profile writer). The first example is the current five-lens skill, nothing more.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | `.claude/workflows/` in the repo is the canonical catalog; no root `workflows/` directory | Felipe: ".claude/workflows canon, yet repo-based". One tracked copy, found by the native tool's project scope, and by the DSH fork from the same path. A second directory would need a drift guard for no benefit. |
| 2 | The first example is the five-lens council from `skills/council/SKILL.md`, with lens briefs inline in the script | The skill already defines the lenses and both response formats. Inline briefs make the script path-free, which is what killed the old stamped `council.js`. |
| 3 | Contract enforcement is a static test, not a runtime | The native tool is the runtime and cannot run in CI; the static half (meta literal, name match, forbidden tokens) is what CI can hold. |
| 4 | The orphaned `~/.claude/workflows/council.js` is superseded by shadowing, and its removal is a documented manual step | Project scope wins in this repo; in other repos the orphan would still run with a dead path, so the README tells the operator to delete it. Genie writes nothing under `~/.claude` in this wish. |

## Simplicity Case

- **Simplest complete design:** one script, one README, one static test. That is the whole wish.
- **Added machinery:** none. The static test exists because the README alone cannot fail a PR.
- **Deferred until measured:** install channel and tarball packaging (trigger above); a `genie doctor` catalog check (trigger: a second orphan like `council.js`).
- **Complexity removed:** no lens-file resolver stage, no stamping, no routing table, no audit mode, no profile writer, no install record.

## Dependencies

**depends-on:** none
**blocks:** dsh-workflow-fork

## Success Criteria

- [ ] `.claude/workflows/council.js` exists, starts with a pure-literal `export const meta` named `council`, and contains no `import`, `require`, `Date.now`, `Math.random` or absolute path.
- [ ] Running `/council` natively from this repo with a decision statement returns a report with five lens sections and a synthesis in the skill's `Decision / Consensus / Dissent / Conditions / Evidence gaps / Next action` shape; the run is recorded under Review Results with its outcome.
- [ ] `.claude/workflows/README.md` states the contract listed in Scope IN.
- [ ] `bun test scripts/workflows-meta.test.ts` passes over every `.claude/workflows/*.js` and fails on fixtures with a mismatched `meta.name`, a non-literal `meta`, or any forbidden token (imports, `require`, clock, process, filesystem, shell, network, timers, dynamic code, quoted absolute paths).
- [ ] `bun test scripts/council-workflow-parity.test.ts` proves the lens roster in `council.js` equals the numbered list in `skills/council/SKILL.md`.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 2 — orchestration script (+2) | `implementor-mid` / medium | Council workflow + catalog README |
| 2 | engineer | 0 — deterministic static test | `implementor-low` / low | Static contract test |

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

### Group 1: council-example — the council workflow and the catalog README

**Goal:** Land the first canonical workflow and the one-page contract beside it.

**Deliverables:**
1. `.claude/workflows/council.js` as described in Scope IN. `args` accepts a plain string (the decision) or `{decision, constraints?, evidence?, unknowns?}`; lens responses use a schema with `verdict` (support / support-with-conditions / oppose / insufficient-evidence), `confidence`, `keyEvidence[]`, `risks[]`, `conditions[]`, `unknowns[]`; the synthesis uses a schema with `decision` (proceed / proceed-with-conditions / revise / stop / gather-evidence), `consensus`, `dissent[]` attributed by lens, `conditions[]`, `evidenceGaps[]`, `nextAction`, `conflictResolution`. Lenses that return null are listed as not convened, never averaged in. Fewer than three responding lenses returns `{ok: false}` instead of a synthesis.
2. `.claude/workflows/README.md` with the contract and the manual step to delete a stale `~/.claude/workflows/council.js`.

**Acceptance Criteria:**
- [ ] The script parses when wrapped as an async function body (top-level `await` and `return` are the contract).
- [ ] A native run of the project file completes and its report is recorded under Review Results, with proof of which file ran: the run summary shows the new description ("Pressure-test a decision…") rather than the orphan's ("Convene a lens council…"). Observed 2026-09-15: invoking by name `council` in the session that created the file resolved the orphaned `~/.claude/workflows/council.js` (its registry is built at session start), so the recorded run invokes the project file by `scriptPath`; a fresh session must confirm name resolution.
- [ ] README states every contract point in Scope IN.

**Validation:**
```bash
# A catalog script has no CI runtime; the static parse is the narrowest check that can disprove it, plus the wish linter for the recorded evidence
bun -e "const s=require('fs').readFileSync('.claude/workflows/council.js','utf8').replace(/^export const meta[\s\S]*?\n}\n/,''); new (Object.getPrototypeOf(async function(){}).constructor)('agent','parallel','pipeline','phase','log','workflow','budget','args',s); console.log('parse ok')" && bun run wishes:lint
```

**depends-on:** none

---

### Group 2: contract-check — static test over the catalog

**Goal:** Make the catalog contract fail a PR when broken.

**Deliverables:**
1. `scripts/workflows-meta.test.ts`: for every `.claude/workflows/*.js`, asserts the file starts with `export const meta = {` whose literal parses and whose `name` equals the filename stem; asserts no `import`, `require(`, `Date.now`, `Math.random`, or quoted absolute path (`/Users/`, `/home/`, `/opt/`, `/var/`, `/tmp/`) outside comments, using the same meta-strip regex as the Group 1 validation so the two checks cannot drift; asserts the remainder parses as an async function body.
2. Negative fixtures inside the test (strings, not files) proving the name-mismatch, non-literal-meta and forbidden-token assertions fire.
3. `scripts/council-workflow-parity.test.ts`: the lens roster inlined in `council.js` must equal the numbered lens list in `skills/council/SKILL.md` (drift guard for Decision 2).

**Acceptance Criteria:**
- [ ] The test passes on `council.js` and `pm-ledger-verify.js`.
- [ ] The test fails on the inline negative fixtures.

**Validation:**
```bash
# New scripts/ file joins the repo-wide bun test and biome sweep: full gate plus the focused test
bun run check && bun test scripts/workflows-meta.test.ts scripts/council-workflow-parity.test.ts
```

**depends-on:** 1

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: `/council` appears in a Claude Code session opened in this repo and runs with a one-line decision.
- [ ] Integration: `/pm-ledger-verify` still runs unchanged from the same catalog.
- [ ] Regression: `bun run check` stays green with the catalog test in the sweep.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| The native tool's project-over-personal shadowing hides the orphaned `~/.claude/workflows/council.js` only inside this repo | Low | README documents the manual delete; the install channel deferred in this wish is the durable fix. |
| A native run costs six agents | Low | Recorded once as execution evidence; the static test is the CI gate. |
| `biome.json` ignores `.claude/`, so the script is never linted | Accepted | The static test is the lint for catalog scripts. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

- **Provenance:** split on 2026-09-15 from the combined `workflows-multibody` wish, which went through three plan-review loops (4 HIGH / 6 MEDIUM / 5 LOW, then 1 HIGH / 2 MEDIUM / 3 LOW, then SHIP) plus an amendment review. Findings that touched this half (catalog location, no drift guard, biome ignores `.claude/`, no root `workflows/`, static meta check) are applied here.

### Plan review — 2026-09-15 — SHIP

- **Context:** plan review of this wish and its sibling by a read-only reviewer subagent that had verified every fork claim over the three loops of the combined predecessor wish.
- **Commands and outcomes:** `bun run wishes:lint` → OK (88 files, template validator green). Group 1 validation (async-function parse of `council.js`) → "parse ok". Forbidden-token grep over `council.js` → no matches. `skills/council/SKILL.md` lenses, verdict / confidence enums and synthesis fields → match the script's schemas. `genie task list --json` → 2 cards carry `workflows-catalog`, 0 carry `workflows-multibody`.
- **Verdict:** SHIP — 0 HIGH, 0 MEDIUM, 3 LOW (install-channel attribution wording; prove which `council` file ran since the orphan shares `meta.name`; broaden the absolute-path check and share the meta-strip regex). All three applied in-document and in `scripts/workflows-meta.test.ts`.
- **Orchestrator transition:** DRAFT → **APPROVED**. Wave base recorded with `genie context --wish workflows-catalog`.

### Execution — council run — 2026-09-15 — `proceed-with-conditions`

- **Invocation surface:** the native Workflow tool by explicit `scriptPath` (`.claude/workflows/council.js`), run id `wf_0fd9c999-aad`, transcript dir `…/subagents/workflows/wf_0fd9c999-aad`. Observed `meta.description` "Pressure-test a decision through five independent lenses…" (the new file). A prior invocation by name `council` in the same session (`wf_0eef4161-744`) resolved the orphaned `~/.claude/workflows/council.js` instead and returned its "No topic to deliberate" error, so name resolution across scopes is unproven; see conditions.
- **Outcome:** `ok: true`, six agents (five lenses plus synthesis), none null, decision `proceed-with-conditions`; lenses: architecture, delivery, product, security `support-with-conditions` (medium), dissent `oppose` (medium). Full report saved as [council-2026-09-15.md](council-2026-09-15.md). Cost: 583k subagent tokens, 108 tool uses, 409 s.
- **Decision under assessment:** this wish and its sibling. The council corroborated the plan for the catalog half and pushed the fork half toward revise; its conditions are dispositioned below.
- **Applied in this wish (2026-09-15):** static test broadened to the README's full forbidden list plus DSH's restricted-source tokens and a pure-literal `meta` guard; `pm-ledger-verify.js` lens-attribution bug fixed (index after `filter(Boolean)`); README no longer asserts project-over-personal shadowing; `scripts/council-workflow-parity.test.ts` ties the inlined roster to `skills/council/SKILL.md`; this evidence block names the invocation surface.
- **Applied in the sibling wish:** upstream already bans the clock (its QuickJS bootstrap, not its token list), so that deliverable becomes error-message alignment; `@dsh-external/workflow` is git-only, not on npm; a seam-comparison gate against DSH's first-party `ctx.workflowEngine` precedes any fork work, with a kill criterion; host DSH version reconciliation; fail-closed policy for correctness-affecting options; finite defaults outside the conformance profile; `outputSchema` capability assertion.
- **Needs Felipe:** (1) the `council` name collision between `skills/council` and this workflow (the slash listing resolves to the skill): rename one surface or make the skill delegate to the workflow; (2) a fresh-session probe to record which `council` surface runs with the orphan present, from this repo and from a non-genie cwd; (3) whether to add a CODEOWNERS entry for `.claude/**`.
- **Deferred with triggers (unchanged):** install channel and tarball packaging; `genie doctor` warning for the orphan; retirement-surface routing for `~/.claude/workflows/council.js`.
- **Group 1 and Group 2 state:** deliverables landed on branch `wish/workflows-catalog`; Group 2 validation `bun run check` ran with the only failures being 19 pre-existing tests in `plugins/dsh-genie-board/src/board.test.ts` and `src/lib/orca-orchestration-adapter.test.ts`, reproduced identically on untouched dev HEAD `67a8d08b1`.

---

## Files to Create/Modify

```
.claude/workflows/council.js          (new: first canonical example)
.claude/workflows/README.md           (new: catalog contract)
scripts/workflows-meta.test.ts        (new: static contract test)
scripts/council-workflow-parity.test.ts (new: roster drift guard)
.claude/workflows/pm-ledger-verify.js (one-line lens attribution fix)
.genie/wishes/workflows-catalog/council-2026-09-15.md (recorded council run)
.genie/INDEX.md                       (entry)
```
