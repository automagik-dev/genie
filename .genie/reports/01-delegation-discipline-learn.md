# 🧞📚 Learning Report: Delegation Discipline

**Sequence:** 01
**Context ID:** delegation-discipline
**Type:** Violation
**Severity:** HIGH
**Teacher:** Felipe (User)
**Date:** 2025-10-15 22:16 UTC

---

## Teaching Input

```
Violation: Manual implementation instead of delegation

Evidence:
- Session 2025-10-16 22:30 UTC: Made 11 Edit calls to fix path references manually
- Should have delegated to implementor agent with clear spec
- Burned 13K tokens on repetitive edits instead of orchestrating
- Pattern: When I see cleanup work, I jump to Edit tool instead of mcp__genie__run

Correction:
- ALWAYS delegate to specialist agents for implementation work
- Use Edit tool ONLY for single surgical fixes, not batch operations
- For any task requiring multiple file edits, create agent session
- Orchestrate, don't implement

Validation:
- Future cleanup tasks use mcp__genie__run with implementor/review agents
- No more than 2 Edit calls per task before delegation
- Context updates track delegation vs manual work ratio

Target: AGENTS.md (critical_behavioral_overrides), CLAUDE.md (delegation discipline), learn.md (self-document)
```

---

## Analysis

### Type Identified
Violation - Manual implementation instead of orchestrator delegation

### Key Information Extracted
- **What:** Orchestrator role performing implementation work directly using Edit tool
- **Why:** Pattern recognition failure - "cleanup work" → "just fix it quickly" instead of delegation
- **Where:** AGENTS.md critical behavioral overrides, CLAUDE.md patterns, learn agent self-documentation
- **How:** Add delegation discipline rules with clear thresholds (>2 files = delegate)

### Affected Files
- **AGENTS.md**: Add new section to `<critical_behavioral_overrides>` about delegation discipline
- **CLAUDE.md**: Add new `## Delegation Discipline` pattern section
- **learn.md**: Target file doesn't exist yet (referenced in violation but not critical for this learning)

---

## Changes Made

### File 1: AGENTS.md

**Section:** `<critical_behavioral_overrides>`
**Edit type:** Append new subsection
**Location:** After "Publishing Protocol" section, before `</critical_behavioral_overrides>` closing tag

**Diff:**
```diff
@@ -675,6 +675,37 @@

 **Validation:** When user says "publish" or "release", immediately suggest release agent delegation via MCP, never direct commands or slash commands.
+
+### Delegation Discipline *(CRITICAL)*
+**NEVER** implement directly when orchestrating. **ALWAYS** delegate to specialist agents for multi-file work.
+
+**Forbidden actions:**
+- ❌ Using Edit tool for batch operations (>2 files)
+- ❌ Manual implementation of cleanup/refactoring work
+- ❌ Repetitive edits instead of delegating to implementor
+- ❌ "I'll just fix this quickly" mindset for multi-file changes
+
+**Required workflow:**
+
+**If you ARE an orchestrator (plan/orchestrator/vibe):**
+- ✅ Delegate to implementor: `mcp__genie__run with agent="implementor" and prompt="[clear spec with files, acceptance criteria]"`
+- ✅ Use Edit tool ONLY for single surgical fixes (≤2 files)
+- ✅ Track delegation vs manual work in context updates
+
+**If you ARE a specialist (implementor/tests/etc.):**
+- ✅ Execute implementation directly using available tools
+- ❌ NEVER delegate to yourself
+
+**Why:**
+- Token efficiency: Delegation uses specialist context, not bloated orchestrator context
+- Separation of concerns: Orchestrators route, specialists implement
+- Evidence trail: Specialist sessions = documentation
+- Scalability: Parallel specialist work vs sequential manual edits
+
+**Recent violation (2025-10-16):**
+- Made 11 Edit calls for path reference cleanup manually
+- Should have delegated to implementor with clear spec
+- Burned 13K tokens on repetitive edits
+- Pattern: See cleanup work → bypass delegation → implement directly
+- **Result**: Context bloat, poor separation of concerns
+- **Evidence**: Session 2025-10-16 22:30 UTC
+
+**Validation:** When encountering cleanup/refactoring/multi-file work, immediately create implementor session with clear spec, never use Edit tool for batch operations.
 </critical_behavioral_overrides>
```

**Reasoning:** Added critical behavioral override to prevent future manual implementation. Includes specific threshold (>2 files), role-specific guidance, evidence from violation, and clear validation criteria.

### File 2: CLAUDE.md

**Section:** New section after `## Experimentation`
**Edit type:** Append new section
**Location:** After Experimentation section, before end of file

