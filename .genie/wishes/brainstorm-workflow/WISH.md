# Wish: brainstorm as a saved workflow

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `brainstorm-workflow` |
| **Date** | 2026-10-01 |
| **Author** | Felipe Rosa |
| **Appetite** | medium |
| **Branch** | `wish/brainstorm-workflow` |
| **Repos touched** | automagik-dev/genie |
| **Design** | [DESIGN.md](../../brainstorms/brainstorm-workflow/DESIGN.md) |

## Summary

`/brainstorm` becomes a saved workflow that runs one round per invocation, with DRAFT.md as state and the skill as its front door. A deterministic round ledger is the only writer of Settled (an answer settles only the question it answers), the Wish Readiness Score returns, a lead chooses scouts, tier and effort and convenes the owner's Socratic council only when needed, and the workflow dispatches and stamps its own design review. The design is reviewed SHIP (digest `a2dd766c…`); this plan also resolves the eight non-blocking findings carried from that review.

## Scope

### IN

- G1: `round-ledger.mjs`, the only writer of the DRAFT's ledger block, with its tests and a committed fixture.
- G2: the routing contract accepts a `judge` tier for Socrates and a clamped lead-chosen tier for scouts, in `brainstorm.js` only.
- G3: `.claude/workflows/brainstorm.js` with a behavior test under fake agents and a parity test.
- G4: the `/brainstorm` front door, the design template, the `budgets.maxCouncilsPerBrainstorm` key, the front-door counts and anchors, and one live round from a checkout that is not genie.

### OUT

