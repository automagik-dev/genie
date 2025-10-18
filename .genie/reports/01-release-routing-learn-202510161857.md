# 🧞📚 Learning Report: release-routing
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Sequence:** 01
**Context ID:** release-routing
**Type:** violation
**Severity:** high
**Teacher:** Felipe

---

## Teaching Input

```
Violation: Failed routing to release agent
Evidence: Session 2025-10-17 ~00:50Z - Attempted to handle RC5 release directly instead of delegating to release agent
Impact: Orchestrator/main agents attempting release work instead of proper delegation
Correction: Release operations (npm publish, gh release create, version tagging) MUST route to release agent. When user identifies routing failures, invoke learn agent immediately to document the correction.
Validation: Future release requests check routing matrix first, confirm release agent delegation before acting
Target: AGENTS.md §routing_decision_matrix, AGENTS.md §critical_behavioral_overrides (Publishing Protocol section)

Context: Meta-learning violation - "I'm learning" without documentation = pattern not propagated. This models template behavior for routing discipline.
```

---

## Analysis

### Type Identified
Violation (Behavioral Correction)

### Key Information Extracted
- **What:** Failed to route release operations to release agent, attempted direct handling
- **Why:** Routing discipline bypassed; meta-learning failure ("I'm learning" without learn agent invocation)
- **Where:** `<routing_decision_matrix>` (release routing rules), `<critical_behavioral_overrides>` §Publishing Protocol (recent violations)
- **How:** Add explicit routing rules with keyword triggers, forbidden/correct patterns, meta-learning trigger

### Affected Files
- `AGENTS.md` `<routing_decision_matrix>`: Add Critical Routing Rules section with release operations guidance
- `AGENTS.md` `<critical_behavioral_overrides>` §Publishing Protocol: Add 2025-10-17 violation entry

---

## Changes Made

### File 1: AGENTS.md `<routing_decision_matrix>`

**Section:** Critical Routing Rules (new section)
**Edit type:** insert

**Diff:**
```diff
@@ -1157,6 +1159,31 @@
 **Note:** Specialist agents do NOT load routing.md to prevent self-delegation paradox.

+### Critical Routing Rules
+
+**Release Operations (CRITICAL):**
+When user requests contain keywords: "publish", "release", "npm publish", "gh release", "create release", "RC", "release candidate":
+1. **STOP**: Do NOT attempt release operations directly
+2. **CHECK**: Consult routing matrix for release agent delegation
+3. **DELEGATE**: `mcp__genie__run with agent="release" and prompt="Create release for vX.Y.Z"`
+4. **NEVER**: Execute `npm publish`, `gh release create`, or version tagging manually
+
+**Forbidden patterns:**
+- ❌ "Let me publish this release..." → WRONG (bypasses specialist)
+- ❌ "I'll create the GitHub release..." → WRONG (bypasses specialist)
+- ❌ "Running npm publish..." → WRONG (bypasses validation)
+
+**Correct patterns:**
+- ✅ "I'll delegate to the release agent..." → CORRECT
+- ✅ "Let me route this to our release specialist..." → CORRECT
+- ✅ User identifies routing failure → Invoke learn agent immediately
+
+**Meta-learning trigger:**
+When user points out routing failures ("you should have routed to X agent"), immediately invoke learn agent to document the correction. Acknowledging "I'm learning" WITHOUT documentation = pattern not propagated.
+
+**Recent violation (2025-10-17):**
+- Session ~00:50Z: Attempted RC5 release handling directly instead of delegating to release agent
+- Pattern: Recognized release work but bypassed routing discipline
+- Meta-violation: "I'm learning" acknowledgment without learn agent invocation
+- **Result**: Routing pattern not propagated to framework
+- **Evidence**: User teaching 2025-10-17
+
+**Validation:** Before ANY release operation, explicitly check routing matrix and confirm delegation to release agent.
+
 ### Quick Reference: Available Specialists

 - **git** — ALL git and GitHub operations (branch, commit, PR, issues)
@@ -1167,7 +1194,7 @@
 - **planner** — Background strategic planning
 - **vibe** — Autonomous wish coordinator (requires dedicated branch)
 - **learn** — Meta-learning and documentation updates
-- **release** — GitHub release and npm publish orchestration
+- **release** — GitHub release and npm publish orchestration (NEVER bypass)
```

