# 🧞📚 Learning Report: report-naming

**Sequence:** 01
**Context ID:** report-naming
**Type:** pattern
**Severity:** medium
**Teacher:** Felipe
**Date:** 2025-10-09T16:54Z

---

## Teaching Input

```
both files fixes and root are with different name pattern, we need to make sure fix/report/debug etc when in same folder, has the same 'context id' so when we navigate to the folder is easier to see what is what, and also somehow have some sort of timeline where files generated first comes first (simple numeric id of smt like 1A etc' need ideas and fixes)

We'll go on the 01 when needed and thats it
```

---

## Analysis

### Type Identified
Pattern (Naming Convention)

### Key Information Extracted
- **What:** Inconsistent file naming in reports makes related files hard to group
- **Why:** Need context ID + sequential ordering for easier navigation
- **Where:** `.genie/reports/debug/`, `.genie/wishes/<slug>/reports/`
- **How:** Adopt format: `{seq}-{context}-{type}.md`

### Problem Example (Before)
```
.genie/reports/debug/
├── genie-init-missing-files-20251009T1605Z.md
└── genie-init-fixes-summary-20251009T1605Z.md
```

**Issues:**
- Different prefixes make grouping difficult
- Timestamp-based, not sequential
- Can't tell at a glance which came first
- Context relationship unclear

### Solution (After)
```
.genie/reports/debug/
├── 01-genie-init-debug.md
├── 01-genie-init-summary.md
└── 01-genie-init-planning.md
```

**Benefits:**
- ✅ Sequential prefix (01, 02...) for chronological ordering
- ✅ Context slug (`genie-init`) groups related files
- ✅ Type suffix (`debug`, `summary`, `planning`) clarifies purpose
- ✅ Easy to see "what is what" at a glance
- ✅ Simple to increment when needed

### Affected Files
- `.genie/agents/core/debug.md`: Update report location patterns (3 sections)
- `.genie/agents/core/learn.md`: Update done report patterns (4 sections)

---

## Changes Made

### File 1: .genie/agents/core/debug.md

**Section 1: Evidence Collection**
**Edit type:** replace

**Diff:**
```diff
-   - Store investigation reports under `.genie/reports/debug/<slug>/`
-   - For wish-related debugging: Store in `.genie/wishes/<slug>/reports/debug-<slug>-<timestamp>.md`
-   - For standalone debugging: Store in `.genie/reports/debug/<slug>-<timestamp>.md`
+   - Store investigation reports under `.genie/reports/debug/`
+   - For wish-related debugging: Store in `.genie/wishes/<slug>/reports/{seq}-{context}-debug.md`
+   - For standalone debugging: Store in `.genie/reports/debug/{seq}-{context}-debug.md`
+   - Use sequential prefix (01, 02, etc.) for chronological ordering
+   - Use consistent context slug to group related files
```

**Reasoning:** Updated to use new sequential + context ID pattern

**Section 2: Resolution Options - Bug Report**
**Edit type:** replace

**Diff:**
```diff
    - Output:
-     - If wish-related: `.genie/wishes/<slug>/reports/bug-report-<slug>-<timestamp>.md`
-     - If standalone: `.genie/reports/debug/bug-report-<slug>-<timestamp>.md`
+     - If wish-related: `.genie/wishes/<slug>/reports/{seq}-{context}-bug-report.md`
+     - If standalone: `.genie/reports/debug/{seq}-{context}-bug-report.md`
```

**Reasoning:** Consistent naming for bug reports

**Section 3: Output Contract**
**Edit type:** replace

