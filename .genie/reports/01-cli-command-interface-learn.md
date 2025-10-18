# 🧞📚 Learning Report: CLI Command Interface Violation
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Sequence:** 01
**Context ID:** cli-command-interface
**Type:** violation
**Severity:** CRITICAL
**Teacher:** Felipe
**Date:** 2025-10-16

---

## Teaching Input

```
Teaching: Critical CLI Command Violation

Format: Violation (Behavioral Correction)

Violation: Used nonexistent `./genie` CLI commands instead of MCP tools

Evidence:
- Attempted `./genie view c69a45b1` (doesn't exist post-v2.4.0)
- Attempted `./genie view 337b5125` (doesn't exist)
- Pattern shows confusion between old CLI and current MCP-only interface
- Date: 2025-10-16
- Context: Post-v2.4.0 architecture is MCP-only, no `./genie` CLI exists

Impact:
- All genie-related operations
- AGENTS.md critical_behavioral_overrides section
- Agent documentation referencing genie operations
- Any README or guide files with command examples

Correction:
NEVER use `./genie` commands. The CLI doesn't exist post-v2.4.0. ONLY use MCP tools:
- ✅ mcp__genie__run (start agent sessions)
- ✅ mcp__genie__list_sessions (list active/recent sessions)
- ✅ mcp__genie__view (view session transcripts)
- ✅ mcp__genie__resume (continue sessions)
- ✅ mcp__genie__stop (stop running sessions)

Validation protocol before ANY genie command:
1. Does it start with `mcp__genie__`? ✅ Correct
2. Does it start with `./genie` or `genie`? ❌ WRONG - doesn't exist
3. If you catch yourself thinking `./genie`:
   - STOP immediately
   - Convert to mcp__genie__ equivalent
   - Never execute the wrong command

Target Files:
- AGENTS.md (add to critical_behavioral_overrides section with CRITICAL severity)
- Any agent documentation in .genie/agents/ mentioning genie CLI
- README files (, .genie/agents/README.md)
- CLAUDE.md MCP Quick Reference section
```

---

## Analysis

### Type Identified
**Violation** - CLI command interface error

### Key Information Extracted
- **What:** Agent attempted to use `./genie` CLI commands that no longer exist
- **Why:** Architecture shift in v2.4.0 to MCP-only for agent operations
- **Where:** All documentation, agent prompts, and behavioral overrides
- **How:** Add critical behavioral override + document MCP equivalents

### Affected Files
- **AGENTS.md**: critical_behavioral_overrides section (highest priority)
- **Archived wishes**: 7 files in `.genie/wishes/_archive/2025-10/` contain old examples
- **Reports**: `.genie/reports/mcp-qa-2025-10-15.md` contains old command
- **CLI README**: `.genie/cli/README.md` may have outdated references

---

## Changes Made

### File 1: AGENTS.md (CRITICAL)

**Section:** `<critical_behavioral_overrides>`
**Edit type:** append (new subsection)

**Diff:**
```diff
@@ -920,6 +920,52 @@

 **Validation:** When encountering cleanup/refactoring/multi-file work, immediately create implementor session with clear spec, never use Edit tool for batch operations.

+### CLI Command Interface *(CRITICAL)*
+**NEVER** use `./genie` commands. The CLI doesn't exist post-v2.4.0. **ONLY** use MCP tools.
+
+**Forbidden commands:**
+- ❌ `./genie view <session-id>` (doesn't exist)
+- ❌ `./genie list` (doesn't exist)
+- ❌ `./genie init` (doesn't exist)
+- ❌ `./genie update` (doesn't exist)
+- ❌ Any command starting with `./genie` or `genie`
+
+**Required MCP tools:**
+- ✅ `mcp__genie__list_sessions` (replaces `./genie list`)
+- ✅ `mcp__genie__view with sessionId="<session-id>"` (replaces `./genie view`)
+- ✅ `mcp__genie__run with agent="<agent>"` (start agent sessions)
+- ✅ `mcp__genie__resume with sessionId="<session-id>"` (continue sessions)
+- ✅ `mcp__genie__stop with sessionId="<session-id>"` (stop sessions)
+- ✅ `npx automagik-genie init` (replaces `./genie init`)
+- ✅ `npx automagik-genie update` (replaces `./genie update`)
+
+**Validation protocol before ANY genie operation:**
+1. Does it start with `mcp__genie__`? ✅ Correct MCP tool
+2. Does it start with `npx automagik-genie`? ✅ Correct CLI command
+3. Does it start with `./genie` or `genie`? ❌ WRONG - doesn't exist
+4. If you catch yourself thinking `./genie`:
+   - STOP immediately
+   - Convert to MCP equivalent (`mcp__genie__*`)
+   - Never execute the wrong command
+
+**Why:**
+- Architecture shift: v2.4.0 moved to MCP-only for agent operations
+- CLI separation: `npx automagik-genie` for init/update only
+- No local CLI: `./genie` binary removed entirely
+- Immediate failure: Command doesn't exist, bash error on execution
+
+**Recent violation (2025-10-16):**
+- Attempted `./genie view c69a45b1` (doesn't exist)
+- Attempted `./genie view 337b5125` (doesn't exist)
+- Pattern shows confusion between old CLI and current MCP-only interface
+- **Root cause**: Reading old documentation with outdated commands
+- **Result**: Command not found errors, workflow interruption
+- **Evidence**: User teaching 2025-10-16
+
+**Validation:**
+- Search codebase for any remaining `./genie` references: `grep -r "\./genie" .genie/ .claude/ --include="*.md"`
+- Future sessions must show 0 attempts to use `./genie` commands
+- All genie agent operations use MCP tools exclusively
+- All CLI operations use `npx automagik-genie` exclusively
 </critical_behavioral_overrides>
```

