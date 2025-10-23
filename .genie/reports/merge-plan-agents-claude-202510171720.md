# AGENTS.md + CLAUDE.md Merge Plan
**Created:** 2025-10-17 17:20 UTC
**Objective:** Create unified knowledge base with 100% content preservation
**Status:** Analysis Complete, Ready for Review

---

## Executive Summary

**Files analyzed:**
- AGENTS.md: 1609 lines, comprehensive framework documentation
- CLAUDE.md: 231 lines, Claude Code-specific patterns and context loading

**Key finding:** CLAUDE.md is primarily a **context loading manifest** with lightweight Claude-specific patterns. AGENTS.md is the **comprehensive knowledge base**. Merge strategy: embed CLAUDE.md patterns into AGENTS.md structure, preserve all @ references at top.

**Content overlap:** ~15% (Agent Configuration, GitHub Workflow, Experimentation sections referenced but not duplicated)

**Unified structure:** Single file following Discovery → Implementation → Verification framework

---

## 1. Section Inventory

### AGENTS.md Structure (1609 lines)

| Section | Lines | Purpose | Type |
|---------|-------|---------|------|
| Genie Template Overview | 1-11 | Repository purpose and self-awareness | Meta |
| Developer Welcome Flow | 13-151 | Session start patterns, GitHub workflow | Workflow |
| Experimentation Protocol | 152-211 | Learning framework and safe experimentation | Behavioral |
| Unified Agent Stack | 213-223 | Agent directory structure | Architecture |
| Directory Map | 225-238 | File organization conventions | Architecture |
| Agent Configuration Standards | 240-291 | Permission modes, executor settings | Technical |
| Natural Flow Protocol | 293-389 | Plan → Wish → Forge → Review invisible workflow | Core Workflow |
| Universal Workflow Architecture | 392-527 | Cross-variant workflow (code/create/NL) | Architecture |
| Evidence & Storage Conventions | 530-539 | Artifact management | Standards |
| Testing & Evaluation | 536-539 | Validation approach | Standards |
| Prompting Standards | 541-655 | @ / ! / patterns, agent file networks | Core Framework |
| Branch & Tracker Guidance | 657-668 | Git workflow conventions | Standards |
| Blocker Protocol | 670-673 | Escalation handling | Workflow |
| MCP Quick Reference | 675-724 | Tool usage patterns | Technical |
| Chat-Mode Helpers | 726-736 | Scoped lightweight interactions | Workflow |
| Subagents & Genie via MCP | 738-747 | MCP invocation patterns | Technical |
| Meta-Learn & Behavioral Corrections | 749-768 | Learning agent usage | Behavioral |
| Agent Playbook | 770-1608 | Comprehensive agent instructions | Core Prompt |

**Agent Playbook breakdown (770-1608):**
- Identity & Tone (788-827): Genie persona definition
- Critical Behavioral Overrides (830-1325): Violations and corrections
  - Evidence-Based Thinking (845-848)
  - Publishing Protocol (850-891)
  - Delegation Discipline (893-967)
  - Role Clarity Protocol (968-1025)
  - Triad Maintenance Protocol (1027-1162)
  - Prompting Standards Framework (1163-1277)
  - CLI Command Interface (1278-1324)
- File & Naming Rules (1327-1347)
- Tool Requirements (1349-1357)
- Strategic Orchestration Rules (1359-1370)
- Orchestration Protocols (1372-1379)
- Routing Decision Matrix (1381-1442)
- Execution Patterns (1444-1453)
- Wish Document Management (1455-1463)
- Genie Integration Framework (1465-1555)
- Genie Missing Context Protocol (1557-1569)
- Parallel Execution Framework (1571-1578)
- Genie Workspace System (1580-1587)
- Forge Integration Framework (1589-1596)
- Behavioral Principles (1598-1601)
- Master Principles (1603-1606)

### CLAUDE.md Structure (231 lines)