**Diff:**
```diff
@@ -167,0 +168,40 @@
+
+## Delegation Discipline
+
+**Pattern:** Orchestrators delegate to specialists. Never implement directly when orchestrating.
+
+**When you are orchestrating (plan/orchestrator/main):**
+- ❌ NEVER use Edit tool for batch operations (>2 files)
+- ❌ NEVER implement cleanup/refactoring work manually
+- ❌ NEVER fall into "I'll just fix this quickly" mindset
+- ✅ ALWAYS delegate to implementor for multi-file work
+- ✅ ALWAYS use specialist sessions for implementation
+- ✅ Edit tool is ONLY for single surgical fixes (≤2 files)
+
+**When you are a specialist (implementor/tests/polish):**
+- ✅ Execute implementation directly using available tools
+- ❌ NEVER delegate to yourself
+- ✅ Use Edit/Write/etc. tools as needed
+
+**Example (WRONG):**
+> *Sees 11 path references to fix*
+> *Makes 11 Edit calls manually*
+> Result: 13K tokens burned, context bloat, poor separation of concerns
+
+**Example (CORRECT):**
+> *Sees 11 path references to fix*
+> "This is multi-file cleanup work. Let me delegate to implementor..."
+> *Creates implementor session with clear spec*
+> Result: Token-efficient, clean evidence trail, proper separation
+
+**Why:**
+- Token efficiency: Specialists work in focused context
+- Separation of concerns: Orchestrators route, specialists implement
+- Evidence trail: Specialist sessions = documentation
+- Scalability: Parallel work vs sequential manual edits
+
+**Validation:**
+- Before using Edit tool, count files affected
+- If >2 files → delegate to implementor
+- If repetitive pattern → delegate, don't implement
+- Track delegation vs manual work ratio in context updates
```

**Reasoning:** Created new Claude-specific pattern for delegation discipline. Includes role-specific rules, concrete examples (wrong vs correct), rationale, and validation checklist. Complements AGENTS.md with Claude-facing guidance.

---

## Validation

### How to Verify
1. **Behavioral check**: Future cleanup/refactoring tasks trigger delegation instead of manual Edit calls
2. **Token monitoring**: Context usage decreases for multi-file tasks (specialist sessions vs orchestrator manual work)
3. **Evidence trail**: Specialist sessions appear in session logs for implementation work
4. **Threshold enforcement**: No more than 2 Edit calls before delegation decision point

### Follow-up Actions
- [x] Update AGENTS.md critical behavioral overrides
- [x] Update CLAUDE.md patterns
- [ ] Monitor next cleanup task for delegation behavior
- [ ] Track delegation vs manual work ratio in context updates

---

## Evidence

### Before (Violation)
**Session:** 2025-10-16 22:30 UTC
**Task:** Fix path references from `core/` to `neurons/`
**Approach:** Manual implementation with Edit tool
**Result:**
- 11 Edit tool calls
- 13K tokens consumed
- Context bloat (orchestrator doing specialist work)
- No evidence trail beyond tool calls

**Example violations:**
```
Edit: .genie/agents/README.md (core/analyze → neurons/analyze)
Edit: .genie/agents/README.md (core/commit → neurons/commit)
Edit: .genie/agents/README.md (core/debug → neurons/debug)
... (8 more manual edits)
```

### After (Expected)
**Future cleanup task:** Fix similar path references
**Approach:** Delegation to implementor
**Expected result:**
```
Orchestrator: "I need to fix path references across 11 files. This is multi-file cleanup work (>2 files threshold). Delegating to implementor..."

mcp__genie__run with agent="implementor" and prompt="
Fix all path references from old/ to new/ across these files:
- .genie/agents/README.md
- .genie/agents/other-file.md
... (file list)

Acceptance criteria:
- All references updated
- No broken links
- Consistent naming

Evidence: Provide file diff summary
"

Implementor session: (executes implementation efficiently)
Result: Token-efficient, clean evidence trail, proper separation
```

---

## Meta-Notes

### Observations
- **Pattern recognition**: "Cleanup work" triggered wrong mental model ("just fix it quickly" instead of "orchestrate delegation")
- **Threshold value**: >2 files chosen as practical boundary between surgical fix and batch operation
- **Role clarity**: Critical to distinguish orchestrator vs specialist behavior
- **Token economics**: 13K token cost for manual work would be ~2-3K with proper delegation

### Framework Improvements
- **Proactive checking**: Add pre-Edit tool check: "How many files affected? If >2, delegate instead"
- **Context tracking**: Add delegation vs manual work ratio to context updates
- **Session naming**: Use consistent pattern `implementor-[task-type]-[slug]` for implementation work

### Learning Process Quality
- ✅ Clear violation evidence (session timestamp, tool calls, token cost)
- ✅ Specific correction threshold (>2 files)
- ✅ Concrete validation steps
- ✅ Role-specific guidance (orchestrator vs specialist)
- ✅ Evidence trail requirements
- ⚠️ Learn agent doesn't exist yet (self-documentation target unfulfilled)

---

**Learning absorbed and propagated successfully.** 🧞📚✅

**Files modified:** 2 (AGENTS.md, CLAUDE.md)
**Lines added:** 77 (37 in AGENTS.md, 40 in CLAUDE.md)
**Validation method:** Behavioral monitoring on next cleanup task
**Follow-up:** Track delegation patterns in future context updates