- AGENTS.md copy of the per-question rule (in PR #3085).
- The visual companion (trigger: the first UI-heavy brainstorm).
- A Socratic type inside `council.js`.
- Any change to `design-review-evidence.mjs` (pinned byte-identical in two skills).
- README and public docs beyond `.claude/workflows/README.md`.
- Editing the frozen DESIGN.md: carried findings are resolved here, in the plan.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Four groups in three waves: G1 ∥ G2, then G3, then G4 | G1 and G2 own disjoint files; G3 consumes both; G4 consumes G3 (owner R4-delivery) |
| 2 | `.claude/workflows/README.md` is edited by G2 (Model routing section), G3 (Entries) and G4 (counts) in that order, never in parallel | One file, three sections; sequencing avoids conflicts |
| 3 | Carried M-b: `settled[]` stores `kind` and the chosen option's `value`; a council approval matches the fixed value `convene`, never an option position; the approval and the cap of 3 are validated before convening; no approval question is asked at the cap | A recommended "don't convene" first option must never count as approval |
| 4 | Carried M-d: a Source token is an id-shaped string (`R<n>-<x>`, `P<n>`, `reviewer <id>`) or a backticked path; other text in a Source cell is prose and ignored; a cell needs at least one token and every token must resolve | Lets OUT notes such as "in PR #3085" carry context without breaking the fixture |
| 5 | Carried L10: `reviewer round-<n> <id>` resolves against `reviews[].findings`, criterion ids included | The frozen DESIGN.md cites "reviewer round-1 C11" |
| 6 | Carried M-a: an owner "stop" ends `blocked`; a run resumed by "repair again" goes straight to repair, check, review and stamp | Every transition lands in the closed state set |
| 7 | Carried M-c and L11: `ledger:commit` is one agent that runs `council`, `ask`, `ratchet` and `render` in that order; a crystallize run dispatches no scouts | Keeps the council round at 15 agents and the crystallize run at ≤11 (the design counted 9 before `ledger:commit` existed) |
| 8 | Carried L9: the fixture transcribes R1-1, R2-4 and R2-5 with their DRAFT meaning, not the `R<round>-<n>` numbering | The design's Sources were written before the ledger's id scheme |

## Simplicity Case

- **Simplest complete design:** the DESIGN.md as reviewed, split by file ownership into four groups; no group adds a mechanism the design does not name.
- **Added machinery:** none beyond the design; Decisions 3-8 only specify behaviour the review found underspecified.
- **Deferred until measured:** a council ceiling default above 1, a native question harness on non-Claude runtimes, and removing the template checks after 10 recorded runs that catch no review finding (the design's stated bet).
- **Complexity removed:** the spike/bounded/architectural classifier and its paths, the six stuck-decision lens cards, the separate write-back turn.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] The ledger refuses an unknown id, a changed question text, an edit to Settled without a reopen answer, a size or scope downgrade without an answer, a council past the ceiling without a Settled, unused `council-approval` answer of value `convene`, and any council past 3. **Proof:** `scripts/brainstorm-round-ledger.test.ts`.
- [ ] `check-design` flags a criterion without Proof, a Decisions or IN row or OUT bullet without a resolvable Source token, an IN item without files, and a placeholder; the committed fixture (the frozen DESIGN.md plus a ledger block transcribing its ids) passes it. **Proof:** `scripts/brainstorm-round-ledger.test.ts` with `scripts/fixtures/brainstorm-workflow/`.
- [ ] The routing scanner rejects an unclamped variable tier, `judge` on a non-`socrates:` label, `judge` in another script, and `scoutTier` on a non-`scout:` label, and accepts `brainstorm.js`. **Proof:** self-tests in `scripts/workflow-routing.test.ts`.
- [ ] Under fake agents keyed by label: answers from run 1 land in Settled in run 2; every `state` is reachable; `done` only after a SHIP stamp; FIX-FIRST repairs once per run, returns `round` with a `review-findings` question while budget remains, ends `blocked` when it is spent or the owner says stop; a council past the ceiling is not convened without a valid approval; a council round stays at ≤15 agents and a normal round caps scouts at 11; the plan schema bounds lenses to 3-5 and the script inserts dissent when it is missing; a run resumed by "repair again" starts at repair; no approval question is asked at the cap of 3; a reopen question changes a Settled id and a plain answer cannot; a repaired DESIGN that cites `reviewer <id>` passes `check-design`; a crystallize run dispatches no scouts and stays at ≤11 agents (the design's 9 plus `ledger:commit` from M-c and `lead:plan` when planning and design share a run). **Proof:** `scripts/brainstorm-workflow-behavior.test.ts`.
- [ ] `skills/brainstorm/SKILL.md` has no spike/bounded/architectural classifier, carries the per-question rule text verbatim, and has a "Without a workflow surface" section. **Proof:** new release-docs anchors.
- [ ] Every existing brainstorm anchor in `scripts/release-docs.test.ts` is unchanged; only additions. **Proof:** `git diff` of that file shows no removed `expect` line.
- [ ] (G4's review waits for this run.) One live round on a real idea, run from a checkout that is not genie, returns `state: round` with ≤4 questions carrying ids and the recommended option first, and writes the ledger block. **Proof:** the run id, its result and `genie wish report <runId>` in the PR body.
- [ ] `bun run check` exits 0. **Proof:** the exit code in the PR body.

## Execution Strategy

### Wave 1 (parallel)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | Medium: new standalone CLI and its tests, ~600-900 lines; no coupling to existing code | inherit | `round-ledger.mjs`, tests and fixture |
| 2 | engineer | Medium: tightens a shared contract scanner every workflow passes through, ~150-300 lines | inherit | Routing contract for `judge` and lead-chosen tiers |

### Wave 2 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | High: the workflow body, its state machine and agent budget, ~1,200-1,900 lines with tests, near the 2,000 band | inherit | `brainstorm.js`, behavior and parity tests, README Entries |

### Wave 3 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 4 | engineer | Medium: rewrites a delivered skill and touches release-docs anchors, config schema and front-door counts, ~300-500 lines | inherit | Front door, template, config key, counts, live round |

**Global constraints:**
- Models in routing are the 5.5 generation (`'sonnet'` = Sonnet 5.5 worker, `'opus'` = Opus 5.5 reasoner), plus `'fable'` (Fable 5.1) only as the `judge` tier on `socrates:` labels in `brainstorm.js` (owner R2-5).
- Catalog contract (`.claude/workflows/README.md`): pure-literal `meta`, plain JavaScript, no `import`/`require`, no filesystem or process access, no `Date.now()`/`Math.random()`/argless `new Date()`; everything arrives through `args`; all IO happens inside agents.
- Configuration may only tighten a budget: every `budgets.*` key has a schema `.max()` (`src/types/genie-config.ts`).
- `design-review-evidence.mjs` is not modified (pinned byte-identical in `skills/brainstorm` and `skills/wish`).
- Release-docs anchors only grow; no existing `expect` line is removed.
- Front doors name their workflow by explicit script path, never a bare name (`scripts/workflow-front-door-parity.ts`).
- Host umask is 0077: run `umask 022` in every shell of a fresh worktree and normalize file modes before committing.
- `skills-lint`: a SKILL.md stays within 40-90 lines; the tokens `Claude Code` and `Workflow tool` are banned in every file under `skills/`, `.mjs` included. Content that does not fit goes in a `skills/brainstorm/references/` file.
- Biome's root rules cover `skills/**/*.mjs`: `noConsole` is an error and cognitive complexity is enforced.
- The 11 existing brainstorm anchors in `scripts/release-docs.test.ts` keep their exact text in the rewritten SKILL.md.

## Execution Groups

### Group 1: Round ledger

**Goal:** a deterministic CLI that is the only writer of the DRAFT's ledger block and runs the design's template and traceability checks.

**Deliverables:**
1. `skills/brainstorm/references/round-ledger.mjs` (Node ESM, no dependencies) with the commands below.
2. `scripts/brainstorm-round-ledger.test.ts` covering every refusal and every `check-design` finding.
3. `scripts/fixtures/brainstorm-workflow/`: a copy of the frozen DESIGN.md and a DRAFT.md whose ledger block transcribes its Settled ids (R1-1, R1-2, R2-4, R2-5, R3-council, R3-agents, R4-ceiling, R4-delivery, R5-roster with their DRAFT meanings), council ids P1-P16 and the reviewer findings it cites.

**Interfaces:**
- Consumes: none.
- Produces: `node round-ledger.mjs <command> [flags]`; stdout is one JSON object; exit 0 ok, 1 refusal or blocking findings, 2 usage.
  - Ledger block: a fenced code block with info string `ledger` holding `{settled: [{id, kind, question, answer, value, provenance, round}], asked: [{id, kind, question, header, multiSelect, options: [{label, description, value}], round}], size: [{value, by, round}], scopeIn: [{item, by, round}], councils: [{run, round, approvedBy?, decided: [string]}], reviews: [{verdict, digest, round, repaired, findings: [string]}]}`; `kind` ∈ `decision | council-approval | review-findings | end-without-design`; `size.value` ∈ `P | M | G`. `councils[].decided` holds the council's decision ids (`P1`…); `reviews[].findings` holds the reviewer's finding and criterion ids (`HIGH-2`, `C11`…).
  - Bootstrap: when the DRAFT or its ledger block does not exist, `apply` creates the file or an empty block and exits 0.
  - Rounds: `apply` returns the round this run works on (the highest `asked[].round` + 1, 1 on an empty ledger); G3 passes it explicitly as `--round` to every later command in the run, so the order inside `ledger:commit` never shifts it.
  - `apply --draft <path> --answers <json>` with answers `[{id, question, answer: string | string[]}]` → `{round, applied: [{id, provenance}], refused: [{id, reason}], ledger}`. `apply` refuses an unknown id, a `question` that differs from `asked[id].question`, and any change to a Settled id unless the answer is to an asked question whose `reopens` names that id and whose text quotes old → new. `value` is taken from the asked option whose `label` equals the answer (an array of values for multi-select); free text stores `value: null` and the verbatim quote. `round` is the round this run works on.
  - `ask --draft <path> --round <n> --questions <json>`, each question `{kind, question, header, multiSelect, options: [{label, description, value}], reopens?}` → `{asked: [{id, ...}]}`; ids are `R<round>-<n>`. A `council-approval` question's affirmative option has `value: 'convene'`; `reopens` names the Settled id a reopen question changes.
  - `ratchet --draft <path> --round <n> --by <who> [--size <P|M|G>] [--scope <json>]`.
  - `council --draft <path> --round <n> --run <id> --ceiling <n> [--approved <id>] [--decided <json>]` records a convening; `--decided` is the list of decision ids Socrates' proposal settled (`P1`…), stored in `councils[].decided`.
  - `review --draft <path> --round <n> --verdict <SHIP|FIX-FIRST|BLOCKED> --digest <sha256> [--repaired] [--findings <json>]` appends to `reviews[]`; `--findings` is the reviewer's finding and criterion ids, stored in `reviews[].findings`.
  - `render --draft <path>` rewrites only the sections headed exactly `## Settled`, `## Asked`, `## Size`, `## Scope ratchet` (the design's "Scope" section of the DRAFT) and `## Councils`, appends any of them that is missing at the end of the file, and keeps every other byte.
  - `check-design --design <path> --draft <path> [--root <path>]` → `{findings: [{kind, location, detail, blocking}]}`. Tokens resolve as: `R<n>-<x>` against `settled[].id`; `P<n>` against `councils[].decided`; `reviewer round-<n> <id>` (n is the review's ordinal, the n-th entry of `reviews[]`; this form is matched before `reviewer <id>`) and `reviewer <id>` against `reviews[].findings`; a backticked path against `--root` (default: the git toplevel of the design's directory).

**Acceptance Criteria:**
- [ ] Success criteria 1 and 2.
- [ ] Decisions 3, 4, 5 and 8 hold in the tests.
- [ ] `render` keeps every section it does not own byte-for-byte.

**Validation:**
```bash
bun test scripts/brainstorm-round-ledger.test.ts && bunx biome check skills/brainstorm/references/round-ledger.mjs scripts/brainstorm-round-ledger.test.ts && bun run skills:lint
```

**depends-on:** none

---

### Group 2: Routing contract

**Goal:** the routing scanner accepts exactly the two new spellings `brainstorm.js` needs and rejects every other use.

**Deliverables:**
1. `scripts/workflow-routing.test.ts`: a `brainstorm.js` entry in TIER_MAP (`ledger:*` worker, `lead:*` reasoner, `lens:*` reasoner, `answer:*` reasoner, `review:*` reasoner, `socrates:*` judge, `scout:*` lead-chosen); acceptance of the one-line three-key TIERS, `modelFor('judge')` on `socrates:` labels and `modelFor(scoutTier(…))` on labels mapped `lead-chosen` (`scout:`) when the `scoutTier` line is present verbatim, all in `brainstorm.js` only; negative self-tests for each rejection in success criterion 3.
2. `scripts/workflows-model-policy.test.ts`: strips the three-key TIERS line for `brainstorm.js`.
3. `.claude/workflows/README.md`, Model routing section: the `judge` and lead-chosen tiers.

**Interfaces:**
- Consumes: none.
- Produces, for G3 to declare verbatim, each on one line:
  - `const TIERS = { worker: { model: 'sonnet' }, reasoner: { model: 'opus' }, judge: { model: 'fable' } }`
  - `const modelFor = (tier) => MODEL || TIERS[tier].model`
  - `const scoutTier = (t) => (t === 'reasoner' ? 'reasoner' : 'worker')`
  - Labels: `ledger:apply`, `ledger:commit`, `ledger:check`, `ledger:stamp`, `lead:plan`, `lead:compose`, `lead:design`, `lead:repair`, `scout:${i}`, `lens:${key}`, `answer:${key}`, `socrates:elenchus`, `socrates:proposal`, `review:design`.

**Acceptance Criteria:**
- [ ] Success criterion 3.
- [ ] Every existing workflow still passes unchanged.

**Validation:**
```bash
bun test scripts/workflow-routing.test.ts scripts/workflows-model-policy.test.ts
```

**depends-on:** none

---

### Group 3: The workflow

**Goal:** `.claude/workflows/brainstorm.js` runs one round per invocation as the design's Approach describes, within the agent budgets.

**Deliverables:**
1. `.claude/workflows/brainstorm.js` (`meta.name: 'brainstorm'`), steps 1-5 of the design's Approach with Decisions 3, 6 and 7 of this wish.
2. `scripts/brainstorm-workflow-behavior.test.ts`: runs the script body under fake agents keyed by label (precedent: `scripts/wish-workflow-behavior.test.ts`); every `ledger:*` fake runs the real `round-ledger.mjs` against a temporary DRAFT, so the G1↔G3 seam is exercised before G4.
3. `scripts/brainstorm-workflow-parity.test.ts`: the script carries the dissent check, the 11-scout cap and the 3-5 lens bound, and declares the G2 lines verbatim.
4. `.claude/workflows/README.md`, Entries: one `brainstorm` row.
5. `plugins/dsh-workflow-loader/src/dialect.test.ts`: `EXPECTED_REMOVALS` gains `brainstorm: <count of effort options in brainstorm.js>`.

**Interfaces:**
- Consumes: G1's CLI (through `args.tools.ledger`, called only inside ledger agents) and G2's TIERS, `modelFor`, `scoutTier` and labels.
- Produces: `args = {slug, request?, answers?: [{id, question, answer}], repo, tools: {ledger, evidence, reviewContract}, councilCeiling, repairBudget, model?, timestamp}` (`model` pins every stage, as in every catalog entry); result `{state: 'round' | 'done' | 'answered' | 'blocked' | 'failed', wrs, questions: [{id, kind, question, header, multiSelect, options: [{label, description}]}], plan, draft, notes: [string]}`.

**Acceptance Criteria:**
- [ ] Success criterion 4.
- [ ] The routing and catalog contract tests pass for `brainstorm.js`.

**Validation:**
```bash
bun test scripts/brainstorm-workflow-behavior.test.ts scripts/brainstorm-workflow-parity.test.ts scripts/workflow-routing.test.ts scripts/workflows-model-policy.test.ts scripts/workflows-meta.test.ts plugins/dsh-workflow-loader/src/dialect.test.ts
```

**depends-on:** Group 1, Group 2

---

### Group 4: Front door, template, config and the live round

**Goal:** `/brainstorm` runs the workflow by explicit path from any repository, and the release surfaces name it.

**Deliverables:**
1. `skills/brainstorm/SKILL.md` rewritten as the front door: resolves `tools` paths from its own directory, reads `genie config get budgets.maxCouncilsPerBrainstorm` and `budgets.maxEscalationsPerGroup` (schema defaults when the CLI is absent or exits non-zero, as an installed 6.260929.2 does on the new key, said in the result), relays questions verbatim through the question harness, maps answers back by order and forwards each question's text as the harness returned it, writes the `.genie/INDEX.md` entry, reads `genie wish report <runId>`, carries the per-question rule verbatim ("An answer settles only the question it answers. Nothing rides along: a change the owner was not asked about, including any edit to something they already approved, goes in its own question. An approved decision is reopened only by a question that quotes it and shows old → new. Moves that add scrutiny may be taken and announced; moves that reduce what the owner sees, or change what they approved, wait for their answer."), and has "Without a workflow surface". Every existing release-docs anchor text survives.
2. `skills/brainstorm/references/design-template.md` (keeps its `## Problem` heading, which `design-review-evidence.test.ts` edits to prove tamper detection): WRS and Size rows; Source on Decisions and IN rows and on OUT bullets; files changed per IN item; Proof per criterion.
3. `src/types/genie-config.ts`, `src/lib/genie-config.test.ts` and `src/term-commands/config.test.ts`: `maxCouncilsPerBrainstorm: z.number().int().nonnegative().max(3).default(1)`; every test that pins the whole budgets object gains the key.
4. Counts and anchors: the explicit-script-path assertion for brainstorm (`expectExplicitScriptPathRule(<SKILL.md>, 'brainstorm')`) added to `scripts/brainstorm-workflow-parity.test.ts`; the front-door count goes from six skills and seven parity tests to seven and eight in `scripts/workflow-front-door-parity.ts`, `scripts/front-door-workflow-parity.test.ts`, `.claude/rules/workflows-channel.md` and `.claude/workflows/README.md`; `scripts/release-docs.test.ts` gains anchors only.
5. The coordinator session (it has a workflow surface; a dispatched engineer may not) runs one live round after G4 lands on the wish branch: a scratch repository created with `git init` under the session scratchpad, the script and `tools` given as explicit paths into the wish worktree, a real idea as the request. Its run id, result and `genie wish report` output go in the PR body. The scratch repository is the only write outside the worktree and needs the owner's go before it runs.
6. `skills/brainstorm/agents/openai.yaml` and the `skills/README.md` catalog row change only if the SKILL.md frontmatter description changes, and then together.

**Interfaces:**
- Consumes: G3's `args` and result shapes.
- Produces: the `/brainstorm` front door; config key `budgets.maxCouncilsPerBrainstorm`.

**Acceptance Criteria:**
- [ ] Success criteria 5, 6, 7 and 8.

**Validation:**
```bash
bun test src/lib/genie-config.test.ts src/term-commands/config.test.ts scripts/release-docs.test.ts scripts/front-door-workflow-parity.test.ts scripts/brainstorm-workflow-parity.test.ts && bun run skills:lint && bun run check
```

**depends-on:** Group 3

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] After `genie update` on a host, `~/.claude/workflows/brainstorm.js` is delivered and recorded, and `genie doctor` reports the catalog with it present.
- [ ] `/brainstorm <idea>` in a repository other than genie returns a round with the WRS bar and ≤4 harness questions, and a second invocation with the answers moves them into Settled.
- [ ] An existing `/council`, `/wish` and `/workfly` run is unaffected by the routing change.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| The DSH executor may not accept `'fable'` | Low | G2 notes it in the README routing section; the Workflow runtime accepted it in wf_24aa02c5-abd |
| The behavior test under fakes misses a real-runtime failure | Medium | G4's live round from a non-genie checkout |
| Three groups edit `.claude/workflows/README.md` | Low | Waves sequence them (Decision 2) |
| A full `bun run check` run concurrently with another suite times out on this host | Medium | Run the gate alone; CI is the clean signal |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review 1 — 2026-10-01T16:55:27Z — FIX-FIRST
- Reviewer: `plan-review-agent-opus-5.5`; reviewed WISH.md sha256 `548edbb7852975f2df46fd2c759d3f98bcafab6eee14c3dcf792736ec1309d5d`; design verify passed on `a2dd766c…`; `genie wish lint` exit 0.
- HIGH: H1 `plugins/dsh-workflow-loader/src/dialect.test.ts` pins the catalog to ten stems and no group owned it; G3 Validation skipped the catalog tests. H2 `src/term-commands/config.test.ts` pins the whole budgets object. H3 G1/G3/G4 seam undefined (round-1 bootstrap, answer `value`, owned headings, round number) and untested before G4.
- MEDIUM: M1 Source tokens for council and reviewer ids have no ledger field; L10 pattern mismatch; paths need a root. M2 the live round's owner, paths, scratch repository and config fallback. M3 gate rules (skills-lint size and banned tokens, biome on `.mjs`) missing. M4 no owner for the brainstorm explicit-script-path assertion and the new counts. M5 carried behaviour missing from criteria; crystallize bound.
- LOW: L1 `model?` arg; L2 `agents/openai.yaml`; L3 quote the rule; L4 size per group; L5 tier name `lead` collides with the `lead:` label prefix.
- Disposition: all fixed in place below; sent to plan review 2.

### Plan review 2 — 2026-10-01T17:00:03Z — FIX-FIRST
- Reviewer: `plan-review-agent-opus-5.5`; reviewed WISH.md sha256 `5520d861f26229e8dd27b151896689722c3d5aebbb5e400eacdd10d3eab1247c`; every review-1 finding resolved.
- HIGH: N1 the `apply` input carried no question text and no reopen marker, so two refusals of criterion 1 had no interface (present since rev 1). N2 `councils[].decided` and `reviews[].findings` had no writer.
- MEDIUM: N3 the round default shifted inside `ledger:commit`. LOW: N4 meaning of n in `reviewer round-<n>`; N5 deliverable numbering, criterion 7 timing, missing-section placement, multi-select value, `## Scope ratchet` naming, the template's `## Problem` heading.
- Disposition: all fixed in place; sent to plan review 3.

### Plan review 3 — 2026-10-01T17:02:31Z — SHIP → APPROVED
- Reviewer: `plan-review-agent-opus-5.5`; reviewed WISH.md sha256 `9e2c4939ef849c9022574cebec1a4b44ebe3191345c1114ede712496ad24c733`; `genie wish lint` exit 0; design verify exit 0 on `a2dd766c…`; every review-1 and review-2 finding resolved; no file outside the declared set turns red.
- Accepted, non-blocking, carried to execution (the plan above is the reviewed text and is not edited):
  - P1 (G3): Socrates' proposal returns an id per decision; `ledger:commit` passes them as `--decided`; `ledger:stamp` passes the reviewer's finding ids as `--findings`. In G1's `council` line, read "settled" as "named".
  - P2 (G3): `ledger:apply` checks that `tools.reviewContract` exists and the run ends `failed` naming the path; add the case to the behavior test.
  - P3 (G1): `ratchet … [--approved <settled id>]` only raises, unless `--approved` names a Settled answer that agreed to exactly that downgrade (DESIGN Decision 9).
  - L-a (G1, G3): a skipped question stays in Asked and is shown again in the next run.
  - L-b (G1): `asked[]` stores `reopens`; `ask` refuses a `reopens` naming an unknown Settled id; a reopened Settled entry records `reopenedBy`.
- Open: DSH acceptance of `'fable'` stays unverified (Risk 1).

### Group 2 review — 2026-10-01T18:09:47Z — SHIP
- Reviewer `review-g2-opus-5.5` on `014f38844` (blind criteria C1-C12 frozen at 18:03:31Z); validation 55 pass, 0 fail; workflows-meta 17 pass; 12 of 14 scanner mutations caught.
- Non-blocking: M1 model names only shape-checked; M2 (pre-existing) label/model read from raw call text, follow-up outside this wish; L1 two rulings without self-tests; L2 README wording. Quality pass: three maintainability LOWs.
- One quality loop at `973756f8a`: model names pinned (`sonnet`/`opus`, `judge: 'fable'` in brainstorm.js only), the two self-tests added, clamp occurrence and value-use message fixed, README wording. Coordinator re-ran validation: 75 pass, 0 fail. Merged `--no-ff` into `wish/brainstorm-workflow`.

### Group 1 review — 2026-10-01T18:34:43Z — SHIP
- Reviewer `review-g1-opus-5.5` on `82de04167`; validation 41 pass; fixture DESIGN.md byte-identical to the frozen design; fixture ids traced to the real reviewer replies (nothing invented); CLI driven by hand against the G3 contract; 8 of 9 mutations caught.
- Rulings 1-11 accepted (notably: round = 1 + highest round recorded anywhere; downgrade approved only by an unused Settled answer of value `size:<P|M|G>` or `scope-drop:<item>`).
- Non-blocking: A (MEDIUM) reopen quote matched any substring; B (MEDIUM) a second open reopen of the same id could never be answered; L1-L7. Quality pass: non-atomic DRAFT write; unused exports.
- One quality loop at `71f684294`: A, B, L1, L2, L3 fixed and the DRAFT write made atomic; L4-L7 accepted as is. Coordinator re-ran validation: 48 pass, 0 fail, biome clean, skills-lint OK. Merged `--no-ff` into `wish/brainstorm-workflow`.
- For G3: the council and downgrade rules must also be checked before convening, from `apply`'s returned ledger; Socrates numbers decisions after the existing `P<n>`; the lead writes `size:`/`scope-drop:` and `convene` option values exactly.
- For G4: the template needs the exact headings, an IN table with "Files changed" and "Source" columns, and OUT bullets ending "(Source: …)".

---

## Files to Create/Modify

```
skills/brainstorm/references/round-ledger.mjs            (new, G1)
scripts/brainstorm-round-ledger.test.ts                  (new, G1)
scripts/fixtures/brainstorm-workflow/                    (new, G1)
scripts/workflow-routing.test.ts                         (G2)
scripts/workflows-model-policy.test.ts                   (G2)
.claude/workflows/README.md                              (G2 Model routing, G3 Entries, G4 counts)
.claude/workflows/brainstorm.js                          (new, G3)
scripts/brainstorm-workflow-behavior.test.ts             (new, G3)
scripts/brainstorm-workflow-parity.test.ts               (new, G3; G4 adds the front-door assertion)
plugins/dsh-workflow-loader/src/dialect.test.ts          (G3)
skills/brainstorm/SKILL.md                               (G4)
skills/brainstorm/references/design-template.md          (G4)
src/types/genie-config.ts                                (G4)
src/lib/genie-config.test.ts                             (G4)
src/term-commands/config.test.ts                         (G4)
skills/brainstorm/agents/openai.yaml, skills/README.md   (G4, only if the description changes)
scripts/workflow-front-door-parity.ts                    (G4)
scripts/front-door-workflow-parity.test.ts               (G4)
.claude/rules/workflows-channel.md                       (G4)
scripts/release-docs.test.ts                             (G4, additions only)
```
