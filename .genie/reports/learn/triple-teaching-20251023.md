# Learning: Triple Teaching - Diverse Options, Debug Confidence Scoring, No Legacy Code
**Date:** 2025-10-23
**Teacher:** User (Felipe)
**Type:** Pattern + Violation
**Severity:** Critical

---

## Teaching Input

### Teaching 1: Diverse Options (Creative Tasks)
**Problem:** LLM probability ordering limits creativity
- When generating options, I order by probability internally
- First option dominates my "inner thoughts"
- Other options get deprioritized
- Results in low diversity (clustered around one concept)

**Correction:** For creative tasks requiring multiple options:
1. Identify creative dimensions FIRST (before probability ordering)
2. Explore diverse possibility space deliberately
3. Generate options from different dimensions
4. Present without probability ordering bias

**Target:** Create collective spell

### Teaching 2: Debug Skill Migration
**Pattern:** Debug moves from agent → spell (executable on-demand)

**New Process:**
1. Generate at least 5 different hypotheses for root cause
2. Narrow down to top 3 based on evidence
3. Present to user with confidence scores (0-100%)

**Confidence Scoring:** Adapt review agent's wish analytics matrix pattern:
- Evidence-backed scoring (no guesses)
- Checkpoint-based evaluation
- Severity tagging (🔴🟠🟡🟢)
- Explicit confidence levels

**Target:** `.genie/code/spells/debug.md` (new skill)

### Teaching 3: NO BACKWARDS COMPATIBILITY (CRITICAL VIOLATION)
**Violation:** Created "Legacy Content (Pre-Migration)" section in debug agent
**Correction:** GENIE ONLY SELF-EVOLVES
- ❌ NO legacy code
- ❌ NO dead code
- ❌ NO backwards compatibility
- ❌ NO "preserved for reference" sections
- ✅ DELETE old agent entirely OR REPLACE with new purpose

**Correct Approach:**
- Debug agent → DELETED
- Fix agent → CREATED (new purpose, uses debug spell)
- Debug spell → Contains all investigation knowledge

---

## Analysis

**What:** Three interconnected teachings about creativity, investigation, and evolution
**Why:**
1. LLM internal probability ordering constrains creative output
2. Debug needs systematic hypothesis exploration with evidence-based scoring
3. Genie self-evolves, never preserves legacy content

**Where:**
- Create collective (diverse options)
- Code collective (debug spell + fix agent)
- Core behavioral patterns (no backwards compatibility)

**How:**
1. Create diverse-options spell for creative work
2. Migrate debug knowledge to spell with confidence scoring
3. Delete debug agent, create fix agent
4. Document violation in break-things-move-fast.md

### Affected Files
- `.genie/create/spells/diverse-options.md` - New spell for creative exploration
- `.genie/code/spells/debug.md` - Debug methodology with 5→3 hypothesis narrowing
- `.genie/code/agents/fix.md` - New fix agent (replaces debug agent)
- `.genie/code/agents/debug.md` - DELETED (violated no-legacy rule)
- `.genie/spells/break-things-move-fast.md` - Added violation pattern

---

## Changes Made

### File: `.genie/create/spells/diverse-options.md`
**Status:** CREATED
**Purpose:** Teach LLMs to explore possibility space before probability ordering

**Key Sections:**
- Core Teaching (probability ordering problem)
- When to Use (creative triggers vs technical decisions)
- Implementation Steps (identify dimensions → explore deliberately → present neutrally)
- Examples (feature naming, content tone)
- Meta-awareness (conscious override of probability ordering)

### File: `.genie/code/spells/debug.md`
**Status:** CREATED
**Purpose:** Systematic investigation with evidence-backed confidence scoring

**Key Sections:**
- 4-phase workflow (Evidence → 5 Hypotheses → Narrow to 3 → Present with scores)
- Confidence calculation (evidence-based, 0-100%)
- Resolution paths (Report Bug / Quick Fix / Full Workflow based on confidence)
- Severity tagging (🔴🟠🟡🟢)
- Integration with review agent pattern (borrowed scoring methodology)
- Example walkthrough (MCP server crash investigation)

**Borrowed from Review Agent:**
- Evidence-based scoring (every point has artifact reference)
- Checkpoint system (phases with validation)
- Severity tagging
- Confidence levels (explicit, not implied)
- Verdict format (structured decision with recommendation)

