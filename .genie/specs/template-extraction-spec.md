# Template Extraction Specification

**Issue:** Template duplication across Genie framework (wish is our bible - consistency is critical)
**Scope:** Extract embedded templates from workflow agents, establish @ template loading pattern
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

**Core workflow agents:**
- `.genie/agents/workflows/wish.md` (223 lines) - Embedded template lines 95-213 (118 lines)
- `.genie/agents/workflows/review.md` (415 lines) - Embedded template lines 98-187 (89 lines)
- `.genie/agents/workflows/qa.md` (351 lines) - Embedded template lines 242-311 (69 lines)

**Template variants:**
- `templates/code/.genie/agents/workflows/{wish,review,qa}.md`
- `templates/create/.genie/agents/workflows/{wish,review,qa}.md`

**Existing wish instances** (for migration):
- `.genie/wishes/*/`*-wish.md` (scan for all wish files)

## Implementation Plan

### Group A: Template Extraction

**Goal:** Extract embedded templates to `.genie/templates/`

**Deliverables:**

1. **Create `.genie/templates/wish-template.md`**
   - Extract lines 95-213 from `.genie/agents/workflows/wish.md`
   - Content: Full wish document structure (118 lines)
   - Format: Markdown with placeholders (`{FEATURE_NAME}`, `{ROADMAP-ID}`, etc.)

2. **Create `.genie/templates/review-report-template.md`**
   - Extract lines 98-187 from `.genie/agents/workflows/review.md`
   - Content: Full review report structure (89 lines)
   - Format: Markdown with score breakdown placeholders

3. **Create `.genie/templates/qa-done-report-template.md`**
   - Extract lines 242-311 from `.genie/agents/workflows/qa.md`
   - Content: QA done report structure (69 lines)
   - Format: Markdown with test matrix placeholders

**Validation:**
```bash
# Verify templates exist
ls -lh .genie/templates/*.md

# Check line counts match
wc -l .genie/templates/wish-template.md  # Should be 118
wc -l .genie/templates/review-report-template.md  # Should be 89
wc -l .genie/templates/qa-done-report-template.md  # Should be 69
```

### Group B: Update Core Workflow Agents

**Goal:** Replace embedded templates with `@` references in core agents

**Deliverables:**

1. **Update `.genie/agents/workflows/wish.md`**
   - Replace lines 94-213 (template section) with:
     ```markdown
     ## Wish Template (Saved at `.genie/wishes/<slug>/<slug>-wish.md`)

     Load the canonical wish template:
     @.genie/templates/wish-template.md

     This template defines the standard structure for all wish documents.
     Customize content within this structure, but maintain the format for consistency.
     ```
   - Reduce from 223 → ~115 lines

2. **Update `.genie/agents/workflows/review.md`**
   - Replace lines 97-187 (report template) with:
     ```markdown
     ## Report Template

     Load the canonical review report template:
     @.genie/templates/review-report-template.md

     This template defines the standard review reporting format.
     Score each matrix checkpoint and provide evidence-based deductions.
     ```
   - Reduce from 415 → ~336 lines

3. **Update `.genie/agents/workflows/qa.md`**
   - Replace lines 240-311 (done report template) with:
     ```markdown
     ## Done Report Template

     Load the canonical QA done report template:
     @.genie/templates/qa-done-report-template.md

     This template defines the standard QA reporting format.
     Document test matrix, bugs found, and learning summary.
     ```
   - Reduce from 351 → ~290 lines

**Validation:**
```bash
# Verify @ references are present
grep -n "@.genie/templates/" .genie/agents/workflows/{wish,review,qa}.md

# Check line counts reduced
wc -l .genie/agents/workflows/wish.md  # ~115 lines
wc -l .genie/agents/workflows/review.md  # ~336 lines
wc -l .genie/agents/workflows/qa.md  # ~290 lines
```

### Group C: Update Template Variants (Code + Create)

**Goal:** Apply same @ reference pattern to template variants

**Deliverables:**

1. **Update `templates/code/.genie/agents/workflows/wish.md`**
   - Same @ reference pattern as core
   - Template path: `@.genie/templates/wish-template.md` (relative from project root)

2. **Update `templates/code/.genie/agents/workflows/review.md`**
   - Same @ reference pattern as core

3. **Update `templates/code/.genie/agents/workflows/qa.md`**
   - Same @ reference pattern as core

4. **Update `templates/create/.genie/agents/workflows/wish.md`**
   - Same @ reference pattern (template path identical - `.genie/templates/` is at project root)

5. **Update `templates/create/.genie/agents/workflows/review.md`**
   - Same @ reference pattern

6. **Update `templates/create/.genie/agents/workflows/qa.md`**
   - Same @ reference pattern

**Validation:**
```bash
# Verify @ references in code variant
grep -n "@.genie/templates/" templates/code/.genie/agents/workflows/{wish,review,qa}.md

# Verify @ references in create variant
grep -n "@.genie/templates/" templates/create/.genie/agents/workflows/{wish,review,qa}.md

# Check all variants have consistent references
diff -u \
  <(grep "@.genie/templates/" .genie/agents/workflows/wish.md) \
  <(grep "@.genie/templates/" templates/code/.genie/agents/workflows/wish.md)
```

### Group D: Migrate Existing Wishes (Optional)

**Goal:** Add @ template references to existing wish instances

**Deliverables:**

1. **Add template reference to existing wishes**
   - Prepend to each `*-wish.md`:
     ```markdown
     @.genie/templates/wish-template.md

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
head -1 .genie/wishes/*/*.md | grep "@.genie/templates/wish-template.md"

# Check wishes still render correctly
for wish in .genie/wishes/*/*.md; do
  echo "=== $wish ==="
  head -5 "$wish"
done
```

## Verification Plan

**Commands to run:**
```bash
# 1. Verify template extraction
ls -1 .genie/templates/*.md
# Expected: wish-template.md, review-report-template.md, qa-done-report-template.md

# 2. Verify @ references in all workflow agents
grep -r "@.genie/templates/" .genie/agents/workflows/ templates/*/. genie/agents/workflows/
# Should show 9 matches (3 agents × 3 locations)

# 3. Check line count reduction
wc -l .genie/agents/workflows/{wish,review,qa}.md
# wish.md: ~115 lines (was 223)
# review.md: ~336 lines (was 415)
# qa.md: ~290 lines (was 351)

# 4. Test @ loading (manual verification)
# Open Claude Code and reference a wish with @ - template should load
```

**Success Criteria:**
- ✅ 3 template files created in `.genie/templates/`
- ✅ 9 workflow agents updated (3 core + 3 code + 3 create)
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
