---
name: install
description: Create Collective install workflow — prepare product identity and connect Create agents

---

# Create Install Workflow

Purpose: Initialize product identity docs and wire up Create collective agents for wish authoring and planning.

## Phases

1) Discovery
- Determine domain, audience, and objectives
- Identify constraints and success criteria for Phase 1
- Choose path: Interview • Analyze Existing Materials • Hybrid

2) Implementation
- Create/update product docs:
  - `@.genie/product/mission.md`
  - `@.genie/product/mission-lite.md`
  - `@.genie/product/roadmap.md`
  - `@.genie/product/environment.md`
- Add Create-specific “Project Notes” inside `.genie/create/agents/*` or relevant spells to guide wish authoring
- Initialize `.genie/CONTEXT.md` and add to `.gitignore`

3) Verification
- Validate references and required sections
- Exercise Create agents: `create/wish` basic prompt to confirm flow
- Capture a Done Report and route into `create/wish` for the first scoped deliverable

## Context Auto-Loading
@.genie/product/mission.md
@.genie/product/roadmap.md
@README.md

## Interview Prompts (Examples)
- Elevator pitch, target users, value proposition
- Top 3 features for Phase 1
- Risks/constraints and non-goals
- Success measures and acceptance signals

## Outputs
- Product docs populated (mission, mission-lite, roadmap, environment)
- `.genie/CONTEXT.md` created and ignored
- Done Report at `.genie/wishes/<slug>/reports/done-install-create-<timestamp>.md`

## Next Steps
- Use `create/wish` to author the first wish and break into actionable tasks
- When ready to implement code, hand off to Code collective: `code/wish` → `code/forge`

## Safety
- Keep edits under `.genie/`
- Do not alter code when running Create install

