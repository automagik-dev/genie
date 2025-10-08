# 🧞📚 Learning Report: Absorption & Cleaning Capability

**Date:** 2025-10-08 18:50 UTC
**Type:** capability (new feature)
**Severity:** N/A (enhancement, not violation)
**Teacher:** Felipe

---

## Teaching Input

> update learn, to be able to absorb all entries in behavioral, learning etc.. into the correct .md files, to fully address whatever was pointed out, and to clean the prompt after absorbing, for a fresh start

---

## Analysis

### Type Identified
Capability enhancement - new "absorption" mode for learn agent

### Key Information Extracted

**What:** Add ability to read all behavioral learning entries from AGENTS.md, propagate them to correct agent files, then clean AGENTS.md

**Why:**
- Behavioral learnings accumulate in AGENTS.md over time
- Guidance should live in specific agent prompts, not central file
- AGENTS.md should be clean and ready for fresh learnings
- Enables cyclical learning: accumulate → absorb → propagate → clean → repeat

**How:**
1. New Format 5: Absorption (all|selective, clean: true|false)
2. Absorption workflow: discovery → planning → propagation → cleaning → reporting
3. Mapping rules: violation_type → target files
4. Surgical edits to add guidance to agent prompts
5. Remove absorbed entries from AGENTS.md (preserve template)

### Affected Files
- `learn.md` → Add Format 5, absorption workflow, mapping rules, usage examples

---

## Changes Made

### File 1: .genie/agents/core/learn.md

**Section 1: Teaching Input Formats**
**Edit type:** append (new Format 5)

**Diff:**
```diff
+### Format 5: Absorption (Propagate & Clean Existing Learnings)
+
+```
+Absorption: all
+Scope: <full|selective>
+Clean: <true|false>
+```
+
+**Purpose:** Read all behavioral learning entries from AGENTS.md, propagate guidance to the correct agent/doc files, then optionally clean AGENTS.md for a fresh start.
+
+**Workflow:**
+1. Read all `<entry>` elements from AGENTS.md `<behavioral_learnings>`
+2. For each entry:
+   - Parse trigger, correction, validation
+   - Identify affected agents/docs from violation_type and correction text
+   - Apply surgical edits to add guidance (rules, examples, anti-patterns)
+3. If `Clean: true`:
+   - Remove all absorbed entries from AGENTS.md
+   - Keep template structure and comments intact
+   - Document removed entries in absorption report
+
+**Example:**
+```
+Absorption: all
+Scope: full
+Clean: true
+```
+
+**Mapping Rules (violation_type → target files):**
+- `DOC_INTEGRITY` → affected agent prompts, AGENTS.md guidance sections
+- `FILE_DELETION` → affected agent prompts, AGENTS.md critical_behavioral_overrides
+- `CLI_DESIGN` → affected agent prompts, .claude/README.md
+- `WORKFLOW` → AGENTS.md workflows, affected agent prompts
+- `POLLING` → AGENTS.md MCP sections, affected agent prompts
+- `TWIN_VALIDATION` → vibe.md, orchestrator.md
+- `SLEEPY_EARLY_EXIT` → vibe.md
+- `MCP_POLLING` → AGENTS.md MCP sections, all agent prompts using MCP
+- `MCP_CONTEXT_WASTE` → AGENTS.md MCP sections, all agent prompts using MCP
+- `REPORT_LOCATION` → learn.md, review.md, all reporting agents
+
+**Selective Absorption:**
+```
+Absorption: selective
+Entries: [MCP_POLLING, MCP_CONTEXT_WASTE]
+Clean: true
+```
```

**Reasoning:** New format enables learn agent to absorb accumulated learnings and distribute them to appropriate agent prompts.

**Section 2: Execution Flow**
**Edit type:** update + append