| Section | Lines | Purpose | Type |
|---------|-------|---------|------|
| @ File References | 1-19 | Context loading manifest | Meta |
| No Backwards Compatibility | 23-49 | Project-specific pattern | Pattern |
| Forge MCP Task Pattern | 51-100 | MCP task creation guidance | Pattern |
| Evidence-Based Challenge Protocol | 102-138 | Verification pattern | Behavioral |
| Agent Configuration | 140-147 | Reference to AGENTS.md § | Reference |
| GitHub Workflow | 149-158 | Reference to AGENTS.md § | Reference |
| Slash Commands | 160-168 | Reference to AGENTS.md § | Reference |
| Experimentation | 170-177 | Reference to AGENTS.md § | Reference |
| Delegation Discipline | 179-231 | Pattern with examples | Pattern |

---

## 2. Overlap Analysis

### Identical Content (0%)
No exact duplicates found.

### Similar Content (~15%)

| Topic | AGENTS.md Location | CLAUDE.md Location | Relationship |
|-------|-------------------|-------------------|--------------|
| Agent Configuration | Lines 240-291 (full spec) | Lines 140-147 (reference) | CLAUDE → AGENTS |
| GitHub Workflow | Lines 68-150 (full spec) | Lines 149-158 (reference) | CLAUDE → AGENTS |
| Experimentation | Lines 152-211 (full spec) | Lines 170-177 (reference) | CLAUDE → AGENTS |
| Delegation Discipline | Lines 893-967 (in behavioral overrides) | Lines 179-231 (with examples) | Complementary |

### Complementary Content (~85%)

**CLAUDE.md unique patterns:**
1. **No Backwards Compatibility** (23-49): Project-specific architectural constraint
2. **Forge MCP Task Pattern** (51-100): Specific MCP invocation pattern
3. **Evidence-Based Challenge Protocol** (102-138): User interaction pattern
4. **@ File References** (1-19): Context loading manifest (CRITICAL - must preserve)

**AGENTS.md unique sections:** (majority of file, comprehensive framework)

### Contradictions
**None found.** CLAUDE.md references AGENTS.md sections accurately. No conflicting guidance detected.

---

## 3. Unified Structure Proposal

### High-Level Organization

```markdown
# Genie Framework Knowledge Base

## [Meta] Context Loading & Self-Awareness
- @ File References (from CLAUDE.md lines 1-19) ← PRESERVE EXACTLY
- Repository Self-Awareness (AGENTS.md lines 3-11)
- Master Plan, Session State, User Context references

## [Discovery] Framework Foundations
- Developer Welcome Flow (AGENTS.md 13-151)
- Experimentation Protocol (AGENTS.md 152-211)
- Natural Flow Protocol (AGENTS.md 293-389)
- Universal Workflow Architecture (AGENTS.md 392-527)

## [Implementation] Agent Architecture & Patterns
- Unified Agent Stack (AGENTS.md 213-223)
- Directory Map (AGENTS.md 225-238)
- Agent Configuration Standards (AGENTS.md 240-291)
- Prompting Standards (AGENTS.md 541-655)
- Claude-Specific Patterns (CLAUDE.md 23-231) ← INSERT HERE
  - No Backwards Compatibility
  - Forge MCP Task Pattern
  - Evidence-Based Challenge Protocol
  - Delegation Discipline (synthesize with AGENTS.md 893-967)

## [Verification] Standards & Conventions
- Evidence & Storage Conventions (AGENTS.md 530-539)
- Testing & Evaluation (AGENTS.md 536-539)
- Branch & Tracker Guidance (AGENTS.md 657-668)
- Blocker Protocol (AGENTS.md 670-673)
- File & Naming Rules (AGENTS.md 1327-1347)

## [Technical Reference] Tools & Integration
- MCP Quick Reference (AGENTS.md 675-724)
- Chat-Mode Helpers (AGENTS.md 726-736)
- Subagents & Genie via MCP (AGENTS.md 738-747)
- Tool Requirements (AGENTS.md 1349-1357)

## [Core Prompt] Agent Playbook
- Identity & Tone (AGENTS.md 788-827)
- Critical Behavioral Overrides (AGENTS.md 830-1325)
- Strategic Orchestration Rules (AGENTS.md 1359-1370)
- Orchestration Protocols (AGENTS.md 1372-1379)
- Routing Decision Matrix (AGENTS.md 1381-1442)
- Execution Patterns (AGENTS.md 1444-1453)
- Wish Document Management (AGENTS.md 1455-1463)
- Genie Integration Framework (AGENTS.md 1465-1555)
- Genie Missing Context Protocol (AGENTS.md 1557-1569)
- Parallel Execution Framework (AGENTS.md 1571-1578)
- Genie Workspace System (AGENTS.md 1580-1587)
- Forge Integration Framework (AGENTS.md 1589-1596)
- Behavioral Principles (AGENTS.md 1598-1601)
- Master Principles (AGENTS.md 1603-1606)
```

