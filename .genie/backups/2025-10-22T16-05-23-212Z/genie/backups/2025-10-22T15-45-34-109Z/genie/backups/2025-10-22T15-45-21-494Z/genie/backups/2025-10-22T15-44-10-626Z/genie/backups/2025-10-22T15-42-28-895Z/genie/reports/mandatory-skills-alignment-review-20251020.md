# Mandatory Skills Alignment Review

**Date:** 2025-10-20
**Purpose:** Review 5 mandatory skills against current framework state
**Context:** Executable skills paradigm shift + Forge-first architecture

---

## Skills Reviewed

1. `know-yourself.md` (Tier 1 - Identity)
2. `evidence-based-thinking.md` (Tier 2 - Decision Framework)
3. `routing-decision-matrix.md` (Tier 2 - Decision Framework)
4. `delegation-discipline.md` (Tier 4 - Orchestration)
5. `role-clarity-protocol.md` (Tier 6 - Role Boundaries)

---

## Skill 1: know-yourself.md

### Current State Analysis

**✅ ALIGNED SECTIONS:**
- Token economy principles (still valid)
- "What You Already Know" vs "What You Need Instructions For" (core principle)
- Application to skills/agents (still relevant)
- Validation questions (still useful)

**🔴 OUTDATED SECTIONS:**

1. **"What I Am Now: Central Coordinator with Parallel Extensions"** (Lines 82-128)
   - References "cloning capability" (genie↔genie sessions)
   - References "advisory teams" invocation
   - **PROBLEM:** Over-complicates identity, conflicts with Forge-first architecture
   - **FIX:** Simplify to: "I orchestrate via Forge tasks, execute when delegated to"

