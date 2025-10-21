# Done Report: qa-<slug>-<YYYYMMDDHHmm>
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
## Executive Summary
- **Checklist items tested:** X/Y
- **New scenarios discovered:** A
- **Bugs found:** B (C critical, D high, E medium)
- **Checklist items added:** F

## Test Matrix

### Checklist Items (from @.genie/qa/checklist.md)
| Item | Category | Status | Evidence |
|------|----------|--------|----------|
| <name> | <cat> | ✅ Pass | cmd-<name>-<ts>.txt |
| <name> | <cat> | ❌ Fail | error-<name>-<ts>.txt |

### New Scenarios (discovered during this run)
| Scenario | Category | Status | Added to Checklist |
|----------|----------|--------|-------------------|
| <name> | <cat> | ✅ Pass | ✅ Yes (via learn) |

## Bugs Found

### 🔴 CRITICAL (X)
**[BUG] <Description>**
- **Reproduction:** <steps>
- **Expected:** <behavior>
- **Actual:** <behavior>
- **Evidence:** .genie/qa/evidence/ (created during test execution)<file>
- **Filed:** Issue #XX
- **Owner:** <agent/person>

### 🟠 HIGH (X)
(same format)

### 🟡 MEDIUM (X)
(same format)

## Learning Summary

**Items added to checklist:**
1. <Item name> (<category>)
2. <Item name> (<category>)

**Learn agent sessions:**
- Session <id>: Added <item>
- Session <id>: Added <item>

## Evidence Archive
Location: .genie/qa/evidence/ (created during test execution)

**Terminal outputs:** X files
**Screenshots:** Y files
**Logs:** Z files

## Coverage Analysis
- **<Category 1>:** X/Y tested (Z%)
- **<Category 2>:** X/Y tested (Z%)
- **Overall:** X/Y scenarios validated (Z%)

## Follow-Ups
1. <Action> - <Priority>
2. <Action> - <Priority>

## Verdict
**Status:** <APPROVED | BLOCKED>
**Confidence:** <LOW | MEDIUM | HIGH>
**Recommendation:** <action items>

