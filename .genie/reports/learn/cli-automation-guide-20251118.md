# Learning: CLI Automation Guide (Complete Reference)
**Date:** 2025-11-18
**Teacher:** Felipe (via crontab testing)
**Type:** capability
**Severity:** high

---

## Teaching Input

User discovered executor array bug (#478) during crontab automation testing. After fix was published (v2.5.20), requested comprehensive documentation of all CLI automation capabilities.

---

## Analysis

**What:** Complete CLI automation reference guide covering all modes (task, run, monitor, view, resume, stop, status)

**Why:**
- CLI automation is a core product capability but was undocumented
- Users need clear patterns for cron, CI/CD, and script integration
- Bug fix (#478) enabled full automation - guide ensures users know how to use it

**Where:** Product documentation (user-facing)

**How:** Created comprehensive guide with:
- Quick reference table
- All 10 automation patterns (fire-and-forget, wait-for-completion, monitor, query, control, health checks, executor control, advanced patterns, CI/CD integration, logging)
- Real-world examples (crontab, GitHub Actions, Jenkins)
- Best practices and common issues

### Affected Files
- `.genie/product/cli-automation.md`: New comprehensive guide (2,296 tokens)
- `.genie/product/README.md`: Added index entry

---

## Changes Made

### File: .genie/product/cli-automation.md
**Section:** New file
**Edit type:** create

**Content:** Complete CLI automation guide covering:
1. Fire-and-Forget Tasks (genie task)
2. Wait for Completion (genie run)
3. Monitor Background Tasks (genie task monitor)
4. Query Task Status (genie list tasks, genie view)
5. Task Control (genie stop, genie resume)
6. System Health Checks (genie status)
7. Executor Control (-x flag, -m flag)
8. Advanced Patterns (parallel, error handling, chaining, retry)
9. CI/CD Integration (GitHub Actions, Jenkins examples)
10. Logging & Output (JSON parsing, log rotation)

**Reasoning:**
- Fills documentation gap for automation users
- Enables crontab/CI/CD workflows without guessing
- Provides canonical reference for all automation modes

### File: .genie/product/README.md
**Section:** Product Docs Index
**Edit type:** append

**Diff:**
```diff
@@ -6,6 +6,7 @@
 - `@.genie/product/tech-stack.md` – Technologies, architecture, dependencies
 - `@.genie/product/environment.md` – Required/optional env vars and setup
 - `@.genie/product/roadmap.md` – Phases, initiatives, and milestones
+- `@.genie/product/cli-automation.md` – Complete CLI automation guide (cron, CI/CD, scripts)
```

**Reasoning:** Makes guide discoverable via product docs index

---

## Validation

### ACE Compliance

**Semantic Deduplication:**
```bash
$ genie helper embeddings "CLI automation guide for cron CI/CD scripts" .genie/product/README.md "Product Docs Index"
{
  "max_similarity": 0.1965683440467364,
  "recommendation": "DIFFERENT (no similar content found)"
}
```
✅ No duplicates (similarity 0.19 << 0.70 threshold)

**Token Measurement:**
```bash
$ genie helper count-tokens .genie/product/cli-automation.md
2296
```
✅ 2,296 tokens added to product documentation

### How to Verify
- Guide is discoverable: `ls .genie/product/cli-automation.md`
- Index references it: `grep cli-automation .genie/product/README.md`
- Agents can load it: `@.genie/product/cli-automation.md` works in prompts
- Users can read it: Markdown renders correctly

### Follow-up Actions
- [ ] Consider adding link from main README.md for discoverability
- [ ] Could add to install wizard as "automation guide" reference
- [ ] Future: Interactive CLI tutorial mode

---

## Evidence

**Context:** Bug #478 (executor array handling) discovered during crontab testing
**Fix:** Commit a57294d2 (published in v2.5.20)
**Testing:** Verified all automation modes work correctly post-fix
**Documentation Need:** User requested comprehensive guide for all CLI automation capabilities

**Result:** Product now has canonical automation reference. Users can automate Genie tasks in cron, CI/CD, and scripts with clear patterns and examples.

---

**Learning absorbed and propagated successfully.** 🧞📚✅

**Token Impact:** +2,296 tokens (product documentation, justified by new capability)
**Net Growth:** Healthy (new user-facing feature documentation)
