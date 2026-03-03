# Pane & Terminal Orchestration v2

**Status:** BACKLOG
**Priority:** HIGH
**Created:** 2026-02-08

---

## Problem

Current pane/terminal management is a workaround, not a solution. The `--pane` flags added recently are band-aids — they shift the cognitive load onto the LLM to track and specify pane targets manually.

## Vision

Pane and terminal orchestration should be **fully automatic**. When a worker is spawned:
- Panes land in the right place, always
- Worktree context is pre-loaded
- No manual `--pane` targeting needed
- The system tracks pane-to-worker mapping internally

The goal: **zero cognitive overhead for the LLM** when managing terminals.

## Context

- Previous experiments have been tried (see wish history)
- This is complex enough to need a dedicated, focused wish cycle
- Not a quick fix — needs brainstorm → wish → careful implementation

## Open Questions

- What's the right abstraction? Session-per-worker? Window-per-worker? Pane-per-worker?
- How does the system know "where" to put things without being told?
- How to handle multi-pane workflows (e.g., editor + test runner)?
- Can we eliminate `--pane` flags entirely?

---

*Parked for focused brainstorm session.*
