# Wish 24: Worker Dashboard

**Status:** COMPLETE
**Slug:** `wish-24`
**Created:** 2026-02-03
**Priority:** HIGH
**Depends:** wish-21 (event capture)

---

## Summary

Real-time CLI/TUI view of all active workers showing current state, last event, and pending approvals. Know what's happening across all parallel workers at a glance.

---

## Problem Statement

### Current State
- `term workers` shows basic pane list
- No visibility into what each worker is currently doing
- Must manually `tmux capture-pane` to see worker output
- No aggregated view of all worker activity

### Desired State
- Single command shows all workers with live status
- See: wish-id, current tool, last event, time since last activity
- Highlight workers waiting for approval
- Refresh automatically or on-demand

---

## Technical Approach

### Dashboard Data Sources

1. **Event stream** (wish-21) - real-time tool calls, completions
2. **Workers registry** (.genie/workers.json) - pane mappings
3. **tmux** - pane existence, basic status

### Display Modes

**Simple (default)**: `term dashboard`
```
┌─────────────────────────────────────────────────────────────┐
│ WORKERS                                          3 active   │
├─────────────────────────────────────────────────────────────┤
│ wish-21  %85  ● Running   Edit src/lib/events.ts    2s ago │
│ wish-23  %86  ⏳ Waiting  Bash: bun test           45s ago │
│ wish-24  %87  ● Running   Read wish.md              5s ago │
└─────────────────────────────────────────────────────────────┘
```

**Watch mode**: `term dashboard --watch`
- Auto-refresh every 2 seconds
- Highlight changes
- Show event stream at bottom

**Verbose**: `term dashboard -v`
- Show full tool parameters
- Show recent event history per worker

---

## Success Criteria

- [x] `term dashboard` shows all active workers with current state
- [x] Workers waiting for approval highlighted (⏳)
- [x] Last event and time-since shown per worker
- [x] `--watch` mode auto-refreshes
- [x] Works with wish-21 event stream
- [x] Graceful fallback if event stream unavailable (show basic tmux info)

---

## Implementation Groups

### Group A: Event aggregation
1. Subscribe to wish-21 event stream
2. Maintain in-memory state per worker (last event, status, timestamp)
3. Handle worker start/stop events

### Group B: Dashboard rendering
1. Table layout with worker rows
2. Color coding: running (green), waiting (yellow), error (red)
3. Truncate long values, show time-ago format

### Group C: Watch mode
1. Terminal clearing and re-render
2. 2-second refresh interval
3. Highlight changed rows

### Group D: CLI integration
1. `term dashboard` command
2. Flags: --watch, --verbose, --json
3. Handle Ctrl+C gracefully in watch mode

---

## Files to Create/Modify

- `src/term-commands/dashboard.ts` (NEW)
- `src/lib/event-aggregator.ts` (NEW or shared with wish-23)
- `src/term.ts` (add dashboard command)

---

## Dependencies

- wish-21: Event capture (for real-time updates)
- Fallback: works without wish-21 but with reduced functionality
