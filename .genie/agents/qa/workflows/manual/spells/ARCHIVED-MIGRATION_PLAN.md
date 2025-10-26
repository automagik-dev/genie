---
name: qa/migration-plan
description: ARCHIVED - QA workflows migration planning document (work complete)
archived: true
archived_date: 2025-10-26
archived_reason: Migration work complete - all workflows converted to autonomous format or archived
---

# ARCHIVED: QA Workflows Migration Plan

**Status:** ARCHIVED (migration complete)

**Archived Date:** 2025-10-26

**Reason for Archiving:**
This planning document described the migration of QA workflows to autonomous format. The work is now complete:

**Migration Completed (Phase 4):**
- ✅ installation-flow.md (converted to autonomous format)
- ✅ cli-commands.md (converted to autonomous format)
- ✅ voice-boot-qa-workflow.md (archived - not autonomous-executable)
- ✅ mcp-operations.md (converted to autonomous format)
- ✅ cli-output-legacy-commands.md (converted to autonomous format)
- ✅ background-launch-timeout-argmax.md (converted to autonomous format - Bug #104)
- ✅ bug-xxx-background-launch.md (archived - duplicate of Bug #104)
- ✅ install-simulation.md (archived - manual script, superseded by autonomous installation-flow.md)

**Current State:**
All QA workflows in `.genie/agents/qa/workflows/manual/scenarios/` are now either:
1. Autonomous workflows (no user interaction required)
2. Archived with clear explanation (not suitable for autonomous execution)

**References:**
- Autonomous workflow pattern: `/tmp/autonomous-workflow-pattern-2025-10-26.md` (if available)
- QA coordination: `.genie/agents/qa/README.md`
- Upgrade guide: `UPGRADE_GUIDE.md` (framework upgrade process)

**Original Content Preserved Below for Historical Reference**

---

# QA Workflows Migration Plan

Goal: Keep all existing QA flows; migrate code-specific scenarios to `qa/scenarios/` while retaining cross-cutting/global flows under `qa/workflows/`.

## Inventory
- Keep (global): `qa/workflows/voice-boot-qa-workflow.md`
  - Reason: validates Voice co-pilot orchestration (not code-specific)
- New (code-specific): `qa/scenarios/agent-listing-latency.md`
  - Reason: tests agent listing performance (integrates with MCP)

## Candidates for future migration
- `qa/scenarios-from-bugs.md` → Extract atomic scenarios into standalone workflows (code or global based on scope)

## Evidence & Conventions
- Evidence paths under `.genie/qa/evidence/`
- Each workflow: name, description, command(s), success, evidence

---

**This planning document remains archived for historical reference. All migration work is complete.**

@.genie/agents/qa/README.md