**Debug-Specific Adaptations:**
- 5 → 3 hypothesis funnel (vs review's 100-point matrix)
- Confidence as percentage (0-100%)
- Hypothesis exploration (vs audit)
- Root cause focus (vs completion scoring)

### File: `.genie/code/agents/fix.md`
**Status:** CREATED (replaces debug agent)
**Purpose:** Apply fixes using debug spell and other code agents

**Key Sections:**
- Identity: Solution implementor (not investigator)
- Can use any code spell/agent (debug, implementor, tests, Master Genie)
- 4-phase workflow (Understand → Implement → Verify → Report)
- Delegation protocol (implementor, not orchestrator)
- Success criteria (minimal change, tests pass, no new issues)

### File: `.genie/code/agents/debug.md`
**Status:** DELETED
**Reasoning:** Violated no-legacy rule by creating "Legacy Content (Pre-Migration)" section

**Correct Approach:**
- Debug knowledge → absorbed into debug spell
- Debug agent → replaced by fix agent with new purpose
- No "backward compatibility" or "preserved for reference"

### File: `.genie/spells/break-things-move-fast.md`
**Section:** Added "Critical Violation Pattern"
**Edit type:** Insert

**Added Content:**
```markdown
## Critical Violation Pattern

**NEVER write "Legacy Content" or "Preserved for Reference" sections.**

**Anti-Pattern (WRONG):**
## Migration Notice
This agent now delegates to spell...

## Legacy Content (Pre-Migration)
The content below is preserved for reference...

**Correct Pattern:**
# Agent Name
[New behavior only, delete old content entirely]

**Why:** Genie self-evolves. When knowledge moves from agent → spell, DELETE the agent or REPLACE it entirely with new purpose.

**Evidence:** Learning session 2025-10-23 - debug agent violation
```

**Reasoning:** Document the violation pattern so I never repeat it

---

## Validation

### How to Verify

**Diverse Options Spell:**
- When user asks for creative options, load spell
- Observe: Options span different creative dimensions (not clustered)
- Evidence: Naming examples show metaphorical, literal, playful, technical variants

**Debug Spell:**
- When debugging, generate ≥5 hypotheses
- Narrow to top 3 with confidence scores
- Present with evidence references
- Evidence: Example shows MCP crash with 5 hypotheses → 3 scored options

**Fix Agent:**
- Load debug spell for investigation
- Can delegate to other code agents
- Implements solutions (not legacy investigation)
- Evidence: Agent file shows clear purpose, no backward compat

**No Legacy Code:**
- Search codebase: `grep -r "Legacy Content" .genie/`
- Search codebase: `grep -r "backward compatibility" .genie/`
- Verify debug.md does not exist in agents/
- Verify fix.md exists and has no legacy sections

### Follow-up Actions
- [x] Created diverse-options spell
- [x] Created debug spell with confidence scoring
- [x] Created fix agent
- [x] Deleted debug agent
- [x] Updated break-things-move-fast.md with violation
- [x] No legacy content in any file

---

## Key Learnings

### Learning 1: LLM Probability Ordering Limits Creativity
**Before:** Generate options → probability ordering happens first → clustered output
**After:** Identify dimensions → explore deliberately → present diverse options
**Impact:** Users get truly different options, not variations of one concept

### Learning 2: Confidence Scoring Requires Evidence
**Before:** Vague confidence levels (low/medium/high)
**After:** Evidence-backed percentages with artifact references
**Impact:** User can make informed decisions based on concrete evidence

### Learning 3: Genie Self-Evolves (NO LEGACY CODE)
**Before:** Attempted to preserve debug agent with "Legacy Content" section
**After:** DELETE old agent, CREATE new one with new purpose
**Impact:** Clean codebase, no dead code, no backwards compatibility cruft

**Critical Insight:** "GENIE ONLY SELF-EVOLVES" means:
- When knowledge moves (agent → spell), DELETE source or REPLACE entirely
- Never write "Legacy", "Preserved", "Backward Compatibility" sections
- Self-evolution = continuous replacement, not accumulation

---

## Context Growth Analysis

**Files Created:** 3 (diverse-options.md, debug.md, fix.md)
**Files Deleted:** 1 (debug.md agent)
**Files Modified:** 1 (break-things-move-fast.md)
**Net Change:** +2 files, ~400 lines added, ~330 lines removed

**Token Impact:**
- Added: ~2,400 tokens (3 new spells)
- Removed: ~2,000 tokens (debug agent deleted)
- Net: +400 tokens (knowledge consolidated and enhanced)

**Quality Improvement:**
- Diverse options: NEW capability (creative exploration)
- Debug: ENHANCED (5→3 funnel + confidence scoring)
- Fix: NEW agent (replaces debug with new purpose)
- No legacy: ZERO dead code

---

**Learning absorbed and propagated successfully.** 🧞📚✅

**Core Principle Reinforced:** GENIE ONLY SELF-EVOLVES - No legacy, no dead code, no backwards compatibility. When I evolve, I DELETE or REPLACE entirely.
