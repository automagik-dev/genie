# DRAFT: Intent-to-Wish Compiler — Genie Product Operating Model

**Parent:** [genie-token-efficiency-program](../genie-token-efficiency-program/DESIGN.md) · **Status:** Simmering
**Related:** [brainstorm-domain-map](../brainstorm-domain-map/DRAFT.md) · [skill-absorbs](../skill-absorbs/DRAFT.md) (`pm` absorption)
**Started:** 2026-07-09

## Problem

Business stakeholders and FDEs need to turn a demand into correctly prioritized, correctly sized, executable software work without knowing product-framework mechanics or accidentally spending standard-wish resources on a tiny fix.

The framework must make the **how invisible** while keeping every routing and sizing decision inspectable.

## Felipe's framing

- The why is usually clear; the what is less clear; the how should be invisible.
- The framework must cover the full path from stakeholder demand to roadmap to one unit of meaningful work (`wish`).
- A wish is not a tiny task. Genie must distinguish a fix from a real bet automatically.
- Wish size must constrain token/model spend; a small fix must not become a billion-token planning/execution session.
- Felipe performs this shaping and sizing manually today; FDEs should receive it as an automatic framework capability.

## Framework comparison

### Scrum/backlog — not the spine

Useful concepts: Product Goal, Sprint Goal, Definition of Done, empirical inspection. Weak fit here: it centers an ordered Product Backlog and leaves item sizing to developers; Genie's target users often are not developers, and an endlessly refined backlog encourages feature inventory rather than explicit bets.

