# DRAFT: brainstorm-domain-map (Domain E — umbrella G8)

**Parent:** [genie-token-efficiency-program](../genie-token-efficiency-program/DESIGN.md) · **Status:** Simmering

## KNOWN (evidence)
- Felipe's critique: /brainstorm tracks readiness (WRS) but never maps context domains and gaps — "which is effectively what must be filled by brainstorming, having a professional flawless specification."
- Live proof ×2: the umbrella session had to improvise its domain map (A–F table); THIS very restructuring (ordering all context per domain with KNOWN/DECIDED/GAPS) is the missing discipline, done by hand.
- LangWatch "skills"/PM-domain-experts docs = collaboration framing, nothing importable; we write our own lens prompts.
- Two brainstorm skill copies exist (repo + global newer); both get the upgrade via the convergence track.

## DECIDED (umbrella D15 — five changes)
1. Domain Map phase (after read-context): enumerate domains touched; per domain: evidence-in-hand (with source), open gaps, gap route (ask user / research agent / mark OUT). Persisted in DRAFT.md, updated as gaps close.
2. Gap ledger: every AskUserQuestion + research dispatch maps to a named gap; unrouted gap blocks crystallize.
3. WRS coupling: Scope ✅ requires the map; Decisions ✅ requires zero open ask-user gaps; umbrella brainstorms track per-domain WRS.
4. Lens subagents drawn from the domain map (council lens library) instead of fixed simplicity/ops/security triad.
5. Crystallize check #5: every mapped domain covered by Decisions/Criteria or explicitly OUT with rationale.

## GAPS
- [x] **Felipe's "real software spec" bar** — resolved as executable specification compilation: stakeholder domain truth → requirement/oracle graph → bounded execution → proof packet → residual-risk review. The demand/roadmap/wish-sizing layer is split into [intent-to-wish-compiler](../intent-to-wish-compiler/DRAFT.md).
- [ ] KNOWN/DECIDED/GAPS as the standard DRAFT.md skeleton (what this restructuring used) — adopt formally?
- [ ] Umbrella protocol: when a brainstorm goes umbrella-scale, standardize the split into child brainstorm tracks (exactly what we just did manually)?
- [ ] Should the domain map feed /wish directly (wish inherits the map as its context section)?

## Felipe's software-building thesis (2026-07-09)

- Traditional developer identity is not the prerequisite for building software. In the FDE system, PMs and business stakeholders must be able to author software through domain intent rather than implementation expertise.
- The lifecycle exists so **anybody can build software**: Genie asks the questions the author did not know to ask and produces the minimum sufficient specification.
- Use the strongest model where ambiguity and leverage are highest: intent discovery, specification compilation, plan synthesis, and adversarial review.
- Make execution constrained and deterministic enough that a smaller model or lower reasoning tier can deliver reliably and cheaply.
- Optimize for the actual outcome: **correct, working, well-made software—as fast and cheaply as possible**. Preserve traditional engineering practices only where they improve that outcome.

## Current lifecycle analysis

| Stage | Deterministic today | Residual judgment / failure surface |
|---|---|---|
| `brainstorm` | Persistent draft, five readiness dimensions, scope decomposition, alternatives, self-review | WRS proves five sections exist, not that the domain was exhaustively mapped; no actors/workflows/invariants/scenarios/ambiguity closure |
| `wish` | Fixed skeleton, explicit IN/OUT, DAG/waves, per-group acceptance and validation commands | Structural lint currently proves only brainstorm links resolve; prose criteria can be shallow, implementation-shaped, or disconnected from stakeholder intent |
| `work` | Curated group briefs, atomic claims, isolated roles, bounded fix loops, orchestrator-owned done, exact validation command | A worker can satisfy a locally complete brief that omitted a domain invariant; no required proof-packet schema or requirement-to-evidence trace |
| `review` | Independent reviewer, explicit pipelines, validation evidence, severity/verdict rules | The reviewer must infer whether tests actually prove intent; edge cases may be classed MEDIUM/non-blocking; no explicit residual-uncertainty or oracle-ownership model |

**Finding:** the lifecycle has strong **process determinism** but weak **specification determinism**. Detailed prose narrows the search space; only an explicit test oracle can turn “follow this plan” into “prove this outcome.”

## Domain map for the specification compiler

| Domain | Required output | Gap route |
|---|---|---|
| Product/domain truth | Actors, jobs, business rules, examples, forbidden outcomes | Ask stakeholder in domain language; never require developer vocabulary |
| Specification compilation | Stable requirement IDs, invariants, scenarios, interfaces, NFR budgets, decision rationale | Strong planning model derives and challenges; unresolved ambiguity remains visible |
| Execution slicing | Each group receives only its requirement slice, preconditions, allowed outputs, forbidden scope, and oracle | `/wish` compiles the canonical spec into independently executable groups |
| Proof and traceability | Requirement → group → acceptance check → validation evidence → review finding | `/work` returns a standard proof packet; machines verify graph completeness |
| Judgment boundary | Every requirement classified by who/what can decide truth | Machine-verifiable, model-judged, or human-judged; subjective truth never masquerades as deterministic |
| Economics | Large model used at high-leverage compile/gate points; cheaper model executes bounded groups | Routing matrix + cost per accepted group without reopening |

