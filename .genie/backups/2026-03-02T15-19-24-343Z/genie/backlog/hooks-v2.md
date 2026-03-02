# Hooks v2 - Intelligent Session Awareness

**Status:** Parked (removed 2026-02-02)
**Why parked:** Scripts weren't being copied to plugin cache + bun dependency

---

## The Soul

Hooks that make Genie *aware* of the session flow:
- Know when a wish task is being written (validate structure live)
- Know when Claude stops (did we actually complete what was asked?)
- Know session context (what wish are we forging? what task?)

## What We Had (v1 - broken)

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": { "tool_name": "Write", "file_path": ".genie/wishes/**/*.md" },
      "command": "bun ${CLAUDE_PLUGIN_ROOT}/scripts/validate-wish.ts --file \"$CLAUDE_FILE_PATH\"",
      "timeout_ms": 5000,
      "on_failure": "warn"
    },
    {
      "event": "Stop",
      "matcher": { "stop_reason": "end_turn" },
      "command": "bun ${CLAUDE_PLUGIN_ROOT}/scripts/validate-completion.ts --session \"$CLAUDE_SESSION_ID\"",
      "timeout_ms": 10000,
      "on_failure": "ignore"
    }
  ]
}
```

## Problems
1. `.ts` files not copied to plugin cache (only `smart-install.js` was)
2. `bun` dependency - not always available
3. Scripts need to be self-contained `.js` or `.cjs`

## Ideas for v2

### Wish Validation Hook
- Validate wish.md structure before write
- Check: scope section exists, acceptance criteria present, tasks defined
- Output: warn if missing sections, suggest fixes
- Could use prompt-based hook instead of script?

### Completion Awareness Hook
- On Stop: check if we're in a forge session
- Did we complete the current task?
- Should we mark task done? Move to next?
- Auto-update task status in wish.md?

### Session Context Hook
- SessionStart: detect if we're resuming a wish/forge
- Load context automatically
- "Welcome back, you were working on wish X, task 3"

### Prompt-Based Alternative
Instead of scripts, use Claude's own judgment via prompt hooks:
```json
{
  "event": "Stop",
  "hooks": [{
    "type": "prompt",
    "prompt": "Check if the current task from .genie/active-wish was completed..."
  }]
}
```

## Questions to Brainstorm
- What's the minimal viable hook that adds value?
- Script vs prompt-based - which fits genie's soul better?
- How to track "active wish" and "active task" across sessions?
- Should hooks modify files or just inform?

---

*This is a parking lot for hook ideas. When ready, run /wish to plan implementation.*
