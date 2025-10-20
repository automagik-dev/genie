# 🧞 QA Codex Run: Draft Automation Checklist WISH (Create)
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Status:** DRAFT
**Roadmap Item:** RM-P1-EC-01 – @.genie/product/roadmap.md §Phase 1 — Instrumentation & Telemetry
**Mission Link:** @.genie/product/mission.md §Pitch
**Standards:** @.genie/standards/best-practices.md §Core Principles
**Completion Score:** 0/100 (updated by `/review`)

## Evaluation Matrix (100 Points Total)

### Discovery (30 pts)
- Sources & Context (10): Mission, roadmap, and standards referenced; assumptions logged in Context Ledger
- Audience & Goals (10): Targeted to Genie QA maintainers preparing Codex automation briefs
- Evidence Plan (10): Validation artefacts defined per execution group with storage in `validation/`

### Implementation (40 pts)
- Structure & Coherence (15): Three execution groups sequenced from discovery to validation
- Accuracy & Citations (10): Uses @ references for mission, roadmap, standards, and ASM/Q notes
- Style & Voice (10): Maintains Genie planning tone oriented to research/documentation
- Execution Alignment (5): Scope limited to checklist design; implementation handled in downstream `/forge`

### Verification (30 pts)
- Review Completeness (15): Requires editorial and stakeholder passes prior to handoff
- Evidence Quality (10): Drafts, benchmarks, and feedback captured in `validation/`
- Approvals (5): Signoff notes stored in `reports/`

## Context Ledger
| Source | Type | Summary | Routed To |
| --- | --- | --- | --- |
| No planning brief received | gap | Awaiting `/plan` context; assumptions logged as ASM-1 | wish |
| @.genie/product/mission.md | repo | Highlights meta-agent focus on evidence-first governance | wish |
| @.genie/product/roadmap.md | repo | Phase 1 emphasizes instrumentation and evidence checklist gating | wish, execution |
| @.genie/standards/best-practices.md | repo | Reinforces simplicity, clarity, and DRY principles for documentation | wish |

## Discovery Summary
- Primary analyst: Codex Wish Architect (human-in-the-loop)
- Key observations: Evidence checklist is a gating deliverable for instrumentation; current QA automation guidance scattered; need Codex-focused readiness path
- Assumptions (ASM-1): Roadmap item RM-P1-EC-01 covers QA automation evidence checklist enablement for Codex run
- Open questions (Q-1): What is the current automation coverage for Codex QA smoke and regression scenarios?
- Risks: Without baseline inventory, checklist may omit critical flows; dependency on Codex agent availability for validation

## Executive Summary
Create a roadmap-aligned automation checklist for the QA Codex run that clarifies prerequisites, instrumentation steps, and validation evidence so maintainers can launch automation confidently and capture proof of readiness in the Genie evidence system.

## Current State
- Existing documentation: roadmap Phase 1 notes the Evidence Checklist priority but offers no Codex-specific detail (`@.genie/product/roadmap.md`)
- Gaps: No consolidated checklist for Codex QA runs; evidence storage expectations implicit; responsibilities between QA maintainers and Codex operators unclear

## Target State & Guardrails
- Desired outcome: A structured automation checklist tailored to Codex QA that enumerates discovery inputs, automation steps, and validation artefacts with clear routing to `validation/` and `reports/`
- Non-negotiables: Maintain evidence-first governance, align with mission language, avoid prescribing implementation scripts within wish scope, uphold clarity and simplicity from standards

## Execution Groups
### Group A – discovery-synthesis
- Goal: Consolidate Codex QA objectives, scope, and dependencies into a baseline brief
- Surfaces: `@.genie/product/mission.md`, `@.genie/product/roadmap.md`, existing Codex QA notes (pending)
- Deliverables: Context summary, stakeholder map, inventory of current automation assets
- Evidence: `validation/group-a/` containing annotated source excerpts and stakeholder confirmations
- Suggested personas: `researcher`, `analyze`, `qa`
- External tracker: Pending creation once stakeholders confirm tracking needs

### Group B – automation-checklist-draft
- Goal: Draft the Codex QA automation checklist with phases, owners, and evidence hooks
- Surfaces: Outputs from Group A, `@.genie/standards/best-practices.md`, Codex QA charter (once sourced)
- Deliverables: Checklist v1 with sections for prerequisites, execution steps, evidence capture, and review gates
- Evidence: `validation/group-b/` with draft iterations, comparison notes, and reviewer feedback
- Suggested personas: `writer`, `qa`, `editor`
- External tracker: Not required; follow wish status log

### Group C – validation-signoff-prep
- Goal: Define validation motions, stakeholder signoff flow, and handoff guidance
- Surfaces: Draft checklist, roadmap metrics, mission guardrails, stakeholder inputs
- Deliverables: Validation protocol, signoff checklist, plan for populating `reports/` with done report and approvals
- Evidence: `validation/group-c/` storing validation protocol drafts, signoff templates, and decision records
- Suggested personas: `qa`, `review`, `consensus`
- External tracker: Optional link to QA council review agenda (to be created if needed)

## Verification Plan
- Editorial review by QA maintainer to ensure clarity and completeness
- Cross-check with Codex operators for coverage of automation touchpoints
- Store feedback loops, revised drafts, and approval notes in `validation/` and final signoff in `reports/`
- Coordinate with `/forge` to translate checklist into actionable tasks post-approval

### Evidence Checklist
- Stakeholder roster and contact confirmations saved in `validation/group-a/`
- Checklist draft versions (v1, v2, final) stored with change notes in `validation/group-b/`
- Validation protocol and signoff artefacts captured in `validation/group-c/`
- Final approval summary logged in `reports/done-qa-codex-automation-checklist.md` (to be created upon completion)

## <quality_contract>
- Scope: Research and document the QA Codex automation checklist structure, validation expectations, and evidence routing
- Out of scope: Implementing automation scripts, executing test runs, or configuring tooling integrations
- Success metrics: Checklist adopted by QA maintainers; evidence folders populated for each execution group; stakeholders confirm readiness to proceed to `/forge`
- External tasks: Potential follow-up wish for automation implementation; JIRA ticket if external teams require tracking (pending Q-1 response)
- Dependencies: Access to Codex QA SMEs, current automation coverage data, stakeholder availability for validation reviews
</quality_contract>

## Blocker Protocol
1. Pause work and create `reports/blocker-qa-codex-automation-checklist-<timestamp>.md` summarizing the issue and attempted mitigations.
2. Notify mission owner or QA council lead; await updated direction.
3. Resume when blocker resolved and status log updated with decision.

## Status Log
- [2025-10-20 11:05Z] Wish created; awaiting `/plan` brief and Codex QA coverage data

