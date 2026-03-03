# Issue 001: Agent splits user's active window instead of target window

**Status:** OPEN
**Severity:** UX Bug
**Found:** 2026-02-04
**Reporter:** Felipe (via Guga session)

## Problem

When an agent (OpenClaw/Guga) wants to create a split pane for collaborative work, it incorrectly splits the **user's currently active window** instead of:
1. Using a dedicated window for the task
2. Or asking where to split

## What Happened

1. User asked to set up genie-cli work with "a split pane to your right"
2. Agent ran `tmux split-window -h -t genie:1.0` (guga's window)
3. This split the window the user was actively using
4. User had to report the bug

## Expected Behavior

Agent should:
1. **Use the dedicated window** (genie:5 "genie-cli" was already created for this)
2. Or **create a new window** for the task
3. Or **ask the user** which window to split
4. NEVER split the user's active session window without explicit permission

## Root Cause

Agent assumed "split pane to your right" meant "split the current window" rather than understanding the user meant "in the genie-cli dedicated space".

## Fix Options

1. **Convention:** Agents should never split window :1 (main agent window) - always use dedicated task windows
2. **Detection:** Check if target window is the agent's main session before splitting
3. **Explicit:** Always ask before splitting, or only split windows the agent created

## Notes

This is more of an agent behavior issue than a genie-cli code issue, but documenting here for the pattern.
