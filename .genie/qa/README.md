# QA Coordination - Master Genie Quality Assurance Framework

**Owner:** Master Genie (QA is core identity, not separate concern)
**Principle:** No release without guarantee it's better than the previous one
**Philosophy:** Test deliberately, capture evidence thoroughly, learn continuously

---

## Quick Start

**Before any release:**
```bash
# Determine release type
# Patch (v2.5.X): Bugfix only → Minimal validation
# Minor (v2.X.0): New features → Comprehensive validation
# Major (vX.0.0): Breaking changes → Exhaustive validation

# Execute appropriate QA level (see below)
# Collect evidence
# Generate Done Report
# Make GO/NO-GO decision
```

---

## Quality Guarantee Levels

### Level 1: Every Commit (Automated)
**Gate:** Pre-commit hooks
**Enforces:**
- Token efficiency baseline
- Cross-reference validity
- Worktree isolation
- User file protection
- Forge task linking

**Outcome:** Code quality baseline maintained

### Level 2: Every Push (Automated + Advisory)
**Gate:** Pre-push hooks + CI/CD
**Enforces:**
- All tests pass
- Commit advisory (issue/wish linkage)
- Changelog updated
- CLI smoke test

**Outcome:** Branch quality verified, main protected

### Level 3: Pre-Release (Coordinated QA Protocol)
**Gate:** Master Genie coordinates
**Granularity:** Release-type dependent

#### Patch Release (v2.5.X → v2.5.X+1)
**Scope:** Bugfix only, minimal risk

**Required:**
- ✅ Automated tests pass (Level 2)
- ✅ Specific bug scenario validation
- ✅ Regression check (affected area)
- ✅ Evidence captured

**Decision:** Can release if automated tests + bug validation pass

#### Minor Release (v2.X.0 → v2.X+1.0)
**Scope:** New features, moderate risk

**Required:**
- ✅ Full QA checklist execution (all 260+ items)
- ✅ QA Agent run (automated + self-improving)
- ✅ Atomic workflow validation
- ✅ Evidence for every test
- ✅ Done Report with learning summary
- ✅ Regression suite

**Decision:** Can release if >95% pass rate, no critical failures

#### Major Release (vX.0.0 → vX+1.0.0)
**Scope:** Breaking changes, architectural shifts, highest risk

**Required:**
- ✅ Full QA checklist execution
- ✅ QA Agent run (multiple iterations)
- ✅ All atomic workflows validated
- ✅ Manual exploratory testing
- ✅ Performance baseline validation
- ✅ Migration path testing
- ✅ Documentation accuracy verification
- ✅ Evidence for every scenario
- ✅ Done Report with comprehensive learning

**Decision:** Can release only if 100% pass rate, zero critical issues

---

## QA Components

### Primary Checklist
**File:** `@.genie/qa/checklist.md`
**Purpose:** Living operational checklist (260+ test items)
**Categories:** MCP operations, Layout/UI, Command Interface, Agent System, Session Lifecycle, Error Handling, Performance
**Maintenance:** Auto-updated by QA Agent via learn integration
**Status:** PRIMARY SOURCE OF TRUTH

### Atomic Test Scenarios
**Directory:** `@.genie/code/workflows/qa/`
**Purpose:** Specific, reproducible test scenarios
**Types:** Bug regression tests, feature scenarios, edge cases
**Count:** 18 scenarios (growing)
**Relationship:** Complementary to checklist (deep-dive validation)

### Bug Regression Suite
**File:** `@.genie/qa/scenarios-from-bugs.md`
**Purpose:** Auto-generated from GitHub issues
**Scope:** 53 tracked bugs (7 open, 46 fixed)
**Sync:** Via `.genie/scripts/sync-qa-from-issues.cjs`
**Guarantee:** Every fixed bug becomes permanent test

### QA Agent
**File:** `@.genie/code/agents/qa.md`
**Purpose:** Automated execution + self-improvement
**Features:** Checklist execution, pattern discovery, learn integration
**Status:** Required for minor/major releases
**Output:** Done Report with evidence + learning summary

### Evidence Repository
**Directory:** `@.genie/qa/evidence/`
**Purpose:** Reproducible test outputs
**Types:** CLI outputs (*.txt), logs (*.log), reports (*.md)
**Gitignore:** JSON/tmp files ignored, markdown committed
**Retention:** Permanent (evidence-backed releases)

---

## Master Genie QA Coordination Protocol

### Pre-Release Workflow

**Step 1: Determine Release Type**
```
Ask: What's changing?
- Bugfix only → Patch
- New features → Minor
- Breaking changes → Major

Load appropriate QA level (see Quality Guarantee Levels above)
```

**Step 2: Execute Quality Gates**
```
Automated (always):
- Run: npm run test:all
- Verify: Pre-commit/pre-push hooks passing
- Check: CI/CD green (GitHub Actions)

Manual (based on level):
- Patch: Bug-specific scenarios
- Minor: Full checklist + QA Agent
- Major: Full checklist + QA Agent + exploratory
```

