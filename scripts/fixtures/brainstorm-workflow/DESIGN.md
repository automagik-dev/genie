# Design: brainstorm as a saved workflow

| Field | Value |
|-------|-------|
| **Slug** | `brainstorm-workflow` |
| **Date** | 2026-10-01 |
| **WRS** | 100/100 |
| **Size** | M · one wish in four groups (raised by: owner, round 4, from the reviewer's L5) |

## Problem

`/brainstorm` lost the structure Felipe designed: `ed6028f15` (2026-09-15) cut it from 167 to 43 lines and removed the Wish Readiness Score, the DRAFT.md written from the start, the stuck-decision escalation and the output-by-size rule. The 2026-09-30 run showed it: no WRS bar, no DRAFT.md, classified Bounded until the owner pushed, and an approval that was stretched past the question asked.

## Scope

### IN
| # | Deliverable | Files changed | Source |
|---|-------------|---------------|--------|
| 1 | Round ledger: the only writer of the DRAFT's ledger block (Settled, Asked, size/scope ratchet, council count) and the template and traceability checks | `skills/brainstorm/references/round-ledger.mjs` (new), `scripts/brainstorm-round-ledger.test.ts` (new), `scripts/fixtures/brainstorm-workflow/` (new) | P1, P2, P4, P11, P13 |
| 2 | Routing contract: a `judge` tier (Fable 5.1) for Socrates in `brainstorm.js` only, and a clamped lead-chosen tier for scouts | `scripts/workflow-routing.test.ts`, `scripts/workflows-model-policy.test.ts`, `.claude/workflows/README.md` (Model routing section) | R2-4, R2-5 |
| 3 | `brainstorm.js`: one round per invocation, spine fixed, inside free; Socratic council with lenses the lead writes per decision, dissent always present | `.claude/workflows/brainstorm.js` (new), `scripts/brainstorm-workflow-behavior.test.ts` (new), `scripts/brainstorm-workflow-parity.test.ts` (new), `.claude/workflows/README.md` (Entries) | R1-2, R2-4, R5-roster, P12, P16 |
| 4 | `/brainstorm` SKILL.md as the front door, including the run without a workflow surface | `skills/brainstorm/SKILL.md`, `skills/brainstorm/agents/openai.yaml` if its description changes | R1-2, P2, P3 |
| 5 | Design template: WRS and Size rows; Source on Decisions and IN rows and on OUT bullets; files changed per IN item; Proof per criterion | `skills/brainstorm/references/design-template.md` | P10, P11, P13 |
| 6 | Council ceiling `budgets.maxCouncilsPerBrainstorm`, default 1, schema max 3 | `src/types/genie-config.ts`, `src/lib/genie-config.test.ts` | R3-council, R4-ceiling |
| 7 | Counts and anchors that name the front-door set | `scripts/workflow-front-door-parity.ts`, `scripts/front-door-workflow-parity.test.ts`, `.claude/rules/workflows-channel.md`, `.claude/workflows/README.md`, `scripts/release-docs.test.ts` (additions only) | `.claude/workflows/README.md` |

### OUT
- AGENTS.md copy of the per-question rule (Source: R3-agents; in PR #3085, open against dev).
- The visual companion; trigger: the first UI-heavy brainstorm (Source: P14).
- A Socratic type inside `council.js`; the Socratic council lives inside `brainstorm.js` as the owner's pattern (Source: R2-5).
- Changes to `design-review-evidence.mjs`, pinned byte-identical in two skills (Source: reviewer round-1 C11).

## Approach

A workflow cannot wait for a human, so each invocation is one round and the human answers between runs. The script fixes the auditable spine; a lead decides everything inside it. All file, git and CLI work happens inside named agents (catalog contract: no filesystem access in the script).

**Inputs.** The front door resolves absolute paths from its own skill directory and passes everything through `args`: `{slug, request?, answers?, repo, tools: {ledger, evidence, reviewContract}, councilCeiling, repairBudget, timestamp}`. `tools.ledger` is `round-ledger.mjs`, `tools.evidence` is `design-review-evidence.mjs`, `tools.reviewContract` is `review/SKILL.md`. `councilCeiling` comes from `genie config get budgets.maxCouncilsPerBrainstorm`, `repairBudget` from `genie config get budgets.maxEscalationsPerGroup`. Nothing is resolved relative to the checkout, so a round runs from any repository. When `review/SKILL.md` is not installed beside `brainstorm` (a single-skill install), the run ends `failed` naming it. When the `genie` CLI is absent, the front door uses the schema defaults (ceiling 1, repair budget 2) and the result says so.

**The ledger.** DRAFT.md carries one fenced `ledger` JSON block: `settled[] {id, question, answer, provenance, round}`, `asked[] {id, kind, question, options[], multiSelect, round}` (kind: `decision`, `council-approval`, `review-findings` or `end-without-design`), `size[] {value, by, round}`, `scopeIn[] {item, by, round}`, `councils[] {run, round, approvedBy?}`, `reviews[] {verdict, digest, round, repaired}`. Every token in a Source cell must resolve. `round-ledger.mjs render` rewrites only the Settled, Asked, Size, Scope and Councils sections from that block and keeps every other section verbatim, so the lead's WRS bar, understanding, gap map, Open and Assumed sections persist across runs while agents never edit Settled directly. Commands, each run by a named ledger agent that returns `{stdout, exitCode}` verbatim:
- `apply --draft P --answers JSON` settles answers to asked ids; refuses an unknown id, a question text that differs from Asked, an edit to Settled without an answer to a reopen question quoting old → new, and a size or scope downgrade without an owner answer. A skipped question stays Asked. Multi-select stores the array of labels; free text stores the verbatim quote as "owner said".
- `ask --draft P --questions JSON` assigns ids `R<round>-<n>` and records the batch.
- `ratchet --draft P --size S --scope JSON --by WHO` only raises.
- `council --draft P --run ID --ceiling N [--approved <settled id>]` records a convening; it always refuses past 3, and past `N` unless `--approved` names a Settled owner answer that asked for it.
- `render --draft P` rewrites the ledger-owned sections.
- `review --draft P --verdict V --digest D [--repaired]` appends to `reviews[]`; the stamp agent runs it right after the stamp, in the same agent.
- `--approved` accepts only a Settled entry of kind `council-approval` answered with its first (affirmative) option and not already named by an earlier council's `approvedBy`.
- `check-design --design P --draft P` flags a criterion without Proof, a Decisions or IN row or OUT bullet without Source, an IN item without files, a Source that is not a Settled id, a council or reviewer citation, or a repository path that exists, and a placeholder; exit 1 when blocking.

**A round.**
1. `ledger:apply` applies `args.answers` (if any) and returns the rendered DRAFT with its ledger block.
2. The lead (Opus 5.5) reads it. On round 1 it writes the understanding (said vs assumed), size (P/M/G, split or not) and the WRS with evidence per dimension. Every round it writes the gap map and a dispatch plan: 0..n scouts, each with tier (`worker` or `reasoner`) and effort, and whether to convene the council, with the reason and expected spend. It convenes only when the owner asked, or a decision is contested and hard to reverse.
3. The script runs the plan. Scouts run in parallel at the lead's tier through `modelFor(scoutTier(s.tier))`. Before any council the script reads the council count from the `councils[]` block in `ledger:apply`'s output. Past the ceiling it drops the council from the plan and the round carries a `council-approval` question asking the owner whether to convene anyway; the answer, once Settled, is passed as `--approved` in a later run. That question counts toward the batch of 4; a lower-priority decision moves to Open when the batch is full. The council is the owner's Socratic pattern: the lead writes 3 to 5 lens briefs for the decision at hand (the plan schema bounds the list to 3-5 items); the script adds a dissent lens when none is present, replacing the last brief when there are already 5, and logs it; lenses → Socrates (judge tier) → answers → Socrates writes the recommended answers and dissent. A council round runs no scouts, and one ledger agent (`ledger:commit`) records the convening, the questions and any raise after the council, so a council round is at most 1 apply + 1 lead + 12 council + 1 commit = 15 agents.
In a normal round the script caps scouts at 11 (15 minus apply, lead, compose and commit) and logs any it drops.
4. The lead (or Socrates' proposal in a council round) composes ≤4 harness-ready questions: 2-4 options, recommended first, dissent in the description. `ledger:ask` assigns ids. The rest of the frontier stays in Open. Raises go through `ledger:ratchet`.
5. At WRS 100 with nothing open, the lead writes DESIGN.md from the template, `ledger:check-design` runs (uncited rows become one harness question instead of a review), then a reviewer agent receives `tools.reviewContract`, the DESIGN, the DRAFT and the changed files plus what references them as required reading. Every verdict is stamped as returned through `tools.evidence`. SHIP freezes DESIGN.md. FIX-FIRST gets one lead repair and a fresh review per run; repairs are counted in `reviews[]` across runs against `repairBudget`. A blocking finding that only the owner can settle becomes a question instead. When a run ends FIX-FIRST with budget left, it returns `round` with one `review-findings` question carrying the open findings, options: repair again (Recommended), I settle them, stop. BLOCKED, or the budget spent, ends `blocked` with the findings. A crystallize run is at most 1 apply + 1 lead + 1 check + 1 review + 1 stamp-and-record + (1 repair + 1 check + 1 review + 1 stamp-and-record) = 9 agents.

**Result.** `state` is one of:
- `round`: questions exist, including a `review-findings` or `council-approval` question (ids kept outside the harness payload);
- `done`: a verified SHIP stamp; the only next route is `wish`;
- `answered`: the owner answered a question to end with a recorded verdict and no design;
- `blocked`: a ledger refusal the owner must resolve, a BLOCKED review, or the repair budget spent;
- `failed`: a spine agent returned null or the ledger failed to start.

The result also carries the WRS bar, the dispatch plan as run, and the DRAFT path.

**The front door** (`/brainstorm`) runs the workflow by explicit script path, relays each round through the question harness with the question text and option labels exactly as returned (no rephrasing, no translation), maps the answers back to ids by question order, and re-invokes. It writes the `.genie/INDEX.md` entry (Simmering while rounds run, Ready at `done`) and reads tokens per stage with `genie wish report <runId>` after each run. It carries the per-question rule verbatim: *"An answer settles only the question it answers. Nothing rides along: a change the owner was not asked about, including any edit to something they already approved, goes in its own question. An approved decision is reopened only by a question that quotes it and shows old → new. Moves that add scrutiny may be taken and announced; moves that reduce what the owner sees, or change what they approved, wait for their answer."*

**Without a workflow surface** (Codex and other runtimes), the front door runs the same spine inline: the ledger commands through the shell, the review through native delegation, and each question as numbered options with its id, in the same answer shape.

**Routing contract.** `brainstorm.js` declares, each on one line: `const TIERS = { worker: { model: '…' }, reasoner: { model: '…' }, judge: { model: '…' } }`, `const modelFor = (tier) => MODEL || TIERS[tier].model`, and `const scoutTier = (t) => (t === 'reasoner' ? 'reasoner' : 'worker')`. The routing scanner accepts the three-key TIERS and `modelFor('judge')` only in `brainstorm.js` and only on `socrates:*` labels, and `modelFor(scoutTier(…))` only on labels the tier map marks `lead` (`scout:*`) and only when the `scoutTier` line is present verbatim. `workflows-model-policy.test.ts` strips the three-key table for `brainstorm.js`. The worker and reasoner spellings follow `wish.js`; `judge` uses `'fable'`, which the Workflow runtime accepted in runs wf_24aa02c5-abd and the owner's khal-platform councils.

Alternatives considered: the old skill restored as prose (owner chose the workflow; prose rituals were skipped in 5 of 17 archived drafts, per the dissent lens of wf_24aa02c5-abd); a fixed pipeline with pinned tiers (owner chose spine fixed, inside free); one free agent for the whole round (loses the auditable spine); `/workfly` alone (owner chose a grouped wish, R4-delivery).

## Simplicity Case

- **Simplest complete design:** the old skill restored as prose. Rejected by the owner (R1-2); file-creating steps held in the archive while rituals did not.
- **Added machinery:** the workflow (R1-2); the ledger, because consent scope and the ratchet must be checked by code (P2, P4); the lead's dispatch plan (R2-4); the council ceiling (R3-council, R4-ceiling); the behavior test, because the spine only shows across runs.
- **A deliberate bet:** the template checks in `check-design` caught 0 of the 9 findings of the 09-30 review (free-the-models dissent). They stay as a free, model-less check; removal trigger: after 10 recorded brainstorm runs, if they caught no review finding, delete them.
- **Deferred until measured:** a ceiling default above 1; a native question harness on non-Claude runtimes.
- **Complexity removed:** the spike/bounded/architectural classifier and its paths, the six stuck-decision lens cards, the separate write-back turn, section-by-section approvals.

## Decisions

| # | Decision | Rationale | Source |
|---|----------|-----------|--------|
| 1 | WRS 5 × 20 with the bar every round; size from triage, outside the score | Felipe's design; a visible progress view | R1-1 |
| 2 | One round per run; DRAFT.md carries state; the skill is the front door | Workflows cannot pause for a human | R1-2 |
| 3 | Spine fixed (ledger, the human round, the review stamp); inside free for a lead | Free the models, keep what must be auditable | R2-4 |
| 4 | Council = the owner's Socratic pattern, Socrates on Fable 5.1 high | His pattern since 2026-09-28 | R2-5 |
| 4b | The lead writes 3 to 5 lens briefs per decision; dissent is always one of them | The owner's own runs write lenses per decision | R5-roster |
| 5 | No council unless the owner asks or a decision is contested and hard to reverse; reason and spend in the plan; reopens R1-3 ("one council per round answers every open decision") → lead's judgment | Never force spawns | R3-council |
| 6 | `budgets.maxCouncilsPerBrainstorm` default 1, schema max 3; past the configured value only with a Settled owner answer (`--approved`) | Owner's ceiling | R4-ceiling, reviewer N2 |
| 7 | An answer settles only the question it answers; the ledger is the only writer of Settled, keyed by id; reopen quotes old → new | The bundled-approval incident | P2, P1 |
| 8 | No classifier; every brainstorm keeps DRAFT, WRS and the stamp; size scales DESIGN.md | Choosing a path changed no artifact | P3 |
| 9 | Size and Scope IN only ratchet up without an owner answer | Under-sizing was the 09-30 failure | P4 |
| 10 | Template and traceability checks before review, no model call | Free; feeds the reviewer | P11, P13 |
| 11 | The workflow dispatches the review with review/SKILL.md's contract and the changed files as required reading; stamp every verdict; freeze on SHIP; FIX-FIRST repaired within `budgets.maxEscalationsPerGroup` | The 09-30 extra round came from an edit after SHIP; current skill and review/SKILL.md:84 already require repair plus fresh review | P10, P12, reviewer HIGH-4 |
| 12 | `state` is a closed set with defined triggers; only verified SHIP routes to wish | Path-bound endings | P16, reviewer M9 |
| 13 | Tool paths and config values come from the front door through `args` | Rounds must run outside this checkout | Reviewer HIGH-2, `.claude/workflows/README.md` |
| 14 | Delivered as one wish in four groups: G1 ledger, G2 routing, G3 workflow, G4 front door/template/config/anchors | Too many units for the single-task /wish | R4-delivery |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | The harness returns answers without ids | High | The front door maps by question order; the ledger verifies the text and refuses a mismatch |
| 2 | A council convening costs 0.7 to 1.3M tokens (wf_b001f24d-1c4, 10 agents, 679k; wf_24aa02c5-abd, 12 agents, 1.30M) | Medium | Off by default, ceiling 1, spend shown in plan and result |
| 3 | The DSH executor may not accept `'fable'` | Low | Verified on the Workflow runtime; the G2 group adds a zero-agent probe note for DSH |
| 4 | DRAFT.md is gitignored, so another clone loses round state | Low | DESIGN.md is the tracked artifact; the review receives the DRAFT |
| 5 | Long workflow runs stall | Medium | ≤15 agents per round; a council round runs no scouts |
| 6 | Non-Claude runtimes have no question harness | Low | Numbered options with ids, same answer shape |

## Success Criteria

- [ ] The ledger refuses an unknown id, a changed question text, an edit to Settled without a reopen answer, a size or scope downgrade without an answer, and a council past the ceiling. **Proof:** `scripts/brainstorm-round-ledger.test.ts`.
- [ ] `check-design` flags a criterion without Proof, a Decisions or IN row or OUT bullet without Source, an IN item without files, an unresolvable Source, and a placeholder; a committed fixture (this DESIGN.md plus a ledger block transcribing its Settled, council and reviewer ids) passes it. **Proof:** `scripts/brainstorm-round-ledger.test.ts` with `scripts/fixtures/brainstorm-workflow/`.
- [ ] The routing scanner rejects an unclamped variable tier, `judge` on a non-Socrates label, `judge` in another script, and `scoutTier` on a non-lead label, and accepts `brainstorm.js`. **Proof:** self-tests in `scripts/workflow-routing.test.ts`.
- [ ] Under fake agents keyed by label: answers from run 1 land in Settled in run 2; each `state` is reachable; `done` only after a SHIP stamp; FIX-FIRST repairs once per run, returns `round` with a `review-findings` question while budget remains, and ends `blocked` when it is spent; a council past the ceiling is not convened without a Settled, unused `council-approval` answer; a council round stays at ≤15 agents and a normal round caps scouts at 11; a plan with 6 lenses or none named dissent is corrected and logged. **Also:** `brainstorm-workflow-parity.test.ts` asserts the script carries the dissent check and both caps. **Proof:** `scripts/brainstorm-workflow-behavior.test.ts`.
- [ ] `skills/brainstorm/SKILL.md` has no spike/bounded/architectural classifier, carries the per-question rule text above verbatim, and has a "Without a workflow surface" section. **Proof:** new release-docs anchors.
- [ ] Every existing brainstorm anchor in `scripts/release-docs.test.ts` is unchanged; only additions. **Proof:** `git diff` of that file shows no removed `expect` line.
- [ ] One live round on a real idea, run from a checkout that is not genie, returns `state: round` with ≤4 questions carrying ids and the recommended option first, and writes the ledger block. **Proof:** the run id, its result and `genie wish report <runId>` output in the PR body.
- [ ] `bun run check` exits 0. **Proof:** the exit code quoted in the PR body.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `a2dd766c158cc36431d81261d3165e83eda8ab21a31a8ea65e7baff869cf9775`
- **Reviewer:** review-agent-opus-5.5
- **Reviewed at:** 2026-10-01T16:39:06.000Z
<!-- genie-design-review:end -->