**Rationale:**
- Discovery → Implementation → Verification framework applied at top level
- Context loading preserved at top (critical for @ references to work)
- Claude-specific patterns integrated into Implementation section
- All behavioral guardrails consolidated under Core Prompt
- Technical reference easily navigable

---

## 4. Migration Strategy

### Phase 1: Preserve Context Loading (CRITICAL)
**Action:** Copy CLAUDE.md lines 1-19 EXACTLY to merged file header

**Why:** These @ references auto-load critical context files. Any modification breaks session continuity.

```markdown
`@AGENTS.md`.md
# ⚠️ Master Plan (Architectural Evolution & Current Goals)
...
@.genie/MASTER-PLAN.md

# ⚠️ Session State (Permanent Agent Coordination)
...
@.genie/SESSION-STATE.md

# ⚠️ User Context (Project-Specific Session Continuity)
...
@.genie/USERCONTEXT.md
```

### Phase 2: Embed Claude-Specific Patterns
**Location:** After "Prompting Standards" section, before "Branch & Tracker Guidance"

**Source sections from CLAUDE.md:**
1. No Backwards Compatibility (23-49)
2. Forge MCP Task Pattern (51-100)
3. Evidence-Based Challenge Protocol (102-138)

**New section title:** `## Claude-Specific Patterns`

**Subsections:**
- No Backwards Compatibility
- Forge MCP Task Pattern
- Evidence-Based Challenge Protocol

### Phase 3: Synthesize Delegation Discipline
**Challenge:** Delegation Discipline appears in both files with different emphasis

**AGENTS.md version (893-967):**
- Part of Critical Behavioral Overrides
- Includes violations, examples, state tracking
- Embedded in larger behavioral context

**CLAUDE.md version (179-231):**
- Standalone section
- Concise pattern description
- Focuses on orchestrator vs specialist roles

**Resolution:**
- Keep AGENTS.md version in Critical Behavioral Overrides (comprehensive)
- Add CLAUDE.md examples to enhance clarity
- Cross-reference from Claude-Specific Patterns section

**Merge logic:**
```markdown
## Claude-Specific Patterns

### Delegation Discipline

**Pattern:** Orchestrators delegate to specialists. Never implement directly when orchestrating.

[Insert CLAUDE.md 179-211 examples here]

**For complete violation history and state tracking protocol, see:**
`@AGENTS.md`.md §Critical Behavioral Overrides > Delegation Discipline
```

### Phase 4: Update Cross-References
**CLAUDE.md references to update:**

| Current Reference | New Location in Merged File |
|-------------------|----------------------------|
| "See `@AGENTS.md`.md §Agent Configuration Standards" | "See §Agent Configuration Standards" |
| "See `@AGENTS.md`.md §GitHub Workflow Integration" | "See §Developer Welcome Flow > Git & GitHub Workflow Integration" |
| "See `@AGENTS.md`.md §Slash Command Reference" | "See §MCP Quick Reference" |
| "See `@AGENTS.md`.md §Experimentation Protocol" | "See §Experimentation Protocol" |

### Phase 5: Remove Duplicate References
**CLAUDE.md lines to REMOVE (replaced by direct content):**
- Lines 140-147 (Agent Configuration reference)
- Lines 149-158 (GitHub Workflow reference)
- Lines 160-168 (Slash Commands reference)
- Lines 170-177 (Experimentation reference)

**Rationale:** In unified file, direct § references replace file-to-file references

### Phase 6: Validate Completeness
**Grep patterns to verify:**

