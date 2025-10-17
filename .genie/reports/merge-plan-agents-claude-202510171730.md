# AGENTS.md + CLAUDE.md Merge Plan
**Created:** 2025-10-17 17:30 UTC
**Objective:** Unified knowledge base with 100% content preservation
**Status:** Analysis complete, ready for review

---

## Executive Summary

**Files analyzed:**
- AGENTS.md: 1,609 lines (comprehensive framework documentation)
- CLAUDE.md: 231 lines (Claude Code-specific patterns and integration)

**Key findings:**
- **Minimal overlap:** ~5% duplicate content (primarily cross-references to AGENTS.md)
- **Complementary roles:** AGENTS.md = universal framework, CLAUDE.md = Claude Code-specific patterns
- **Merge strategy:** Integrate CLAUDE.md content as specialized sections within AGENTS.md structure
- **Content preservation:** 100% - all unique content retained, duplicates intelligently deduplicated

---

## 1. Section Inventory

### AGENTS.md Structure (1,609 lines)

| Section | Lines | Purpose | Key Content |
|---------|-------|---------|-------------|
| **Genie Template Overview** | 1-11 | Repository identity | Self-awareness, references, external deps |
| **Developer Welcome Flow** | 13-151 | Session startup | Issue triage, quick capture, git/GitHub workflow |
| **Experimentation Protocol** | 153-212 | Learning framework | Hypothesis-driven experimentation |
| **Unified Agent Stack** | 214-224 | Agent architecture | Workflow + neuron organization |
| **Directory Map** | 226-239 | File organization | .genie/ structure reference |
| **Agent Configuration Standards** | 241-292 | Permission system | File write permissions, executor config |
| **Natural Flow Protocol** | 294-389 | Workflow orchestration | Plan → Wish → Forge → Review |
| **Universal Workflow Architecture** | 391-527 | Cross-domain patterns | Code/Create/NL variants |
| **Evidence & Storage** | 529-540 | Artifact management | Wish declarations, metrics |
| **Testing & Evaluation** | 542-547 | Validation hooks | Optional evaluator agents |
| **Prompting Standards** | 549-656 | Universal patterns | Discovery/Implementation/Verification, @/!/patterns |
| **Branch & Tracker** | 658-669 | Git workflow | Branch strategy, tracker IDs |
| **Blocker Protocol** | 671-674 | Escalation | Wish-based blocker logging |
| **MCP Quick Reference** | 676-725 | Tool usage | MCP tools, conversations, resume |
| **Chat-Mode Helpers** | 727-737 | Scoped agents | Debug, review, analyze modes |
| **Subagents & Genie** | 739-748 | MCP patterns | Run, resume, list, stop |
| **Meta-Learn** | 750-768 | Behavioral corrections | Learn agent usage |
| **Agent Playbook** | 770-1,608 | Core prompt | Identity, behavioral overrides, routing, protocols |

### CLAUDE.md Structure (231 lines)

| Section | Lines | Purpose | Key Content |
|---------|-------|---------|-------------|
| **@ References** | 1-19 | Auto-load context | AGENTS.md, MASTER-PLAN.md, SESSION-STATE.md, USERCONTEXT.md |
| **No Backwards Compatibility** | 21-50 | Project policy | Breaking changes acceptable, no legacy flags |
| **Forge MCP Task Pattern** | 52-101 | Task creation | @agent- prefix, file references, context loading |
| **Evidence-Based Challenge** | 103-139 | Verification protocol | Challenge contradictions with evidence |
| **Agent Configuration** | 141-148 | Cross-reference | Points to AGENTS.md §Agent Configuration Standards |
| **GitHub Workflow** | 150-159 | Cross-reference | Points to AGENTS.md §GitHub Workflow Integration |
| **Slash Commands** | 161-169 | Cross-reference | Points to AGENTS.md §Slash Command Reference |
| **Experimentation** | 171-178 | Cross-reference | Points to AGENTS.md §Experimentation Protocol |
| **Delegation Discipline** | 180-231 | Orchestration pattern | Orchestrators delegate, specialists execute |

