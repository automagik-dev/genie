---
title: "Auto-advance tasks when PRs merge via wish slug matching"
date: 2026-03-29
status: SHIPPED
slug: task-auto-close-on-merge
github_issue: 797
priority: P1
---

# Wish: Auto-Close Tasks on PR Merge

## Summary

Add a `genie task close-merged` command that scans recently merged PRs, extracts wish slugs from PR bodies, and marks corresponding genie tasks as shipped. Eliminates the #1 source of state drift — 28 stale tasks were manually reconciled in today's daily sync alone.

## Problem

When dream sessions or engineers merge PRs, genie tasks are never updated. In three consecutive daily syncs (2026-03-25, 2026-03-27, 2026-03-29), 100% of stale tasks were caused by this. The dream session on 2026-03-28 merged 15 PRs across 3 repos — zero tasks were updated until the manual daily sync the next morning.

## Approach

A CLI command (not a GH Action) that can be run manually or via cron. This avoids needing PG access from GitHub Actions and works with the existing genie CLI.

## Acceptance Criteria

- [ ] `genie task close-merged` command exists
- [ ] Scans merged PRs in the current repo's GitHub remote (last 24h by default)
- [ ] `--since <duration>` flag to customize window (e.g., `--since 48h`, `--since 7d`)
- [ ] Extracts wish slug from PR body (pattern: `Wish: <slug>` or `wish: <slug>` or `slug: <slug>`)
- [ ] For each wish slug found, looks up genie tasks with matching `wish_file` field
- [ ] Moves matched tasks from any non-shipped stage to `ship` stage
- [ ] Adds comment on each moved task: `"Auto-closed: PR #N merged to dev"`
- [ ] `--dry-run` flag shows what would be closed without acting
- [ ] `--repo <owner/repo>` flag to override GitHub remote detection
- [ ] Skips tasks already in `ship` stage (no duplicate moves)
- [ ] Outputs summary: `"Closed N tasks from M merged PRs (K already shipped)"`
- [ ] Existing tests pass
- [ ] New tests cover slug extraction, task matching, dry-run output

## Execution Groups

### Group 1: PR Scanning + Wish Slug Extraction

**Files:**
- `src/commands/task.ts` — add `close-merged` subcommand
- `src/lib/task-service.ts` — add `closeMergedTasks()` function

**Changes:**
1. New `genie task close-merged` command with `--since`, `--dry-run`, `--repo` flags
2. Use `gh pr list --state merged --json number,title,body,mergedAt` to fetch recent merged PRs
3. Parse wish slug from PR body using regex: `/(?:wish|slug):\s*(\S+)/i`
4. Also try extracting from branch name pattern: `feat/<slug>`, `fix/<slug>`
5. Return list of `{ prNumber, slug, mergedAt }` tuples

### Group 2: Task Matching + Auto-Close

**Files:**
- `src/lib/task-service.ts` — add query for tasks by wish_file
- `src/commands/task.ts` — implement the close logic

**Changes:**
1. Query tasks matching `wish_file LIKE '%<slug>%'` for each extracted slug
2. Filter to tasks NOT already in `ship` stage
3. For each matched task, call `moveTask()` to stage `ship`
4. Add comment via `addTaskComment()`: `"Auto-closed: PR #N merged to dev"`
5. In `--dry-run` mode, print the actions without executing
6. Print summary at end

### Group 3: Tests

**Files:**
- `src/lib/task-service.test.ts` or new `src/commands/task.test.ts`

**Changes:**
1. Test: wish slug extraction from PR body (various formats)
2. Test: slug extraction from branch name fallback
3. Test: task matching by wish_file
4. Test: dry-run mode produces output but no state changes
5. Test: already-shipped tasks are skipped
