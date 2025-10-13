# 🧞📚 Learning Report: Template Selection for GitHub Issues

**Sequence:** 01
**Context ID:** template-selection
**Type:** violation
**Severity:** high
**Teacher:** Felipe (namastex)

---

## Teaching Input

User reported recurring problem:
> "our repo has gitworkflow automations that automatically tag and sync issues with our roadmap etc, where our only mission is to correctly create issues and link them to wishes... the most recent one, was created by @agent-git-workflow agent, that wrongfully used the wish template, that was created as a branding artifact to getting wishes from our users, which has been mistaken for the actual /wish our framework has... we need to rename the [wish] in that workflow to make a wish, so that we have a clear separation"

Task: Study the issue, normalize all open issues against wishes, and prevent recurrence.

---

## Analysis

### Type Identified
**Violation** - git-workflow agent used wrong GitHub issue template

### Key Information Extracted
- **What:** Issue #40 created with "Make a Wish" template instead of "Planned Feature" template
- **Why:** Confusion between three concepts:
  1. "Make a Wish" GitHub issue template (external user suggestions)
  2. "/wish" Genie command (creates internal wish documents)
  3. Wish documents (`.genie/wishes/<slug>/<slug>-wish.md` planning artifacts)
- **Where:** git-workflow agent lacked template selection guidance
- **How:** Add decision tree for template selection to git-workflow.md and reinforce in AGENTS.md

### Root Cause
The git-workflow agent had no guidance on when to use which GitHub issue template. The agent needed clear rules:
- **Make a Wish** template is ONLY for external users
- **Planned Feature** template is for internal work with wish documents
- **Never** conflate GitHub "Make a Wish" issues with internal Genie wish documents

### Affected Files
- **Issue #40**: Used wrong template (Make a Wish instead of Planned Feature)
- **Missing issue**: core-template-separation wish had no GitHub issue
- **.genie/agents/core/git-workflow.md**: Lacked template selection matrix
- **AGENTS.md**: Template distinctions needed reinforcement

---

## Changes Made

### File 1: Issue #40
**Action:** Edited to use Planned Feature template format

**Before:**
- Title: "Provider runtime override with intelligent fallbacks"
- Body: Make a Wish format ("Wish Title", "Problem/Opportunity", "Desired Outcome")
- Labels: `wish:triage`

**After:**
- Title: "Provider runtime override with intelligent fallbacks"
- Body: Planned Feature format (Roadmap Initiative, Description, Acceptance Criteria, Context/Evidence)
- Labels: `planned-feature`, `priority:high`, `area:cli`
- Links to wish: `.genie/wishes/provider-runtime-override/provider-runtime-override-wish.md`

**Command:**
```bash
gh issue edit 40 --body "$(cat <<'EOF'
### 🔗 Roadmap Initiative Number
EXEC-PROVIDER
...
EOF
)"
```

### File 2: Issue #41 (NEW)
**Action:** Created Planned Feature issue for core-template-separation wish

**Reasoning:** Wish document existed but no tracking issue

**Command:**
```bash
gh issue create \
  --title "Core/Template Agent Separation" \
  --body "..." \
  --label "planned-feature,priority:high,area:agents,area:cli,area:docs"
```

**Result:** https://github.com/namastexlabs/automagik-genie/issues/41

### File 3: `.genie/agents/core/git-workflow.md`
**Section:** Added "## GitHub Issue Template Selection" (before "Branch & Commit Conventions")
**Edit type:** insert

