# Commit Advisory – Template Selection Learning

**Generated:** 2025-10-13T18:35Z

## Snapshot

- **Branch:** main
- **Commit:** e7bafc7f037b4d23b064027aa6b26dcaf5061d53
- **Related wish:** Meta-learning / GitHub issue template usage
- **Related issues:** #40 (corrected), #41 (created)

## Changes by Domain

### Agent Documentation (2 files modified)
- `.genie/agents/core/git-workflow.md` (+49 lines)
  - Added "GitHub Issue Template Selection" section with decision tree
  - Includes template matrix, decision tree, key distinctions, and examples
  - Positioned before "Branch & Commit Conventions" for visibility

- `AGENTS.md` (+21 lines, -7 lines)
  - Replaced bullet-point template rules with visual decision tree
  - Added critical rules section with ⚠️ emoji markers for emphasis
  - Reinforces "NEVER use make-a-wish for internal work"

### Learning Reports (1 file created)
- `.genie/reports/01-template-selection-learn.md` (+342 lines)
  - Complete violation analysis and evidence capture
  - Before/after examples of Issue #40
  - Template selection decision tree documentation
  - Prevention checklist for future issue creations

## Recommended Commit Message (USED)

```
learn: add template selection matrix to prevent GitHub issue template confusion

- Add decision tree to git-workflow.md for choosing correct template
- Reinforce AGENTS.md template rules with visual emphasis (⚠️)
- Document violation: Issue #40 used Make a Wish instead of Planned Feature
- Capture learning report: template-selection-learn.md

Fixes: Recurring template misuse by git-workflow agent
Context: Issue #40 had wish document but used external user template
Prevention: Clear rules - Make a Wish ONLY for external users, Planned Feature when wish exists

Related: #40 (corrected), #41 (created)
```

## Pre-commit Gate Results

**Status:**
```
lint:       n/a (no linting configured)
type:       n/a (TypeScript not in scope)
tests:      n/a (documentation changes only)
docs:       ✅ PASS (documentation improvements)
changelog:  n/a (no changelog required)
security:   ✅ PASS (no security concerns)
formatting: ✅ PASS (markdown formatting correct)
```

**Blockers:** None

**Verdict:** ✅ READY (confidence: high)

## Validation Checklist

- [x] Documentation changes reviewed
- [x] Template distinctions clarified (Make a Wish vs Planned Feature vs Wish Document)
- [x] Decision tree added to both git-workflow.md and AGENTS.md
- [x] Learning report generated with complete violation capture
- [x] Issues normalized (#40 corrected, #41 created)
- [x] Markdown formatting verified
- [x] Commit created successfully
- [x] Working tree clean after commit

## Commit Statistics

```
3 files changed, 412 insertions(+), 7 deletions(-)
create mode 100644 .genie/reports/01-template-selection-learn.md
```

## Root Cause Analysis

**Violation:** git-workflow agent used "Make a Wish" template (external user format) for Issue #40, which had an existing wish document at `.genie/wishes/provider-runtime-override/`

**Contributing factors:**
1. Agent lacked explicit template selection guidance
2. Three "wish" concepts caused confusion:
   - "Make a Wish" GitHub issue template (external)
   - `/wish` Genie command (creates documents)
   - Wish documents (`.genie/wishes/<slug>/`)
3. No decision tree for template selection

**Solution implemented:**
1. Added template selection matrix to git-workflow.md
2. Reinforced rules in AGENTS.md with visual emphasis
3. Created learning report documenting violation and prevention

## Prevention Measures

**Future git-workflow agent behavior:**
- Will read template selection section before creating issues
- Will check if wish document exists: `test -d ".genie/wishes/<slug>"`
- Will use decision tree to select correct template
- Will NEVER use "Make a Wish" for internal work
- Will ALWAYS include wish document path in issue body when using Planned Feature template

**Validation command for agent:**
```bash
# Before creating issue, agent should run:
test -d ".genie/wishes/<slug>" && echo "Use planned-feature template" || echo "Use feature-request or bug-report"
```

## Risks & Follow-ups

**Risks:** None - documentation-only changes

**Follow-up actions:**
- [ ] Monitor next git-workflow agent issue creation (verify correct template usage)
- [ ] Validate with team that template distinctions are clear
- [ ] Consider adding template selection validation to CI/CD

## External Actions Completed

**Outside of git:**
1. Issue #40 edited via `gh issue edit` (corrected body to Planned Feature format)
   - Changed from Make a Wish fields to Planned Feature fields
   - Added roadmap initiative number: EXEC-PROVIDER
   - Added wish document link: `.genie/wishes/provider-runtime-override/`

2. Issue #41 created via `gh issue create` (tracking issue for core-template-separation)
   - Used Planned Feature template
   - Links to: `.genie/wishes/core-template-separation/`
   - URL: https://github.com/namastexlabs/automagik-genie/issues/41

## Notes

**Template name was already correct:** No rename needed - "Make a Wish" already sufficiently differentiated from "wish document". The problem was missing agent guidance, not template naming.

**Automation unchanged:** link-to-roadmap.yml workflow was already correct (only processes `planned-feature` labeled issues). We just needed to use the right template.

**Learning captured successfully:** Complete violation → analysis → fix → prevention cycle documented in learning report.

---

**Advisory complete. Commit successful.** ✅
