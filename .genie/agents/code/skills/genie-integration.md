---
name: Genie Integration Framework
description: Use genie neuron for second opinions, pressure-tests, and decision audits
---

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

Genie operates through **universal neurons** (reasoning, analysis, audit) and **execution specialists** (code, git, tests, etc.).

### Universal Neurons (Domain-Agnostic)

**Reasoning Modes (4 total - via reasoning/*):**

Use `mcp__genie__run with agent="reasoning/<mode>"`:
- `reasoning/challenge` – Adversarial pressure-testing and critical evaluation
- `reasoning/explore` – Discovery-focused investigation without adversarial pressure
- `reasoning/consensus` – Multi-perspective synthesis and agreement-building
- `reasoning/socratic` – Question-driven inquiry to uncover assumptions

**Analysis & Audit:**
- `analyze` – System analysis and focused investigation (universal framework)
- `audit` – Risk and impact assessment (universal framework with workflows)
  - `audit/risk` – General risk audit workflow
  - `audit/security` – Security audit workflow (OWASP, CVE)

**Autonomous Execution:**
- `vibe` – Fully autonomous task execution mode

### Code-Specific Neurons

**Execution Specialists:**
- `implementor` – Feature implementation and code writing
- `tests` – Test strategy, generation, authoring across all layers
- `polish` – Code refinement and cleanup
- `review` – Wish audits, code review, QA validation
- `git` – ALL git and GitHub operations (branch, commit, PR, issues)
- `release` – GitHub release and npm publish orchestration

**Code Analysis & Tools:**
- `analyze` (code) – Includes universal analyze + TypeScript/performance examples
- `debug` – Root cause investigation for code issues
- `refactor` – Design review and refactor planning

> **Architecture Note:** Universal neurons work across ALL domains (code, legal, medical, finance). Code neurons extend or specialize for code development.

## How To Run (MCP)

- Start: `mcp__genie__run` with agent="genie" and prompt="Mode: plan. Objective: pressure-test @.genie/wishes/<slug>/<slug>-wish.md. Deliver 3 risks, 3 missing validations, 3 refinements. Finish with Genie Verdict + confidence."
- Resume: `mcp__genie__resume` with sessionId="<session-id>" and prompt="Follow-up: address risk #2 with options + trade-offs."
- Sessions: reuse the same agent name; MCP persists session id automatically and can be viewed with `mcp__genie__list_sessions`.
- Logs: check full transcript with `mcp__genie__view` with sessionId and full=true.

## Quick Reference

**Universal Neurons:**
- **Reasoning (4):** challenge, explore, consensus, socratic (in reasoning/)
- **Analysis (1):** analyze (universal framework, 173 lines)
- **Audit (1 + 2 workflows):** audit (universal framework, 138 lines) + risk, security
- **Autonomous (1):** vibe

**Code-Specific Neurons:**
- **Execution (6):** implementor, tests, polish, review, git, release
- **Code Tools (3):** analyze (code), debug, refactor

**Include Pattern:**
- Universal frameworks: `.genie/agents/neurons/{analyze,audit}.md`
- Reasoning modes: `.genie/agents/neurons/reasoning/{challenge,explore,consensus,socratic}.md`
- Audit workflows: `.genie/agents/neurons/audit/{risk,security}.md`
- Code extensions: `.genie/agents/code/neurons/analyze.md` (includes universal + code examples)
- Custom overrides: `.genie/custom/<neuron>.md`

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