**Reasoning:** Added explicit routing rules with keyword triggers, forbidden/correct patterns, meta-learning trigger, and recent violation evidence. Emphasizes STOP-CHECK-DELEGATE workflow before any release operation.

### File 2: AGENTS.md `<critical_behavioral_overrides>` §Publishing Protocol

**Section:** Recent violations
**Edit type:** append

**Diff:**
```diff
@@ -882,7 +884,13 @@
 - **Evidence**: Commits 0c6ef02, 30dce09, GitHub Actions runs 18506885592

-**Validation:** When user says "publish" or "release", immediately suggest release agent delegation via MCP, never direct commands or slash commands.
+**Recent violation (2025-10-17):**
+- Session ~00:50Z: Recognized RC5 release work but attempted direct handling
+- Failed to check routing matrix before acting on release request
+- Acknowledged "I'm learning" but did NOT invoke learn agent for documentation
+- **Result**: Routing pattern not propagated to framework
+- **Evidence**: User teaching 2025-10-17
+
+**Validation:** When user says "publish" or "release", immediately check routing matrix and delegate to release agent via MCP. When user identifies routing failures, invoke learn agent immediately to document correction.
```

**Reasoning:** Documents the 2025-10-17 routing failure alongside existing 2025-10-14 violation. Adds meta-learning trigger to validation rule.

---

## Validation

### How to Verify
1. Search for release keywords in user messages: "publish", "release", "RC", "npm publish", "gh release"
2. Before acting, explicitly check routing matrix: `<routing_decision_matrix>` §Critical Routing Rules
3. Delegate via MCP: `mcp__genie__run with agent="release" and prompt="Create release for vX.Y.Z"`
4. When user identifies routing failures, immediately invoke learn agent: `mcp__genie__run with agent="learn" and prompt="<Teaching input>"`

**Commands:**
```bash
# Verify routing rules present
grep -A 15 "Critical Routing Rules" AGENTS.md

# Verify violation documented
grep "2025-10-17" AGENTS.md

# Test routing trigger detection
# Future sessions should show explicit "Checking routing matrix..." before release operations
```

### Follow-up Actions
- [x] Add routing rules to `<routing_decision_matrix>`
- [x] Document violation in `<critical_behavioral_overrides>`
- [ ] Monitor next release request for proper delegation
- [ ] Confirm learn agent invocation when routing failures occur

---

## Evidence

### Before
**Violation pattern:**
- User: "Create RC5 release"
- Agent: "I'm learning..." (acknowledges but no documentation)
- Result: Routing pattern not propagated

**Missing sections:**
- No Critical Routing Rules in `<routing_decision_matrix>`
- No 2025-10-17 violation in Publishing Protocol

### After
**Correction:**
- Explicit STOP-CHECK-DELEGATE workflow
- Keyword triggers: "publish", "release", "RC", etc.
- Forbidden/correct pattern examples
- Meta-learning trigger: User identifies failure → Invoke learn agent

**Documentation:**
- `<routing_decision_matrix>`: 33 lines added (Critical Routing Rules section)
- `<critical_behavioral_overrides>`: 8 lines added (2025-10-17 violation entry)

---

## Meta-Notes

**Key insight:** Meta-learning requires action, not just acknowledgment. "I'm learning" without invoking the learn agent = pattern not propagated. This learning report itself models the correct behavior.

**Pattern generalization:** This routing discipline applies to ALL specialist agents, not just release. When user identifies routing failures for any specialist (implementor, tests, git, etc.), immediately invoke learn agent to document the correction.

**Template behavior:** This learning demonstrates the meta-learning trigger pattern:
1. User identifies routing failure
2. Agent invokes learn agent immediately
3. Learn agent documents violation with evidence
4. Pattern propagates to framework via AGENTS.md updates

---

**Learning absorbed and propagated successfully.** 🧞📚✅