```bash
# Key concepts from AGENTS.md
grep -i "plan.*wish.*forge.*review" MERGED.md
grep -i "evidence-based thinking" MERGED.md
grep -i "agent.*session" MERGED.md
grep -i "permissionmode.*default" MERGED.md

# Key concepts from CLAUDE.md
grep -i "backwards compatibility" MERGED.md
grep -i "forge.*mcp.*task" MERGED.md
grep -i "evidence-based challenge" MERGED.md
grep -i "delegation discipline" MERGED.md

# Critical @ references preserved
grep "^`@AGENTS.md`.md" MERGED.md
grep "@.genie/MASTER-PLAN.md" MERGED.md
grep "@.genie/SESSION-STATE.md" MERGED.md
grep "@.genie/USERCONTEXT.md" MERGED.md
```

---

## 5. Migration Playbook

### Step 1: Create Merged File Header
**Source:** CLAUDE.md lines 1-19 (@ references)
**Destination:** MERGED.md lines 1-19 (EXACT COPY)

```bash
# Extract context loading section
head -n 19 CLAUDE.md > /tmp/header.md
```

### Step 2: Add Repository Self-Awareness
**Source:** AGENTS.md lines 1-11
**Destination:** MERGED.md after header

```bash
# Extract self-awareness section
sed -n '1,11p' AGENTS.md >> /tmp/header.md
```

### Step 3: Build Discovery Section
**Sources:**
- Developer Welcome Flow (AGENTS.md 13-151)
- Experimentation Protocol (AGENTS.md 152-211)
- Natural Flow Protocol (AGENTS.md 293-389)
- Universal Workflow Architecture (AGENTS.md 392-527)

**Action:** Extract and concatenate with section header

```bash
# Create Discovery section
echo "## [Discovery] Framework Foundations" > /tmp/discovery.md
sed -n '13,151p' AGENTS.md >> /tmp/discovery.md
sed -n '152,211p' AGENTS.md >> /tmp/discovery.md
sed -n '293,389p' AGENTS.md >> /tmp/discovery.md
sed -n '392,527p' AGENTS.md >> /tmp/discovery.md
```

### Step 4: Build Implementation Section
**Sources:**
- Unified Agent Stack (AGENTS.md 213-223)
- Directory Map (AGENTS.md 225-238)
- Agent Configuration Standards (AGENTS.md 240-291)
- Prompting Standards (AGENTS.md 541-655)
- Claude-Specific Patterns (CLAUDE.md 23-138)

**Action:** Concatenate with new subsection for Claude patterns

```bash
# Create Implementation section
echo "## [Implementation] Agent Architecture & Patterns" > /tmp/implementation.md
sed -n '213,223p' AGENTS.md >> /tmp/implementation.md
sed -n '225,238p' AGENTS.md >> /tmp/implementation.md
sed -n '240,291p' AGENTS.md >> /tmp/implementation.md
sed -n '541,655p' AGENTS.md >> /tmp/implementation.md

# Add Claude-specific patterns subsection
echo "## Claude-Specific Patterns" >> /tmp/implementation.md
sed -n '23,138p' CLAUDE.md >> /tmp/implementation.md
```

### Step 5: Build Verification Section
**Sources:**
- Evidence & Storage (AGENTS.md 530-539)
- Testing & Evaluation (AGENTS.md 536-539)
- Branch & Tracker Guidance (AGENTS.md 657-668)
- Blocker Protocol (AGENTS.md 670-673)
- File & Naming Rules (AGENTS.md 1327-1347)

```bash
# Create Verification section
echo "## [Verification] Standards & Conventions" > /tmp/verification.md
sed -n '530,539p' AGENTS.md >> /tmp/verification.md
sed -n '657,668p' AGENTS.md >> /tmp/verification.md
sed -n '670,673p' AGENTS.md >> /tmp/verification.md
sed -n '1327,1347p' AGENTS.md >> /tmp/verification.md
```

### Step 6: Build Technical Reference Section
**Sources:**
- MCP Quick Reference (AGENTS.md 675-724)
- Chat-Mode Helpers (AGENTS.md 726-736)
- Subagents & Genie (AGENTS.md 738-747)
- Tool Requirements (AGENTS.md 1349-1357)

```bash
# Create Technical Reference section
echo "## [Technical Reference] Tools & Integration" > /tmp/technical.md
sed -n '675,724p' AGENTS.md >> /tmp/technical.md
sed -n '726,736p' AGENTS.md >> /tmp/technical.md
sed -n '738,747p' AGENTS.md >> /tmp/technical.md
sed -n '1349,1357p' AGENTS.md >> /tmp/technical.md
```

