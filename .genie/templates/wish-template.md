# 🧞 {FEATURE NAME} WISH
**Status:** DRAFT
**Roadmap Item:** {ROADMAP-ID} – @.genie/product/roadmap.md §{section}
**Mission Link:** @.genie/product/mission.md §Pitch
**Standards:** @.genie/standards/best-practices.md §Core Principles
**Completion Score:** 0/100 (updated by `/review`)

## Evaluation Matrix (100 Points Total)

### Discovery Phase (30 pts)
- **Context Completeness (10 pts)**
  - [ ] All relevant files/docs referenced with @ notation (4 pts)
  - [ ] Background persona outputs captured in context ledger (3 pts)
  - [ ] Assumptions (ASM-#), decisions (DEC-#), risks documented (3 pts)
- **Scope Clarity (10 pts)**
  - [ ] Clear current state and target state defined (3 pts)
  - [ ] Spec contract complete with success metrics (4 pts)
  - [ ] Out-of-scope explicitly stated (3 pts)
- **Evidence Planning (10 pts)**
  - [ ] Validation commands specified with exact syntax (4 pts)
  - [ ] Artifact storage paths defined (3 pts)
  - [ ] Approval checkpoints documented (3 pts)

### Implementation Phase (40 pts)
- **Code Quality (15 pts)**
  - [ ] Follows project standards (@.genie/standards/*) (5 pts)
  - [ ] Minimal surface area changes, focused scope (5 pts)
  - [ ] Clean abstractions and patterns (5 pts)
- **Test Coverage (10 pts)**
  - [ ] Unit tests for new behavior (4 pts)
  - [ ] Integration tests for workflows (4 pts)
  - [ ] Evidence of test execution captured (2 pts)
- **Documentation (5 pts)**
  - [ ] Inline comments where complexity exists (2 pts)
  - [ ] Updated relevant external docs (2 pts)
  - [ ] Context preserved for maintainers (1 pt)
- **Execution Alignment (10 pts)**
  - [ ] Stayed within spec contract scope (4 pts)
  - [ ] No unapproved scope creep (3 pts)
  - [ ] Dependencies and sequencing honored (3 pts)

### Verification Phase (30 pts)
- **Validation Completeness (15 pts)**
  - [ ] All validation commands executed successfully (6 pts)
  - [ ] Artifacts captured at specified paths (5 pts)
  - [ ] Edge cases and error paths tested (4 pts)
- **Evidence Quality (10 pts)**
  - [ ] Command outputs (failures → fixes) logged (4 pts)
  - [ ] Screenshots/metrics captured where applicable (3 pts)
  - [ ] Before/after comparisons provided (3 pts)
- **Review Thoroughness (5 pts)**
  - [ ] Human approval obtained at checkpoints (2 pts)
  - [ ] All blockers resolved or documented (2 pts)
  - [ ] Status log updated with completion timestamp (1 pt)

## Context Ledger
| Source | Type | Summary | Routed To |
| --- | --- | --- | --- |
| Planning brief | doc | Key findings | entire wish |
| `@path/to/file` | repo | Insight | wish, docs |
| mcp__genie__run agent="..." | background | Output summary | wish, roadmap |

## Discovery Summary
- **Primary analyst:** {Human/Agent}
- **Key observations:** …
- **Assumptions (ASM-#):** …
- **Open questions (Q-#):** …
- **Risks:** …

## Executive Summary
Concise outcome tied to user/system impact.

## Current State
- **What exists today:** `@file` references with short notes
- **Gaps/Pain points:** …

## Target State & Guardrails
- **Desired behaviour:** …
- **Non-negotiables:** latency, safety, human-likeness, compliance, etc.

## Execution Groups
### Group A – {slug}
- **Goal:** …
- **Surfaces:** `@file`, `@docs`
- **Deliverables:** …
- **Evidence:** Store in wish `qa/group-a/`, add notes in `reports/` if needed
- **Suggested personas:** `forge-coder`, `forge-quality`
- **External tracker:** {placeholder ID or JIRA-XXX}

(Repeat for Group B/C as needed.)

## Verification Plan
- Validation steps or scripts to run (tests, metrics, evaluation)
- Evidence storage: reference wish `qa/` + `reports/` subfolders
- Branch strategy note (dedicated branch vs existing vs micro-task)

### Evidence Checklist
- **Validation commands (exact):** …
- **Artefact paths (where evidence lives):** use wish `qa/` + `reports/`
- **Approval checkpoints (human sign-off required before work starts):** …

## <spec_contract>
- **Scope:** …
- **Out of scope:** …
- **Success metrics:** …
- **External tasks:** Tracker IDs (if any)
- **Dependencies:** …
</spec_contract>

## Blocker Protocol
1. Pause work and create `reports/blocker-<slug>-<timestamp>.md` inside the wish folder describing findings.
2. Notify owner and wait for updated instructions.
3. Resume only after the wish status/log is updated.

## Status Log
- [YYYY-MM-DD HH:MMZ] Wish created
- …
