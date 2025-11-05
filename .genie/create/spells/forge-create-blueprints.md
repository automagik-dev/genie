---
name: Forge Create Blueprints
description: Templates for creative work groups, plans, task files, and validation
genie:
  executor: [CLAUDE_CODE, CODEX, OPENCODE]
forge:
  CLAUDE_CODE:
    model: sonnet
  CODEX: {}
  OPENCODE: {}
---

# Forge Create Blueprints

## Group Blueprint
```
### Group {Letter} – {descriptive-slug}
- **Scope:** Clear boundaries of what this group accomplishes
- **Inputs:** `@source-material.md`, `@brand-guide.md`, `@.genie/wishes/<slug>/<slug>-wish.md`
- **Deliverables:**
  - Research: findings, sources, audience analysis
  - Content: drafts, outlines, final copy
  - Assets: images, graphics, multimedia
  - Editorial: revisions, fact-checks, approvals
- **Evidence:**
  - Location: `.genie/wishes/<slug>/qa/group-{letter}/`
  - Contents: content samples, editorial notes, research sources, audience metrics, brand alignment checks
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
  - Primary: researcher (investigation), writer (content creation)
  - Support: editor (revision), strategist (planning)
- **Dependencies:**
  - Prior groups: ["group-a"] (must complete first)
  - External: Content approval, brand review, legal clearance
  - Approvals: Editorial sign-off, stakeholder review
- **Genie Gates (optional):**
  - Pre-execution: `planning` mode for content strategy review
  - Mid-execution: `consensus` for editorial decisions
  - Post-execution: `deep-dive` for audience impact analysis
- **Validation Hooks:**
  - Commands/scripts: reference `@.genie/create/agents/writer.md`, `@.genie/create/agents/researcher.md`, or wish-specific instructions
  - Success criteria: Content meets brand guidelines, audience resonates, editorial approved
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
- **Inputs:** `@source-material.md`, `@brand-guide.md`
- **Deliverables:** …
- **Evidence:** Store in `.genie/wishes/<slug>/qa/group-a/`
- **Branch:** `feat/<wish-slug>` or existing
- **Tracker:** JIRA-123 (or placeholder)
- **Suggested personas:** researcher, writer, editor
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
**Persona:** writer
**Tracker:** JIRA-123 (or placeholder)
**Status:** pending

## Scope
[What this task accomplishes]

## Inputs
- `@source-material.md`
- `@brand-guide.md`

## Validation
- Commands: reference `@.genie/create/agents/editor.md`
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
**Persona:** writer
**Branch:** feat/<wish-slug>

## Scope
[What this group accomplishes]

## Inputs
- `@source-material.md`
- `@brand-guide.md`

## Deliverables
- Research findings
- Content drafts
- Editorial revisions

## Validation
- Commands/scripts: see `@.genie/create/agents/editor.md` and wish-specific instructions

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
   - Unable to determine content strategy

   ## Investigation
   [What was checked, research performed]

   ## Recommendations
   - Update wish with spec_contract
   - Reorder groups to resolve dependencies
   - Specify content strategy in wish metadata
   ```

2. **Update Status:**
   - Mark wish status as "BLOCKED" in wish status log
   - Note blocker in wish status log

3. **Notify & Halt:**
   - Return blocker report reference to human
   - Do not proceed with forge plan generation
   - Wait for wish updates or guidance
