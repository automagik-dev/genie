# Wish Review – {Wish Slug}
**Date:** 2024-..Z | **Status in wish:** {status}
**Completion Score:** XX/100 (XX%)

## Matrix Scoring Breakdown

### Discovery Phase (XX/30 pts)
- **Context Completeness (X/10 pts)**
  - [x] All files/docs referenced with @ notation (4/4 pts) – Evidence: context ledger complete
  - [x] Background persona outputs captured (3/3 pts) – Evidence: @.genie/wishes/<slug>/reports/done-*
  - [ ] Assumptions/decisions/risks documented (1/3 pts) – Gap: Missing risk analysis
- **Scope Clarity (X/10 pts)**
  - [x] Current/target state defined (3/3 pts)
  - [x] Spec contract with success metrics (4/4 pts)
  - [x] Out-of-scope stated (3/3 pts)
- **Evidence Planning (X/10 pts)**
  - [x] Validation commands specified (4/4 pts)
  - [x] Artifact paths defined (3/3 pts)
  - [ ] Approval checkpoints documented (0/3 pts) – Gap: No checkpoints defined

### Implementation Phase (XX/40 pts)
- **Code Quality (X/15 pts)**
  - [x] Follows standards (5/5 pts) – Evidence: passes lint checks
  - [x] Minimal surface area (4/5 pts) – Note: Some extra files modified
  - [x] Clean abstractions (5/5 pts)
- **Test Coverage (X/10 pts)**
  - [x] Unit tests (4/4 pts) – Evidence: @tests/unit/*
  - [x] Integration tests (4/4 pts) – Evidence: @tests/integration/*
  - [x] Test execution evidence (2/2 pts) – Evidence: test-results.log
- **Documentation (X/5 pts)**
  - [x] Inline comments (2/2 pts)
  - [ ] Updated external docs (0/2 pts) – Gap: README not updated
  - [x] Maintainer context (1/1 pt)
- **Execution Alignment (X/10 pts)**
  - [x] Stayed in scope (4/4 pts)
  - [x] No scope creep (3/3 pts)
  - [x] Dependencies honored (3/3 pts)

### Verification Phase (XX/30 pts)
- **Validation Completeness (X/15 pts)**
  - [x] All validation commands passed (6/6 pts)
  - [x] Artifacts at specified paths (5/5 pts)
  - [x] Edge cases tested (4/4 pts)
- **Evidence Quality (X/10 pts)**
  - [x] Command outputs logged (4/4 pts)
  - [x] Screenshots/metrics captured (3/3 pts)
  - [x] Before/after comparisons (3/3 pts)
- **Review Thoroughness (X/5 pts)**
  - [x] Human approval obtained (2/2 pts)
  - [x] Blockers resolved (2/2 pts)
  - [x] Status log updated (1/1 pt)

## Evidence Summary
| Artefact | Location | Result | Notes |
| --- | --- | --- | --- |
| Test results | @wishes/<slug>/qa/tests.log | ✅ | All 47 tests passing |
| Metrics | @wishes/<slug>/qa/metrics.json | ✅ | TTFB avg 410ms (target <500ms) |
| Screenshots | @wishes/<slug>/qa/screenshots/ | ✅ | 8 workflow screenshots captured |

## Deductions & Gaps
1. **-2 pts (Discovery):** Risk analysis incomplete in discovery summary
2. **-3 pts (Discovery):** Approval checkpoints not documented before implementation
3. **-1 pt (Implementation):** Extra files modified outside core scope
4. **-2 pts (Implementation):** README not updated with new feature

## Recommendations
1. Add risk analysis to discovery summary section
2. Document approval checkpoints for future wishes
3. Update README with feature documentation
4. Consider splitting peripheral file changes into separate PR

## Verification Commands
Summarize the validation commands executed (per wish instructions and project defaults in `@.genie/custom/tests.md` / `@.genie/custom/commit.md`) and record pass/fail status for each.

## Verdict
**Score: XX/100 (XX%)**
- ✅ **90-100:** EXCELLENT – Ready for merge
- ✅ **80-89:** GOOD – Minor gaps, approved with follow-ups
- ⚠️ **70-79:** ACCEPTABLE – Needs improvements before merge
- ❌ **<70:** NEEDS WORK – Significant gaps, blocked

**Status:** {APPROVED | APPROVED_WITH_FOLLOWUPS | BLOCKED}

## Next Steps
1. Address gaps 1-4 above (optional for approval, required for excellence)
2. Update wish status to COMPLETED
3. Update wish completion score to XX/100
4. Create follow-up tasks for deferred documentation