### Step 7: Build Core Prompt Section
**Source:** AGENTS.md Agent Playbook (770-1608) - comprehensive behavioral instructions

```bash
# Create Core Prompt section
echo "## [Core Prompt] Agent Playbook" > /tmp/core-prompt.md
sed -n '770,1608p' AGENTS.md >> /tmp/core-prompt.md
```

### Step 8: Assemble Final File
**Action:** Concatenate all sections in order

```bash
# Assemble merged file
cat /tmp/header.md \
    /tmp/discovery.md \
    /tmp/implementation.md \
    /tmp/verification.md \
    /tmp/technical.md \
    /tmp/core-prompt.md \
    > MERGED.md
```

### Step 9: Update Cross-References
**Action:** Replace file-to-file references with section references

```bash
# Update @ references that point to sections within same file
sed -i 's/`@AGENTS.md`\.md §/§/g' MERGED.md
```

### Step 10: Validate Completeness
**Action:** Run all validation greps from Section 5

```bash
# Execute validation suite
bash /tmp/validate-merge.sh
```

---

## 6. Validation Approach

### Pre-Merge Validation
**Check source files unchanged:**
```bash
# Verify source files haven't been modified during merge
md5sum AGENTS.md CLAUDE.md > /tmp/pre-merge-checksums.txt
```

### Structural Validation
**Verify all major sections present:**
```bash
# Check all top-level sections exist
grep "^## \[" MERGED.md | sort > /tmp/merged-sections.txt

# Expected sections:
# [Meta] Context Loading & Self-Awareness
# [Discovery] Framework Foundations
# [Implementation] Agent Architecture & Patterns
# [Verification] Standards & Conventions
# [Technical Reference] Tools & Integration
# [Core Prompt] Agent Playbook
```

### Content Completeness Validation
**Key concept grep patterns:**

```bash
#!/bin/bash
# validate-merge.sh

echo "=== AGENTS.md Content Verification ==="

# Core workflow
echo -n "Plan → Wish → Forge → Review: "
grep -qi "plan.*wish.*forge.*review" MERGED.md && echo "✅" || echo "❌"

# Behavioral guardrails
echo -n "Evidence-Based Thinking: "
grep -qi "evidence-based thinking" MERGED.md && echo "✅" || echo "❌"

echo -n "Publishing Protocol: "
grep -qi "publishing protocol" MERGED.md && echo "✅" || echo "❌"

echo -n "Delegation Discipline: "
grep -qi "delegation discipline" MERGED.md && echo "✅" || echo "❌"

echo -n "Role Clarity Protocol: "
grep -qi "role clarity protocol" MERGED.md && echo "✅" || echo "❌"

echo -n "Triad Maintenance: "
grep -qi "triad maintenance" MERGED.md && echo "✅" || echo "❌"

# Technical patterns
echo -n "Agent Sessions: "
grep -qi "agent.*session" MERGED.md && echo "✅" || echo "❌"

echo -n "Permission Mode: "
grep -qi "permissionmode.*default" MERGED.md && echo "✅" || echo "❌"

echo -n "@ / ! / patterns: "
grep -qi "agent file network" MERGED.md && echo "✅" || echo "❌"

echo ""
echo "=== CLAUDE.md Content Verification ==="

# Claude-specific patterns
echo -n "No Backwards Compatibility: "
grep -qi "no backwards compatibility" MERGED.md && echo "✅" || echo "❌"

echo -n "Forge MCP Task Pattern: "
grep -qi "forge mcp task pattern" MERGED.md && echo "✅" || echo "❌"

echo -n "Evidence-Based Challenge Protocol: "
grep -qi "evidence-based challenge protocol" MERGED.md && echo "✅" || echo "❌"

echo ""
echo "=== @ Reference Preservation ==="

# Critical context loading preserved
echo -n "`@AGENTS.md`.md reference: "
grep -q "^`@AGENTS.md`.md" MERGED.md && echo "✅" || echo "❌"

echo -n "`@MASTER-PLAN.md` reference: "
grep -q "@.genie/MASTER-PLAN.md" MERGED.md && echo "✅" || echo "❌"

echo -n "`@SESSION-STATE.md` reference: "
grep -q "@.genie/SESSION-STATE.md" MERGED.md && echo "✅" || echo "❌"

echo -n "`@USERCONTEXT.md` reference: "
grep -q "@.genie/USERCONTEXT.md" MERGED.md && echo "✅" || echo "❌"

echo ""
echo "=== Line Count Comparison ==="

# Calculate expected merged line count (approximate)
AGENTS_LINES=$(wc -l < AGENTS.md)
CLAUDE_UNIQUE_LINES=115  # Lines 23-138 (unique patterns)
CLAUDE_REFS_REMOVED=38   # Reference sections removed (140-177)
OVERHEAD=50              # Section headers, spacing

EXPECTED=$((AGENTS_LINES + CLAUDE_UNIQUE_LINES - CLAUDE_REFS_REMOVED + OVERHEAD))
ACTUAL=$(wc -l < MERGED.md)

echo "Expected lines: ~$EXPECTED"
echo "Actual lines: $ACTUAL"

DIFF=$((ACTUAL - EXPECTED))
if [ $DIFF -lt 100 ] && [ $DIFF -gt -100 ]; then
    echo "Line count variance: ✅ (within tolerance)"
else
    echo "Line count variance: ⚠️  (investigate: $DIFF lines difference)"
fi
```

