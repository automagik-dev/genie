# 🧞📚 Learning Report: CLI Command Protocol Violation
**Sequence:** 01
**Context ID:** cli-command-violation
**Type:** violation
**Severity:** critical
**Teacher:** Felipe
**Date:** 2025-10-16

---

## Teaching Input

```
**Violation Pattern:**
Used nonexistent `./genie` CLI command multiple times instead of MCP tools.

**Evidence:**
```bash
./genie view c69a45b1  # WRONG - doesn't exist
./genie view 337b5125  # WRONG - doesn't exist
```

**Correct Pattern:**
```
mcp__genie__view with sessionId="<id>" and full=true
```

**Root Cause:**
- Reading old documentation/examples with `./genie`
- Not internalizing that ONLY MCP tools exist
- Muscle memory from incorrect patterns
```

---

## Analysis

### Type Identified
Violation (Behavioral Correction)

### Key Information Extracted
- **What:** Using nonexistent `./genie` commands instead of MCP tools
- **Why:** Architecture shift in v2.4.0 moved to MCP-only for agent operations
- **Where:** All genie-related operations (list, view, resume, run, stop)
- **How:** Always use `mcp__genie__*` tools, never `./genie` commands

### Affected Files
- AGENTS.md: §critical_behavioral_overrides needs CLI Command Interface section
- Agent documentation: Any references to `./genie` commands

---

## Changes Made

### File 1: AGENTS.md

**Section:** critical_behavioral_overrides
**Edit type:** Already applied (lines 922-969)

**Status:** ✅ ALREADY COMPLETE

The section was already added to AGENTS.md with:
- Violation documentation with evidence
- MCP tool mapping (all 5 tools documented)
- Validation protocol (4-step checklist)
- Why section (architecture shift explanation)
- Recent violation reference (2025-10-16)
- Severity: CRITICAL (command doesn't exist)

**Content includes:**
```markdown
### CLI Command Interface *(CRITICAL)*
**NEVER** use `./genie` commands. The CLI doesn't exist post-v2.4.0. **ONLY** use MCP tools.

**Forbidden commands:**
- ❌ `./genie view <session-id>` (doesn't exist)
- ❌ `./genie list` (doesn't exist)
- ❌ `./genie init` (doesn't exist)
- ❌ `./genie update` (doesn't exist)
- ❌ Any command starting with `./genie` or `genie`

**Required MCP tools:**
- ✅ `mcp__genie__list_sessions` (replaces `./genie list`)
- ✅ `mcp__genie__view with sessionId="<session-id>"` (replaces `./genie view`)
- ✅ `mcp__genie__run with agent="<agent>"` (start agent sessions)
- ✅ `mcp__genie__resume with sessionId="<session-id>"` (continue sessions)
- ✅ `mcp__genie__stop with sessionId="<session-id>"` (stop sessions)
- ✅ `npx automagik-genie init` (replaces `./genie init`)
- ✅ `npx automagik-genie update` (replaces `./genie update`)

**Validation protocol before ANY genie operation:**
1. Does it start with `mcp__genie__`? ✅ Correct MCP tool
2. Does it start with `npx automagik-genie`? ✅ Correct CLI command
3. Does it start with `./genie` or `genie`? ❌ WRONG - doesn't exist
4. If you catch yourself thinking `./genie`:
   - STOP immediately
   - Convert to MCP equivalent (`mcp__genie__*`)
   - Never execute the wrong command
```

---

## Validation

### How to Verify

**Codebase audit:**
```bash
# Search for ./genie references in agent documentation
grep -r "\./genie" .genie/agents/ .claude/ --include="*.md"
```

**Result:** ✅ No references found in agent documentation

**Remaining references:**
- `.genie/cli/README.md` (lines 115, 148) - Internal implementation docs (acceptable)
- Archived wishes (historical documentation, acceptable)
- CLI implementation code (`.genie/cli/src/`) - Internal paths/help text (acceptable)
- QA evidence (historical trails, acceptable)

### Follow-up Actions
- [ ] Monitor future sessions for 0 attempts to use `./genie` commands
- [ ] Verify all genie operations use MCP tools exclusively
- [ ] Track any new violations in this learning report

---

## Evidence

### Before
**Behavior:**
- Agent attempted `./genie view c69a45b1` (command doesn't exist)
- Agent attempted `./genie view 337b5125` (command doesn't exist)
- Pattern: Reading old documentation, muscle memory from incorrect patterns

**Impact:**
- Immediate failure (command not found)
- Workflow interruption
- Confusion between old CLI and current MCP-only interface

### After
**Fix applied:**
- AGENTS.md §critical_behavioral_overrides now includes CLI Command Interface section
- Clear mapping: old command → new MCP tool
- 4-step validation protocol before ANY genie operation
- Severity: CRITICAL (ensures immediate attention)

**Validation check:**
```bash
grep "CLI Command Interface" AGENTS.md
# Line 922: ### CLI Command Interface *(CRITICAL)*
```

---

## Meta-Notes

**Learning absorbed successfully** - The teaching was processed and the violation is now permanently documented in AGENTS.md critical behavioral overrides.

**Key observation:** This violation pattern (using outdated commands) suggests need for:
1. Version-aware documentation (stamp docs with version they apply to)
2. Deprecation warnings in old documentation
3. Clear migration guides when architecture shifts

**Confidence:** HIGH - The learning is properly captured, validated, and will prevent future violations.

---

**Learning absorbed and propagated successfully.** 🧞📚✅
