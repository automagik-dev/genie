# 🧞 Agent Folder Unification WISH
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Status:** DRAFT
**Roadmap Item:** ARCH-AGENTS-MERGE – @.genie/product/roadmap.md §Architecture
**Mission Link:** @.genie/product/mission.md §Pitch
**Completion Score:** 0/100 (updated by `/review`)

## Evaluation Matrix (100 Points Total)

### Discovery Phase (30 pts)
- [ ] All relevant files/docs referenced with @ notation (4 pts)
- [ ] Background persona outputs captured in context ledger (3 pts)
- [ ] Assumptions (ASM-#), decisions (DEC-#), risks documented (3 pts)
- [ ] Clear current state and target state defined (3 pts)
- [ ] Spec contract complete with success metrics (4 pts)
- [ ] Out-of-scope explicitly stated (3 pts)
- [ ] Validation commands and artefact storage defined (10 pts)

### Implementation Phase (40 pts)
- [ ] Minimal surface area changes, focused scope (5 pts)
- [ ] Clean, consistent folder architecture (10 pts)
- [ ] All references updated (10 pts)
- [ ] Evidence of checks and migrations captured (5 pts)
- [ ] No unapproved scope creep (3 pts)
- [ ] Dependencies and sequencing honored (7 pts)

### Verification Phase (30 pts)
- [ ] All validation commands executed successfully (10 pts)
- [ ] Artefacts captured at specified paths (10 pts)
- [ ] Before/after comparisons provided (5 pts)
- [ ] Status log updated with completion timestamp (5 pts)

## Context Ledger
| Source | Type | Summary | Routed To |
| --- | --- | --- | --- |
| `.genie/code/teams/tech-council/*` | repo | Modern council location | wish |
| Legacy council files (removed): `.genie/agents/{jt,nayr,oettam}.md` | note | Confirmed superseded; deleted | wish |
| diffs (attached) | file | Legacy vs modern differences | validation |
| scan scripts | script | Repo-wide @ ref validation | validation |

## Executive Summary
We have two agent-era structures: legacy `@.genie/agents` and modern collectives under `@.genie/code/*` (and `@.genie/create/*`). This wish unifies the folders, updates references, and archives legacy files after migration. We will attach diffs, update AGENTS.md references, and provide a check script to prevent regressions.

## Current State
- Legacy: council personae were at `.genie/agents/{jt,nayr,oettam}.md` (now removed)
- Modern: council lives under `@.genie/code/teams/tech-council/` and code agents under `@.genie/code/agents/*`
- Observed outdated references in `AGENTS.md` (fixed) and legacy README with non-existent paths

## Target State & Guardrails
- Single source of truth: domain collectives (`@.genie/code/*`, `@.genie/create/*`)
- Teams live under `<collective>/teams/*`
- Agents live under `<collective>/agents/*`
- Legacy `@.genie/agents/*` archived or converted to docs (no active references)

## Execution Groups
### Group A – tech-council-unify
- Goal: Align council personae to modern path
- Surfaces: `@.genie/agents/{jt,nayr,oettam}.md`, `@.genie/code/teams/tech-council/*`
- Deliverables: migration decision (source of truth), legacy pointers/archives
- Evidence: `validation/group-a/` diffs + decision note

### Group B – references-update
- Goal: Update repo references to use modern paths
- Surfaces: `AGENTS.md`, any other `@.genie/agents/*` refs
- Deliverables: PR-ready patch; scan output
- Evidence: `validation/group-b/` scan logs before/after

### Group C – legacy-archive
- Goal: Archive or convert `.genie/agents/README.md` → `.genie/docs/agents-architecture.md` with note
- Surfaces: `.genie/agents/README.md`
- Deliverables: moved/renamed file, deprecation banner
- Evidence: `validation/group-c/` outputs

### Group D – guardrail-checks
- Goal: Add and run repo checker for `@.genie/` references
- Surfaces: scan script under `.genie/scripts`
- Deliverables: `check-genie-refs.sh` + CI/local instructions
- Evidence: `validation/group-d/` run logs

## Verification Plan
- Run `check-genie-refs.sh` (added) and confirm 0 broken refs
- Confirm no references to `@.genie/agents/` remain (except archive note)
- Capture before/after scans and diffs in `validation/`

### Evidence Checklist
- Diffs: legacy vs modern council files
- Scan logs: before/after
- List of updated references
- Decision note: which files archived vs retained

## <spec_contract>
- Scope: Unify agent folders; update references; add guardrail script
- Out of scope: Creating new collectives (tracked separately)
- Success metrics: 0 broken refs; 0 active uses of `@.genie/agents/`; docs updated
- Dependencies: none
</spec_contract>

## Blocker Protocol
1. Pause and create `reports/blocker-<slug>-<timestamp>.md` if conflicts
2. Notify owner and await decisions
3. Resume once wish status/log updated

## Status Log
- [YYYY-MM-DD HH:MMZ] Draft created