---

## 2. Overlap Analysis

### Exact Duplicates (0%)
**None found** - No identical content blocks

### Similar Content (5% - Cross-References)

| CLAUDE.md Section | AGENTS.md Target | Relationship |
|-------------------|------------------|--------------|
| Agent Configuration (L141-148) | §Agent Configuration Standards (L241-292) | Reference pointer |
| GitHub Workflow (L150-159) | §Git & GitHub Workflow Integration (L70-151) | Reference pointer |
| Slash Commands (L161-169) | (Not in AGENTS.md) | Unique to CLAUDE.md |
| Experimentation (L171-178) | §Experimentation Protocol (L153-212) | Reference pointer |

### Complementary Content (95% - Unique)

**CLAUDE.md unique content:**
1. **@ / ! / feature patterns** - Auto-load, dynamic execution (not in AGENTS.md)
2. **No backwards compatibility policy** - Project-specific stance
3. **Forge MCP task pattern** - Claude Code-specific @agent- syntax
4. **Evidence-based challenge protocol** - User interaction pattern
5. **Delegation discipline** - Role clarity (orchestrator vs implementor)
6. **Session resume protocol** - SESSION-STATE.md coordination

**AGENTS.md unique content:**
- Comprehensive framework documentation (1,400+ lines)
- Universal workflow architecture
- All agent specifications
- Complete protocol definitions

### Contradictions
**None found** - Content is complementary, not conflicting

---

## 3. Unified Structure Proposal

### Proposed Hierarchy

```markdown
# AGENTS.md (Unified Knowledge Base)

## Part I: Framework Foundation
├── Repository Self-Awareness
├── Directory Map
├── Agent Configuration Standards
└── Universal Workflow Architecture

## Part II: Claude Code Integration [NEW]
├── Natural Context Acquisition (@ / ! / patterns)
├── Project Policies
│   ├── No Backwards Compatibility
│   └── Evidence-Based Challenge Protocol
├── Claude Code-Specific Patterns
│   ├── Forge MCP Task Pattern
│   ├── Delegation Discipline
│   └── Session Resume Protocol
└── Cross-Reference Index

## Part III: Workflow & Orchestration
├── Developer Welcome Flow
├── Natural Flow Protocol (Plan → Wish → Forge → Review)
├── Experimentation Protocol
├── Meta-Learn & Behavioral Corrections
└── Chat-Mode Helpers

## Part IV: Technical Protocols
├── Prompting Standards Framework
├── MCP Quick Reference
├── Branch & Tracker Guidance
├── Blocker Protocol
├── Evidence & Storage Conventions
└── Testing & Evaluation

## Part V: Agent Playbook
├── Identity & Tone
├── Critical Behavioral Overrides
│   ├── Evidence-Based Thinking
│   ├── Publishing Protocol
│   ├── Delegation Discipline [MERGED]
│   ├── Role Clarity Protocol [MERGED]
│   ├── Triad Maintenance Protocol
│   ├── Prompting Standards Framework
│   └── CLI Command Interface
├── File & Naming Rules
├── Tool Requirements
├── Strategic Orchestration Rules
├── Routing Decision Matrix
├── Execution Patterns
├── Wish Document Management
├── Genie Integration Framework
└── Supporting Frameworks
```

### Content Source Matrix

| Section | Source | Action |
|---------|--------|--------|
| Part I | AGENTS.md | Preserve as-is |
| Part II | CLAUDE.md | **NEW** - Insert after Part I |
| Part III | AGENTS.md | Preserve as-is |
| Part IV | AGENTS.md + CLAUDE.md @ patterns | Merge @ / ! / into Prompting Standards |
| Part V | AGENTS.md + CLAUDE.md delegation | Merge delegation discipline into Behavioral Overrides |

