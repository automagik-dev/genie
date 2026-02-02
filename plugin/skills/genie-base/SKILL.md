---
name: genie-base
description: "Bootstrap or migrate a Genie workspace into a new agent/body. Use when the user says 'new workspace', 'new body', 'wake up', 'divide yourself', or asks to carry progress forward."
---

# Genie Base Workspace (Bootstrap + Migration)

## Overview

Create a portable "base agent" workspace that can be dropped into any directory and immediately behave like a full Genie setup.

This skill ships a canonical set of workspace files and an installer script.

---

## Quick Install

Run the installer script:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/skills/genie-base/scripts/install-workspace.sh --dest /path/to/new/workspace
# add --force to overwrite existing files (backs up first)
```

**What it installs:**
- `AGENTS.md` - Agent behavior configuration
- `SOUL.md` - Persona/identity
- `USER.md` - User profile
- `TOOLS.md` - Available tools
- `MEMORY.md` - Long-term memory
- `HEARTBEAT.md` - Daily check-in template
- `IDENTITY.md` - Instance identity
- `ROLE.md` - Current role/mission
- `ENVIRONMENT.md` - OS/environment context
- `memory/` - Daily notes directory

---

## Post-Install Sanity Sweep

Run the sweep to catch stale paths/symlinks:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/skills/genie-base/scripts/sanity-sweep.sh --dest /path/to/new/workspace
```

If it reports matches, fix them to canonical paths:
- Canonical workspace: `/home/genie/workspace`
- tmux: shared session `genie`

---

## Behavior Guarantees

The base workspace preserves:

**Persona**
- As described in `SOUL.md`

**User Profile**
- `USER.md` contains user preferences

**Continuity**
- Daily notes in `memory/YYYY-MM-DD.md`
- Curated long-term memory in `MEMORY.md`

**Workflow Conventions**
- Use shared tmux session when applicable
- Be resourceful before asking
- Update files rather than relying on chat memory

---

## Updating the Template

When workspace files evolve, refresh the template:

1. Copy latest files into `${CLAUDE_PLUGIN_ROOT}/skills/genie-base/assets/workspace/`
2. Re-run sanity sweep
3. Test installation on fresh directory

---

## When to Use

Use this skill when the user:
- Says "new workspace" or "new body"
- Says "wake up" or "divide yourself"
- Wants to carry progress forward into a reusable template
- Asks to create a base agent
- Wants to migrate to a new machine/environment

---

## Never Do

- Install without user confirmation
- Overwrite existing files without --force flag
- Skip the sanity sweep
