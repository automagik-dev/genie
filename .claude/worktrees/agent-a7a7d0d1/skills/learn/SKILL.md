---
name: learn
description: "Interactive learning mode — explore context, absorb user knowledge, generate plan, apply behavioral improvements."
---

# /learn — Behavioral Learning Mode

Interactive session to make Genie smarter about this project. Explore the codebase, absorb user knowledge, propose behavioral changes, and apply them with explicit approval.

## When to Use
- User wants to teach Genie about project conventions, preferences, or constraints
- Agent behavior needs tuning based on project-specific knowledge
- New project onboarding — capture domain knowledge early
- User explicitly invokes `/learn`

## How It Works

This is an **interactive skill**. It is not dispatched as a background worker by the orchestrator. The user invokes `/learn` directly, and the agent runs in the foreground, conversing with the user throughout.

## Flow
1. **Explore context:** scan codebase structure, existing docs, CLAUDE.md, memory files, identity files, project history. Build a baseline understanding before asking the user anything.
2. **Learning mode:** interactive Q&A with the user. Ask one question at a time. Absorb knowledge about conventions, patterns, constraints, preferences, and domain-specific rules. Verify understanding before moving on.
3. **Generate learning plan:** enter native plan mode. Show exactly which files will be created or updated, what content will change, and why each change improves behavior. User must approve before any write proceeds.
4. **Apply learnings:** update only the approved surfaces. Each change is minimal and targeted. Report what was learned and what changed.

## Writable Surfaces

The learn agent is allowed to modify these surfaces — and only these:

- `.claude/memory/` — persistent knowledge files
- `CLAUDE.md` — project instructions, conventions, rules
- Project-level agent definitions (if the project defines its own outside the framework)
- `SOUL.md`, `IDENTITY.md`, `BOOTSTRAP.md` — Genie's own agent workspace identity
- Any configuration file that shapes agent behavior in this project

## Never-Touch Surfaces

The learn agent never modifies these — they are framework-scoped:

- `plugins/genie/skills/` — framework skills are maintained by framework developers
- `plugins/genie/agents/` — framework agents are maintained by framework developers
- Other projects' files — scope is the current project only
- Source code — learn updates behavior configuration, not implementation

## Rules
- **Plan mode is mandatory** — never write without user approval via native plan mode.
- **One question at a time** — never batch questions during learning mode.
- **Never assume** — verify with the user before recording any learning.
- **Never modify framework files** — `plugins/genie/skills/` and `plugins/genie/agents/` are off limits.
- **Never write source code** — behavioral configuration only.
- **Explore before asking** — read the codebase first so questions are informed, not generic.
- **Verify before applying** — confirm understanding with the user before proposing changes.
