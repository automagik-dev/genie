---
name: learn
description: "Diagnose and fix agent behavioral surfaces when the user corrects a mistake — connects to Claude native memory."
---

# /learn — Behavioral Correction

When a user corrects a mistake, `/learn` diagnoses which behavioral surface caused it and applies a minimal, targeted fix.

## When to Use
- User corrects agent behavior ("no, don't do that", "you should always...", "stop doing X")
- Agent made a mistake that should never recur
- User explicitly invokes `/learn`
- A pattern of repeated errors suggests a missing behavioral rule

## How It Works

This is an **interactive skill**. The user invokes `/learn` directly, and the agent runs in the foreground, conversing with the user throughout.

## Flow

1. **Analyze the mistake:** What went wrong? Read the conversation context, recent changes, and relevant code to understand the error.
2. **Determine root cause:** Why did the agent behave this way? Missing rule? Stale convention? Wrong default?
3. **Diagnose the surface:** Which behavioral surface needs to change? (See Writable Surfaces below.)
4. **Propose minimal fix:** Enter native plan mode. Show exactly which file will change, what content will be added/modified, and why. One change per learning — never batch.
5. **Apply with approval:** User must approve before any write. Apply the change. Confirm what was learned.
6. **Save to memory:** Write the learning as a feedback memory in `.claude/memory/` so Claude native memory retains it across sessions.

## Writable Surfaces

The learn agent diagnoses which surface needs the fix:

| Surface | Path | What It Controls |
|---------|------|-----------------|
| Project conventions | `CLAUDE.md` | Commands, gotchas, project rules, coding style |
| Agent identity | `AGENTS.md` | Agent role, preferences, team behavior |
| Agent personality | `SOUL.md` / `IDENTITY.md` | Tone, communication style |
| Global rules | `~/.claude/rules/*.md` | Cross-project behavioral rules |
| Claude native memory | `.claude/memory/` | Feedback, user prefs, project context |
| Project memory | `memory/` | Project-scoped knowledge files |
| Hooks | `.claude/settings.json` | Event-driven automation, permission gates |
| Any config file | varies | Any file that shapes agent behavior |

## Never-Touch Surfaces

- `plugins/genie/skills/` — framework skills (maintained by framework developers)
- `plugins/genie/agents/` — framework agents (maintained by framework developers)
- Other projects' files — scope is the current project only
- Source code — learn updates behavior configuration, not implementation

## Claude Native Memory Connection

When a learning is applied, also save it as a feedback memory:

1. Write a memory file to `.claude/memory/` with frontmatter:
   ```markdown
   ---
   name: <concise-name>
   description: <one-line description for relevance matching>
   type: feedback
   ---

   <The rule itself>
   **Why:** <reason the user gave or the incident that caused it>
   **How to apply:** <when/where this guidance kicks in>
   ```
2. Update `.claude/memory/MEMORY.md` index with a pointer to the new file.

This ensures the learning persists across conversations via Claude's native memory system.

## Example

User corrects the agent: "Stop using `pip install` — this system only has `uv`."

The agent runs `/learn`:

1. **Analyze:** Agent used `pip install python-dotenv` which failed because pip isn't installed.
2. **Root cause:** No rule in `~/.claude/rules/` about Python tooling.
3. **Surface:** Global rules (`~/.claude/rules/python-tooling.md`) — applies to all projects.
4. **Propose fix (plan mode):**
   ```
   Create ~/.claude/rules/python-tooling.md:
   - NEVER use pip or pip3 — not installed
   - Use uv tool install for persistent CLI tools
   - Use uv pip install inside venvs
   ```
5. **User approves.** File written.
6. **Save to memory:**
   ```markdown
   # ~/.claude/memory/feedback_python_tooling.md
   ---
   name: use-uv-not-pip
   description: System uses uv for Python package management, pip is not installed
   type: feedback
   ---
   Use uv instead of pip for all Python operations.
   **Why:** pip is not installed on this system; uv is the only package manager.
   **How to apply:** Any time a Python package needs installing, use uv tool install or uv pip install.
   ```

## Rules
- **Plan mode is mandatory** — never write without user approval via native plan mode.
- **One learning at a time** — diagnose one surface, propose one fix.
- **Never assume** — verify with the user before recording any learning.
- **Never modify framework files** — `plugins/genie/skills/` and `plugins/genie/agents/` are off limits.
- **Never write source code** — behavioral configuration only.
- **Minimal changes** — add the smallest rule that prevents the mistake from recurring.
- **Always save to memory** — every learning gets a feedback memory for cross-session persistence.