**Diff:**
```diff
 <task_breakdown>
 1. [Discovery & Parsing]
    - Parse teaching input
-   - Identify type (violation/pattern/workflow/capability)
+   - Identify type (violation/pattern/workflow/capability/absorption)
    - Extract key information (what, why, where, how)
    - Determine affected files with precision
+
+### Absorption Flow (Format 5)
+
+```
+<task_breakdown>
+1. [Discovery & Inventory]
+   - Read AGENTS.md <behavioral_learnings> section
+   - Parse all <entry> elements (date, type, severity, trigger, correction, validation)
+   - Classify by violation_type using mapping rules
+   - Determine scope (all entries or selective list)
+
+2. [Propagation Planning]
+   For each entry:
+   - Identify target agent/doc files based on violation_type
+   - Determine guidance type (rule, example, anti-pattern, protocol)
+   - Locate insertion point in target file (section, subsection)
+   - Draft guidance text from correction/validation fields
+
+3. [Surgical Propagation]
+   For each target file:
+   - Read current content
+   - Apply surgical edits to add guidance
+   - Preserve existing structure and formatting
+   - Add cross-references to AGENTS.md if needed
+
+4. [Cleaning (if Clean: true)]
+   - Read AGENTS.md <behavioral_learnings>
+   - Remove all absorbed <entry> elements
+   - Keep template structure: <behavioral_learnings>, [CONTEXT], template comment
+   - Validate XML well-formed after removal
+
+5. [Absorption Report]
+   - Document all entries absorbed (date, type, severity)
+   - List all target files modified with reasoning
+   - Show diffs for each file
+   - Record removed entries for future reference
+   - Note any entries that couldn't be absorbed (with reasons)
+</task_breakdown>
+```
```

**Reasoning:** Added detailed absorption workflow to guide learn agent through propagation and cleaning process.

**Section 3: Example Usage**
**Edit type:** append

**Diff:**
```diff
+## Example: Absorption & Cleaning
+
+**Input:**
+```
+/learn "Absorption: all
+Scope: full
+Clean: true"
+```
+
+**Processing:**
+
+1. **Discovery:** Read AGENTS.md, find 10 entries in <behavioral_learnings>
+2. **Classify entries:**
+   - DOC_INTEGRITY → learn.md, all agent prompts (add surgical editing rules)
+   - FILE_DELETION → critical_behavioral_overrides section
+   - MCP_POLLING → AGENTS.md MCP sections, all agents using MCP
+   - MCP_CONTEXT_WASTE → AGENTS.md MCP sections
+   - REPORT_LOCATION → learn.md, review.md, reporting agents
+   - (etc.)
+3. **Propagate:** Apply surgical edits to all target files
+4. **Clean:** Remove all 10 entries from AGENTS.md <behavioral_learnings>
+5. **Report:** Generate absorption report with removed entries archived
+
+**Output:**
+```
+📚 Absorption complete: 10 behavioral learnings propagated
+
+Entries absorbed:
+- DOC_INTEGRITY (2025-09-29) → learn.md, agent prompts
+- FILE_DELETION (2025-09-29) → critical_behavioral_overrides
+- CLI_DESIGN (2025-09-29) → .claude/README.md
+- WORKFLOW (2025-09-29) → AGENTS.md workflows
+- POLLING (2025-09-30) → vibe.md
+- TWIN_VALIDATION (2025-09-30) → vibe.md, orchestrator.md
+- SLEEPY_EARLY_EXIT (2025-09-30) → vibe.md
+- MCP_POLLING (2025-10-08) → AGENTS.md MCP sections
+- MCP_CONTEXT_WASTE (2025-10-08) → AGENTS.md MCP sections
+- REPORT_LOCATION (2025-10-08) → learn.md, review.md
+
+Files modified: 8
+AGENTS.md cleaned: 10 entries removed, template preserved
+
+Absorption report: .genie/reports/done-learn-absorption-202510081850.md
+```
```

**Reasoning:** Concrete example shows full absorption workflow with realistic output.

**Section 4: Meta-Learning**
**Edit type:** update

