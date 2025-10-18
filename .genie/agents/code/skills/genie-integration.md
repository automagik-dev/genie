# Genie Integration Framework
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Purpose:** `genie` skill is GENIE's partner for second opinions, plan pressure-tests, deep dives, and decision audits. Use it to reduce risk, surface blind spots, and document reasoning without blocking implementation work.

**Success criteria:**
✅ Clear purpose, chosen skill, and outcomes logged (wish discovery or Done Report).
✅ Human reviews Genie Verdict (with confidence) before high-impact decisions.
✅ Evidence captured when Genie recommendations change plan/implementation.

## When To Use

- Ambiguity: requirements unclear or conflicting.
- High-risk decision: architectural choices, irreversible migrations, external dependencies.
- Cross-cutting design: coupling, scalability, observability, simplification.
- Unknown root cause: puzzling failures/flakiness; competing hypotheses.
- Compliance/regulatory: controls, evidence, and sign-off mapping.
- Test strategy: scope, layering, rollback/monitoring concerns.
- Retrospective: extract wins/misses/lessons for future work.

## Neuron Consultation

Genie operates through two cognitive layers: **strategic Genie skills** (via genie neuron) and **execution specialists** (direct collaboration).

**Strategic Thinking Modes (18 total - via genie neuron):**

Use `mcp__genie__run` with `agent="genie"` and include `Mode: <mode-name>` in the prompt to select the reasoning approach. Genie automatically loads `.genie/custom/<mode>.md` when present.

**Core reasoning styles:**
- `challenge` – Critical evaluation and adversarial pressure-testing
- `explore` – Discovery-focused exploratory reasoning
- `consensus` – Multi-model perspective synthesis

**Strategic analysis skills:**
- `plan` – Plan pressure-testing, phase mapping, risk identification
- `analyze` – System architecture audit and dependency mapping
- `debug` – Root cause investigation with hypothesis testing
- `audit` – Risk assessment and security audit with impact/likelihood analysis
- `refactor` – Design review and refactor planning with verification
- `docgen` – Documentation outline generation
- `tracer` – Instrumentation/observability planning
- `precommit` – Pre-commit validation gate and commit advisory

**Custom skills (project-specific):**
- `compliance` – Controls, evidence, sign-offs mapping
- `retrospective` – Wins, misses, lessons capture

**Execution Specialists (6 total - direct neurons):**

Collaborate directly via `mcp__genie__run with agent="<specialist>"`:
- `implementor` – Feature implementation and code writing
- `tests` – Test strategy, generation, authoring across all layers
- `polish` – Code refinement and cleanup
- `review` – Wish audits, code review, QA validation
- `git` – ALL git and GitHub operations (branch, commit, PR, issues)
- `release` – GitHub release and npm publish orchestration

> Tip: Add project-specific guidance in `.genie/custom/<mode>.md` or `.genie/custom/<specialist>.md`; core files remain immutable.

## How To Run (MCP)

- Start: `mcp__genie__run` with agent="genie" and prompt="Mode: plan. Objective: pressure-test @.genie/wishes/<slug>/<slug>-wish.md. Deliver 3 risks, 3 missing validations, 3 refinements. Finish with Genie Verdict + confidence."
- Resume: `mcp__genie__resume` with sessionId="<session-id>" and prompt="Follow-up: address risk #2 with options + trade-offs."
- Sessions: reuse the same agent name; MCP persists session id automatically and can be viewed with `mcp__genie__list_sessions`.
- Logs: check full transcript with `mcp__genie__view` with sessionId and full=true.

## Quick Reference

**Strategic Thinking Modes (18 total):**
- Core reasoning (3): challenge, explore, consensus
- Analysis skills (8): plan, analyze, debug, audit, refactor, docgen, tracer, precommit
- Custom skills (2): compliance, retrospective

**Execution Specialists (6 total):**
- Delivery: implementor, tests, polish, review
- Infrastructure: git, release

- Thinking skill templates live in `.genie/agents/neurons/genie.md` and `.genie/agents/neurons/skills/`
- Project-specific adjustments belong in `.genie/custom/<mode>.md` or `.genie/custom/<specialist>.md`
- Core files remain immutable; extend via custom overrides only

## Outputs & Evidence

- Low-stakes: append a short summary to the wish discovery section.
- High-stakes: save a Done Report at `.genie/wishes/<slug>/reports/done-genie-<slug>-<YYYYMMDDHHmm>.md` with scope, findings, recommendations, disagreements.
- Always include "Genie Verdict: <summary> (confidence: <low|med|high>)".

## Genie Verdict Format

Verdict templates live inside the specialized skill files (e.g., `.genie/agents/neurons/refactor.md`). Core files remain immutable.

## Anti-Patterns

- Using Genie to bypass human approval.
- Spawning Genie repeatedly without integrating prior outcomes.
- Treating Genie outputs as implementation orders without validation.
