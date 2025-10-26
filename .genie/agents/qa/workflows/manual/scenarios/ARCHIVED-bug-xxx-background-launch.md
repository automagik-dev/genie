---
name: qa/bug-xxx-background-launch
description: ARCHIVED - Background agent launch failure (covered by Bug #104)
parent: qa
autonomous: false
archived: true
archived_date: 2025-10-26
archived_reason: Duplicate of Bug #104 (background-launch-timeout-argmax.md validates this)
---

# ARCHIVED: NEW BUG • Background Agent Launch Failure

**Status:** ARCHIVED (duplicate of Bug #104)

**Archived Date:** 2025-10-26

**Reason for Archiving:**
This workflow describes the same underlying issue as Bug #104, which is tracked and validated by `background-launch-timeout-argmax.md`. The autonomous workflow for Bug #104 comprehensively tests:
- Background agent launch with normal prompts
- ARG_MAX handling with long prompts
- Multiple concurrent background sessions
- Status transition validation (starting → running)
- Executor process spawning

**References:**
- Bug #104: MCP Background Launch Timeout + Long Prompt ARG_MAX Failure (RC9+)
- Active workflow: `background-launch-timeout-argmax.md`
- Bug tracking: `.genie/agents/qa/workflows/auto-generated/scenarios-from-bugs.md`

**Original Content Preserved Below for Historical Reference**

---

## Bug Description
**Discovered:** 2025-10-17 (during RC9 testing)
**Status:** UNRESOLVED
**Issue:** TBD (needs GitHub issue creation)

Background agents (with `background: true`) fail to launch silently. Session entry created in sessions.json but executor process never spawns.

**Symptoms:**
- Session status stuck in "starting"
- executorPid remains null
- Log file created but 0 bytes (no content)
- runnerPid process doesn't exist
- `list_sessions` doesn't show session (filters out "starting" status?)
- `view` returns "No messages yet"

**Evidence from Discovery:**
- qa agent invocation (session: temp-genie/agents/qa/qa-1760728615256)
- implementor agent invocation (session: temp-genie/agents/implementor/implementor-1760728741265)
- Both stuck in identical failure state

[... rest of original content omitted for brevity ...]

---

**This workflow remains archived for historical reference. Background agent validation is now handled by the autonomous Bug #104 workflow.**

@.genie/agents/qa/README.md