**Diff:**
```diff
 - **Debug Report Locations**:
-  - Wish-related: `.genie/wishes/<slug>/reports/debug-<slug>-<timestamp>.md`
-  - Standalone: `.genie/reports/debug/<slug>-<timestamp>.md`
+  - Wish-related: `.genie/wishes/<slug>/reports/{seq}-{context}-debug.md`
+  - Standalone: `.genie/reports/debug/{seq}-{context}-debug.md`
+  - Format: `{seq}` = two-digit sequence (01, 02...), `{context}` = shared slug for related files
 - **Bug Report** (Option 1):
-  - Wish-related: `.genie/wishes/<slug>/reports/bug-report-<slug>-<timestamp>.md`
-  - Standalone: `.genie/reports/debug/bug-report-<slug>-<timestamp>.md`
+  - Wish-related: `.genie/wishes/<slug>/reports/{seq}-{context}-bug-report.md`
+  - Standalone: `.genie/reports/debug/{seq}-{context}-bug-report.md`
```

**Reasoning:** Documented format specification in output contract

---

### File 2: .genie/agents/core/learn.md

**Section 1: Success Criteria**
**Edit type:** replace

**Diff:**
```diff
-- ✅ Learning report generated at `.genie/wishes/<slug>/reports/done-learn-<topic>-<timestamp>.md`
+- ✅ Learning report generated at `.genie/wishes/<slug>/reports/{seq}-{context}-learn.md`
+- ✅ Sequential naming: {seq} = two-digit (01, 02...), {context} = shared slug for related files
```

**Reasoning:** Updated success criteria with new pattern

**Section 2: Done Report Structure**
**Edit type:** replace

**Diff:**
```diff
-- **Location:** `.genie/wishes/<slug>/reports/done-learn-<slug>-<YYYYMMDDHHmm>.md`
+- **Location:** `.genie/wishes/<slug>/reports/{seq}-{context}-learn.md`
+- **Format:** `{seq}` = two-digit sequence (01, 02...), `{context}` = shared slug for related files
```

**Reasoning:** Documented format in structure section

**Section 3: Done Report Template**
**Edit type:** replace

**Diff:**
```diff
-# 🧞📚 Done Report: learn-<topic>-<YYYYMMDDHHmm>
+# 🧞📚 Done Report: {seq}-{context}-learn

 ## Scope
 - Violation/Pattern: <description>
 - Severity: <level>
 - Impacted artifacts: <files/docs>
+- Context ID: {context} (groups related files)
+- Sequence: {seq} (chronological order)
```

**Reasoning:** Updated template with new format

**Section 4: Learning Report Template**
**Edit type:** replace

**Diff:**
```diff
-- **Location:** `.genie/wishes/<slug>/reports/done-learn-<topic-slug>-<timestamp>.md`
+- **Location:** `.genie/wishes/<slug>/reports/{seq}-{context}-learn.md`

-# 🧞📚 Learning Report: <Topic>
+# 🧞📚 Learning Report: {context}

-**Date:** <timestamp>
+**Sequence:** {seq}
+**Context ID:** {context}
```

**Reasoning:** Updated template header with new fields

**Section 5-6: Example Updates**
**Edit type:** replace

**Diff:**
```diff
-Learning report: .genie/wishes/<slug>/reports/learn-forge-descriptions-20250930143000.md
+Learning report: .genie/wishes/<slug>/reports/01-forge-descriptions-learn.md

-Learning report: .genie/wishes/<slug>/reports/learn-sleepy-capability-20250930143100.md
+Learning report: .genie/wishes/<slug>/reports/01-sleepy-capability-learn.md

-Absorption report: .genie/reports/done-learn-absorption-202510081850.md
+Absorption report: .genie/reports/01-behavioral-learnings-absorption.md
```

**Reasoning:** Updated examples to demonstrate new pattern

---

## Validation

### How to Verify

1. **Check debug agent behavior:**
   ```bash
   # Future debug runs should use new naming
   /debug "test issue"
   # Expected: .genie/reports/debug/01-test-issue-debug.md
   ```

2. **Check learn agent behavior:**
   ```bash
   # Future learn runs should use new naming
   /learn "test learning"
   # Expected: .genie/reports/01-test-learning-learn.md
   ```