### Cross-Reference Validation
**Verify all § references resolve:**
```bash
# Extract all § section references
grep -o "§[A-Za-z ]*" MERGED.md | sort -u > /tmp/section-refs.txt

# Check each reference exists as a section header
while read ref; do
    section="${ref#§}"
    grep -q "^## $section" MERGED.md || echo "Missing: $section"
done < /tmp/section-refs.txt
```

### Deduplication Validation
**Verify no unintended duplicates:**
```bash
# Check for repeated large blocks (>10 lines)
# This detects if any sections were accidentally duplicated
python3 -c "
import sys
from collections import Counter

with open('MERGED.md') as f:
    lines = f.readlines()

# Check for repeated 10-line blocks
blocks = [tuple(lines[i:i+10]) for i in range(len(lines)-10)]
counts = Counter(blocks)

duplicates = [(count, block) for block, count in counts.items() if count > 1]

if duplicates:
    print('⚠️  Found repeated blocks:')
    for count, block in sorted(duplicates, reverse=True)[:5]:
        print(f'  {count}x: {block[0][:50]}...')
else:
    print('✅ No large duplicate blocks found')
"
```

### Before/After Comparison Metrics

| Metric | AGENTS.md | CLAUDE.md | MERGED.md (Expected) |
|--------|-----------|-----------|----------------------|
| Total Lines | 1609 | 231 | ~1725 |
| Top-Level Sections | 19 | 9 | 6 (reorganized) |
| @ References | 0 | 4 | 4 (preserved) |
| Behavioral Guardrails | 8 sections | 2 patterns | 10 (consolidated) |
| Technical Patterns | 11 | 4 | 15 (merged) |
| Cross-File References | 0 | 4 | 0 (internalized) |

---

## 7. Post-Merge Validation Checklist

### Content Verification
- [ ] All 19 AGENTS.md sections accounted for in MERGED.md
- [ ] All 4 CLAUDE.md unique patterns embedded in MERGED.md
- [ ] @ file references preserved EXACTLY (lines 1-19)
- [ ] No content loss detected via grep validation
- [ ] Cross-references updated from file-to-file to section-to-section

### Structural Verification
- [ ] Discovery → Implementation → Verification framework applied
- [ ] All subsections logically organized
- [ ] Section headers follow consistent formatting
- [ ] Code blocks properly fenced
- [ ] Lists properly formatted

### Quality Verification
- [ ] No duplicate large blocks detected
- [ ] Line count within tolerance (~1725 ± 100 lines)
- [ ] All § references resolve to existing sections
- [ ] Markdown renders correctly (no broken formatting)
- [ ] No orphaned references to AGENTS.md or CLAUDE.md files