2. **"Current Evolution Stage"** (Lines 131-157)
   - References rc21 (we're at rc36+)
   - References "manual → dynamic state" evolution
   - **PROBLEM:** Outdated version references
   - **FIX:** Remove version-specific content, focus on timeless principles

3. **"How I Become More Intelligent Over Time"** (Lines 159-189)
   - References phases 1-4 evolution
   - **PROBLEM:** Speculative future content, not current behavior
   - **FIX:** Remove future speculation, keep only current patterns

### Recommended Changes

**KEEP:**
- Core principle (lines 1-27)
- Token economy (lines 29-53)
- Application to skills/agents (lines 55-70)
- Validation (lines 72-79)

**REMOVE:**
- Lines 82-189 (entire "What I Am Now" section)
- Lines 131-189 (entire "Current Evolution Stage" and future phases)

**ADD:**
- New section: "Current Identity (2025-10-20)"
  - Forge-first orchestration
  - Executable skills (not all auto-loaded)
  - Wish→Issue→Forge→PR workflow
  - Real-time skill execution capability

**NEW TOTAL:** ~120 lines (down from 202 lines, 40% reduction)

---

## Skill 2: evidence-based-thinking.md

### Current State Analysis

**✅ FULLY ALIGNED:**
- Core principle (investigate before commit)
- Decision-making protocol (pause, investigate, analyze, evaluate, respond)
- Investigation discipline (4 phases)
- Communication patterns (validation openers, respectful disagreement)
- Anti-patterns
- Example (Issue #120 investigation)

**🟢 NO CHANGES NEEDED**

This skill is **timeless** - the evidence-based approach doesn't change with framework evolution.

**TOTAL:** 102 lines (optimal, keep as-is)

---

## Skill 3: routing-decision-matrix.md

### Current State Analysis

**✅ ALIGNED SECTIONS:**
- Agent Invocation Architecture (4-tier hierarchy)
- Self-awareness check (before mcp__genie__run)
- Decision flowchart
- Agent selection matrix
- Critical routing rules

**🟡 MINOR UPDATES NEEDED:**

1. **Advisory Teams References** (Lines 83-87)
   - References tech-council invocation
   - **STATUS:** Still valid (tech-council exists)
   - **ACTION:** Keep, but note this is executable (not auto-loaded)

2. **Universal Analysis Agents** (Lines 89-102)
   - References analyze, audit/risk, audit/security agents
   - **STATUS:** Need to verify these exist in current codebase
   - **ACTION:** Validate agent list, remove non-existent ones

3. **Agent List Completeness** (Lines 146-156)
   - Lists: genie, implementor, tests, git, release, learn, polish
   - **MISSING:** New agents added since this was written
   - **ACTION:** Audit current agent list, update table

### Recommended Changes

**VERIFY & UPDATE:**
- Lines 89-102: Validate universal analysis agents exist
- Lines 146-156: Update agent selection matrix with current agents
- Add note: "Some agents are executable skills (on-demand), not persistent sessions"

**TOTAL:** ~338 lines (minor updates, mostly accurate)

---

## Skill 4: delegation-discipline.md

### Current State Analysis

**✅ ALIGNED SECTIONS:**
- Forbidden actions (still valid)
- Required workflow (still valid)
- Why this matters (still valid)
- Delegation instinct pattern (CRITICAL, still valid)

**🔴 OUTDATED SECTIONS:**

1. **"🔴 CRITICAL LEARNING: Orchestration Simplification"** (Lines 105-192)
   - References "Three-tier model: Forge Tasks → Me → Felipe"
   - References "stop over-engineering orchestration"
   - **PROBLEM:** This section contradicts executable skills paradigm
   - **ANALYSIS:**
     - "Forge Tasks = orchestrators" is CORRECT
     - "Me = execute what Forge tells me" is PARTIALLY CORRECT
     - Missing: "I can execute skills on-demand for dynamic behavior"
   - **FIX:** Update to reflect Forge + executable skills hybrid model

2. **Recent Violations** (Lines 73-92)
   - 2025-10-16, 2025-10-18 violations
   - **PROBLEM:** Historical context, clutters the skill
   - **FIX:** Move to learn reports, keep only core principle

### Recommended Changes

**KEEP:**
- Lines 1-70 (core delegation discipline)
- Delegation instinct pattern (lines 38-57)
- Pre-execution checklist concept (adapt for current model)

**UPDATE:**
- Lines 105-192: Replace with "Forge + Executable Skills Model"
  - Forge tasks orchestrate work
  - I execute via Forge delegation OR via skill execution
  - Skills are callable on-demand (not background tasks)
  - Example: Run `wish-issue-linkage-rule` skill before wish creation

**REMOVE:**
- Lines 73-92 (historical violations → move to learn report)

**NEW TOTAL:** ~140 lines (down from 192 lines, 27% reduction)

---

## Skill 5: role-clarity-protocol.md

### Current State Analysis

**✅ ALIGNED SECTIONS:**
- Core role distinction (orchestrator vs implementor)
- Forbidden actions (bypassing session checks)
- Required workflow (check sessions first)
- Why this matters

**🟡 MINOR UPDATES NEEDED:**

1. **SESSION-STATE.md References** (Lines 18-29)
   - References checking SESSION-STATE.md for active agents
   - **STATUS:** SESSION-STATE.md exists but may be updated differently now
   - **ACTION:** Update to reflect Forge task status as source of truth

2. **Recent Violation** (Lines 48-72)
   - 2025-10-17 violation
   - **PROBLEM:** Historical context, should be in learn report
   - **FIX:** Remove, keep only core principle

### Recommended Changes

**KEEP:**
- Lines 1-46 (core role clarity protocol)

**UPDATE:**
- Lines 18-29: Reflect Forge task status as source of truth (not just SESSION-STATE.md)
- Add: "When Forge task exists, I'm the executor (not delegator)"

**REMOVE:**
- Lines 48-72 (historical violation → move to learn report)

**NEW TOTAL:** ~50 lines (down from 73 lines, 32% reduction)

---

## Summary: Token Reduction Impact

### Before (Current State)
- know-yourself.md: 202 lines (~1,400 tokens)
- evidence-based-thinking.md: 102 lines (~700 tokens)
- routing-decision-matrix.md: 338 lines (~2,300 tokens)
- delegation-discipline.md: 192 lines (~1,300 tokens)
- role-clarity-protocol.md: 73 lines (~500 tokens)

**TOTAL: ~907 lines (~6,200 tokens)**

### After (Proposed Updates)
- know-yourself.md: ~120 lines (~850 tokens) [↓ 40%]
- evidence-based-thinking.md: 102 lines (~700 tokens) [no change]
- routing-decision-matrix.md: ~340 lines (~2,300 tokens) [minor updates]
- delegation-discipline.md: ~140 lines (~950 tokens) [↓ 27%]
- role-clarity-protocol.md: ~50 lines (~350 tokens) [↓ 32%]

**TOTAL: ~752 lines (~5,150 tokens)**

**SAVINGS: ~155 lines (~1,050 tokens, 17% reduction)**

---

## Key Alignment Themes

### 1. Remove Historical Violations
All "Recent Violation" sections should move to learn reports, not live in skills.

**WHY:** Skills teach principles, not history. Learn reports archive violations.

### 2. Remove Version-Specific Content
No rc21, rc36, or version-specific evolution phases.

**WHY:** Skills should be timeless principles, not snapshot documentation.

### 3. Simplify Identity Narrative
Current "What I Am Now" is over-complicated (cloning, phases, etc.).

**WHY:** Simpler identity = clearer behavior. Forge orchestrates, I execute or delegate.

### 4. Align with Executable Skills
Skills reference other skills as "callable" not "auto-loaded documentation."

**WHY:** Paradigm shift - skills are tools, not static instructions.

### 5. Forge-First Architecture
Forge tasks are source of truth, not SESSION-STATE.md manual tracking.

**WHY:** SESSION-STATE.md was manual (error-prone), Forge is real-time (authoritative).

---

## Implementation Plan

### Phase 1: Update know-yourself.md (HIGHEST IMPACT)
- Remove lines 82-189 (outdated identity/evolution)
- Add new "Current Identity" section (Forge-first + executable skills)
- Focus on token efficiency + project-specific patterns
- **Expected:** 40% token reduction

### Phase 2: Update delegation-discipline.md
- Remove historical violations (lines 73-92)
- Replace orchestration section with Forge + executable skills model
- Keep core delegation instinct pattern
- **Expected:** 27% token reduction

### Phase 3: Update role-clarity-protocol.md
- Remove historical violation (lines 48-72)
- Update to reflect Forge task source of truth
- Simplify to core role distinction
- **Expected:** 32% token reduction

### Phase 4: Minor Updates to routing-decision-matrix.md
- Verify agent list completeness
- Add note about executable skills (on-demand)
- No major structural changes

### Phase 5: Keep evidence-based-thinking.md as-is
- No changes needed (timeless principles)

---

## Next Steps

1. **Get Felipe approval** on this alignment analysis
2. **Execute Phase 1** (know-yourself.md update - highest impact)
3. **Execute Phases 2-3** (delegation-discipline, role-clarity)
4. **Execute Phase 4** (routing-decision-matrix minor updates)
5. **Validate** all 5 skills work together coherently
6. **Update AGENTS.md** to reflect new skill structure

---

**Status:** Analysis complete, awaiting Felipe feedback
**Priority:** Phase 1 (know-yourself.md) - 40% token reduction, foundational identity
