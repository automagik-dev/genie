# Genie Dev Mission
## Pitch

Genie Dev is the self-development branch of the Genie framework. It turns the template into a living meta-agent that can audit, upgrade, and validate its own workflow stack while remaining installable in any host repository.

## Users

### Primary Customers

- **Framework Maintainers:** Steer the Genie prompt stack and CLI toward higher autonomy without losing human oversight.
- **Power Users / Partner Teams:** Pilot emerging self-improvement patterns and feed structured evidence back into the core templates.

### User Personas

**Meta-Orchestrator**
- **Role:** Maintains Genie agents and safeguards guardrails
- **Context:** Needs rapid iteration on prompts, policies, and diagnostics without destabilizing downstream repos
- **Pain Points:** Slow feedback loops, fragmented experiments, weak traceability when agents evolve themselves
- **Goals:** Tighten validation loops, capture every change rationale, and publish upgrade paths that downstream repos can adopt deliberately

**Pilot Squad Lead**
- **Role:** Early adopter embedding Genie into complex delivery environments
- **Context:** Validates new meta-agent behaviours before they ship broadly
- **Pain Points:** Unclear upgrade guidance, lack of proof that automation changes are safe, difficulty reporting outcomes
- **Goals:** Receive pre-baked playbooks, evidence kits, and rollback guidance for every self-improvement release

## The Problem

### Self-Evolving Agents Need Structure
Genie’s templates must improve themselves without eroding trust or breaking installs across diverse projects.

**Our Approach:** Codify meta-agent upgrades as wishes with verifiable evidence, ensuring every prompt or workflow change is paired with metrics and rollback hooks.

### Feedback Loops Are Opaque
Learnings often stay buried in session transcripts, delaying improvements to prompts and guardrails.

**Our Approach:** Promote learnings into persistent documentation, align them with experiments, and surface them in done reports so humans can audit evolution.

### Downstream Risk Management
Branch experimentation can create surprises for adopters if success criteria are not explicit.

**Our Approach:** Treat this branch as the proving ground for phased releases, publish adoption kits, and require validation evidence before merging into the canonical template.

## Differentiators

### Meta-Agent Feedback Harness
Purpose-built to let Genie run experiments on itself, capture the outcomes, and decide what ships.

### Evidence-First Governance
Every change must tie back to a wish, a forge plan, validation commands, and a done report stored under `.genie/wishes/<slug>/reports/`.

### Human-in-the-Loop Control
Automation never bypasses human approval gates; new capabilities arrive with clear opt-in guidance and rollback instructions.

## Key Focus Areas

- **Self-Audit Loops:** Plan → Wish → Forge cycles targeted at the prompt stack, CLAUDE/AGENTS guardrails, and CLI behaviours.
- **Learning Propagation:** Promote validated learnings into `.genie/instructions/` and agent briefs so changes stick.
- **Tooling Diagnostics:** Expand test harnesses and smoke commands that ensure the CLI behaves before releases.
- **Adoption Playbooks:** Provide branch-to-main migration guides, change logs, and decision records for every improvement wave.