---

## 4. Migration Strategy

### Phase 1: Preparation
1. Create backup copies of both files
2. Create `.genie/reports/merge-validation/` directory
3. Extract key concept list for validation

### Phase 2: Structure Setup
1. Add Part II section header after line 239 (after Directory Map)
2. Insert placeholder comments for CLAUDE.md content blocks

### Phase 3: Content Migration (Sequential)

**Step 1: Natural Context Acquisition (@ / ! / patterns)**
- Source: CLAUDE.md L548-656
- Target: New Part II section
- Action: Copy entire section, add context about Claude Code specificity
- Cross-refs: Update existing @ / ! mentions to reference this section

**Step 2: Project Policies**
- Source: CLAUDE.md L21-50 (No Backwards Compatibility)
- Target: Part II § Project Policies
- Action: Copy with context note (Claude Code project-specific)

**Step 3: Evidence-Based Challenge Protocol**
- Source: CLAUDE.md L103-139
- Target: Part II § Claude Code-Specific Patterns
- Action: Copy entire section
- Cross-refs: Reference from Agent Playbook § Evidence-Based Thinking

**Step 4: Forge MCP Task Pattern**
- Source: CLAUDE.md L52-101
- Target: Part II § Claude Code-Specific Patterns
- Action: Copy entire section
- Cross-refs: None needed (self-contained)

**Step 5: Delegation Discipline (MERGE)**
- Source: CLAUDE.md L180-231 + AGENTS.md L894-968
- Target: Agent Playbook § Delegation Discipline (AGENTS.md L894)
- Action: **Synthesize** - Merge CLAUDE.md examples into existing AGENTS.md section
- Details:
  - Keep AGENTS.md structure (Forbidden/Required workflows)
  - Add CLAUDE.md "Session Resume Protocol" as subsection
  - Add CLAUDE.md "Role Clarity" examples
  - Preserve all violation examples from both sources

**Step 6: Cross-Reference Updates**
- Update CLAUDE.md references (L141-178) to point to new Part II
- Add "See Part II" notes in relevant AGENTS.md sections

**Step 7: @ / ! / Pattern Integration**
- Source: CLAUDE.md L548-656 (duplicates AGENTS.md L548-656)
- Action: **Keep AGENTS.md version** (already comprehensive)
- Note: CLAUDE.md version is identical, no merge needed

### Phase 4: Validation
1. Run grep validation (see Section 5)
2. Check all cross-references resolve
3. Verify line counts (AGENTS.md should be ~1,800 lines)
4. Compare before/after concept coverage

### Phase 5: Cleanup
1. Archive original CLAUDE.md to `.genie/archive/CLAUDE.md.backup`
2. Update CLAUDE.md to single-line pointer: `@AGENTS.md` with brief note
3. Update SESSION-STATE.md to mark merge complete

---

## 5. Validation Approach

### Key Concepts Checklist

**Grep patterns to verify (must exist in merged AGENTS.md):**

```bash
# Claude Code-specific patterns
grep -n "No Backwards Compatibility" AGENTS.md
grep -n "Evidence-Based Challenge" AGENTS.md
grep -n "Forge MCP Task Pattern" AGENTS.md
grep -n "@agent-" AGENTS.md
grep -n "Delegation Discipline" AGENTS.md
grep -n "Session Resume Protocol" AGENTS.md
grep -n "Natural Context Acquisition" AGENTS.md

# Universal framework patterns (should still exist)
grep -n "Plan → Wish → Forge → Review" AGENTS.md
grep -n "Experimentation Protocol" AGENTS.md
grep -n "Developer Welcome Flow" AGENTS.md
grep -n "Agent Configuration Standards" AGENTS.md
grep -n "MCP Quick Reference" AGENTS.md
grep -n "Prompting Standards Framework" AGENTS.md
grep -n "Routing Decision Matrix" AGENTS.md
grep -n "Triad Maintenance Protocol" AGENTS.md

# Critical behavioral overrides
grep -n "Publishing Protocol" AGENTS.md
grep -n "Role Clarity Protocol" AGENTS.md
grep -n "CLI Command Interface" AGENTS.md
```