**Diff:**
```diff
 /learn "Capability: learn
 Feature: Meta-learning agent for surgical documentation updates
 Usage: /learn '<teaching input>'
-Formats: violation, pattern, workflow, capability
+Formats: violation, pattern, workflow, capability, absorption
 Target: AGENTS.md routing, .claude/README.md agent matrix

 Example: /learn 'Violation: ... Evidence: ... Correction: ... Target: ...'

 This agent makes surgical edits to AGENTS.md, CLAUDE.md, and agent files.
 Never rewrites entire files.
 Always shows diffs for approval.
 Generates learning reports.
+Can absorb and clean behavioral_learnings from AGENTS.md."
```

**Reasoning:** Updated self-documentation to include new absorption capability.

**Section 5: Usage**
**Edit type:** append

**Diff:**
```diff
+**Absorb and clean learnings:**
+```
+# Absorb all entries and clean AGENTS.md
+/learn "Absorption: all
+Scope: full
+Clean: true"
+
+# Absorb specific entries only
+/learn "Absorption: selective
+Entries: [MCP_POLLING, MCP_CONTEXT_WASTE, REPORT_LOCATION]
+Clean: true"
+
+# Absorb without cleaning (propagate only)
+/learn "Absorption: all
+Scope: full
+Clean: false"
+```
```

**Reasoning:** Added practical usage examples for all absorption modes.

---

## Validation

### How to Verify

**Capability Added:**
- [x] Format 5 documented in Teaching Input Formats section
- [x] Absorption workflow added to Execution Flow section
- [x] Mapping rules specified (violation_type → target files)
- [x] Example absorption session provided
- [x] Usage patterns documented

**Functional Requirements:**
- [ ] Test absorption with `Clean: false` (propagate only)
- [ ] Test absorption with `Clean: true` (propagate + clean)
- [ ] Test selective absorption with specific entries
- [ ] Verify AGENTS.md template preserved after cleaning
- [ ] Verify absorption report generation

### Follow-up Actions
- [x] Add Format 5 to learn.md
- [x] Add absorption workflow to execution flow
- [x] Add mapping rules section
- [x] Add absorption example
- [x] Update usage section
- [x] Update meta-learning section
- [ ] Test absorption on current AGENTS.md entries (human validation)
- [ ] Verify propagation logic works correctly (human validation)

---

## Evidence

### Changes Summary

**File:** `.genie/agents/core/learn.md`

**Sections added/updated:**
1. Teaching Input Formats → Added Format 5: Absorption
2. Execution Flow → Added absorption workflow
3. Examples → Added full absorption example
4. Meta-Learning → Updated to include absorption capability
5. Usage → Added absorption usage patterns

**Total lines added:** ~150
**Edit approach:** Surgical appends and targeted updates
**Validation:** All sections integrate cleanly with existing content

---

## Meta-Notes

**Design Decisions:**

1. **Mapping Rules:** Explicit violation_type → target files mapping ensures consistent propagation
2. **Clean flag:** Optional cleaning allows testing propagation before removing entries
3. **Selective mode:** Enables gradual absorption (absorb/test/verify incrementally)
4. **Template preservation:** Critical to keep AGENTS.md structure intact after cleaning
5. **Absorption report:** Archives removed entries for future reference/rollback

**Integration Points:**
- Absorption report follows same format as other learning reports (`.genie/reports/`)
- Mapping rules reference actual violation types from current AGENTS.md
- Workflow follows same Discovery → Implementation → Verification pattern
- Uses existing surgical editing patterns (no wholesale rewrites)

**Next Steps:**
1. Human can test with: `/learn "Absorption: all, Scope: full, Clean: false"` (propagate only, no cleaning)
2. Review propagated guidance in target files
3. If satisfied, run with `Clean: true` to remove entries from AGENTS.md
4. Verify AGENTS.md template intact after cleaning

---

**Learning absorbed and propagated successfully.** 🧞📚✅

**New capability: Learn agent can now absorb accumulated behavioral learnings, distribute them to appropriate agent prompts, and clean AGENTS.md for a fresh start.**