Source: [The Scrum Guide](https://scrumguides.org/scrum-guide.html).

### Amazon Working Backwards — intake layer

Start from the desired customer outcome, customer value, adoption/usage assumptions, and FAQ; work backwards into operational and technical requirements. Strong for translating stakeholder demand into a customer contract. It does not by itself define portfolio betting, execution slicing, or AI spend.

Source: [AWS guidance on Working Backwards](https://docs.aws.amazon.com/wellarchitected/latest/devops-guidance/oa.ti.6-prioritize-customer-needs-to-deliver-optimal-business-outcomes.html).

### Impact Mapping — strategy-to-scope bridge

Goal → Actors → desired behavior Impacts → Deliverables preserves the causal chain from business outcome to proposed software. Strong for roadmaps that explain why work exists and for deleting features that do not support an impact.

Source: [Impact Mapping — Drawing impact maps](https://www.impactmapping.org/drawing.html).

### Shape Up — favorite spine

Shape Up is the closest fit because it distinguishes raw demand from shaped work, sets an **appetite before solution detail**, treats the committed unit as a bet with a defined payout and capped downside, and uses a circuit breaker instead of allowing runaway projects. It also separates shaping from building and refuses to turn every incoming request into backlog inventory.

Sources: [Principles of Shaping](https://basecamp.com/shapeup/1.1-chapter-02), [Set Boundaries](https://basecamp.com/shapeup/1.2-chapter-03), [The Betting Table](https://basecamp.com/shapeup/2.2-chapter-08).

## Recommendation: a Genie-native synthesis

Shape Up is the operating spine; Working Backwards is the demand intake; Impact Mapping is the causal roadmap; Genie's executable specification + proof system is the delivery compiler.

```text
Demand → Outcome → Impact Map → Shaped Pitch → Bet/Roadmap → Wish → Groups → Proof → Outcome
```

### 1. Demand — cheap, uncommitted signal

The stakeholder says what they need and why in ordinary domain language. Genie records the signal without turning it into a task or promise. Duplicate demands can cluster under the same outcome.

Minimum visible input:
- Who is affected?
- What are they unable to do or what goes wrong today?
- What observable change would make this valuable?

Genie should infer answers from supplied context and existing product evidence first, asking only unresolved domain gaps.

### 2. Outcome contract — Working Backwards, compressed

Genie synthesizes a short customer-facing future narrative plus FAQ-level risks:
- target actor and current baseline;
- desired behavior/outcome and business measure;
- why existing alternatives are inadequate;
- adoption, operational, policy, and failure questions.

This is not automatically a wish. It is a candidate product outcome.

### 3. Impact map — the roadmap's reasoning graph

Each candidate outcome traces:

```text
business goal → actors → behavior changes → candidate deliverables
```

Deliverables without a supported impact are removed. Competing deliverables for the same impact remain options until shaping chooses one.

### 4. Shaped pitch — `/brainstorm`

The large planning model sets an appetite, maps domains/gaps, explores alternatives, resolves rabbit holes, defines the payout, and classifies oracles. The pitch stays uncommitted until it is good enough to bet on.

### 5. Bet/roadmap — portfolio decision

The roadmap is not a feature backlog:

| Horizon | Meaning |
|---|---|
| **NOW** | Bets actually committed; each has a funded appetite and an executable/compiling wish |
| **NEXT** | Shaped pitches eligible for the next betting decision; no delivery promise |
| **LATER** | Outcome themes and recurring signals worth preserving; no detailed feature inventory |
| **DONE** | Shipped bets with proof, actual cost, and measured/awaiting outcome |

Only NOW is a commitment. NEXT/LATER remain options so learning can change the roadmap cheaply.

### 6. Wish — one shaped bet, not one task

A wish is the executable contract for **one meaningful payout** within a fixed appetite. It owns the requirement/oracle graph, scope boundary, risk decisions, execution DAG, proof requirements, and circuit breaker.

Multiple independently valuable payouts mean multiple wishes under a program/roadmap outcome. Umbrella wishes are planning containers and are never executed directly.

### 7. Group — the smallest independently provable execution slice

Groups are implementation units inside a wish. Group complexity selects model effort; it does not determine whether the parent request deserved a wish.

### 8. Proof and outcome

`/work` produces proof packets; `/review` verifies the requirement-to-evidence graph and residual uncertainty. After shipping, the roadmap tracks whether the business outcome occurred, not merely whether code merged.

## Invisible wish sizing and routing

Wish size is not story points, estimated files, or generated tokens. It is classified from **outcome cardinality, semantic surface, uncertainty, consequence, reversibility, and oracle strength**.

### Routing lanes

| Lane | Deterministic fit test | Lifecycle/appetite consequence |
|---|---|---|
| **Incident** | Active harm/data loss/security/outage; urgency dominates portfolio order | Diagnose/contain/fix immediately; minimal incident contract; retrospective proof and follow-up shaping |
| **Patch** | One existing behavior is wrong; expected behavior + repro are objective; one domain/local surface; reversible; no architecture/product decision | Compact direct contract, one group, fresh small context, no Fable by default, one review/fix budget |
| **Small bet** | One actor impact, one domain, strong oracle, at most two tightly coupled groups, no unresolved rabbit hole | Lightweight shaping only if a gap exists; one wish; cheap execution; Fable gate only on risk triggers |
| **Standard bet** | One meaningful payout, multiple domains/surfaces or 3–6 groups, state/contract decisions, or meaningful judgment | Full brainstorm → wish → work → review lifecycle and existing routing/budget policy |
| **Program** | Multiple independently valuable payouts, more than six plausible groups, or child work can be bet/shipped separately | Umbrella design + roadmap entries; split into child wishes before any `/work` dispatch |
| **Spike** | A technical/domain unknown prevents a trustworthy oracle or bounded solution | Timeboxed learning wish whose output is evidence/decision, never disguised production delivery |

### Hard routing rules

1. **More than one independent payout ⇒ split**, regardless of apparent coding size.
2. **No trustworthy oracle ⇒ shape or spike**, never compensate with a smarter executor.
3. **High consequence raises verification**, not scope: security, money, permissions, migrations, and irreversible state force stronger review even when the diff is small.
4. **A patch that requires architecture or product policy is not a patch.**
5. **A program is never executable.** Only its independently funded child wishes are.

### Appetite versus complexity

- **Wish lane/appetite** controls lifecycle depth, number of groups, context allowance, expensive-model gates, and the stop condition.
- **Group complexity score** (already decided in `routing-matrix`) controls model/effort for one bounded implementation group.
- **Actual cost telemetry** calibrates both: `genie spend` should maintain rolling p50/p90 cost and cache-read burn by lane, complexity, and outcome verdict.

Do not invent permanent dollar/token thresholds before measurement. Start with structural caps (groups, contexts, Fable gates, fix loops), then derive monetary/token appetites from observed distributions.

### Circuit breaker — the full contract (RATIFIED by Felipe 2026-07-09, as recommended)

One-line principle: **when appetite exhausts, Genie cuts breadth and attempts, never proof — and only humans cut payout.**

Rationale from the burn data: the north star is *cost per group accepted without reopening*. Cutting verification to save tokens converts visible spend into invisible reopen-debt — the most expensive token in the system is the one spent reopening a "done" group. The breaker therefore protects the denominator (accepted-without-reopening) and attacks the numerator (scope, attempts, context).

**FIXED — non-negotiable when the breaker fires:**
1. **The payout definition.** The executing session may never redefine success criteria to declare victory. Shrinking the payout (shipping a partial outcome) is a betting-table decision — routed through the omni approval queue with the breaker report attached, decidable from WhatsApp. Never autonomous.
2. **Proof discipline on everything that lands.** Any group that merges gets full review at its consequence tier. No "salvage merges."
3. **Repo invariants.** Green tree, no half-applied migrations, no disabled gates. Revert beats landing unproven.
4. **The breaker report.** Compiled by the control plane from genie.db state (group statuses, stage log, spend) — deterministic, near-zero model cost. The dying session contributes only a diagnosis enum + ≤3 sentences; it does not write a retrospective at 90% context.
5. **Consequence-tier verification.** Security/money/permissions/migration review never shrinks to fit a budget (hard routing rule 3 survives the breaker).

**CUTTABLE — in order, autonomously:**
1. **Flex groups** — every group is tagged `core|flex` at bet time; Genie cuts flex without asking (logged; cut scope returns to LATER/demand pool with its impact-map link intact — cuts become signal, never silent deletion).
2. **Exploration breadth** — alternatives, speculative robustness beyond the declared oracles, opportunistic refactors.
3. **Retry attempts** — fix loops shrink before verification does; a failing group parks as evidence instead of getting more attempts.
4. **Polish** — docs beyond minimum, cosmetic fidelity.

Never autonomously cuttable: anything in the FIXED list, and core groups — a core group that cannot fit is a breaker fire, not a scope cut.

**Tag-gaming guard:** core-set sufficiency is a plan-review gate item — the core groups alone must deliver the payout. All-core tagging (nothing cuttable) is legal for Patch/Small; for Standard+ the reviewer challenges it. All-flex tagging is structurally invalid (payout unreachable).

**Mechanics when the breaker fires:**
- Stop dispatching new groups. In-flight groups: **proof is the discriminator** — a group whose proof packet exists finishes its review; a group with no proof yet parks on its branch unproven. ("Almost done" claims without proof don't count; this is the same proof-carrying rule as everywhere else.)
- Parked branches are evidence, not pre-approved work: nothing auto-revives; the re-shaping decides revive-or-delete explicitly, and a revived branch re-enters as a new group with fresh review.
- Wish status → `returned` (not failed, not done). Board/INDEX reflect it.
- **Re-entry depends on diagnosis** — not everything needs re-shaping:
  | Diagnosis | Re-entry path |
  |---|---|
  | Environment (CI down, infra flake) | Same pitch, new appetite — cheap re-bet, no re-shaping |
  | Missing evidence | Spike wish; output feeds the re-shape |
  | Bad shaping | Full `/brainstorm` re-shape referencing the breaker report |
  | Irreducible scope | Split into program / smaller payout ruling at the betting table |
- A re-bet is always a **new bet with fresh appetite** — never an "extension" of the exhausted one.

**Detection ownership:** the control plane (genie.db counters + spend telemetry), never self-reported by the burning session — a session at 90% context is the least qualified agent to notice it is over budget. Phase 1 = structural caps (groups dispatched, fix loops, reviewer reopens; group-level cap already exists as routing-matrix `maxEscalationsPerGroup`). Phase 2 = $/token caps per lane from `genie spend` percentiles. Seam to record: hooks see every PreToolUse, so a cheap per-session turn/context tripwire can live in the hook chain (interface to always-on-genie + control-plane-contract; do not build yet).

For Patch and Small Bet lanes, all caps are drastically tighter — this is the mechanism that prevents a local fix from inheriting a monolithic planning session and consuming billion-token cache reads.

**Hermes counter-read:** cegonha unreachable 2026-07-09 (fail-open policy applied — logged, not blocking). Self-run adversarial pass in its place; attacks that produced the refinements above: flex-tag gaming → core-set sufficiency gate; parked-branch landfill → explicit revive-or-delete + fresh review; attempt-starving near-done work → proof-as-discriminator; human-only payout cut as bottleneck → omni approval queue; detection lag inside one group → group-level caps + hook tripwire seam; environment thrash → diagnosis-dependent re-entry; breaker-report token cost → control-plane-compiled report.

## Invisible FDE experience

The user experiences a conversation, not a framework ceremony:

1. The FDE states the demand in business language.
2. Genie mines available product/repo context and builds the outcome/impact/domain maps silently.
3. Genie asks one question only when an answer changes value, scope, truth ownership, or risk.
4. Genie explains the result in one line: inferred lane, appetite, reason, and any human decision needed.
5. The full map, score inputs, assumptions, and routing are persisted for audit but hidden by default.

The classification must be **invisible but explainable**: no story-point meeting, no architecture interrogation of a business stakeholder, and no unexplained model/spend choice.

## Scope

### IN

- End-to-end artifact/state model from raw demand through outcome tracking.
- Roadmap semantics and the relationship between outcome, pitch, bet, wish, and group.
- Deterministic lane classifier and automatic lifecycle/model/context appetite selection.
- FDE-facing interaction contract: domain-language questions, silent inference, explainable routing.
- Interfaces to `brainstorm-domain-map`, `routing-matrix`, `genie-spend`, `pm` absorption, and proof-carrying work/review.

### OUT

- Implementing CLI/schema/skill changes during this brainstorm.
- Choosing permanent dollar/token thresholds before per-lane telemetry exists.
- Prescribing organizational sprint/cycle length; Genie's appetite is resource/cost bounded and need not copy Shape Up's six-week cadence.
- Replacing incident response, support intake, or long-term company strategy with one framework.
- Forcing every request through a full wish; Patch and Incident lanes deliberately use smaller contracts.

## Risks

| Risk | Mitigation direction |
|---|---|
| Invisible routing feels arbitrary | Persist inputs and emit a concise rationale; allow explicit human override with audit |
| “Patch” becomes a loophole for unreviewed risk | Hard disqualifiers for state/security/architecture/policy; risk raises review tier |
| Outcome maps become another backlog | LATER stores themes/signals, not decomposed feature inventory; only shaped bets advance |
| Appetite cuts essential quality | Quality/invariants are fixed; variable scope cuts peripheral capability, never correctness |
| Over-shaping cheap work | Patch lane bypasses full brainstorm; measure planning-to-execution cost ratio |
| Framework-specific jargon leaks to FDEs | Ask actors, baseline, behavior, and examples in domain language; technical artifacts are compiled output |
| Historical p90 normalizes waste | Pair cost distributions with accepted-without-reopening and outcome success, not cost alone |

## Candidate acceptance criteria

- [ ] Given representative demand fixtures, the classifier deterministically routes Incident/Patch/Small/Standard/Program/Spike with a human-readable reason.
- [ ] An independently reproducible local bug routes to Patch without loading unrelated roadmap/program context or invoking Fable by default.
- [ ] A request with two independently valuable payouts routes to Program and cannot dispatch `/work` until split.
- [ ] Every committed roadmap bet maps to exactly one executable wish; every wish maps to one outcome/payout.
- [ ] Every wish declares its lane/appetite and circuit-breaker policy; every group retains its separate complexity score.
- [ ] FDE prompts use domain language and ask only gaps that can change value, scope, truth ownership, or risk.
- [ ] `genie spend` can report cost and accepted-without-reopening by lane so budgets can be recalibrated from evidence.

## Decisions (ratified)

**Circuit-breaker contract — RATIFIED as recommended (Felipe, 2026-07-09):**
1. **Flex-cut autonomy:** Genie cuts pre-tagged flex groups without asking (logged, returned to LATER with impact-map link).
2. **Partial-payout shipping:** human-only, via omni approval queue with the control-plane-compiled breaker report attached.

This completes the commitment semantics: fixed appetite, variable peripheral scope, proof never variable, payout human-owned.

## Next refinement

By its own lane classifier this track is a **Program**, not one wish: pouring it means child wishes, not a single `/work` dispatch. Natural seams (to confirm at pour time):
- **Lane classifier + breaker state machine** — genie.db wish fields (lane, appetite caps, core|flex tags, `returned` status, diagnosis enum) + board rendering. Depends on control-plane-contract.
- **Intake compiler** — Working Backwards + Impact Mapping absorbed into `/brainstorm` (merges with brainstorm-domain-map; that draft owns requirement/oracle graphs — same organ).
- **Roadmap surface** — NOW/NEXT/LATER/DONE semantics on top of INDEX/board (absorbs the `pm` disposition from skill-absorbs).
- **Spend calibration loop** — per-lane p50/p90 from `genie spend` Phase 2 (already specced in genie-spend).

## WRS

WRS: █████████░ 92/100
Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅

- Problem: demand-to-roadmap-to-sized-wish failure is explicit, including the billion-token small-fix failure mode.
- Scope: framework semantics and interfaces are bounded; implementation and premature monetary thresholds are OUT.
- Decisions: synthesis, lanes, compiler flow, and the full circuit-breaker contract ratified 2026-07-09.
- Risks: invisibility, loopholes, backlog drift, quality cuts, over-shaping, jargon, and metric normalization are covered.
- Criteria: routing fixtures, traceability cardinality, patch isolation, program non-executability, FDE language, and cost calibration are testable.
- Remaining 8 points: program split confirmation at pour time + interfaces to brainstorm-domain-map/control-plane-contract still converging in those drafts.