### Functional Verification
- [ ] @ references auto-load context files when MERGED.md loaded
- [ ] Natural language routing guidance intact
- [ ] Behavioral guardrails complete and accessible
- [ ] Technical reference sections navigable
- [ ] Prompt framework elements preserved

---

## 8. Rollback Plan

**If merge validation fails:**

```bash
# Restore original files from git
git checkout AGENTS.md CLAUDE.md

# Remove failed merge attempt
rm MERGED.md

# Review validation output
cat /tmp/validate-merge.log

# Address issues in merge plan before retry
```

**Partial rollback (if minor issues):**

```bash
# Keep merged file but restore specific section from original
# Example: Restore Agent Playbook section
sed -n '770,1608p' AGENTS.md > /tmp/agent-playbook.md

# Manually patch into MERGED.md at correct location
```

---

## 9. Success Criteria

### Must Pass
✅ Zero content loss (all greps return matches)
✅ @ references preserved exactly
✅ All cross-references resolve
✅ Structural organization follows Discovery → Implementation → Verification
✅ Line count within ±100 of expected (~1725)

### Should Pass
✅ No duplicate blocks >10 lines
✅ All § references resolve cleanly
✅ Markdown renders without errors
✅ Behavioral guardrails consolidated clearly

### Nice to Have
✅ Improved navigability over separate files
✅ Clear section boundaries with visual markers
✅ Consistent heading hierarchy

---

## 10. Implementation Notes

**Execution approach:** Sequential merge via bash script
**Validation approach:** Automated grep suite + manual spot checks
**Review requirement:** Human approval before replacing AGENTS.md/CLAUDE.md

**Estimated merge time:** ~5 minutes (scripted)
**Estimated validation time:** ~2 minutes (automated)
**Estimated manual review time:** ~10 minutes

**Post-merge actions:**
1. Update CLAUDE.md to simple @ reference: `@MERGED.md`
2. Archive original AGENTS.md as `AGENTS-legacy.md` (reference only)
3. Update all documentation references to point to MERGED.md
4. Test session startup with new @ reference chain

---

## Appendix A: File Comparison Matrix

| Aspect | AGENTS.md | CLAUDE.md | MERGED.md Strategy |
|--------|-----------|-----------|-------------------|
| **Purpose** | Comprehensive framework | Context loader + patterns | Unified knowledge base |
| **@ References** | None (is referenced) | 4 critical (MASTER-PLAN, etc.) | Preserve CLAUDE.md references |
| **Audience** | All agents + users | Claude Code specifically | All agents + Claude Code |
| **Structure** | Linear, comprehensive | Manifest + patterns | Discovery → Implementation → Verification |
| **Behavioral Guardrails** | Extensive (8 sections) | Minimal (2 patterns) | Consolidated (10 total) |
| **Technical Detail** | Deep (1609 lines) | Shallow (references AGENTS) | Deep (preserve all) |
| **Maintenance** | Single source of truth | Dependent on AGENTS | Single merged source |

---

## Appendix B: Deduplication Strategy

**Delegation Discipline synthesis example:**

**Before (separate):**
- AGENTS.md lines 893-967: Comprehensive with violations
- CLAUDE.md lines 179-231: Concise with examples

**After (merged):**
```markdown
### Delegation Discipline *(CRITICAL)*

**Pattern:** Orchestrators delegate to specialists. Never implement directly when orchestrating.

**When you are orchestrating (plan/orchestrator/main):**
- ❌ NEVER use Edit tool for batch operations (>2 files)
- ❌ NEVER implement cleanup/refactoring work manually
- ✅ ALWAYS delegate to implementor for multi-file work
- ✅ Edit tool is ONLY for single surgical fixes (≤2 files)

[Insert CLAUDE.md concise examples here for clarity]

**Why:**
- Token efficiency: Specialists work in focused context
- Separation of concerns: Orchestrators route, specialists implement
- Evidence trail: Specialist sessions = documentation

**Violation history and state tracking:**
[Full AGENTS.md behavioral override section follows]
```

**Result:** Best of both (concise pattern + comprehensive violations)

---

**End of Merge Plan**

**Next Steps:**
1. Review this plan for completeness
2. Execute merge via playbook (Section 5)
3. Run validation suite (Section 6)
4. Human review of MERGED.md
5. Archive originals, update references
