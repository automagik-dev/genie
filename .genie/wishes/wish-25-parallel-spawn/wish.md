# Wish 25: Parallel Spawn

**Status:** COMPLETE
**Slug:** `wish-25`
**Created:** 2026-02-03
**Priority:** HIGH
**Depends:** wish-21 (event capture)

---

## Summary

Spawn multiple Claude Code workers in parallel with a single command. Track all workers, aggregate results, and report overall status.

---

## Problem Statement

### Current State
- `term work <wish-id>` spawns one worker at a time
- Must run multiple commands to spawn parallel workers
- No unified tracking of parallel work batches
- No aggregated completion status

### Desired State
- `term spawn-parallel wish-21 wish-23 wish-24` launches all three
- Unified batch tracking: "batch-001: 3 workers, 2 running, 1 complete"
- Completion notification when all workers done
- Can spawn by pattern: `term spawn-parallel 'wish-2*'`

---

## Technical Approach

### Command Interface

```bash
# Spawn specific wishes
term spawn-parallel wish-21 wish-23 wish-24

# Spawn by pattern (ready wishes matching pattern)
term spawn-parallel 'wish-2*'

# Spawn all ready wishes
term spawn-parallel --all-ready

# Spawn with options
term spawn-parallel wish-21 wish-23 --skill forge --no-auto-approve

# Limit concurrency
term spawn-parallel --all-ready --max 3
```

### Batch Tracking

Create `.genie/batches/<batch-id>.json`:
```json
{
  "id": "batch-001",
  "createdAt": "2026-02-03T20:00:00Z",
  "wishes": ["wish-21", "wish-23", "wish-24"],
  "workers": {
    "wish-21": { "paneId": "%85", "status": "running" },
    "wish-23": { "paneId": "%86", "status": "complete" },
    "wish-24": { "paneId": "%87", "status": "waiting" }
  },
  "options": {
    "skill": "forge",
    "autoApprove": true
  }
}
```

### Status Aggregation

```bash
$ term batch status batch-001
Batch batch-001: 3 workers
  ● wish-21  %85  Running   Edit src/lib/events.ts
  ✓ wish-23  %86  Complete  Passed review
  ⏳ wish-24  %87  Waiting   Bash: bun test

Progress: 1/3 complete, 1 waiting for approval
```

---

## Success Criteria

- [x] `term spawn-parallel <wish-ids...>` spawns multiple workers
- [x] All workers get correct worktree + branch (via existing term work)
- [x] Batch tracking file created with all worker info
- [x] `term batch status <batch-id>` shows aggregated status
- [x] `term batch list` shows all batches
- [x] Pattern matching works: `term spawn-parallel 'wish-2*'`
- [x] `--max N` limits concurrent workers
- [x] Notification when batch completes (all workers done)

---

## Implementation Groups

### Group A: Batch management
1. Create batch registry (`.genie/batches/`)
2. Generate batch IDs
3. CRUD operations for batches

### Group B: Parallel spawning
1. Parse wish-id arguments (explicit or pattern)
2. Validate all wishes exist and are ready
3. Spawn workers via existing `term work` logic
4. Record in batch registry

### Group C: Concurrency control
1. `--max N` flag to limit concurrent workers
2. Queue remaining wishes
3. Auto-spawn next when one completes (via wish-21 events)

### Group D: Status commands
1. `term batch status <batch-id>`
2. `term batch list`
3. `term batch cancel <batch-id>` - stop all workers in batch

### Group E: Completion notification
1. Subscribe to worker completion events
2. Update batch status
3. Notify when all workers complete (or one fails)

---

## Files to Create/Modify

- `src/lib/batch-manager.ts` (NEW)
- `src/term-commands/spawn-parallel.ts` (NEW)
- `src/term-commands/batch.ts` (NEW)
- `src/term.ts` (add commands)

---

## Dependencies

- wish-21: Event capture (for completion tracking)
- wish-22: Worktree enforcement (each worker gets correct worktree)
- Existing: `term work` logic for individual spawning
