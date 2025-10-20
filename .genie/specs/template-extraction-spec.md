# Template Extraction Specification
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Issue:** Template duplication across Genie framework (wish is our bible - consistency is critical)
**Scope:** Extract embedded templates from workflow agents, establish @ template loading pattern (centralized under product/templates)
**Priority:** HIGH - architectural foundation

## Problem Statement

Workflow agents (wish.md, review.md, qa.md) contain embedded templates that are:
1. Duplicated across 3 locations (core + code/create variants) = 828 lines total
2. Copied into every wish/report instance (+118-276 lines per file)
3. Hard to maintain (template updates require updating all copies)
4. Violates DRY principle and Claude Code `@` loading pattern

## Architectural Design

**Pattern:** Template extraction + dynamic loading via `@` references

**Benefits:**
- ✅ Single source of truth for templates
- ✅ Template updates propagate instantly to all instances
- ✅ Wish files shrink to ~100-200 lines (variable content only)
- ✅ Leverages Claude Code `@` feature for automatic loading
- ✅ Maintainable, scalable, consistent across variants

## Discovery (Files to Analyze)

**Current workflow/agents using templates:**
- `.genie/code/agents/wish/blueprint.md` – loads wish template
- `.genie/code/agents/review.md` – loads review report template
- `.genie/code/agents/qa.md` – loads QA done report template

**Existing wish instances** (for migration):
- `.genie/wishes/*/`*-wish.md` (scan for all wish files)

## Implementation Plan

### Group A: Template Extraction

**Goal:** Extract embedded templates to `.genie/product/templates/`

**Deliverables:**

1. **Create `.genie/product/templates/wish-template.md`**
   - Content: Full wish document structure (canonical)
   - Format: Markdown with placeholders (`{FEATURE_NAME}`, `{ROADMAP-ID}`, etc.)

2. **Create `.genie/product/templates/review-report-template.md`**
   - Content: Full review report structure (canonical)
   - Format: Markdown with score breakdown placeholders

3. **Create `.genie/product/templates/qa-done-report-template.md`**
   - Content: QA done report structure (canonical)
   - Format: Markdown with test matrix placeholders

**Validation:**
```bash
# Verify templates exist
ls -lh .genie/product/templates/*.md
```

### Group B: Update Core Workflow Agents

**Goal:** Replace embedded templates with `@` references in core agents

**Deliverables:**

1. **Update wish blueprint agent**
   - In `.genie/code/agents/wish/blueprint.md`, load:
     ```markdown
     @.genie/product/templates/wish-template.md
     ```
   - Reduce from 223 → ~115 lines

2. **Update review agent**
   - In `.genie/code/agents/review.md`, load:
     ```markdown
     @.genie/product/templates/review-report-template.md
     ```
   - Reduce from 415 → ~336 lines

3. **Update QA agent**
   - In `.genie/code/agents/qa.md`, load:
     ```markdown
     @.genie/product/templates/qa-done-report-template.md
     ```
   - Reduce from 351 → ~290 lines

**Validation:**
```bash
# Verify @ references are present
grep -n "@.genie/product/templates/" .genie/code/agents/{review.md,qa.md} .genie/code/agents/wish/blueprint.md
```

### Group C: Update Template Variants (Code + Create)

**Goal:** Apply same @ reference pattern to template variants

**Deliverables:**
- Ensure all agent references to templates point to `.genie/product/templates/`

**Validation:**
```bash
# Verify @ references in current agents
grep -n "@.genie/product/templates/" .genie/code/agents/{review.md,qa.md} .genie/code/agents/wish/blueprint.md
```

### Group D: Migrate Existing Wishes (Optional)

**Goal:** Add @ template references to existing wish instances

**Deliverables:**

1. **Add template reference to existing wishes**
   - Prepend to each `*-wish.md`:
     ```markdown
     @.genie/product/templates/wish-template.md

     # 🧞 {FEATURE NAME} WISH
     [rest of wish content]
     ```
   - Files to update:
     - `.genie/wishes/backup-update-system/backup-update-system-wish.md`
     - `.genie/wishes/mcp-permission-regression/mcp-permission-regression-wish.md`
     - `.genie/wishes/multi-template-architecture/multi-template-architecture-wish.md`
     - `.genie/wishes/provider-runtime-override/provider-runtime-override-wish.md`
     - `.genie/wishes/triad-redesign/triad-redesign-wish.md`

**Note:** This is OPTIONAL - existing wishes work without @ reference, but adding it makes template updates propagate to them.

**Validation:**
```bash
# Verify @ references added
head -1 .genie/wishes/*/*.md | grep "@.genie/product/templates/wish-template.md"

# Check wishes still render correctly
for wish in .genie/wishes/*/*.md; do
  echo "=== $wish ==="
  head -5 "$wish"
done
```

## Verification Plan

**Commands to run:**
```bash
# 1. Verify templates exist
ls -1 .genie/product/templates/*.md
# Expected: wish-template.md, review-report-template.md, qa-done-report-template.md

# 2. Verify @ references in agents
grep -r "@.genie/product/templates/" .genie/code/agents/

# 3. Check line count reduction
wc -l .genie/agents/workflows/{wish,review,qa}.md
# wish.md: ~115 lines (was 223)
# review.md: ~336 lines (was 415)
# qa.md: ~290 lines (was 351)

# 4. Test @ loading (manual verification)
# Open Claude Code and reference a wish with @ - template should load
```

**Success Criteria:**
- ✅ 3 template files created in `.genie/product/templates/`
- ✅ Agent files updated to load templates via `@.genie/product/templates/`
- ✅ All agents reduced in size (~40-50% smaller)
- ✅ `@` references load templates correctly
- ✅ Existing wishes optionally updated with @ references
- ✅ No functionality broken (agents still create wishes/reports)

## Evidence Location

Save all validation outputs to:
- `.genie/qa/template-extraction/`
  - `before-after-line-counts.txt`
  - `grep-at-references.txt`
  - `template-validation.txt`

## Done Report

After completion, produce Done Report at:
- `.genie/wishes/template-extraction/reports/done-implementor-template-extraction-<YYYYMMDDHHmm>.md`

Include:
- Files created/modified count
- Line count reduction achieved
- @ reference validation results
- Any blockers or deferred items

## Acceptance Criteria

**CRITICAL:**
- ❌ DO NOT modify template content - only extract and reference
- ❌ DO NOT change wish/report functionality - only structure
- ❌ DO NOT break existing wishes - @ loading is additive
- ✅ Template is single source of truth
- ✅ Updates to template propagate to all users
- ✅ Framework maintains "wish is our bible" consistency
