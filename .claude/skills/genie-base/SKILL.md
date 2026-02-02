---
name: genie-base
description: "Bootstrap or migrate an OpenClaw personal-assistant workspace into a new agent/body while preserving the current Genie conventions, persona, and memory files. Use when the user says things like: 'new workspace', 'new body', 'wake up buddy', 'divide yourself', 'make a base agent', 'survive for good', or asks to carry progress forward into a reusable skill/template. Includes scripts to install/update AGENTS.md/SOUL.md/USER.md/TOOLS.md/MEMORY.md/HEARTBEAT.md/IDENTITY.md and daily memory notes, plus a post-migration sanity scan for stale paths and tmux/session conventions.'"
---

# Genie Base Workspace (Bootstrap + Migration)

Goal: make a *portable* “base agent” workspace that can be dropped into a fresh OpenClaw workspace and immediately behave like the current Genie setup.

This skill ships a canonical set of workspace files in `assets/workspace/` and an installer script.

## Do the migration/install

1. **Pick the destination**
   - Usually the current workspace root (e.g. `/home/genie/workspace`).
   - If the user is creating a *new body*, target that new workspace root.

2. **Run the installer**

   ```bash
   bash skills/public/genie-base/scripts/install-workspace.sh --dest /path/to/new/workspace
   # add --force to overwrite existing files (backs up first)
   ```

   What it does:
   - Creates the destination if needed
   - Makes a timestamped backup of any files it will overwrite
   - Copies:
     - `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`, `HEARTBEAT.md`, `IDENTITY.md`
     - `memory/` daily notes directory (if missing)

3. **Post-install sanity sweep (required)**

   Run the included sweep to catch stale paths/symlinks (macOS paths, legacy `.genie/workspace`, etc.):

   ```bash
   bash skills/public/genie-base/scripts/sanity-sweep.sh --dest /path/to/new/workspace
   ```

   If it reports matches, fix them (prefer updating the file to the canonical paths):
   - Canonical workspace: `/home/genie/workspace`
   - Canonical repo: `/home/genie/workspace/khal`
   - tmux: shared session `genie` (window `khal`)

## Behavior guarantees this base should preserve

- **Persona**: as described in `SOUL.md`.
- **User profile**: `USER.md` (Felipe, preferences).
- **Continuity**:
  - Daily notes in `memory/YYYY-MM-DD.md`
  - Curated long-term memory in `MEMORY.md`
- **Workflow conventions**:
  - Khal work happens in the shared tmux session `genie` (window `khal`).
  - Prefer being “resourceful before asking”; update files rather than relying on chat memory.

## Updating the base template (when things evolve)

If you refine the workspace files over time (new rules in `AGENTS.md`, updated persona in `SOUL.md`, etc.), refresh the template shipped in this skill:

- Copy the latest files into `skills/public/genie-base/assets/workspace/`
- Re-run sanity sweep
- Re-package the skill (optional; only if you plan to distribute):

```bash
python3 /home/genie/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw/skills/skill-creator/scripts/package_skill.py skills/public/genie-base ./skills/dist
```
