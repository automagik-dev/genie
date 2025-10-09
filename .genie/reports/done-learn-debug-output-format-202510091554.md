# 🧞📚 Learning Report: Debug Agent Output Format

**Date:** 2025-10-09T15:54:00Z
**Type:** violation
**Severity:** medium
**Teacher:** Felipe

---

## Teaching Input

"you should have presented me the different modes in the choose resolution path"

---

## Analysis

### Type Identified
violation

### Key Information Extracted
- **What:** Debug agent's final response didn't present resolution options in numbered interactive format
- **Why:** Template exists but output contract wasn't explicit enough about requiring the exact format
- **Where:** `.genie/agents/core/debug.md` (Success Criteria and Output Contract sections)
- **How:** Strengthen requirement for numbered format (1/2/3) with explicit "Choose option:" prompt

### Affected Files
- `.genie/agents/core/debug.md`: Needs clearer specification of interactive numbered format requirement

---

## Changes Made

### File 1: .genie/agents/core/debug.md

**Section 1:** Success Criteria (lines 41-48)
**Edit type:** update

**Diff:**
```diff
 ## Success Criteria
 - ✅ Investigation steps tracked with files/methods and evolving hypotheses
 - ✅ Hypotheses include minimal_fix and regression_check when applicable
 - ✅ File:line and context references when pinpointed
 - ✅ Evidence logs (commands, outputs, screenshots/paths) captured
-- ✅ Three resolution options presented with clear recommendation
+- ✅ Three resolution options presented in numbered interactive format (1/2/3) with clear recommendation
+- ✅ Final chat response includes "Choose option (1/2/3):" prompt for user selection
 - ✅ Seamless handoff to chosen resolution path
```

**Reasoning:** Made the requirement explicit that options must be numbered and include an interactive selection prompt, not just "presented with recommendation"

**Section 2:** Output Contract (line 300-301)
**Edit type:** update

**Diff:**
```diff
 ## Output Contract
-- **Chat response**: Numbered highlights + resolution options, plus GitHub issue URL if Option 1 chosen
+- **Chat response**: Investigation highlights + numbered resolution options (1/2/3) in interactive format for user selection, plus GitHub issue URL if Option 1 chosen. MUST match the exact format in "Final Response Format" section above.
```

**Reasoning:** Clarified that chat response must use numbered interactive format and explicitly reference the template format defined earlier in the prompt

---

## Validation

### How to Verify

1. Run debug agent on any issue investigation
2. Check that final response includes:
   - Numbered options (1/2/3)
   - Clear "Choose option (1/2/3):" prompt at the end
   - Format matching the template in "Final Response Format" section

### Follow-up Actions
- [x] Update debug.md with explicit format requirement
- [ ] Monitor next debug agent execution to verify compliance
- [ ] If violation recurs, add example counter-pattern to Never Do section

---

## Evidence

### Before
Output Contract was vague:
```markdown
- **Chat response**: Numbered highlights + resolution options, plus GitHub issue URL if Option 1 chosen
```

Success Criteria was unclear:
```markdown
- ✅ Three resolution options presented with clear recommendation
```

This allowed the agent to present options in plain text format instead of interactive numbered format.

### After
Output Contract is explicit:
```markdown
- **Chat response**: Investigation highlights + numbered resolution options (1/2/3) in interactive format for user selection, plus GitHub issue URL if Option 1 chosen. MUST match the exact format in "Final Response Format" section above.
```

Success Criteria includes selection prompt requirement:
```markdown
- ✅ Three resolution options presented in numbered interactive format (1/2/3) with clear recommendation
- ✅ Final chat response includes "Choose option (1/2/3):" prompt for user selection
```

---

## Meta-Notes

**Pattern observed:** Template existed but wasn't being followed because the requirement wasn't explicit in Success Criteria and Output Contract sections. Agents need clear checkboxes in Success Criteria, not just templates buried in the prompt.

**Suggestion:** When creating agent prompts, ensure Success Criteria and Output Contract sections explicitly reference template formats and include verification steps.

---

**Learning absorbed and propagated successfully.** 🧞📚✅