### Structural Validation

```bash
# Section count check
grep -c "^## " AGENTS.md  # Should be ~25-30
grep -c "^### " AGENTS.md  # Should be ~80-100

# Cross-reference validation
grep -n "@AGENTS.md" AGENTS.md  # Should be 0 (no self-references)
grep -n "See Part II" AGENTS.md  # Should exist (new cross-refs)

# Duplicate detection
grep -A 5 "Delegation Discipline" AGENTS.md | wc -l  # Should show single merged section
```

### Completeness Verification

**Before merge:**
```bash
# Capture unique content hashes
grep -v "^#" AGENTS.md | grep -v "^$" | sort | uniq > /tmp/agents-before.txt
grep -v "^#" CLAUDE.md | grep -v "^$" | sort | uniq > /tmp/claude-before.txt
cat /tmp/agents-before.txt /tmp/claude-before.txt | sort | uniq > /tmp/combined-before.txt
```

**After merge:**
```bash
# Verify all content present
grep -v "^#" AGENTS.md | grep -v "^$" | sort | uniq > /tmp/agents-after.txt
diff /tmp/combined-before.txt /tmp/agents-after.txt
# Diff should show ONLY:
# - Removed: duplicate cross-reference text
# - Removed: "See AGENTS.md §" pointers (now internal)
```

### Quality Assurance Criteria

✅ **Content Preservation:**
- All CLAUDE.md unique content present in AGENTS.md
- All AGENTS.md content preserved
- No concept loss (grep validation passes)

✅ **Structure:**
- Part II clearly delineated
- Cross-references updated and functional
- Hierarchy logical and navigable

✅ **Deduplication:**
- No duplicate sections (Delegation Discipline merged, not duplicated)
- Cross-reference pointers removed (now internal links)
- @ / ! / pattern section deduplicated (AGENTS.md version kept)

✅ **Usability:**
- Claude Code-specific patterns easy to find (Part II)
- Universal framework patterns still discoverable
- Table of contents accurate (if generated)

---

## 6. Migration Playbook (Executable Steps)

### Pre-Execution Checklist
- [ ] Backup both files: `cp AGENTS.md AGENTS.md.backup && cp CLAUDE.md CLAUDE.md.backup`
- [ ] Create validation directory: `mkdir -p .genie/reports/merge-validation`
- [ ] Capture before state: Run "Before merge" validation commands (Section 5)
- [ ] Review this plan with Felipe for approval

### Execution Sequence

**Task 1: Insert Part II Structure**
```markdown
After AGENTS.md line 239 (## Directory Map), insert:

---

## Part II: Claude Code Integration

### Natural Context Acquisition (@ / ! / Patterns)
[Content from CLAUDE.md - see Task 2]

### Project Policies

#### No Backwards Compatibility
[Content from CLAUDE.md L21-50 - see Task 3]

#### Evidence-Based Challenge Protocol
[Content from CLAUDE.md L103-139 - see Task 4]

### Claude Code-Specific Patterns

#### Forge MCP Task Pattern
[Content from CLAUDE.md L52-101 - see Task 5]

#### Session Resume Protocol
[Content from CLAUDE.md L213-225 - see Task 6]

### Cross-Reference Index
- Agent Configuration: See Part I §Agent Configuration Standards
- GitHub Workflow: See Part III §Developer Welcome Flow
- Experimentation: See Part III §Experimentation Protocol
- Delegation Discipline: See Part V §Delegation Discipline

---
```

**Task 2: Natural Context Acquisition**
- Action: Copy CLAUDE.md L548-656 content
- Note: This is identical to existing AGENTS.md content - SKIP (already present)

