---
type: entity
created: 2026-03-25
updated: 2026-03-25
tags: [product, genie, architecture, marketing-ready]
---

# Genie Product Deep Dive — Marketing-Ready Intelligence

## What Genie Is (One Sentence)
An AI orchestration CLI that turns vague ideas into shipped PRs — you describe the problem, Genie interviews you, plans the work, dispatches parallel agents, reviews the code, and hands you a PR.

## The Core Metaphor
"Seven brilliant musicians, no conductor, no sheet music, no shared key signature. The music is cacophony — and you're the one with the headache." Genie is the conductor.

## The Problem: Context Collapse
Developers in 2026 aren't struggling because AI can't code. They're struggling because they've become human clipboards — copying context between 7 agent tabs. The problem is the absence of orchestration, not the absence of intelligence.

## Killer Stats
- 48 PRs merged in 7 days
- 0.7h (42 min) average merge time
- 96% SHIP rate (first review cycle)
- 14 built-in skills
- 46 CLI commands
- Works with any AI provider (BYOA)

## "Wait, It Does THAT?" Moments (Ranked)
1. **Overnight Mode** — Queue wishes before bed, wake up to reviewed PRs. Not a metaphor.
2. **Self-Fixing Agents** — FIX-FIRST auto-dispatches /fix (max 2 loops), escalates only if stuck.
3. **10-Critic Council** — 10 specialist AI perspectives debate and vote on your architecture.
4. **96% SHIP Rate** — Proven on itself. Genie ships Genie.
5. **Session Replay** — Rewatch any past agent session. Full searchable history.
6. **Parallel Isolated Worktrees** — 5 agents simultaneously, zero merge conflicts.
7. **Full Audit Trail** — Immutable log of every permission, tool call, state change.

## Key Taglines
- "Wishes in, PRs out." (current)
- "You shouldn't be the orchestration layer. Genie is."
- "You're the bottleneck, not your agents."
- "You make the decisions. Genie does everything else."

## Technical Differentiators
- TypeScript + Bun, single-file 305KB binary
- PostgreSQL-backed state (embedded pgserve)
- Provider-agnostic (Claude, Codex, any OpenAI-compatible)
- Git-versioned portable context (wishes, skills, memory = markdown)
- tmux-based real process isolation (not simulation)

## The Pipeline
```
/brainstorm → /wish → /work → /review → ship
```
Each stage is a skill (structured markdown). The whole thing can run autonomously overnight.
