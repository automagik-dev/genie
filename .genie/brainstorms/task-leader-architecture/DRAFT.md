# Brainstorm: Task Leader Architecture

**Slug:** `task-leader-architecture`
**Date:** 2026-03-14

## Problem

The PM session (user typing `genie` in a folder) is conflated with task execution. When the PM creates a team and spawns workers, those workers can't message the PM back (#566) because the PM is a Claude Code native teammate, not in genie's agent registry. The PM also can't effectively manage multiple parallel tasks because it's stuck orchestrating one team at a time.

## Core Insight

The PM should delegate, not execute. When a wish is ready for work, the PM spawns a **task leader** — a dedicated agent in the team's worktree that owns the full lifecycle (hire → implement → review → PR → QA). Workers report to the task leader. The PM monitors task leaders.

## Proposed Hierarchy

```
PM (user session — strategic, planning, decisions)
├── Task Leader A (spawned agent — owns wish-a lifecycle)
│   ├── implementor (hired by leader A)
│   ├── reviewer
│   └── tester
├── Task Leader B (spawned agent — owns wish-b lifecycle)
│   ├── implementor (hired by leader B)
│   └── reviewer
└── ...parallel tasks
```

## What Changes

### Team Creation Flow (current → proposed)

**Current:**
```bash
genie team create fix/my-feature --repo /path --branch dev
# Creates worktree + team config. PM is implicit leader.
genie team hire implementor --team fix/my-feature
genie spawn implementor --team fix/my-feature
# PM manually orchestrates via genie send / genie read
```

**Proposed:**
```bash
genie team create fix/my-feature --repo /path --branch dev
# Creates worktree + team config + spawns a task leader in the worktree
# Task leader gets wish context injected, runs /work autonomously
# Task leader hires its own members, manages lifecycle
# PM monitors via genie read / genie send to the task leader
```

### Key Design Questions

1. **How does the task leader get the wish?**
   - Option: `genie team create fix/my-feature --repo /path --wish skill-refresh`
   - The wish slug links to `.genie/wishes/<slug>/WISH.md`
   - Task leader reads it on startup and begins `/work`

2. **Is the task leader a built-in role?**
   - Yes: add `leader` to built-in agents with a system prompt that says "you own this wish lifecycle"
   - The leader's prompt includes: team management, `/work` orchestration, PR workflow, QA loop
   - Different from the PM — the leader is execution-focused, the PM is strategy-focused

3. **How does the PM monitor task leaders?**
   - `genie ls` shows task leaders and their status
   - `genie send 'status update?' --to fix/my-feature-leader` — leader responds with progress
   - `genie read fix/my-feature-leader` — see what the leader is doing
   - Task leader sends milestone updates to PM: "Group 1 done", "PR created", "QA passed"

4. **How does the PM intervene?**
   - `genie send 'stop, I changed my mind about X' --to fix/my-feature-leader`
   - Leader doesn't escalate to PM — it works until done or blocked. PM watches proactively.

5. **PM is NOT addressable by task leaders.**
   - Task leader doesn't know the PM exists. Works autonomously until done.
   - PM watches via `genie ls`, `genie status`, `genie read`, sends instructions via `genie send`.
   - PM polls periodically (e.g., every 10 minutes), intervenes as needed, notifies human when done.
   - This keeps the architecture simple — no coupling between PM and task leader.

6. **What happens to `genie team create` without `--wish`?**
   - Still works — creates worktree + team, no leader spawned
   - User can manually hire and spawn as before (for ad-hoc work)
   - The `--wish` flag is the trigger for autonomous task leader

7. **Does `/dream` change?**
   - Yes: `/dream` spawns one task leader per wish instead of one implementor per wish
   - Each task leader runs the full lifecycle independently
   - PM's dream session just monitors task leaders and writes DREAM-REPORT.md

## Messaging Architecture (fixes #566)

Within a team, ALL agents are genie-spawned (leader + workers). `genie send` works bidirectionally because everyone is in the registry. No #566 problem.

The PM does NOT need to be addressable by task leaders. The task leader doesn't know the PM exists — it just works until done.

**PM → task leader:** PM watches from the outside:
- `genie ls` — see all task leaders and their status
- `genie read <leader>` — see what the leader is doing
- `genie send 'instruction' --to <leader>` — send further instructions
- `genie status <wish-slug>` — check wish group progress

**Task leader → done:** When everything is complete (all groups done, PR open, CI green, QA passed), the task leader sets a done status visible to anyone watching:
- Team config gets a `status: done` field
- Or the wish state shows all groups as `done`
- PM can poll `genie status` / `genie team ls` periodically

**PM monitoring loop:**
```
while tasks running:
  sleep 10 minutes
  check on task leaders (genie ls, genie status)
  send instructions if needed (genie send)
  if all done → notify human (WhatsApp, Slack, etc.)
```

## What This Unblocks

1. **Parallel task management** — PM spawns N task leaders for N wishes, monitors all
2. **Bidirectional messaging within teams** — leader ↔ workers all in genie registry (#566 solved)
3. **Autonomous execution** — task leaders handle everything, PM just watches
4. **PM stays strategic** — brainstorms, plans, monitors, notifies humans
5. **No architectural coupling** — task leader doesn't know about PM, can be spawned by anyone
6. **Works for any user** — solo dev types `genie`, creates a team, leader runs autonomously. No PM required.

## WRS Status

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```