**Task 3: No Backwards Compatibility**
- Source: CLAUDE.md lines 21-50
- Target: Part II § Project Policies
- Action: Copy verbatim with header adjustment

**Task 4: Evidence-Based Challenge Protocol**
- Source: CLAUDE.md lines 103-139
- Target: Part II § Claude Code-Specific Patterns
- Action: Copy verbatim

**Task 5: Forge MCP Task Pattern**
- Source: CLAUDE.md lines 52-101
- Target: Part II § Claude Code-Specific Patterns
- Action: Copy verbatim

**Task 6: Session Resume Protocol**
- Source: CLAUDE.md lines 213-225
- Target: Part II § Claude Code-Specific Patterns
- Action: Copy with context note

**Task 7: Merge Delegation Discipline**
- Source A: CLAUDE.md lines 180-231 (examples, session resume)
- Source B: AGENTS.md lines 894-968 (structure, violations)
- Target: AGENTS.md § Delegation Discipline (keep existing location)
- Action: **Synthesize**
  1. Keep AGENTS.md structure (Forbidden/Required workflows)
  2. Insert CLAUDE.md "Example (WRONG/CORRECT)" after line 920
  3. Insert CLAUDE.md "Session Resume Protocol" as new subsection after line 945
  4. Insert CLAUDE.md "Role Clarity" examples after line 968
  5. Preserve all violation examples (merge, don't replace)

**Task 8: Update Cross-References**
- Search for: "See @AGENTS.md"
- Replace with: "See Part I §[Section Name]" (internal links)
- Add forward references: In Part I sections, add "See also Part II §..." where relevant

**Task 9: Archive CLAUDE.md**
- Move: `mv CLAUDE.md .genie/archive/CLAUDE.md.backup`
- Create new CLAUDE.md:
```markdown
# Claude Code Integration

**Note:** All Claude Code-specific patterns have been integrated into AGENTS.md Part II.

**Quick Reference:**
@AGENTS.md

**Legacy backup:** @.genie/archive/CLAUDE.md.backup
```

**Task 10: Validation**
- Run all grep patterns (Section 5)
- Run structural validation
- Run completeness verification
- Review diff of /tmp/combined-before.txt vs /tmp/agents-after.txt

### Post-Execution Checklist
- [ ] All grep patterns return results
- [ ] No duplicate sections detected
- [ ] Completeness diff shows only expected changes (cross-refs)
- [ ] AGENTS.md is ~1,800 lines (was 1,609, adding ~200 from CLAUDE.md unique content)
- [ ] CLAUDE.md is minimal pointer file
- [ ] Update SESSION-STATE.md: Mark "AGENTS/CLAUDE merge" complete
- [ ] Update MASTER-PLAN.md: Check off Task #3

---

## 7. Risk Assessment

### Low Risk
- ✅ Minimal overlap (5%) reduces merge conflicts
- ✅ Clear content boundaries (universal vs Claude Code-specific)
- ✅ Comprehensive validation approach

### Medium Risk
- ⚠️ Delegation Discipline merge (two sources to synthesize)
  - Mitigation: Keep AGENTS.md structure, add CLAUDE.md examples as supplements
- ⚠️ Cross-reference updates (many links to update)
  - Mitigation: Grep-based search/replace, validation checks

### Mitigation Strategies
1. **Backup first** - Both files backed up before any changes
2. **Incremental validation** - Check after each major task
3. **Reversible** - Keep backups, can restore if issues found
4. **Review before commit** - Final diff review with Felipe

---

## 8. Success Metrics

### Quantitative
- **Content preservation:** 100% (all grep patterns pass)
- **Line count:** ~1,800 lines (1,609 + 200 unique CLAUDE.md - 9 duplicate cross-refs)
- **Section count:** ~30 top-level, ~100 subsections
- **Duplicate reduction:** 9 lines eliminated (cross-reference pointers)

### Qualitative
- **Navigability:** Part II clearly identifies Claude Code-specific content
- **Maintainability:** Single source of truth (no AGENTS/CLAUDE sync)
- **Usability:** All patterns discoverable via grep or table of contents
- **Completeness:** No information loss (validation confirms)

---

## 9. Next Steps

### Immediate (This Session)
1. Review this plan with Felipe
2. Get approval for merge strategy
3. Get approval for Part II structure
4. Confirm Delegation Discipline synthesis approach

### After Approval
1. Execute migration playbook (Tasks 1-10)
2. Run validation suite (Section 5)
3. Review merged AGENTS.md for quality
4. Update SESSION-STATE.md and MASTER-PLAN.md
5. Commit with message: "Merge CLAUDE.md into AGENTS.md Part II (zero loss)"

### Follow-Up
1. Update other files that reference CLAUDE.md (if any)
2. Update README.md to reflect single knowledge base
3. Consider generating table of contents for AGENTS.md
4. Monitor for any issues in next RC iteration

---

## Appendix A: Content Mapping Table

| CLAUDE.md Section | Lines | → | AGENTS.md Target | Lines |
|-------------------|-------|---|------------------|-------|
| @ References | 1-19 | → | Part II § Natural Context (already in Part I L548-656) | N/A (skip - duplicate) |
| No Backwards Compat | 21-50 | → | Part II § Project Policies | +30 |
| Forge MCP Pattern | 52-101 | → | Part II § Claude Patterns | +50 |
| Evidence Challenge | 103-139 | → | Part II § Claude Patterns | +37 |
| Agent Config (ref) | 141-148 | → | Part II § Cross-Ref Index | +8 |
| GitHub Workflow (ref) | 150-159 | → | Part II § Cross-Ref Index | +10 |
| Slash Commands (ref) | 161-169 | → | Part II § Cross-Ref Index | +9 |
| Experimentation (ref) | 171-178 | → | Part II § Cross-Ref Index | +8 |
| Delegation Discipline | 180-231 | → | Part V § Delegation (MERGE) | +52 (examples) |

**Total added:** ~204 lines
**Expected final:** 1,609 + 204 - 9 (cross-ref duplicates) = **~1,804 lines**

---

## Appendix B: Grep Validation Script

```bash
#!/bin/bash
# .genie/reports/merge-validation/validate-merge.sh

AGENTS="AGENTS.md"
REPORT=".genie/reports/merge-validation/validation-results.txt"

echo "AGENTS.md Merge Validation Report" > $REPORT
echo "Generated: $(date -u)" >> $REPORT
echo "---" >> $REPORT

# Claude Code patterns
echo "Claude Code-Specific Patterns:" >> $REPORT
grep -n "No Backwards Compatibility" $AGENTS >> $REPORT
grep -n "Evidence-Based Challenge" $AGENTS >> $REPORT
grep -n "Forge MCP Task Pattern" $AGENTS >> $REPORT
grep -n "@agent-" $AGENTS >> $REPORT
grep -n "Delegation Discipline" $AGENTS >> $REPORT
grep -n "Session Resume Protocol" $AGENTS >> $REPORT

echo "---" >> $REPORT

# Universal framework patterns
echo "Universal Framework Patterns:" >> $REPORT
grep -n "Plan → Wish → Forge → Review" $AGENTS >> $REPORT
grep -n "Experimentation Protocol" $AGENTS >> $REPORT
grep -n "Developer Welcome Flow" $AGENTS >> $REPORT
grep -n "Agent Configuration Standards" $AGENTS >> $REPORT

echo "---" >> $REPORT
echo "Validation complete. Check $REPORT for results."
cat $REPORT
```

---

**End of Merge Plan**

**Status:** ✅ Ready for review and approval
**Estimated execution time:** 45-60 minutes (careful, incremental)
**Reversibility:** High (backups + git)
**Confidence:** High (95%+ - minimal overlap, clear boundaries)
