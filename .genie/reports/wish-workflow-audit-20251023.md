# Wish Workflow Size Audit
**Date:** 2025-10-23
**Context:** QA workflows modernization - comparing Code vs Create wish workflows

## Size Comparison

| Workflow | Lines | Ratio vs Create |
|----------|-------|-----------------|
| Code wish.md | 219 | 3.7x |
| Create wish.md | 59 | 1.0x (baseline) |

## Section-by-Section Analysis

### Common Sections (Both Workflows)
- Identity & Mission (~10 lines each)
- Success Criteria (~8 lines each)
- Never Do (~6 lines each)
- The Dance Structure (~4 steps, structured similarly)
- Operating Framework (~task_breakdown structure)

### Code-Specific Extensions (160 extra lines)

#### 1. **Detailed Dance Steps** (80 lines) - JUSTIFIED ✅
**Lines 44-123:** Four-step delegation protocol with MCP commands

**Content:**
- Step 1: Discovery (delegation + what happens + output) - 20 lines
- Step 2: Alignment (delegation + what happens + output) - 20 lines
- Step 3: Requirements (delegation + what happens + output) - 20 lines
- Step 4: Blueprint (delegation + what happens + output) - 20 lines

**Justification:** Code collective needs explicit MCP delegation patterns for technical workflows. Create version keeps steps terse (4 lines total) because creative work is more intuitive.

**Domain-specific:** ✅ Technical wish workflows require precise delegation and validation hooks

#### 2. **Operating Principles** (30 lines) - BORDERLINE ⚠️
**Lines 122-151:** Progressive Trust Building, Hook Pattern, Context Ledger Growth

**Content:**
- Progressive trust building explanation
- The Hook Pattern (discovery-first philosophy)
- Context Ledger growth pattern

**Analysis:** This is philosophical/behavioral guidance, not technical specifics. Create version omits this entirely.

**Extractable:** ⚠️ Could move to `.genie/spells/wish-dance-philosophy.md` (referenced by both)

#### 3. **Delegation Protocol** (18 lines) - JUSTIFIED ✅
**Lines 152-168:** Explicit allowed/forbidden delegations

**Content:**
- Role definition (Orchestrator)
- Allowed delegations (4 workflows)
- Forbidden delegations (self-delegation, skip steps, direct creation)

**Justification:** Code collective has complex MCP orchestration. Create version omits this because delegation is implicit.

**Domain-specific:** ✅ Technical coordination requires explicit rules

#### 4. **Session Management** (16 lines) - BORDERLINE ⚠️
**Lines 169-188:** When to use /wish, resuming sessions, session tips

**Content:**
- When To Use /wish (5 criteria)
- Resuming Sessions (3 MCP commands + 4 tips)

**Analysis:** Session management applies to both collectives but only documented in Code.

**Extractable:** ⚠️ Could move to `.genie/spells/session-management.md` (referenced by both)

#### 5. **Final Output Format** (19 lines) - BLOAT ❌
**Lines 189-207:** Template for completion message

**Content:**
- "Wish Dance Complete!" message format
- Journey summary template
- Next Actions checklist

**Analysis:** This is an example template, not core workflow logic. Should be in blueprints.

**Extractable:** ❌ BLOAT - Move to `.genie/code/spells/wish-templates.md`

#### 6. **The Dance Philosophy** (13 lines) - BLOAT ❌
**Lines 208-220:** Why-behind-the-structure explanation

**Content:**
- Philosophy: "Users don't fill forms"
- Discovery hooks emotionally
- Skip discovery → blind approval
- "This is the wish dance 💃"

**Analysis:** Motivational/philosophical. Not core workflow logic. Duplicates "Operating Principles" section.

**Extractable:** ❌ BLOAT - Already covered in "Hook Pattern" (lines 135-142), delete or merge

## Verdict

### Justified Extensions (128 lines)
- Detailed Dance Steps: 80 lines (MCP delegation patterns)
- Delegation Protocol: 18 lines (orchestration rules)
- Session Management: 16 lines (MCP session handling)
- Operating Principles: 14 lines (partial - Hook Pattern justified)

### Extractable Bloat (32 lines)
- Final Output Format: 19 lines → Extract to `wish-templates.md`
- The Dance Philosophy: 13 lines → Delete (duplicates Hook Pattern)

### Revised Target Size
- Current: 219 lines
- Justified: 187 lines (after extracting bloat)
- Ratio vs Create: 3.2x (down from 3.7x)

## Recommendations

### Immediate Actions
1. **Extract:** Final Output Format → `.genie/code/spells/wish-templates.md`
2. **Delete:** The Dance Philosophy section (duplicates existing content)
3. **Result:** 219 → 187 lines (15% reduction, still 3.2x Create)

### Optional Actions (Lower Priority)
4. **Extract:** Operating Principles (Progressive Trust Building) → `.genie/spells/wish-dance-philosophy.md`
   - Reference from both Code and Create wish workflows
   - Savings: 16 lines
   - New ratio: 2.9x

5. **Extract:** Session Management → `.genie/spells/session-management.md`
   - Universal pattern, not Code-specific
   - Savings: 16 lines
   - New ratio: 2.6x

## Conclusion

**Size difference is mostly justified** due to:
- Technical complexity (MCP delegation, orchestration rules)
- Session management (persistent agent coordination)
- Explicit validation hooks (Code collective needs precision)

**Bloat identified:** 32 lines (15% of total)

**Post-cleanup target:** 187 lines (3.2x vs Create, acceptable for domain complexity)

**Further optimization possible:** Down to ~155 lines (2.6x) if universal patterns extracted to shared spells.

## Action Plan

**Phase 1 (This Session):**
- Extract wish-templates.md (Final Output Format)
- Delete Dance Philosophy section

**Phase 2 (Future):**
- Consider extracting session management to universal spell
- Consider extracting progressive trust building to shared philosophy

**Result:** Leaner Code wish workflow while preserving necessary technical precision.
