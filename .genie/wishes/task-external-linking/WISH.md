---
title: "Add external_id and external_url fields to genie tasks"
date: 2026-03-29
status: SHIPPED
slug: task-external-linking
github_issue: 796
priority: P1
---

# Wish: Task External Linking — external_id + external_url

## Summary

Add `external_id` and `external_url` columns to the tasks table so genie tasks can link to GitHub Issues, Jira tickets, or any external tracker. This is the foundation for `genie connector sync`.

## Problem

genie tasks have zero linkage to external systems. During daily audits, PMs must manually fuzzy-match task titles against issue titles. At 50+ tasks across 4 repos, this is unworkable. All 4 PMs identified this as the #1 friction point in three consecutive daily syncs.

## Acceptance Criteria

- [ ] `tasks` table has `external_id TEXT` column (e.g., `automagik-dev/genie#789`)
- [ ] `tasks` table has `external_url TEXT` column (e.g., `https://github.com/automagik-dev/genie/issues/789`)
- [ ] Drizzle migration adds both columns (nullable, no default)
- [ ] `genie task create "title" --gh owner/repo#N` sets both fields automatically (external_id = `owner/repo#N`, external_url = `https://github.com/owner/repo/issues/N`)
- [ ] `genie task create "title" --external-id "JIRA-123" --external-url "https://jira.example.com/JIRA-123"` sets fields for non-GitHub systems
- [ ] `genie task link <task-id> --gh owner/repo#N` updates external fields on an existing task
- [ ] `genie task list` output includes external_id column when present (truncated to 25 chars)
- [ ] `genie task list --gh owner/repo#N` filters tasks by external_id
- [ ] `genie task get <id>` shows external_id and external_url in detail view
- [ ] Existing tests pass
- [ ] New tests cover create-with-gh, link, list-filter-by-gh

## Execution Groups

### Group 1: Schema + Migration

**Files:**
- `src/lib/task-service.ts` — add columns to INSERT/UPDATE/SELECT queries
- SQL migration file — `ALTER TABLE tasks ADD COLUMN external_id TEXT; ALTER TABLE tasks ADD COLUMN external_url TEXT;`

**Changes:**
1. Add migration: two nullable TEXT columns on `tasks` table
2. In `createTask()` (line 554), add `external_id` and `external_url` to the INSERT columns and values
3. In `updateTask()`, support updating `external_id` and `external_url`
4. In `mapTask()`, include new fields in the mapped output
5. In `buildScopeConditions()` or `listTasks()`, add filter for `external_id` matching

### Group 2: CLI Integration

**Files:**
- `src/commands/task.ts` — add `--gh`, `--external-id`, `--external-url` flags to `create` and new `link` subcommand
- `src/lib/task-service.ts` — add `linkTask()` function

**Changes:**
1. `genie task create` — add `--gh <owner/repo#N>` option that auto-expands to external_id + external_url
2. `genie task create` — add `--external-id` and `--external-url` for generic linking
3. New `genie task link <id> --gh <owner/repo#N>` subcommand — calls `updateTask()` with external fields
4. `genie task list` — add `--gh <owner/repo#N>` filter flag
5. `genie task list` — add external_id column to table output (show when non-null, truncate to 25 chars)
6. `genie task get` — show external_id and external_url in detail output

### Group 3: Tests

**Files:**
- `src/lib/task-service.test.ts` — new test cases

**Changes:**
1. Test: create task with `--gh` flag sets both external_id and external_url correctly
2. Test: `linkTask()` updates external fields on existing task
3. Test: `listTasks()` with external_id filter returns only matching tasks
4. Test: task detail view displays external fields
