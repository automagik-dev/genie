---
title: "Fix: Daily Metrics Agent — Better Metrics, Signature, Persistent Deploy"
date: 2026-03-24
status: SHIPPED
slug: fix-metrics-agent
---

# Fix: Daily Metrics Agent

## Summary

Fix the daily metrics agent: add Genie signature with ISO timestamp, add LoC/commits/PRs metrics, update both repo and persistent copies.

## Scope

### IN
- Fix README metrics table format with HTML comment markers and ISO timestamp
- Add 3 new metrics: Lines changed (24h), Commits (24h), Pull requests (24h)
- Update tools: run-metrics.sh, parse-metrics.py, update-readme.py, commit-formatter.sh
- Update both copies: `.genie/agents/metrics-updater/` (repo) AND `/home/genie/agents/namastexlabs/genie/metrics-updater/` (persistent)
- Refine AGENT.md with CEO feedback

### OUT
- Self-refinement loop changes (already built)
- Cron setup (already done)

## Acceptance Criteria

- [ ] Table has `<!-- METRICS:START — Updated by Genie Metrics Agent at <ISO8601> -->` top marker
- [ ] Table has `<!-- METRICS:END — 🧞 automagik/genie -->` bottom marker
- [ ] Table includes 7 rows: releases/day, avg bugfix time, SHIP rate, LoC changed (24h), commits (24h), PRs (24h), parallel agents
- [ ] `bash tools/run-metrics.sh --dry-run` shows correct values
- [ ] Persistent copy at `/home/genie/agents/namastexlabs/genie/metrics-updater/` matches repo copy
- [ ] AGENT.md updated with feedback about table format and quality expectations

## Execution Groups

### Group 1: Fix metrics tools and table format

**Goal:** Update all metrics tools to fetch LoC/commits/PRs, sign the table, use ISO timestamps.

**Deliverables:**
1. Update `tools/parse-metrics.py`:
   - Add LoC calculation: `git log --since="24 hours ago" --stat --format="" | awk '/files? changed/ {adds+=$4; dels+=$6} END {print adds+dels}'`
   - Add commits count: `git log --since="24 hours ago" --oneline | wc -l`
   - Add PRs count: use gh API to count PRs created in last 24h
   - Output: add `loc_changed_24h`, `commits_24h`, `prs_24h` to metrics JSON

2. Update `tools/update-readme.py`:
   - New table format with signature markers:
     ```
     <!-- METRICS:START — Updated by Genie Metrics Agent at 2026-03-24T23:45:00Z -->
     | Metric | Value |
     |--------|-------|
     | Releases/day | 17 |
     | Avg bug-fix time | 1.7h |
     | SHIP rate | 100% |
     | Lines changed (24h) | 12,450 |
     | Commits (24h) | 34 |
     | Pull requests (24h) | 8 |
     | Parallel agents | 5 |
     <!-- METRICS:END — 🧞 automagik/genie -->
     ```
   - Drop the "Updated" column — the timestamp is in the HTML comment

3. Update `tools/run-metrics.sh`:
   - Pass repo root to parse-metrics.py for git log commands
   - Ensure LoC/commits metrics work correctly

4. Update `tools/commit-formatter.sh`:
   - Include new metrics in commit message

5. Update AGENT.md with CEO feedback about quality expectations

6. Copy all updated files to persistent location: `/home/genie/agents/namastexlabs/genie/metrics-updater/`

7. Run `bash tools/run-metrics.sh --dry-run` to verify

**Acceptance:**
- Dry run outputs all 7 metrics with correct values
- Table has signature markers
- Both copies updated

**depends-on:** none

---

### Group 2: Review and validate

**Goal:** Verify the agent works end-to-end

**Deliverables:**
1. Run dry-run, verify output format
2. Check both copies match
3. Verify no broken scripts

**depends-on:** 1
