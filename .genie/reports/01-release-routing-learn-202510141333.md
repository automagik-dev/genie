# 🧞📚 Learning Report: Release Agent Routing
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Sequence:** 01
**Context ID:** release-routing
**Type:** violation
**Severity:** HIGH
**Teacher:** Felipe
**Date:** 2025-10-14

---

## Teaching Input

"we publish from within publising tag and version in github second violation today"

Context: Attempted `npm publish` directly instead of delegating to release agent. This is the second violation of proper publishing workflow today.

---

## Analysis

### Type Identified
Violation - Agent routing failure

### Key Information Extracted
- **What:** Bypassed release agent; executed `npm publish` directly
- **Why:** Failed to recognize publishing as delegatable task requiring release agent
- **Where:** Publishing workflow, routing decision matrix
- **How:** Always delegate to release agent via MCP

### Affected Files
- `AGENTS.md`: Routing decision matrix needs release agent routing rule
- `AGENTS.md`: Critical behavioral overrides needs publishing protocol

---

## Changes Made

### File 1: AGENTS.md

**Section:** `<routing_decision_matrix>`
**Edit type:** Append new subsection

**Diff:**
```diff
+### Publishing & Release Routing (CRITICAL)
+
+**User intent:** "publish to npm", "create release", "deploy version", "publish v2.x.x"
+
+**Required routing:**
+- ✅ Delegate to release agent: `mcp__genie__run` with agent="release" and prompt="Create release for vX.Y.Z with changelog"
+- ❌ NEVER execute `npm publish` directly
+- ❌ NEVER execute `gh release create` directly
+
+**Why delegation matters:**
+- Release agent validates version, git status, tests
+- Generates release notes from commits
+- Creates GitHub release (triggers npm publish via Actions)
+- Verifies publish succeeded, provides release URL
+
+**Example correct routing:**
+```
+User: "Publish v2.1.20"
+Genie: "I'll delegate to the release agent to orchestrate the GitHub release and npm publish:
+
+mcp__genie__run with:
+- agent: "release"
+- prompt: "Create release for v2.1.20. Include changelog from recent commits."
+
+The release agent will validate readiness, create the GitHub release, and monitor npm publish via GitHub Actions."
+```
```

**Reasoning:** Added explicit routing rule for publishing tasks with example showing correct delegation pattern.

**Section:** `<critical_behavioral_overrides>`
**Edit type:** Append new subsection

**Diff:**
```diff
+### Publishing Protocol *(CRITICAL)*
+**NEVER** execute `npm publish` or `gh release create` directly. **ALWAYS** delegate to release agent.
+
+**Forbidden actions:**
+- ❌ `npm publish` (bypasses validation, GitHub release, audit trail)
+- ❌ `gh release create` (direct command - let agent orchestrate)
+- ❌ Manual version tagging without release agent
+
+**Required workflow:**
+1. Commit code + version bump to main
+2. Delegate to release agent: `mcp__genie__run` with agent="release"
+3. Release agent validates, creates GitHub release, monitors npm publish
+4. Provide release URL to user
+
+**Why:**
+- Safety: Pre-flight checks (clean git, tests pass, version valid)
+- Consistency: Follows project workflow (GitHub Actions)
+- Audit trail: All releases documented in GitHub
+- Rollback: Structured process easier to revert
+
+**Validation:** When user says "publish" or "release", immediately suggest release agent delegation, never direct commands.
```

**Reasoning:** Added publishing protocol to critical behavioral overrides to prevent future violations.

---

## Validation

### How to Verify

1. **Check routing rule exists:**
   ```bash
   grep -A 20 "Publishing & Release Routing" AGENTS.md
   ```

2. **Check critical override exists:**
   ```bash
   grep -A 15 "Publishing Protocol" AGENTS.md
   ```

3. **Test agent recognition:**
   - When user says "publish v2.1.21", Genie should suggest release agent
   - Never show `npm publish` in responses
   - Always show `mcp__genie__run` with agent="release"

4. **Verify release agent available:**
   ```bash
   test -f .genie/agents/core/release.md && echo "✅ Release agent available"
   ```

### Follow-up Actions
- [x] Update routing decision matrix
- [x] Add publishing protocol to critical overrides
- [ ] Monitor next publishing request (verify routing works)
- [ ] Document in CONTRIBUTING.md if it exists

---

## Evidence

### Before
- Routing decision matrix: Had release agent listed but no explicit routing rule
- Critical overrides: No publishing protocol
- Behavior: Attempted `npm publish` directly

### After
- Routing decision matrix: Added "Publishing & Release Routing (CRITICAL)" section with explicit rules
- Critical overrides: Added "Publishing Protocol *(CRITICAL)*" section
- Expected behavior: Will delegate to release agent for all publishing tasks

---

## Meta-Notes

**Observation:** This is the second violation today. The routing rule was not explicit enough - just listing "release" in aliases wasn't sufficient. Added explicit routing instructions with user intent keywords ("publish", "release", "deploy") and example dialog.

**Pattern:** High-severity violations require BOTH routing matrix update AND critical behavioral override entry to prevent recurrence.

**Validation strategy:** Monitor next publishing request to verify new routing rule is recognized and followed.

---

**Learning absorbed and propagated successfully.** 🧞📚✅