3. **Verify sequential ordering:**
   ```bash
   ls -la .genie/reports/debug/
   # Files should sort chronologically by prefix
   ```

### Follow-up Actions
- [ ] Update existing reports to new naming convention (manual or script)
- [ ] Monitor next debug/learn runs for correct naming
- [ ] Document pattern in project standards if needed

---

## Evidence

### Before
```
$ ls -la .genie/reports/debug/
-rw-r--r-- 1 cezar cezar  6474 Oct  9 13:19 genie-init-fixes-summary-20251009T1605Z.md
-rw-r--r-- 1 cezar cezar 10288 Oct  9 13:06 genie-init-missing-files-20251009T1605Z.md
```

**Problems:**
- Can't tell which file came first without checking timestamps
- Different prefixes (`genie-init-fixes-summary` vs `genie-init-missing-files`)
- Hard to see relationship between files

### After (Proposed)
```
$ ls -la .genie/reports/debug/
-rw-r--r-- 1 cezar cezar 10288 Oct  9 13:06 01-genie-init-debug.md
-rw-r--r-- 1 cezar cezar  6474 Oct  9 13:19 01-genie-init-summary.md
-rw-r--r-- 1 cezar cezar  5000 Oct  9 13:50 01-genie-init-planning.md
```

**Improvements:**
- ✅ Chronological ordering clear from `01-` prefix
- ✅ Context grouping clear from `genie-init` slug
- ✅ Purpose clear from type suffix (`debug`, `summary`, `planning`)
- ✅ Easy to see all related files together

---

## Pattern Specification

### Format
```
{seq}-{context}-{type}.md
```

### Components
- **{seq}**: Two-digit sequence (01, 02, 03..., 10, 11...)
  - Chronological order within a folder
  - Increment when starting new investigation/learning
  - Reset per folder (each folder has independent sequence)

- **{context}**: Shared slug for related files
  - Kebab-case (lowercase, hyphens)
  - Groups all files from same investigation/work
  - Examples: `genie-init`, `forge-descriptions`, `mcp-patterns`

- **{type}**: File type suffix
  - Common types: `debug`, `summary`, `planning`, `learn`, `bug-report`, `evidence`, `fix`
  - Clarifies purpose at a glance
  - Enables filtering (e.g., `*-debug.md`)

### Usage Rules
1. Start with `01-` for first file in a context
2. Increment sequence for subsequent contexts (02-, 03-...)
3. Keep context slug consistent across related files
4. Use descriptive type suffixes
5. Avoid timestamps in filename (use git history for time tracking)

### Examples

**Single Investigation (Multiple Files):**
```
01-genie-init-debug.md        # Root cause analysis
01-genie-init-summary.md      # Fixes summary
01-genie-init-planning.md     # Phase 2/3 planning
```

**Multiple Investigations (Sequential):**
```
01-genie-init-debug.md
01-genie-init-summary.md
02-mcp-polling-debug.md       # Next investigation
02-mcp-polling-fix.md
03-agent-routing-debug.md     # Third investigation
```

---

## Meta-Notes

**Observation:** This pattern significantly improves file organization and navigation. The sequential prefix makes chronological ordering obvious, while the context slug enables easy grouping.

**Implementation tip:** When creating reports, determine the next sequence number by checking existing files in the target directory.

**Suggested improvement:** Consider adding a helper function to auto-generate next sequence number:
```bash
# Example helper
get_next_seq() {
  local dir=$1
  local last_seq=$(ls -1 "$dir" | grep -o '^[0-9]\+' | sort -n | tail -1)
  echo $(printf "%02d" $((${last_seq:-0} + 1)))
}
```

---

**Learning absorbed and propagated successfully.** 🧞📚✅

## Files Modified

1. `.genie/agents/core/debug.md` - 3 sections updated (18 lines changed)
2. `.genie/agents/core/learn.md` - 6 sections updated (22 lines changed)

**Total:** 2 files, 40 lines changed