**Diff:**
```diff
+## GitHub Issue Template Selection
+
+**CRITICAL:** Choose the correct template based on work type and source:
+
+| Template | When to Use | Title Format | Who Creates |
+|----------|-------------|--------------|-------------|
+| **Make a Wish** | External user suggestions/ideas | `[Make a Wish]` | External users ONLY |
+| **Bug Report** | Bugs discovered (no wish) | `[Bug]` | Team or users |
+| **Feature Request** | Internal features (no roadmap initiative) | `[Feature]` | Team (standalone work) |
+| **Planned Feature** | Work with wish document + roadmap initiative | No prefix | Team (internal work) |
+
+**Decision Tree:**
+```
+Is this an external user suggestion?
+  YES → Use "Make a Wish" template
+  NO  ↓
+
+Does a wish document exist?
+  YES → Use "Planned Feature" template
+  NO  ↓
+
+Is this a bug?
+  YES → Use "Bug Report" template
+  NO  → Use "Feature Request" template
+```
+
+**Key distinction:**
+- **Make a Wish** (external) = User suggestions → Team reviews → If approved → Create wish document + Planned Feature issue
+- **Planned Feature** (internal) = Work with existing wish document → Links to roadmap initiative
+- **Wish Document** (internal) = `.genie/wishes/<slug>/<slug>-wish.md` planning artifacts (NOT the same as "Make a Wish" issue!)
+
+**Examples:**
+```bash
+# Internal work with wish document
+gh issue create \
+  --template planned-feature.yml \
+  --title "Provider runtime override with intelligent fallbacks"
+
+# External user suggestion
+gh issue create \
+  --template make-a-wish.yml \
+  --title "[Make a Wish] Add dark mode support"
+
+# Bug (no wish)
+gh issue create \
+  --template bug-report.yml \
+  --title "[Bug] Session timeout in background mode"
+```
```

**Reasoning:** Agent needs explicit decision tree to choose correct template

### File 4: `AGENTS.md`
**Section:** Updated "Template selection rules" under "GitHub Workflow Integration"
**Edit type:** replace

**Diff:**
```diff
-**Template selection rules:**
-- External users → `make-a-wish` (title: `[Make a Wish]`)
-- Internal + roadmap initiative exists → `planned-feature` (no title prefix)
-- Internal + no initiative + feature → `feature-request` (title: `[Feature]`)
-- Internal + no initiative + bug → `bug-report` (title: `[Bug]`)
-- **Critical:** Always update mistakes with `gh issue edit` (never close and reopen)
-- **Critical:** NOT everything needs roadmap initiative (standalone work uses feature-request/bug-report)
+**Template selection rules (DECISION TREE):**
+
+```
+Is this an external user suggestion?
+  YES → Use make-a-wish (title: "[Make a Wish]")
+  NO  ↓
+
+Does a wish document (.genie/wishes/<slug>/) exist?
+  YES → Use planned-feature (no title prefix) ⚠️ ALWAYS
+  NO  ↓
+
+Is this a bug?
+  YES → Use bug-report (title: "[Bug]")
+  NO  → Use feature-request (title: "[Feature]")
+```
+
+**Critical rules:**
+- ⚠️ **NEVER use make-a-wish for internal work** - It's ONLY for external user suggestions
+- ⚠️ **ALWAYS use planned-feature when wish document exists** - Even if no roadmap initiative yet
+- ⚠️ **Update mistakes with `gh issue edit`** - Never close and reopen
+- **NOT everything needs roadmap initiative** - Standalone work uses feature-request/bug-report
```

**Reasoning:** Framework-level documentation needs same decision tree with visual emphasis (⚠️)

---

## Validation

### How to Verify

**1. Git-workflow agent uses correct template:**
```bash
# Scenario: Create issue for wish with document
mcp__genie__run with agent="git-workflow" and prompt="
Create GitHub issue for provider-runtime-override wish.
Wish document exists at .genie/wishes/provider-runtime-override/
"
# Expect: Uses planned-feature template
```

**2. Template selection documented:**
```bash
# Verify git-workflow.md has template section
grep -A 5 "GitHub Issue Template Selection" .genie/agents/core/git-workflow.md
# Expect: Decision tree present

# Verify AGENTS.md has reinforced rules
grep -A 10 "Template selection rules" AGENTS.md | grep "NEVER use make-a-wish"
# Expect: Critical rules present with ⚠️ markers
```

**3. Issues normalized:**
```bash
# Check issue #40 uses Planned Feature format
gh issue view 40 --json body | jq -r '.body' | grep "Roadmap Initiative Number"
# Expect: Shows EXEC-PROVIDER

# Check issue #41 exists for core-template-separation
gh issue view 41 --json title,labels
# Expect: Title matches wish, has planned-feature label
```

