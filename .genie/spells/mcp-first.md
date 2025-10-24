---
name: MCP First (Tool Usage Hierarchy)
description: MCP tools are primary interface, not optional. Use native tools only as fallback.
---

# MCP First - Tool Usage Hierarchy

## Core Principle

**MCP Genie tools are PRIMARY interface for all Genie/Agent/Spell/Forge operations, not supplementary.**

When MCP tools exist for an operation, use them first. Native tools (Read, Bash, etc.) are fallback only.

## Why MCP First

1. **Optimized:** MCP tools may have caching, better integration
2. **Superpower:** MCP is designed specifically for Genie workflows
3. **Consistency:** Using MCP ensures all agents use same interface
4. **Future-proof:** MCP layer can evolve without changing agent behavior

## Tool Hierarchy

### Spell Operations

❌ **Wrong:** `Read(.genie/spells/learn.md)`
✅ **Right:** `mcp__genie__read_spell("learn")`

**Why:** MCP spell reading may parse frontmatter, handle aliases, track usage

### Agent/Session Operations

❌ **Wrong:** Reading files in Forge worktree with `Read`
✅ **Right:** `mcp__genie__view(sessionId, full=true)`

**Why:** MCP provides structured session data, handles worktree paths automatically

### Forge Operations

❌ **Wrong:** Bash worktree commands to check status
✅ **Right:** `mcp__forge__get_task(task_id)`

**Why:** Forge API provides structured data, handles multiple worktrees

### Workspace Info

❌ **Wrong:** Reading individual files from `.genie/product/`
✅ **Right:** `mcp__genie__get_workspace_info()`

**Why:** MCP aggregates all workspace context in one call

## When to Use Native Tools

Use native tools (Read, Glob, Grep, Bash) when:
- ✅ No MCP equivalent exists
- ✅ Working with non-Genie files (implementation code, config files)
- ✅ MCP tool fails or is unavailable
- ✅ Performance-critical path exploration (Glob is very fast)

## Common Violations

### Violation 1: Reading Spells Directly
**Wrong:**
```javascript
Read(.genie/spells/delegate-dont-do.md)
```

**Right:**
```javascript
mcp__genie__read_spell("delegate-dont-do")
```

### Violation 2: Checking Forge Status with Bash
**Wrong:**
```bash
cd /var/tmp/automagik-forge/worktrees/abc123
git log --oneline -3
```

**Right:**
```javascript
mcp__forge__get_task_attempt(attempt_id="abc123")
mcp__genie__view(sessionId="abc123", full=true)
```

### Violation 3: Reading Workspace Files Individually
**Wrong:**
```javascript
Read(.genie/product/mission.md)
Read(.genie/product/tech-stack.md)
Read(.genie/product/roadmap.md)
```

**Right:**
```javascript
mcp__genie__get_workspace_info()
```

## Checklist Before Using Native Tools

Before using Read/Bash/Grep for Genie-related operations:

- [ ] Did I check if MCP tool exists for this?
- [ ] Is this a non-Genie file (implementation code)?
- [ ] Have I tried the MCP equivalent and it failed?
- [ ] Am I certain no MCP tool covers this use case?

## Evidence

**Origin:** Learning #6 from `learn.md` (lines 140-150)
**Teaching:** "The Genie MCP is your superpower. You need to rely on it as much as you can."
**Session:** `/tmp/session-ultrathink-analysis.md` lines 263-292

## Quick Reference

| Operation | ❌ Native | ✅ MCP |
|-----------|----------|--------|
| Read spell | `Read(.genie/spells/X.md)` | `read_spell("X")` |
| Check session | `Read(worktree/file)` | `view(sessionId, full=true)` |
| Get task status | `cd worktree && git log` | `get_task(task_id)` |
| Workspace info | `Read(.genie/product/*.md)` | `get_workspace_info()` |
| List agents | `ls .genie/code/agents` | `list_agents()` |
| List spells | `ls .genie/spells` | `list_spells()` |

**Remember:** MCP is my superpower. Use it.
