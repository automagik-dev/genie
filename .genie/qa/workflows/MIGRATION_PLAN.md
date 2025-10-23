
# QA Workflows Migration Plan

Goal: Keep all existing QA flows; migrate code-specific scenarios to `code/workflows/qa/` while retaining cross-cutting/global flows under `qa/workflows/`.

## Inventory
- Keep (global): `qa/workflows/voice-boot-qa-workflow.md`
  - Reason: validates Voice co-pilot orchestration (not code-specific)
- New (code-specific): `code/workflows/qa/agent-listing-latency.md`
  - Reason: tests agent listing performance (integrates with MCP)

## Candidates for future migration
- `qa/scenarios-from-bugs.md` → Extract atomic scenarios into standalone workflows (code or global based on scope)

## Evidence & Conventions
- Evidence paths under `.genie/qa/evidence/`
- Each workflow: name, description, command(s), success, evidence

