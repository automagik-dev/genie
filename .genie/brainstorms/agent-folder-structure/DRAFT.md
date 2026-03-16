# Brainstorm: Agent Folder Structure — Built-in Agents as Boilerplates

**Slug:** `agent-folder-structure`
**Date:** 2026-03-15

## Problem

Built-in agents (implementor, tester, reviewer, leader, etc.) are defined as inline objects in `src/lib/builtin-agents.ts` — a name, a system prompt string, a model, a category. There's no folder structure, no memory, no identity files. Meanwhile, real agents like genie-pm, genie-engineer have full folder structures:

```
genie-pm/
├── memory/
├── AGENTS.md
├── HEARTBEAT.md
└── SOUL.md
```

Users who want to create their own agents have no boilerplate to follow. The built-in agents should serve as examples of how to structure an agent — full folders shipped with genie that users can copy, customize, or learn from.

## Current State

### Built-in agents today (`builtin-agents.ts`)
```typescript
{ name: 'implementor', description: '...', systemPrompt: '...', category: 'role', promptMode: 'append' }
```

No folder, no files — just a JS object. The system prompt is an inline string.

### Real agents (what works in practice)
```
genie-pm/
├── memory/              # Persistent learnings
│   ├── feedback_*.md    # User corrections
│   └── project_*.md     # Project context
├── AGENTS.md            # Identity + instructions (loaded as system prompt)
├── HEARTBEAT.md         # Periodic check-in routine
└── SOUL.md              # Personality, values, communication style
```

### What `plugins/genie/agents/` has today
```
plugins/genie/agents/
├── implementor.md       # One-file agent definition
├── tests.md
├── fix.md
├── trace.md
├── refactor.md
├── council.md
├── council--questioner.md
├── council--sentinel.md
├── ... (more council members)
├── learn.md
├── spec-reviewer.md
├── quality-reviewer.md
└── docs.md
```

These are Claude Code agent definitions (`.md` files that define subagent_type for the Agent tool). They're NOT the same as built-in genie agents. They're used by Claude Code's native Agent tool, not by `genie spawn`.

## Questions to Resolve

### 1. What files should each agent folder have?

Candidates:
- **AGENTS.md** — Identity, role, instructions, conventions. This IS the system prompt when spawned.
- **SOUL.md** — Personality, values, tone. Separates WHO from WHAT.
- **HEARTBEAT.md** — What to do on periodic check-ins (relevant for long-running agents like PM).
- **memory/** — Persistent learnings folder.
- **CLAUDE.md** — Project-specific instructions (or is this per-project, not per-agent?).

Which of these does every agent need vs which are optional?

### 2. Where should these folders live?

Options:
- `plugins/genie/agents/<name>/` — shipped with the package, users see them as boilerplates
- `~/.genie/agents/<name>/` — global, user-managed, writable
- Both — ship boilerplates in plugin, users copy to `~/.genie/agents/` to customize

### 3. How does this connect to `genie dir` and `genie spawn`?

Currently:
- `genie dir add <name> --dir <path>` registers a user agent by folder path
- `genie spawn <name>` resolves from directory → built-in → error
- Built-in agents use inline `systemPrompt`, not a folder

If built-ins become folders, `genie spawn implementor` should resolve to the built-in folder and load `AGENTS.md` from it — same as user agents.

### 4. What about the existing `plugins/genie/agents/*.md` files?

These are Claude Code Agent tool definitions. They coexist with genie agents but serve a different purpose. Do we:
- Merge them (each folder has both the genie identity AND the CC agent definition)?
- Keep them separate?
- Remove them (if genie spawn replaces the Agent tool)?

### 5. Do agents need memory out of the box?

The `memory/` folder is for runtime learnings. Should built-in boilerplate agents ship with empty memory, or is memory a user-created artifact?

## Decisions Made

### 1. What files per agent?
- **AGENTS.md** — every agent. Instructions + Claude Code frontmatter (name, tools, color, model). Source of truth for both `genie spawn` and CC Agent tool.
- **SOUL.md** — only for agents with distinct personality:
  - `team-lead` — "you exist for one wish, execute it, stop"
  - Council members — each inspired by a real person's philosophy (Ryan Dahl, Linus Torvalds, Troy Hunt, etc.)
- No custom `memory/` folder — use Claude native auto memory
- No `HEARTBEAT.md` — not needed for built-in agents

### 2. Where do they live?
`plugins/genie/agents/<name>/` — shipped with the package. Users see them as boilerplates.

### 3. How does `genie spawn` resolve?
`builtin-agents.ts` becomes a resolver that scans `plugins/genie/agents/*/AGENTS.md`. No more inline prompt strings in TypeScript. The file path is passed directly via `--append-system-prompt-file`.

### 4. Claude Code Agent tool unification?
Symlinks. Each `plugins/genie/agents/<name>.md` symlinks to `<name>/AGENTS.md`. One file, both systems read it. No duplication.

```
plugins/genie/agents/
├── implementor/
│   └── AGENTS.md                              # Source of truth
├── implementor.md → implementor/AGENTS.md     # Symlink for CC Agent tool
├── team-lead/
│   ├── AGENTS.md
│   └── SOUL.md
├── team-lead.md → team-lead/AGENTS.md
├── council--questioner/
│   ├── AGENTS.md
│   └── SOUL.md                                # Ryan Dahl's philosophy
├── council--questioner.md → council--questioner/AGENTS.md
└── ...
```

### 5. Memory?
Claude native auto memory only. No custom per-agent memory folder.

## Full Agent List

### With SOUL.md (personality-driven)
| Agent | Soul | Inspired by |
|-------|------|-------------|
| team-lead | Single-purpose wish executor | — |
| council--questioner | Challenge assumptions, foundational simplicity | Ryan Dahl |
| council--benchmarker | Performance evidence, benchmark-driven | Matteo Collina |
| council--simplifier | Complexity reduction, minimalist | TJ Holowaychuk |
| council--sentinel | Security oversight, blast radius | Troy Hunt |
| council--ergonomist | Developer experience, API usability | Sindre Sorhus |
| council--architect | Systems thinking, backwards compatibility | Linus Torvalds |
| council--operator | Operations reality, infrastructure readiness | Kelsey Hightower |
| council--deployer | Zero-config deployment, CI/CD | Guillermo Rauch |
| council--measurer | Observability, profiling, metrics | Bryan Cantrill |
| council--tracer | Production debugging, high-cardinality | Charity Majors |

### Without SOUL.md (functional roles)
| Agent | Purpose |
|-------|---------|
| implementor | Write code, follow conventions, signal done |
| tester | Write tests, run them, report failures |
| reviewer (spec-reviewer) | Review against wish criteria → SHIP/FIX-FIRST/BLOCKED |
| reviewer (quality-reviewer) | Review code quality, security, maintainability |
| fixer | Fix gaps from review, re-run review |
| trace | Read-only root cause investigation |
| docs | Documentation audit + generation |
| refactor | Code restructuring |
| learn | Behavioral improvement (diagnose + apply) |

## WRS Status

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```
