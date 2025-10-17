# 🧞📚 Learning Report: triad-maintenance

**Sequence:** 01
**Context ID:** triad-maintenance
**Type:** violation
**Severity:** CRITICAL
**Teacher:** Felipe

---

## Teaching Input

Violation: Triad Maintenance Failure (CRITICAL)

Evidence: Vibe mode session 2025-10-17
- Completed TODO #4 (template extraction) - DIDN'T mark complete in TODO.md
- Completed TODO #5 (MCP bug fix) - DIDN'T mark complete in TODO.md
- Published RC7 - DIDN'T update STATE.md version info
- Said "I'm learning" about version awareness - DIDN'T invoke learn agent

Pattern: Load triad files (@TODO.md, @STATE.md, @USERCONTEXT.md) but NEVER maintain them

Felipe's ask: "definite solution for this" = permanent fix, not promises

Root Cause Analysis:
- Files load automatically via @ in CLAUDE.md
- No protocol for WHEN to update them
- No checklist enforcing updates
- Updates happen ad-hoc (forgotten)

Impact: CRITICAL - System designed for session continuity breaks when files stale

Required Solution (Definite):
1. Protocol: WHEN to update each file
2. Enforcement: Checklist/validation BEFORE completion claims
3. Automation: Where possible, reduce manual updates

---

## Analysis

### Type Identified
Violation (critical behavioral pattern)

### Key Information Extracted
- **What:** Complete tasks/publish releases without maintaining triad files (TODO.md, STATE.md, USERCONTEXT.md)
- **Why:** Files load automatically but no enforcement protocol for updates
- **Where:** Session continuity system (triad files), completion claims, learning propagation
- **How:** Add protocol to AGENTS.md, reminder to CLAUDE.md, pattern to USERCONTEXT.md

### Affected Files
- AGENTS.md: Add Triad Maintenance Protocol to critical_behavioral_overrides
- CLAUDE.md: Add triad maintenance reminder to Delegation Discipline section
- USERCONTEXT.md: Add triad discipline to core patterns

---

## Changes Made

### File 1: AGENTS.md

**Section:** `<critical_behavioral_overrides>` (after Role Clarity Protocol)
**Edit type:** insert (new protocol section)

**Diff:**
```diff
+### Triad Maintenance Protocol *(CRITICAL)*
+**NEVER** claim task completion without updating TODO.md. **NEVER** publish/bump version without updating STATE.md. **NEVER** say "I'm learning" without invoking learn agent.
+
+**Root cause:** Files load automatically via @ in CLAUDE.md, but no protocol for WHEN to update them. Updates happen ad-hoc (forgotten).
+
+**Forbidden patterns:**
+- ❌ Completing TODO task without marking complete in TODO.md
+- ❌ Publishing release without updating STATE.md version info
+- ❌ Saying "I'm learning" without invoking learn agent to document
+- ❌ Claiming "done" when triad files are stale
+
+**Required workflow:**
+
+**TODO.md updates (task status changes):**
+- TRIGGER: Before claiming "done" in chat
+- VALIDATION: `grep -A 2 "### N." .genie/TODO.md | grep "COMPLETE"` (replace N with task number)
+- Update when: Task starts (pending → in progress) or completes (in progress → complete)
+
+**STATE.md updates (version/milestone changes):**
+- TRIGGER: After version bump, after major feature commit, after release
+- VALIDATION: `diff <(jq -r .version package.json) <(grep "Version:" .genie/STATE.md | awk '{print $2}')` (should be empty)
+- Update when: Version changes in package.json, major commit pushed, milestone reached
+
+**USERCONTEXT.md updates (new patterns learned):**
+- TRIGGER: Rarely (only significant behavioral patterns)
+- VALIDATION: Pattern documented with evidence from teaching session
+- Update when: New working patterns emerge, relationship dynamics shift significantly
+
+**Completion checklist (BEFORE responding "Done!" or "Complete!"):**
+1. [ ] TODO.md updated? (if task was in TODO)
+2. [ ] STATE.md updated? (if version/milestone changed)
+3. [ ] Evidence matches claims? (files, commits, tests)
+
+**Why:**
+- Session continuity: Triad system designed for cross-session memory
+- User trust: Claims match reality when files are current
+- Learning propagation: "I'm learning" without documentation = pattern lost
+- Definite solution: Protocol + enforcement replaces ad-hoc updates
+
+**Recent violation (2025-10-17):**
+- Vibe session completed TODO #4 (template extraction) - DIDN'T mark complete in TODO.md
+- Vibe session completed TODO #5 (MCP bug fix) - DIDN'T mark complete in TODO.md
+- Published RC7 - DIDN'T update STATE.md version info
+- Said "I'm learning" about version awareness - DIDN'T invoke learn agent
+- **Pattern**: Load triad files but never maintain them
+- **Result**: Stale context, false claims, lost learnings
+- **Evidence**: User teaching 2025-10-17, demands "definite solution"
+
+**Validation:** Check TODO.md/STATE.md before claiming completion. Invoke learn agent immediately when saying "I'm learning".
```

