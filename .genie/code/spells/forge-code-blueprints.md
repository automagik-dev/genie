---
name: Forge Blueprints
description: Templates for groups, plans, task files, and error handling
genie:
  executor: [CLAUDE_CODE, CODEX, OPENCODE]
forge:
  CLAUDE_CODE:
    model: sonnet
  CODEX: {}
  OPENCODE: {}
---

# Forge Blueprints

## Group Blueprint
```
### Group {Letter} – {descriptive-slug}
- **Scope:** Clear boundaries of what this group accomplishes
- **Inputs:** `@file.rs`, `@doc.md`, `@.genie/wishes/<slug>/<slug>-wish.md`
- **Deliverables:**
  - Code changes: specific files/modules
  - Tests: unit/integration coverage
  - Documentation: updates needed
- **Evidence:**
  - Location: `.genie/wishes/<slug>/qa/group-{letter}/`
  - Contents: test results, metrics, logs, screenshots (per wish/custom guidance)
- **Evaluation Matrix Impact:**
  - Discovery checkpoints this group addresses (ref: wish evaluation matrix)
  - Implementation checkpoints this group targets
  - Verification evidence this group must produce
- **Branch strategy:**
  - Default: `feat/<wish-slug>`
  - Alternative: Use existing `<branch>` (justify: already has related changes)
  - Micro-task: No branch, direct to main (justify: trivial, low-risk)
- **Tracker:**
  - External: `JIRA-123` or `LINEAR-456`
  - Placeholder: `placeholder-group-{letter}` (create actual ID before execution)
  - Task file: `.genie/wishes/<slug>/task-{letter}.md`
- **Suggested personas:**
  - Primary: implementor (implementation)
  - Support: tests (test coverage), polish (linting)
- **Dependencies:**
  - Prior groups: ["group-a"] (must complete first)
  - External: API deployment, database migration
  - Approvals: Security review, design sign-off
- **Genie Gates (optional):**
  - Pre-execution: `planning` mode for architecture review
  - Mid-execution: `consensus` for trade-off decisions
  - Post-execution: `deep-dive` for performance analysis
- **Validation Hooks:**
  - Commands/scripts: reference `@.genie/code/agents/tests.md`, `@.genie/code/agents/implementor.md`, or wish-specific instructions
  - Success criteria: All tests green, no regressions
  - Matrix scoring: Targets X/100 points (specify which checkpoints)
```

## Plan Blueprint
```
# Forge Plan – {Wish Slug}
**Generated:** 2024-..Z | **Wish:** @.genie/wishes/{slug}/{slug}-wish.md
**Task Files:** `.genie/wishes/<slug>/task-*.md`

## Summary
- Objectives from spec_contract
- Key risks and dependencies
- Branch strategy: `feat/<wish-slug>` (or alternative with justification)

## Spec Contract (from wish)
[Extracted <spec_contract> content]

## Proposed Groups
### Group A – {slug}
- **Scope:** …
- **Inputs:** `@file`, `@doc`
- **Deliverables:** …
- **Evidence:** Store in `.genie/wishes/<slug>/qa/group-a/`
- **Branch:** `feat/<wish-slug>` or existing
- **Tracker:** JIRA-123 (or placeholder)
- **Suggested personas:** implementor, tests
- **Dependencies:** …

## Validation Hooks
- Commands or scripts to run per group
- Evidence storage paths:
  - Group A: `.genie/wishes/<slug>/qa/group-a/`
  - Group B: `.genie/wishes/<slug>/qa/group-b/`
  - Logs: `.genie/wishes/<slug>/qa/validation.log`

## Task File Blueprint
# Task A - <descriptive-name>
**Wish:** @.genie/wishes/<slug>/<slug>-wish.md
**Group:** A
**Persona:** implementor
**Tracker:** JIRA-123 (or placeholder)
**Status:** pending

## Scope
[What this task accomplishes]

## Inputs
- `@file.rs`
- @doc.md

## Validation
- Commands: reference `@.genie/code/agents/tests.md`
- Evidence: wish `qa/` + `reports/` folders

## Approval Log
- [timestamp] Pending approval by …

## Follow-up
- Checklist of human actions before/during execution
- MCP commands for background personas: `mcp__genie__run` with agent and prompt parameters
- PR template referencing wish slug and this forge plan
```

## Task File Blueprint (Standalone)
```markdown
# Task: <group-name>

## Context
**Wish:** @.genie/wishes/<slug>/<slug>-wish.md
**Group:** A - <descriptive-name>
**Tracker:** JIRA-123 (or placeholder)
**Persona:** implementor
**Branch:** feat/<wish-slug>

## Scope
[What this group accomplishes]

## Inputs
- `@file1.rs`
- `@file2.md`

## Deliverables
- Code changes
- Tests
- Documentation

## Validation
- Commands/scripts: see `@.genie/code/agents/tests.md` and wish-specific instructions

## Dependencies
- None (or list prior groups)

## Evidence
- Store results in the wish `qa/` + `reports/` folders
```

## Error Handling

### Common Issues & Solutions
| Issue | Detection | Solution |
|-------|-----------|----------|
| No spec_contract | Missing `<spec_contract>` tags | Request wish update with spec |
| Circular dependencies | Group A needs B, B needs A | Restructure groups or merge |
| Missing personas | Referenced agent doesn't exist | Use available agents |
| Invalid branch name | Over 48 chars or special chars | Truncate and sanitize |
| Task file exists | Previous task not complete | Archive or update existing |

### Graceful Degradation
- If task file creation fails, generate forge plan anyway with warning
- If evidence paths can't be created, document in plan for manual creation
- If external tracker unreachable, use placeholder IDs

## Blocker Protocol

When forge planning encounters issues:

1. **Create Blocker Report:**
   ```markdown
   # Blocker Report: forge-<slug>-<timestamp>
   Location: .genie/wishes/<slug>/reports/blocker-forge-<slug>-<YYYYMMDDHHmm>.md

   ## Issue
   - Missing spec_contract in wish
   - Conflicting dependencies between groups
   - Unable to determine branch strategy

   ## Investigation
   [What was checked, commands run]

   ## Recommendations
   - Update wish with spec_contract
   - Reorder groups to resolve dependencies
   - Specify branch in wish metadata
   ```

2. **Update Status:**
   - Mark wish status as "BLOCKED" in wish status log
   - Note blocker in wish status log

3. **Notify & Halt:**
   - Return blocker report reference to human
   - Do not proceed with forge plan generation
   - Wait for wish updates or guidance
