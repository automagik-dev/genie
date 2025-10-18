# 🧞📚 Learning Report: Issue Template Selection
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Sequence:** 01
**Context ID:** issue-template-selection
**Type:** violation + pattern
**Severity:** high
**Teacher:** Felipe
**Date:** 2025-10-13T18:09Z

---

## Teaching Input

```
Violation: Issue #40 created with make-a-wish template instead of feature-request template

Evidence:
- Issue #40 title: "[Wish] Provider runtime override with intelligent fallbacks"
- Used make-a-wish template (external user template)
- Created by founder (Felipe) for internal planned work
- Wish document already exists: .genie/wishes/provider-runtime-override/provider-runtime-override-wish.md
- No labels applied (should have type:enhancement, priority:high, area:cli)

Context:
- NOT everything goes into roadmap initiatives
- Founder-initiated infrastructure wishes are common
- Need standalone pattern without breaking framework

Correction:
Use correct template based on source and purpose:
1. External user suggestions → make-a-wish template
2. Internal features (founder/team) → feature-request template
3. Internal bugs (founder/team) → bug-report template
4. Roadmap-linked work (when initiative exists) → planned-feature template
5. Standalone work (no roadmap initiative) → feature-request or bug-report

Template naming fix:
- Changed make-a-wish title prefix from "[Wish]" to "[Make a Wish]" for clarity
- Updated documentation references in AGENTS.md and github-workflow.md

Validation:
- Issue #40 fixed: title updated, labels corrected (type:enhancement, priority:high, area:cli, status:needs-review)
- Future issues use correct templates
- Standalone pattern documented: not everything needs roadmap initiative
- Always update mistakes, NEVER close and reopen issues
```

---

## Analysis

### Type Identified
**Violation + Pattern**

### Key Information Extracted
- **What:** Wrong template used for internal feature (make-a-wish instead of feature-request)
- **Why:** Template confusion between "Make a Wish" (external) and "wish documents" (internal planning)
- **Where:** Issue creation process, github-workflow agent guidance
- **How:** Update template title prefix, fix issue #40, document standalone pattern

### Affected Files
- `.github/ISSUE_TEMPLATE/make-a-wish.yml`: Title prefix clarity
- `AGENTS.md`: Template pattern documentation
- `.genie/agents/core/github-workflow.md`: Template selection guidance
- Issue #40: Corrected from make-a-wish to feature-request format

---

## Changes Made

### File 1: `.github/ISSUE_TEMPLATE/make-a-wish.yml`

**Section:** Template metadata
**Edit type:** update

**Diff:**
```diff
- title: "[Wish] "
+ title: "[Make a Wish] "
```

**Reasoning:** Clear separation between external "Make a Wish" issues and internal "wish documents"

---

### File 2: `.genie/agents/core/github-workflow.md`

**Section:** Template documentation (line 72)
**Edit type:** update

**Diff:**
```diff
- **Title pattern:** `[Wish] <description>`
+ **Title pattern:** `[Make a Wish] <description>`
```

**Reasoning:** Match template file change, clarify naming

---

### File 3: `AGENTS.md`

**Section:** GitHub Workflow Integration (lines 83, 87)
**Edit type:** update

**Diff:**
```diff
- Make a Wish: `[Wish] <description>` (external user suggestions only)
+ Make a Wish: `[Make a Wish] <description>` (external user suggestions only)

- **✅ Right:** `[Bug]`, `[Feature]`, `[Wish]`
+ **✅ Right:** `[Bug]`, `[Feature]`, `[Make a Wish]`
```

**Reasoning:** Consistency with template naming change

---

### File 4: Issue #40

**Section:** Title and labels
**Edit type:** update (not close/reopen)

**Command:**
```bash
gh issue edit 40 \
  --title "Provider runtime override with intelligent fallbacks" \
  --add-label "type:enhancement,priority:high,area:cli,status:needs-review"
```

**Before:**
- Title: `[Wish] Provider runtime override with intelligent fallbacks`
- Labels: (none)

**After:**
- Title: `Provider runtime override with intelligent fallbacks`
- Labels: `type:enhancement`, `priority:high`, `area:cli`, `status:needs-review`

**Reasoning:** Convert to feature-request format, apply correct labels, remove make-a-wish prefix

---

## Pattern Documented: Standalone Work Items

**Discovery:** Not everything needs roadmap initiative linkage

**Pattern:**
1. **Roadmap-driven work:** Use planned-feature template (requires initiative number)
2. **Standalone work:** Use feature-request or bug-report (no initiative required)
3. **External suggestions:** Use make-a-wish (users only, not team/founder)

**When founder creates issue for internal feature:**
- ✅ Use feature-request template
- ✅ Add relevant labels (type:enhancement, priority, area)
- ✅ Reference wish document path in body
- ❌ Don't use make-a-wish (external only)
- ❌ Don't force into roadmap initiative if none exists

**Critical rule learned:**
- **Always update mistakes, NEVER close and reopen**
- Use `gh issue edit` to fix title, labels, body
- Preserve issue history and references

---

## Validation

### How to Verify
1. Check `.github/ISSUE_TEMPLATE/make-a-wish.yml` has `[Make a Wish]` prefix
2. Verify AGENTS.md and github-workflow.md reference `[Make a Wish]`
3. Confirm issue #40 has feature-request labels and corrected title
4. Test: Future internal features use feature-request, not make-a-wish
5. Test: External user issues use make-a-wish with `[Make a Wish]` prefix

### Follow-up Actions
- [ ] Monitor next 5 issues to ensure correct template usage
- [ ] Document in github-workflow.md: template selection decision tree
- [ ] Add example: "Founder creates feature → use feature-request"

---

## Evidence

### Before
**Issue #40:**
- Title: `[Wish] Provider runtime override with intelligent fallbacks`
- Template: make-a-wish (wrong)
- Labels: none
- Status: Created but mislabeled

**Templates:**
- make-a-wish prefix: `[Wish]` (confusing with internal wishes)

### After
**Issue #40:**
- Title: `Provider runtime override with intelligent fallbacks`
- Template: feature-request format
- Labels: `type:enhancement`, `priority:high`, `area:cli`, `status:needs-review`
- Status: Corrected via update (not close/reopen)

**Templates:**
- make-a-wish prefix: `[Make a Wish]` (clear external designation)

**Git diff:**
```bash
# Template file
- title: "[Wish] "
+ title: "[Make a Wish] "

# Documentation
- Make a Wish: `[Wish] <description>`
+ Make a Wish: `[Make a Wish] <description>`
```

---

## Meta-Notes

**Process observations:**
- Template naming matters: `[Wish]` vs `[Make a Wish]` caused confusion
- Standalone pattern needed: not everything fits roadmap initiatives
- Update-in-place is critical: never close/reopen issues
- Founder-initiated features are common, need clear template guidance

**Suggestions for improving learning mode:**
- Add template selection decision tree to github-workflow.md
- Create examples for each template use case
- Document "always update, never close/reopen" rule explicitly

**Pattern established:**
- Roadmap initiatives are for strategic, cross-cutting work
- Standalone features/bugs use standard templates without forcing roadmap linkage
- Make-a-wish is ONLY for external users, NOT team/founder

---

**Learning absorbed and propagated successfully.** 🧞📚✅
