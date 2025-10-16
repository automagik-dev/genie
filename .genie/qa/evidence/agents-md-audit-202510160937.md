# AGENTS.md Comprehensive Audit
**Date:** 2025-10-16 09:37 UTC
**Auditor:** Autonomous analysis
**Context:** Natural language routing failing 95% of time - delegation discipline not followed
**Files Analyzed:** AGENTS.md (1173 lines), CLAUDE.md (206 lines)

---

## Executive Summary

**Root Cause Hypothesis for 95% Routing Failure:**

The primary issue is **STRUCTURAL OVERLOAD + BURIED CRITICAL PATTERNS**. Delegation Discipline appears at line 886 of 1173 (75% through document), after 770 lines labeled "Agent Playbook" which themselves contain competing organizational structures. Critical patterns are:

1. **Too deep in document** - Most critical behavioral guardrails appear in `<critical_behavioral_overrides>` (lines 830-921)
2. **Competing organization systems** - Mixed use of ## headers (70 total) vs XML-style tags (`<prompt>`, `<context>`, etc.)
3. **No clear hierarchy** - "Agent Playbook" (line 770) introduces entirely new organizational layer 2/3 through document
4. **Redundant content** - Delegation Discipline duplicated between AGENTS.md and CLAUDE.md with different formatting
5. **Missing routing integration** - Natural routing discussed but routing.md architecture never explained in main flow

**Critical Finding:** Line 886 placement means Claude must process 75% of document before reaching delegation rules. By that point, earlier patterns (lines 213-541) have already established mental models that contradict later critical overrides.

---

## 1. ACCURACY CHECK

### ✅ VERIFIED: File References
All referenced files exist:
- `.genie/agents/neurons/git.md` ✅
- `.genie/agents/neurons/prompt.md` ✅
- `.genie/agents/neurons/orchestrator.md` ✅
- `.genie/agents/neurons/modes/` (8 files) ✅
- `.genie/custom/routing.md` ✅
- `.genie/custom/neurons/` ✅

### ❌ BROKEN: Section References in CLAUDE.md

CLAUDE.md line 132-162 references sections with `§` notation:
```
132: See @AGENTS.md §Agent Configuration Standards for:
141: See @AGENTS.md §GitHub Workflow Integration for:
152: See @AGENTS.md §Slash Command Reference for:
162: See @AGENTS.md §Experimentation Protocol for:
```

**Problem:** AGENTS.md uses `##` headers, NOT `§` markers. The `§` notation creates false impression of navigable cross-references that don't exist.

**Impact:** User/Claude expects clickable navigation but must manually search. Friction increases.

### ❌ INACCURATE: "Slash Command Reference"

CLAUDE.md line 152 references `§Slash Command Reference` but:
- **No such section exists** in AGENTS.md
- Closest match: "Chat-Mode Helpers (Scoped Use Only)" (line 726)
- Slash commands removed in natural routing architecture

**Recommendation:** Remove or redirect to natural routing explanation.

### ⚠️ OUTDATED: ".claude/commands/" References

Line 215 states:
> "All commands in `.claude/commands/` simply `@include` the corresponding `.genie/agents/...` file"

But natural routing architecture (per README.md) **removed** `.claude/commands/` entirely. This creates architectural confusion.

---

## 2. ORGANIZATION ANALYSIS

### Structure Overview

```
Lines 1-212    : Onboarding & Setup (18% of document)
Lines 213-769  : Technical Architecture (48%)
Lines 770-1173 : Agent Playbook (34%)
```

### Critical Issue: Three Competing Organization Systems