**Reasoning:** Add complete protocol with triggers, validation commands, completion checklist. Addresses Felipe's requirement for "definite solution" - not vague promises, but concrete enforcement.

### File 2: CLAUDE.md

**Section:** Delegation Discipline (after Role Clarity, before Validation)
**Edit type:** insert (triad maintenance reminder)

**Diff:**
```diff
+**Triad Maintenance (CRITICAL):**
+- BEFORE claiming "Done!" or "Complete!":
+  1. Update TODO.md (if task was tracked)
+  2. Update STATE.md (if version/milestone changed)
+  3. Invoke learn agent (if you said "I'm learning")
+- See @AGENTS.md §Triad Maintenance Protocol for full checklist
+
 **Validation:**
 - Before using Edit tool, count files affected
 - If >2 files → delegate to implementor
 - If repetitive pattern → delegate, don't implement
 - Track delegation vs manual work ratio in context updates
 - When resuming with active sessions → Check sessions FIRST, never bypass
+- Before completion claims → Check TODO.md/STATE.md updated
```

**Reasoning:** Add concise reminder in high-traffic location (Delegation Discipline). Links to full protocol in AGENTS.md. Adds validation step to existing checklist.

### File 3: .genie/USERCONTEXT.md

**Section:** Core Working Patterns (after "Maintain TODO.md", before "Role clarity")
**Edit type:** insert (triad discipline pattern)

**Diff:**
```diff
+- **Triad discipline (CRITICAL):** BEFORE claiming completion:
+  1. Update TODO.md (if task tracked there)
+  2. Update STATE.md (if version/milestone changed)
+  3. Invoke learn agent (if I said "I'm learning")
+  - Files load automatically but must be maintained manually
+  - See @AGENTS.md §Triad Maintenance Protocol for full checklist
```

**Reasoning:** Document pattern in user context so it's reinforced in every session greeting. Emphasizes automatic loading vs manual maintenance distinction.

---

## Validation

### How to Verify
Protocol is propagated when agents observe these behaviors:

**TODO.md maintenance:**
```bash
# Before claiming "Task #4 complete", verify:
grep -A 2 "### 4." .genie/TODO.md | grep "COMPLETE"
# Should return matching line if marked complete
```

**STATE.md maintenance:**
```bash
# After version bump, verify version matches:
diff <(jq -r .version package.json) <(grep "Version:" .genie/STATE.md | awk '{print $2}')
# Should return empty output if synced
```

**Learn agent invocation:**
```bash
# When saying "I'm learning", verify learn agent invoked:
# Check for mcp__genie__run with agent="learn" in session
```

### Follow-up Actions
- [x] Protocol added to AGENTS.md critical_behavioral_overrides
- [x] Reminder added to CLAUDE.md Delegation Discipline
- [x] Pattern added to USERCONTEXT.md core patterns
- [ ] Monitor next completion claims (verify checklist used)
- [ ] Monitor next version bump (verify STATE.md updated)
- [ ] Monitor "I'm learning" statements (verify learn agent invoked)

---

## Evidence

### Before
**Pattern:** Load triad files but never maintain them
- Completed TODO #4, #5 - DIDN'T mark complete
- Published RC7 - DIDN'T update STATE.md
- Said "I'm learning" - DIDN'T invoke learn agent

**Impact:** Session continuity broken, stale context, false claims, lost learnings

### After
**Protocol established:**
- AGENTS.md: Complete Triad Maintenance Protocol with triggers/validation/checklist (50 lines)
- CLAUDE.md: Triad maintenance reminder + validation step (8 lines)
- USERCONTEXT.md: Core pattern documented (6 lines)

**Validation commands provided:**
- TODO.md: `grep -A 2 "### N." .genie/TODO.md | grep "COMPLETE"`
- STATE.md: `diff <(jq -r .version package.json) <(grep "Version:" .genie/STATE.md | awk '{print $2}')`

**Enforcement mechanism:**
- Completion checklist BEFORE responding "Done!"
- Explicit triggers for each file update
- Links protocol across all three framework docs

---

## Meta-Notes

**Observation:** This violation highlights a critical gap between automatic loading (@ syntax) and manual maintenance. The solution addresses Felipe's demand for "definite" (not ad-hoc) with:
1. Clear triggers for WHEN to update
2. Validation commands for HOW to verify
3. Completion checklist for enforcement
4. Cross-references for discoverability

**Pattern:** "Load automatically but maintain manually" is a common trap. Protocol makes the invisible (maintenance) visible and enforceable.

**Future improvement:** Automation opportunities noted in teaching (git hooks, parse scripts) but not implemented - manual protocol first, automation later if needed.

---

**Learning absorbed and propagated successfully.** 🧞📚✅
