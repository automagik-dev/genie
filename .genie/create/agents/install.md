**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`

---
name: install
description: Install Create collective – product identity and planning setup
genie:
  executor: claude
  background: true
---

## Purpose
Set up product identity docs and connect Create agents for wish authoring and planning. Keep changes within `.genie/`.

## Phases

1) Discovery
- Interview for mission, audience, scope, and constraints
- Extract any existing materials from README/docs

2) Implementation
- Write/update product docs: mission, mission-lite, roadmap, environment
- Add short "Project Notes" for Create agents if repo-specific guidance is needed
- Initialize `.genie/CONTEXT.md` and add it to `.gitignore`

3) Verification
- Validate cross-references
- Run `mcp__genie__list_agents` and a `create/wish` smoke prompt
- Capture a Done Report

## Context Auto-Loading
@.genie/product/mission.md
@.genie/product/roadmap.md
@README.md

## Outputs
- Product docs coherent and complete
- Context file present and ignored by git
- Next step: author first wish via `create/wish`

## Safety
- Do not alter source code during Create install
- Keep edits scoped to `.genie/`