**Step 3: Evidence Collection**
```
For each test:
- Capture output → .genie/qa/evidence/<test>-<timestamp>.txt
- Record status in checklist (✅/⚠️/❌)
- Document failures with reproduction steps
- Link to GitHub issues if new bugs found
```

**Step 4: Learning Integration**
```
If QA Agent discovers new patterns:
- Invoke learn agent with teaching prompt
- Checklist auto-updated
- New test items available for future runs

Example:
mcp__genie__run with agent="learn" and prompt="
Teaching: QA Checklist Update
Discovery: New validation pattern found...
Implementation: Append to checklist.md under <category>
"
```

**Step 5: Release Decision**
```
Calculate:
- Pass rate = (✅ count) / (total tests)
- Critical failures = (❌ count where severity=critical)

Decision Matrix:
┌──────────┬────────────┬──────────────────┬──────────┐
│ Type     │ Pass Rate  │ Critical Allowed │ Decision │
├──────────┼────────────┼──────────────────┼──────────┤
│ Patch    │ >90%       │ 0                │ GO/NO-GO │
│ Minor    │ >95%       │ 0                │ GO/NO-GO │
│ Major    │ 100%       │ 0                │ GO/NO-GO │
└──────────┴────────────┴──────────────────┴──────────┘

If NO-GO:
- Document blockers in GitHub issues
- Defer release until resolved
- Re-run QA after fixes
```

**Step 6: Done Report**
```
Generate using template:
@.genie/product/templates/qa-done-report-template.md

Include:
- Test matrix (all scenarios + results)
- Evidence references (file paths)
- Bugs found/fixed (with GitHub issue links)
- Learning summary (new patterns discovered)
- Coverage analysis (% validated)
- Release recommendation (GO/NO-GO + reasoning)

Save to: .genie/qa/evidence/done-report-<version>-<timestamp>.md
```

---

## Self-Improvement Loop

Every QA run makes the system smarter:

```
┌──────────────┐
│ QA Run       │
│ (Manual/Auto)│
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ New Pattern  │
│ Discovered   │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Learn Agent  │
│ Invoked      │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Checklist    │
│ Updated      │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Next QA Run  │
│ Includes New │
└──────────────┘
```

**Result:** Checklist grows organically, regression-proof, continuously improving

---

## Directory Structure

```
.genie/qa/
├── README.md                    # This file (Master coordination)
├── checklist.md                 # Living operational checklist (PRIMARY)
├── scenarios-from-bugs.md       # Auto-generated regression tests
├── evidence/                    # Test outputs
│   ├── *.txt                   # CLI outputs (committed)
│   ├── *.log                   # Logs (gitignored)
│   ├── *.md                    # Reports (committed)
│   └── *.json                  # Structured data (gitignored)
└── workflows/                   # Workflow-specific QA
    ├── voice-boot-qa-workflow.md
    └── MIGRATION_PLAN.md

.genie/code/workflows/qa/        # Atomic test scenarios (18 files)
├── README.md                    # Index (bidirectional links)
├── mcp-operations.md
├── session-lifecycle.md
├── bug-*.md                     # Bug regression tests
└── ...

.genie/code/agents/qa.md         # QA Agent (automation + self-improvement)

.genie/product/docs/qa-checklist.md  # Template (canonical format)
.genie/product/templates/qa-done-report-template.md  # Report template
```

---

## Quick Reference

**Run full QA for minor release:**
```bash
# Option 1: QA Agent (automated + self-improving)
mcp__genie__run with agent="qa" and prompt="Execute full QA for v2.X.0 release"

# Option 2: Manual (use checklist directly)
# Load: @.genie/qa/checklist.md
# Execute each test item
# Capture evidence
# Update status
```

**Run bug-specific validation:**
```bash
# Find atomic workflow
# Example: @.genie/code/workflows/qa/bug-102-session-collision.md
# Execute test steps
# Capture evidence
# Update regression suite
```

**Generate Done Report:**
```bash
# Load template: @.genie/product/templates/qa-done-report-template.md
# Fill in: test matrix, evidence, bugs, learning, decision
# Save to: .genie/qa/evidence/done-report-<version>-<timestamp>.md
```

---

## Success Metrics

**Quality Guarantee:**
- 🎯 Zero regressions in production
- 🎯 100% evidence-backed releases
- 🎯 Continuous checklist improvement
- 🎯 Fast feedback (pre-commit catches early)

**Release Confidence:**
- Patch: Can ship in <1 hour
- Minor: Can ship in <4 hours
- Major: Can ship in <1 day

**Learning Rate:**
- Every bug → permanent test
- Every QA run → 1-3 new patterns discovered
- Checklist grows organically, never shrinks

---

## Key Principles

1. **Master Genie coordinates** - QA is my responsibility, part of my identity
2. **No release without evidence** - Every test captures proof
3. **Granularity matches risk** - Patch=light, Major=exhaustive
4. **Self-improving** - Learn from every run
5. **Regression-proof** - Bugs become permanent tests
6. **Fast feedback** - Catch issues at commit time
7. **Human-friendly** - Clear reports, obvious decisions

---

**Master Genie says:** Quality is not optional. It's who I am. Every release is better than the last, guaranteed. 🎯