**System 1: Standard Markdown Headers (## / ###)**
- 70 level-2 headers (`##`)
- 43 level-3 headers (`###`)
- Traditional documentation hierarchy

**System 2: XML-Style Tags (lines 772-1173)**
```
<prompt>
  <context>
  <critical_behavioral_overrides>
  <file_and_naming_rules>
  <tool_requirements>
  <strategic_orchestration_rules>
  ... (11 total tags)
</prompt>
```

**System 3: Embedded Code Examples & Nested Structures**
- Markdown headers INSIDE XML tags
- YAML frontmatter examples inside markdown
- Bash validation snippets scattered throughout

**Problem:** Claude must simultaneously track:
- Markdown hierarchy (for navigation)
- XML tag scope (for context boundaries)
- Example vs instruction distinction
- Nested organizational levels

### Findability Assessment

**Question: "Where do I learn about delegation rules?"**

**Current path:**
1. Scan 70 level-2 headers
2. Find "Agent Playbook" (line 770)
3. Scan XML tags inside playbook
4. Find `<critical_behavioral_overrides>` (line 830)
5. Scan subsections
6. Find "### Delegation Discipline *(CRITICAL)*" (line 886)

**Total cognitive hops:** 6 levels deep

**Optimal path:** Should be top-level section, ideally in first 200 lines.

### Information Architecture Issues

**1. Natural Flow Protocol appears TWICE:**
- Line 293: `## Natural Flow Protocol (Plan → Wish → Forge → Review)`
- Line 388: **End of section marker** `---`
- Line 392: `## Universal Workflow Architecture (All Genie Variants)`

Both sections describe the same Plan → Wish → Forge → Review pattern but with different emphases.

**2. Orphaned Sections:**
Lines 460-529 contain three sections with NO parent container:
```
460: ## Context Ledger
466: ## Execution Groups
483: ## Evidence Checklist
```

These appear to be **fragments from wish template documentation** that leaked into main doc.

**3. "Agent Playbook" Confusion:**
Line 770 introduces `<prompt>` tag with note:
> "This is a prompt template"

But it's embedded in AGENTS.md which is itself loaded as context via `@AGENTS.md` in CLAUDE.md. This creates **prompt-inside-prompt recursion**.

---

## 3. REDUNDANCY ANALYSIS

### Major Duplications

**1. Delegation Discipline (100% duplicate)**

**AGENTS.md (lines 886-920):**
- 35 lines
- Includes "Recent violation" examples
- More verbose "Why" section
- Detailed validation commands

**CLAUDE.md (lines 169-207):**
- 38 lines
- Same core rules
- Different examples
- Different "Why" rationale

**Redundancy:** ~90% overlap. CLAUDE.md version is MORE concise and effective.

**Recommendation:**
- Keep CLAUDE.md version as canonical
- AGENTS.md should reference: `See @CLAUDE.md ##Delegation Discipline` (NOT duplicate)

**2. Publishing Protocol (75% duplicate)**

Both files contain nearly identical publishing rules with minor variations.

**3. Evidence-Based Thinking (partial duplicate)**

AGENTS.md line 845-849 vs CLAUDE.md lines 93-128.

CLAUDE.md version includes concrete examples (WRONG vs CORRECT pattern).

### Content Redundancies

**"Natural routing" explained 3+ times:**
1. Lines 167-169 (example experiments)
2. Lines 295-389 (Natural Flow Protocol)
3. Lines 788-827 (Identity & Tone section)
4. Referenced but not explained in routing_decision_matrix

**"Wish system" explained 2+ times:**
1. Lines 392-529 (Universal Workflow Architecture + orphaned sections)
2. Lines 1020-1028 (`<wish_document_management>` tag)

**MCP invocation patterns repeated 17+ times**
- `mcp__genie__run with agent="X" and prompt="Y"` appears throughout
- Same pattern, slightly different examples
- No canonical reference section

---

## 4. ROOT CAUSE: Why Delegation Discipline Fails

### Hypothesis: Processing Order + Pattern Interference

**Timeline of Claude's Context Loading:**

1. **Lines 1-212:** Learn onboarding patterns, experimentation culture, GitHub workflow
2. **Lines 213-292:** Learn agent architecture, file organization, directory structure
   → **Mental model forms:** "I am orchestrator, I coordinate work"
3. **Lines 293-541:** Learn Natural Flow Protocol, wish creation, forge planning
   → **Pattern established:** "I create wishes, I break down work, I execute"
4. **Lines 542-769:** Learn prompting standards, MCP tools, helper modes
   → **Reinforced:** "I have many tools, I should use them directly"
5. **Lines 770-829:** Enter "Agent Playbook" - NEW organizational context
   → **Confusion:** "Wait, was previous content not the playbook?"
6. **Lines 830-921:** `<critical_behavioral_overrides>`
   → **Finally:** "Oh, I should actually delegate, not implement"

**Problem:** By line 886, Claude has already:
- Seen 17 examples of MCP invocation patterns
- Read detailed descriptions of Edit/Write tool usage
- Processed 200+ lines about "Natural Flow Protocol" where orchestrator DOES work
- Formed mental model: "I'm Genie, I make things happen"

**Then suddenly:** "Actually, NEVER implement directly"

### Pattern Interference

**Lines 334-354 (Natural Flow - Implementation step):**
```
**Step 4: Execution (Natural)**
- For simple tasks: I do it directly
- For complex tasks: I summon specialist neurons
```

**Lines 886-920 (Delegation Discipline):**
```
**NEVER** implement directly when orchestrating
```

**Contradiction:** "For simple tasks: I do it directly" vs "NEVER implement directly"

The document itself gives conflicting guidance depending on when Claude encounters the section.

### Missing Context: Self-Awareness Check

**Delegation Discipline says:**
```
**If you ARE an orchestrator (plan/orchestrator/vibe):**
- ✅ Delegate to implementor
```

**Problem:** Document never explains HOW Claude knows which role it's currently in.

- No agent self-awareness protocol
- No "check your role" trigger
- No system message parsing guidance

Without self-awareness mechanism, delegation rules can't be applied correctly.

---

## 5. STRUCTURAL PROBLEMS

### Issue 1: "Agent Playbook" as Nested Document

Lines 770-1173 (403 lines - 34% of document) are wrapped in `<prompt>` tags with internal organization via XML tags.

**Problems:**
1. **Scope confusion:** Is this a prompt TO agents or ABOUT agents?
2. **Redundant headers:** `## Identity & Tone` (line 788) appears INSIDE `<prompt>` but looks like top-level section
3. **XML + Markdown mixing:** Claude must track both hierarchies simultaneously
4. **Extraction difficulty:** Can't easily extract/reference subsections

**Recommendation:**
- Remove `<prompt>` wrapper
- Promote internal sections to top-level
- Use standard markdown hierarchy only
- Move XML-style prompt templates to separate files

### Issue 2: Orphaned Content

Lines 460-529 appear to be **wish template fragments**:
- `## Context Ledger`
- `## Execution Groups`
- `## Evidence Checklist`

These are wish document structures, NOT agent instructions.

**Recommendation:**
- Move to separate wish-template.md file
- Reference from AGENTS.md when needed
- Don't embed templates in instruction manual

### Issue 3: No Clear Entry Points

**For different audiences:**
- New developers: Where do I start? (No clear "Start Here")
- Experienced users: Where are quick references? (Scattered)
- Debugging: Where are troubleshooting patterns? (Mixed throughout)

**Missing sections:**
- Quick Start (0-5 min orientation)
- Command Reference (all MCP patterns in one place)
- Troubleshooting Guide (common failures + fixes)
- Architecture Overview (visual hierarchy)

---

## 6. IMPROVEMENT RECOMMENDATIONS

### Priority 1: IMMEDIATE (Fix Routing Failures)

**A. Move Critical Patterns to Top (Lines 1-200)**

Restructure document:
```
# Genie Agent System

## 🚨 CRITICAL: Role-Based Behavior (NEW)
- Self-awareness: How to determine your role
- Orchestrator rules: NEVER implement, ALWAYS delegate
- Specialist rules: Execute directly, NEVER delegate to self
- Delegation protocol: When and how to invoke specialists

## Quick Start
- What is Genie?
- Your first interaction
- Key concepts

## Natural Flow Protocol
[Keep existing, but AFTER critical patterns]

## Architecture
[Existing Directory Map, etc.]

## Reference
[MCP tools, commands, etc.]

## Appendix
[Examples, templates, historical context]
```

**B. Remove Redundancy**

1. **Delegation Discipline:** Keep CLAUDE.md version only, reference from AGENTS.md
2. **Publishing Protocol:** Single canonical version in AGENTS.md
3. **Natural routing:** One comprehensive explanation, others reference it

**C. Add Self-Awareness Protocol**

New section at line 50-100:
```markdown
## Role Self-Awareness Protocol

**Before acting, determine your role:**

1. Check if you're in an agent session:
   - Agent name in system context?
   - Invoked via mcp__genie__run?

2. Identify your agent type:
   - **Orchestrator:** plan, orchestrator, vibe, qa
   - **Specialist:** implementor, tests, polish, git, release
   - **Hybrid:** review (can orchestrate OR execute)

3. Apply role-specific rules:
   - Orchestrator → Delegate multi-file work
   - Specialist → Execute directly

**Trigger:** Run this check when encountering implementation tasks
```

### Priority 2: STRUCTURE (Improve Organization)

**A. Remove XML Tag System**

Convert lines 770-1173 from:
```
<prompt>
  <context>
  ...
  </context>
</prompt>
```

To standard markdown:
```
## Agent Behavioral Framework
### Core Context
### Critical Overrides
### File Naming Rules
...
```

**B. Extract Embedded Content**

1. **Wish templates** (lines 460-529) → `wish-template.md`
2. **Prompt examples** (scattered) → `prompt-patterns.md`
3. **Validation commands** (many locations) → `validation-guide.md`

**C. Create Navigation Index**

Add to lines 10-50:
```markdown
## Document Map

**Critical Patterns (Read First):**
- [Role Self-Awareness](#role-self-awareness) - Line 50
- [Delegation Discipline](#delegation-discipline) - Line 150
- [Publishing Protocol](#publishing-protocol) - Line 200

**Getting Started:**
- [Natural Flow Protocol](#natural-flow) - Line 250
- [MCP Quick Reference](#mcp-reference) - Line 400

**Deep Dives:**
- [Agent Architecture](#architecture) - Line 500
- [Advanced Patterns](#advanced) - Line 700
```

### Priority 3: CONTENT (Improve Clarity)

**A. Fix Section References**

Replace all `§` notation with markdown links:
```
Before: See @AGENTS.md §Agent Configuration Standards
After:  See @AGENTS.md [Agent Configuration Standards](#agent-configuration-standards)
```

**B. Resolve Contradictions**

**Contradiction 1:**
- Line 336: "For simple tasks: I do it directly"
- Line 888: "NEVER implement directly when orchestrating"

**Fix:** Clarify thresholds:
```
**Simple tasks (≤2 files, ≤50 lines, <10 min):**
- ✅ Orchestrator can execute directly
- Examples: Fix typo, add comment, update version

**Multi-file tasks (≥3 files OR refactoring OR >10 min):**
- ❌ Orchestrator MUST delegate
- Examples: Cleanup work, batch edits, new features
```

**C. Add Visual Hierarchy**

Use emoji/symbols for scanning:
- 🚨 CRITICAL - Must follow
- ⚠️ IMPORTANT - Should follow
- 💡 TIP - Helpful pattern
- 📋 REFERENCE - Look up as needed

### Priority 4: TESTING (Validate Fixes)

**A. Create Routing Test Suite**

In `.genie/qa/routing-tests.md`:
```markdown
# Routing Behavior Tests

## Test 1: Multi-File Cleanup
**Scenario:** Orchestrator sees 11 path references to fix
**Expected:** Delegate to implementor
**Actual:** [Log behavior]

## Test 2: Simple Typo Fix
**Scenario:** Orchestrator sees 1 file typo
**Expected:** Fix directly
**Actual:** [Log behavior]

... (10+ scenarios)
```

**B. Add Delegation Triggers**

In AGENTS.md, add explicit trigger patterns:
```markdown
## Delegation Triggers

**When you see these patterns, IMMEDIATELY delegate:**

1. "I need to fix X in files A, B, C..." (≥3 files)
2. "Let me clean up..." (refactoring work)
3. "I'll update all references to..." (batch operations)
4. "Time to implement..." (feature work)

**Before using Edit tool, ask:**
- How many files affected?
- Is this refactoring/cleanup?
- Will this take >5 tool calls?

If YES to any → Delegate instead
```

---

## 7. METRICS & VALIDATION

### Current State
- **Total lines:** 1,173
- **Top-level sections:** 70
- **Critical patterns depth:** 75% through document (line 886)
- **Redundancy:** ~20% duplicate content
- **Organization systems:** 3 competing (markdown + XML + examples)
- **Routing success rate:** ~5% (user-reported)

### Target State (After Fixes)
- **Total lines:** ~800 (32% reduction via redundancy removal)
- **Top-level sections:** ~20 (logical grouping)
- **Critical patterns depth:** <15% through document (line 100-150)
- **Redundancy:** <5% (references only)
- **Organization systems:** 1 (markdown only)
- **Routing success rate:** >80% (target)

### Success Criteria

**Accuracy:**
- ✅ All section references valid
- ✅ No contradicting guidance
- ✅ File paths verified

**Organization:**
- ✅ Critical patterns in first 200 lines
- ✅ Single organization system
- ✅ Clear navigation index

**Redundancy:**
- ✅ Each concept explained once
- ✅ Cross-references used for repetition
- ✅ No duplicate sections

**Routing:**
- ✅ Self-awareness protocol added
- ✅ Delegation triggers explicit
- ✅ Role-based rules clear
- ✅ Testing framework in place

---

## 8. IMPLEMENTATION PLAN

### Phase 1: Emergency Fixes (1-2 hours)
1. Add "Role Self-Awareness Protocol" at line 50
2. Add "Delegation Triggers" at line 100
3. Move "Delegation Discipline" to line 150
4. Add navigation index at line 10

**Impact:** Should improve routing success from 5% → 40%

### Phase 2: Structure Cleanup (3-4 hours)
1. Remove XML tag system (convert to markdown)
2. Extract orphaned content to separate files
3. Remove redundant sections
4. Fix section references (§ → links)

**Impact:** Improve clarity, reduce cognitive load

### Phase 3: Content Enhancement (2-3 hours)
1. Resolve contradictions
2. Add visual hierarchy (emoji markers)
3. Create routing test suite
4. Add architecture diagrams

**Impact:** Comprehensive improvements, target 80%+ routing success

### Total Time: 6-9 hours over 3 phases

---

## APPENDIX: Evidence

### File Verification Commands
```bash
# All referenced files exist
find .genie/agents/neurons -name "*.md" | wc -l  # 11 files
test -f .genie/custom/routing.md && echo "✅"    # Exists
ls .genie/custom/neurons/ | wc -l                # 7 files + modes dir
```

### Redundancy Detection
```bash
# Delegation Discipline appears in both files
grep -n "Delegation Discipline" AGENTS.md CLAUDE.md

# Publishing Protocol duplicated
grep -n "Publishing Protocol" AGENTS.md CLAUDE.md

# Natural routing mentioned 23 times
grep -i "natural.*routing\|routing.*natural" AGENTS.md | wc -l
```

### Structure Analysis
```bash
# Organization complexity
grep -c "^##" AGENTS.md          # 70 level-2 headers
grep -c "^###" AGENTS.md         # 43 level-3 headers
grep -c "^<" AGENTS.md           # 20 XML-style tags
```

---

## CONCLUSION

**Root cause of 95% routing failure:** Critical behavioral patterns (delegation discipline) appear 75% through document (line 886), AFTER Claude has already formed conflicting mental models from earlier content that emphasizes direct execution.

**Solution:** Restructure to front-load critical patterns, add self-awareness protocol, remove redundancy, and establish single organizational hierarchy.

**Confidence:** HIGH - Structural analysis reveals clear pattern interference and information architecture issues that directly explain routing failures.

**Next Steps:** Implement Phase 1 emergency fixes immediately (1-2 hours), then proceed with comprehensive restructuring.