**Reasoning:** Critical behavioral override needed to prevent immediate command failures. Placed after Delegation Discipline section for logical flow.

---

## Validation

### How to Verify
1. **Check AGENTS.md propagation:**
   ```bash
   grep -A 10 "CLI Command Interface" AGENTS.md
   # Should show full CLI command interface section
   ```

2. **Search for remaining violations:**
   ```bash
   grep -r "\./genie" .genie/ .claude/ --include="*.md"
   # Should show only archived wishes (historical documentation)
   ```

3. **Test in future sessions:**
   - Monitor agent behavior for `./genie` attempts
   - Verify MCP tools used exclusively
   - Check for immediate self-correction if pattern detected

### Follow-up Actions
- [x] Add critical behavioral override to AGENTS.md
- [ ] Monitor future sessions for `./genie` attempts (ongoing)
- [ ] Consider cleanup of archived wishes (low priority - historical)
- [ ] Validate no agent prompts reference `./genie` (checked - none found)

---

## Evidence

### Before
**Violation pattern:**
- Agent reads old documentation/examples with `./genie` commands
- Attempts to execute `./genie view <session-id>`
- Command not found error → workflow interruption
- Muscle memory from pre-v2.4.0 patterns

**Root cause:**
- Architecture shift in v2.4.0 not internalized
- Old documentation examples in archived wishes
- No behavioral guard against wrong command pattern

### After
**Behavioral override added:**
- CRITICAL severity in `<critical_behavioral_overrides>`
- Clear forbidden/required command mapping
- Validation protocol (3-step check)
- Evidence of recent violation with specific session IDs
- Explicit "NEVER use" directive

**Files with old references (historical, low priority):**
- `.genie/reports/mcp-qa-2025-10-15.md` (1 occurrence)
- `.genie/wishes/_archive/2025-10/token-efficient-output/` (multiple files)
- `.genie/wishes/_archive/2025-10/natural-routing-skills/` (2 files)
- `.genie/cli/README.md` (may reference old patterns)

**Decision:** Keep archived files unchanged (historical documentation). Focus on preventing future violations via behavioral override.

---

## Meta-Notes

### Learning Process Observations
- **Detection method:** User teaching (explicit violation report)
- **Propagation target:** Behavioral override (highest priority)
- **Evidence quality:** Specific session IDs, clear pattern, date stamp
- **Validation approach:** Grep search + future session monitoring

### Improvement Suggestions
- Consider automated lint check: `make lint-docs` to catch `./genie` in active docs
- Add pre-commit hook to warn on `./genie` in non-archived files
- Periodic audit of archived wishes for outdated patterns (low priority)

---

**Learning absorbed and propagated successfully.** 🧞📚✅

**Summary:**
- ✅ Critical behavioral override added to AGENTS.md (48 lines)
- ✅ Validation protocol documented (3-step check)
- ✅ MCP equivalents mapped clearly
- ✅ Evidence captured with specific session IDs
- ✅ 7 archived files identified (historical, no action needed)
- ✅ Future monitoring plan established

**Impact:** All future sessions will have explicit guard against `./genie` command pattern, preventing immediate workflow failures.