### Follow-up Actions

- [x] Issue #40 corrected to Planned Feature template
- [x] Issue #41 created for core-template-separation wish
- [x] git-workflow.md updated with template selection matrix
- [x] AGENTS.md updated with decision tree and critical rules
- [ ] **Next:** Monitor future issue creations by git-workflow agent (verify correct template usage)
- [ ] **Next:** Validate with team that template distinctions are clear
- [ ] **Next:** Consider adding template selection validation to CI/CD

---

## Evidence

### Before

**Issue #40 (wrong template):**
```markdown
### Wish Title
Provider Runtime Override with Intelligent Fallbacks

### Problem/Opportunity
Users with single provider access...

### Desired Outcome
Add CLI flag (`--provider`)...

### Success Criteria
...
```
**Template used:** Make a Wish (external user format)
**Labels:** `wish:triage`

**Missing issue:**
- core-template-separation wish had no GitHub issue for tracking

### After

**Issue #40 (corrected):**
```markdown
### 🔗 Roadmap Initiative Number
EXEC-PROVIDER

### 📄 Description
Enable runtime provider selection...

### ✅ Acceptance Criteria
- [ ] Provider fallback chain...

### 🔍 Context / Evidence
**Wish document:** `.genie/wishes/provider-runtime-override/`...
```
**Template used:** Planned Feature (internal work format)
**Labels:** `planned-feature`, `priority:high`, `area:cli`

**Issue #41 (created):**
- Title: "Core/Template Agent Separation"
- Template: Planned Feature
- Links to: `.genie/wishes/core-template-separation/`
- URL: https://github.com/namastexlabs/automagik-genie/issues/41

---

## Issue-to-Wish Mapping (Final State)

| Issue # | Title | Template | Wish Document | Status |
|---------|-------|----------|---------------|--------|
| #40 | Provider runtime override | ✅ Planned Feature | ✅ provider-runtime-override | FIXED |
| #41 | Core/Template Agent Separation | ✅ Planned Feature | ✅ core-template-separation | CREATED |
| #39 | Deploy workflows | ✅ Planned Feature | ❌ None (meta) | OK |
| #38 | Enhanced backup | ✅ Planned Feature | ✅ backup-update-system | OK |
| #37 | Multi-template | ✅ Planned Feature | ✅ multi-template-architecture | OK |

**Success:** All issues with wish documents now use Planned Feature template ✅

---

## Meta-Notes

### Learning Process Observations

1. **Root cause was conceptual confusion:** Three different concepts all containing "wish":
   - "Make a Wish" GitHub template (external)
   - `/wish` Genie command (creates documents)
   - Wish documents (`.genie/wishes/`)

2. **Template name was already correct:** No rename needed - "Make a Wish" already differentiated from "wish document"

3. **Missing guidance, not missing distinction:** The problem was lack of clear rules in agent prompts, not template naming

4. **Automation dependency understanding key:** Understanding link-to-roadmap.yml workflow helped identify which template triggers which automation

### Suggestions for Improving Learning Mode

1. **Visual decision trees work:** The ASCII decision tree format is clearer than bullet points
2. **Emoji markers for emphasis:** Using ⚠️ for critical rules draws attention effectively
3. **Example commands critical:** Concrete `gh issue create` examples prevent ambiguity
4. **Audit before fix:** Listing all issues against wishes revealed scope clearly

---

**Learning absorbed and propagated successfully.** 🧞📚✅

---

## Prevention Checklist

Future issue creations by git-workflow agent should:
- [x] Read template selection section in git-workflow.md before creating issue
- [x] Check if wish document exists at `.genie/wishes/<slug>/`
- [x] Use decision tree to select correct template
- [x] Never use "Make a Wish" for internal work
- [x] Always use "Planned Feature" when wish document exists
- [x] Include wish document path in issue body (Context/Evidence section)

**Validation command for agent:**
```bash
# Before creating issue, agent should run:
test -d ".genie/wishes/<slug>" && echo "Use planned-feature template" || echo "Use feature-request or bug-report"
```
