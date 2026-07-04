---
name: learn
description: "Diagnose and fix agent behavioral surfaces when the user corrects a mistake — connects to Claude native memory."
---

# /learn — Behavioral Correction

When the user corrects a mistake, diagnose which behavioral surface caused it and apply one minimal, targeted fix. Interactive — runs in the foreground with the user.

## When to Use
- User corrects behavior ("no, don't do that", "you should always...") or a mistake must never recur
- A pattern of repeated errors suggests a missing rule

## Flow

1. **Diagnose before changing anything.** Read the conversation, recent changes, and relevant config to establish what went wrong and why — missing rule, stale convention, or wrong default. Name the responsible surface. If the diagnosis is ambiguous, report what you verified and ask — never guess a surface.
2. **Propose the minimal fix in plan mode:** exactly which file changes, the content, and the rationale. One learning = one surface = one change; never batch.
3. **Apply after approval**, then confirm what was learned.
4. **Persist to memory:** write a feedback memory (format below) and add it to the `.claude/memory/MEMORY.md` index so the learning survives across sessions.

## Writable Surfaces

| Surface | Path | Controls |
|---------|------|----------|
| Project conventions | `CLAUDE.md` | Commands, gotchas, coding rules |
| Agent identity | `AGENTS.md` | Role, preferences, team behavior |
| Personality | `SOUL.md` / `IDENTITY.md` | Tone, communication style |
| Global rules | `~/.claude/rules/*.md` | Cross-project behavior |
| Native memory | `.claude/memory/` | Feedback, user prefs, project context |
| Project memory | `memory/` | Project-scoped knowledge |
| Hooks | `.claude/settings.json` | Event-driven automation, gates |

## Never Touch
- Framework files — the installed genie plugin's `skills/` and `agents/`
- Other projects' files — scope is the current project only
- Source code — learn changes behavior configuration, never implementation

## Memory Format

`.claude/memory/<name>.md`:

```markdown
---
name: <concise-name>
description: <one line for relevance matching>
type: feedback
---

<The rule itself>
**Why:** <the incident or reason the user gave>
**How to apply:** <when/where this guidance kicks in>
```

## Example

"Stop using `pip install` — this system only has `uv`." → Diagnosis: no Python-tooling rule exists anywhere; surface is global rules, since it applies to every project. Proposal in plan mode: create `~/.claude/rules/python-tooling.md` (never pip; `uv tool install` for CLIs, `uv pip install` inside venvs). On approval: write the rule, then persist a `use-uv-not-pip` feedback memory and index it.

## Rules
- Plan mode gates every write — user approval is the checkpoint.
- Smallest rule that prevents recurrence — no essays.
- Every applied learning also gets a feedback memory.