## Approaches

### A. Harden the prose documents

Add more sections and reviewer checklists to DESIGN/WISH. Lowest migration cost and easiest for humans to read, but it risks checklist theater: an artifact may contain every heading while still lacking a trustworthy oracle or trace from intent to proof.

### B. Executable specification compiler — recommended

Treat the lifecycle as a compiler:

1. Stakeholder conversation is the source language.
2. `brainstorm` produces a domain model and closes/routs every gap.
3. `wish` lowers that model into requirement-addressed execution groups and validation oracles.
4. `work` produces code **plus a proof packet** (diff, tests, command output, requirement coverage, residual risks).
5. Deterministic gates check structure and evidence first; the large-model reviewer spends reasoning only on contradictions, missing intent, unsafe assumptions, and irreducibly subjective quality.

This maximizes cheap mechanical execution without pretending all software truth is mechanically decidable.

### C. Formal-spec-first

Require state machines, property tests, schemas, and model checking wherever possible before implementation. This offers the strongest guarantees for protocols, money, permissions, migrations, and stateful systems, but would overburden ordinary product work and slow the FDE authoring experience. Use it as a risk-triggered profile inside Approach B, not the universal default.

## Recommended specification contract

- Each requirement gets a stable ID and an **oracle class**: `machine`, `model`, or `human`.
- Machine-verifiable truth is maximized: examples become tests, invariants become properties/assertions, interfaces become schemas/contracts, non-functional goals become budgets.
- Model judgment is allowed only with an explicit rubric and evidence inputs; it cannot silently substitute for a missing test.
- Human judgment is a first-class approval gate for domain policy, taste, and other subjective outcomes; it is not treated as planning failure.
- Each execution group is a closed contract: inputs/preconditions, deliverables, forbidden changes, acceptance checks, validation commands, dependencies, and expected evidence.
- Every completed group carries proof. “The worker says it is done” is never evidence.
- The final large-model gate reviews **residual uncertainty**, not the entire implementation transcript.

## Principal risks

| Risk | Why it matters | Mitigation direction |
|---|---|---|
| False determinism | Tests can prove the wrong interpretation | Trace every oracle to stakeholder intent/examples; review the oracle before execution |
| Over-specification | Planning becomes slower/more expensive than implementation | Minimum sufficient spec; depth scales with risk/irreversibility |
| Stakeholder overload | Non-developers get asked architecture questions they cannot answer | Ask in domain scenarios and outcomes; let the planning model translate technically |
| Correlated model error | The same large model authors and approves a flawed interpretation | Independent review context, cross-LLM dissent when triggered, stakeholder oracle for domain truth |
| Brittle execution | Cheap workers exploit underspecified criteria or overfit validations | Negative cases, forbidden outcomes, mutation/adversarial checks for high-risk groups |
| Review becomes the bottleneck | Expensive model rereads too much context | Proof packets + requirement deltas + unresolved risks only |

## Candidate acceptance criteria

- [ ] Every mapped domain is covered or explicitly OUT; every gap is closed or has an owner/route.
- [ ] Every requirement has a stable ID and an oracle class (`machine`, `model`, or `human`).
- [ ] Every execution-group criterion traces to at least one requirement; every in-scope requirement traces to evidence.
- [ ] `/work` cannot mark a group done without its required proof packet and passing deterministic validations.
- [ ] A fresh lower-tier executor can implement a representative group from its curated contract without reading the full brainstorm/session transcript.
- [ ] Final review receives the spec, proof graph, diff summary, and residual uncertainty—not monolithic worker transcripts.

## Active question

Define who owns truth when a requirement cannot be made objectively machine-verifiable. This boundary determines what Genie can guarantee and where it must ask for judgment rather than manufacture certainty.

## WRS

WRS: ████████░░ 80/100
Problem ✅ | Scope ░ | Decisions ✅ | Risks ✅ | Criteria ✅

- Problem: the missing domain/gap discipline is clear and evidenced by this program.
- Scope: the compiler architecture is bounded conceptually, but the ownership boundary for irreducibly subjective truth—and therefore the exact IN/OUT line of deterministic guarantees—is not yet locked.
- Decisions: strong-model specification compilation + cheap bounded execution + proof-based large-model review is the chosen architecture; formal methods are risk-triggered, not universal.
- Risks: false determinism, over-specification, stakeholder overload, correlated model error, brittle validations, and review cost are identified with mitigation directions.
- Criteria: domain closure, oracle classification, bidirectional traceability, proof packets, lower-tier executability, and context-bounded review are all mechanically testable.
