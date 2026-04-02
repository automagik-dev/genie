# Wish: Genie TUI — native tmux theme, scripts, and install

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `tmux-tui` |
| **Date** | 2026-03-17 |

## Summary

Ship a complete Genie TUI experience via `install.sh` and `genie update`. Custom dark theme (purple/cyan/gold palette), clickable tabs, top info bar (version, git status, CPU, RAM, clock), bottom tab bar, vi-mode, mouse support — all native tmux, zero plugins. Scripts bundled in the npm package at `scripts/tmux/` (repo root), installed to `~/.genie/scripts/`. All paths use `$HOME` — never hardcoded.

## Scope

### IN
- Bundle tmux scripts in npm package: `genie-git.sh`, `cpu-info.sh`, `ram-info.sh`, `genie-update-check.sh`
- Remove Dracula dependency — inline `utils.sh` helpers into each script
- Generate complete `.tmux.conf` with Genie dark theme (all native tmux, no plugins)
- **All 3 install paths deploy tmux TUI:**
  1. `install.sh` → `configure_tmux_defaults()` writes full config + copies scripts
  2. `smart-install.js` (SessionStart hook after `bun install -g`) → copies scripts + writes config on first run
  3. `genie update` → `syncPlugin()` refreshes scripts at `~/.genie/scripts/`
- Script paths in `.tmux.conf` reference `~/.genie/scripts/` (not Dracula plugin paths)

### OUT
- Dracula plugin installation or dependency
- Changes to tmux keybindings (keep current ones)
- Windows support
- Changes to genie CLI behavior

## Decisions

| Decision | Rationale |
|----------|-----------|
| Scripts at `~/.genie/scripts/` | Stable path, not tied to npm version. `genie update` refreshes. |
| Scripts in npm at `scripts/tmux/` (repo root) | Symlinks in `plugins/genie/` don't survive npm. Use repo root like `skills/`. `syncPlugin()` copies separately. |
| No Dracula dependency | We customized everything — the plugin is dead weight. Inline the 2 helper functions. |
| All paths use `$HOME`, never hardcoded | Version display uses `$(genie --version)` not `grep ... /home/user/.bun/...`. Scripts use `$HOME/.genie/`. |
| CPU via /proc/stat on Linux | `top -bn2` takes ~2s per refresh — too slow for tmux status. `/proc/stat` is instant. macOS falls back to `ps`. |
| Full `.tmux.conf` on install, warn + backup | Users get full experience. Existing config backed up. Warning message during install: "Genie will configure tmux. Your existing config will be backed up." |
| `genie update` refreshes scripts only, not `.tmux.conf` | Don't overwrite user customizations. Only scripts update. |

## Success Criteria

- [ ] Fresh `install.sh` sets up full TUI with theme, top bar, clickable tabs
- [ ] `bun install -g` + new CC session → TUI deployed via smart-install hook
- [ ] `genie update` refreshes scripts at `~/.genie/scripts/`
- [ ] No Dracula plugin referenced anywhere
- [ ] Scripts work on Linux and macOS
- [ ] Top bar shows: 🧞 Automagik Genie v{version} | git status | CPU | RAM | clock
- [ ] Bottom bar shows clickable tabs with purple active/lavender inactive
- [ ] `bun run check` passes

## Execution Groups

### Group 1: Bundle tmux scripts

**Goal:** Create self-contained tmux scripts without Dracula dependency.

**Deliverables:**
1. Create `scripts/tmux/genie-git.sh` — git status (branch, staged, modified, ahead/behind). Inline `get_tmux_option()` helper. No Dracula dependency.
2. Create `scripts/tmux/cpu-info.sh` — CPU usage. Linux: read `/proc/stat` (instant, no `top`). macOS: `ps -A -o %cpu`. Inline helpers.
3. Create `scripts/tmux/ram-info.sh` — RAM usage. Support Linux + macOS. Inline helpers.
4. Create `scripts/tmux/genie-update-check.sh` — version check with 30min cache. Use `$HOME/.genie/` paths, not hardcoded.
5. Create `scripts/tmux/genie.tmux.conf` — complete tmux config template. All script paths use `$HOME/.genie/scripts/`. Version display uses `$(genie --version)`. Genie dark theme, clickable tabs, top info bar, keybindings.
6. All scripts must be `chmod +x`

**Acceptance Criteria:**
- [ ] Scripts run standalone without Dracula plugin
- [ ] `genie-git.sh` shows branch + status in a git repo
- [ ] `cpu-info.sh` outputs CPU percentage on Linux
- [ ] `ram-info.sh` outputs RAM usage on Linux
- [ ] `.tmux.conf` template uses `$HOME/.genie/scripts/` paths, no hardcoded home dirs
- [ ] `cpu-info.sh` uses `/proc/stat` on Linux (not `top`)

**Validation:**
```bash
bash scripts/tmux/genie-git.sh && echo "git OK"
bash scripts/tmux/cpu-info.sh && echo "cpu OK"
bash scripts/tmux/ram-info.sh && echo "ram OK"
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 2: Install + update integration (all 3 paths)

**Goal:** All install paths deploy the TUI: `install.sh`, `smart-install.js` (bun install -g), and `genie update`.

**Deliverables:**
1. Update `install.sh` → `configure_tmux_defaults()`:
   - Copy scripts from package `scripts/tmux/` to `~/.genie/scripts/` (chmod +x)
   - Warn user: "Genie will configure tmux. Your existing config will be backed up."
   - Back up existing `.tmux.conf` to `.tmux.conf.bak` (if exists and differs)
   - Write full `genie.tmux.conf` template to `~/.tmux.conf`
   - Run `tmux source-file ~/.tmux.conf` if tmux is running
2. Update `plugins/genie/scripts/smart-install.js`:
   - Add `configureTmux()` function — same logic as install.sh but in JS
   - Copy scripts from npm package (`scripts/tmux/`) to `~/.genie/scripts/`
   - On first run (no `~/.tmux.conf` or no "Genie" marker in it): write full config with backup
   - On subsequent runs: only refresh scripts, don't touch `.tmux.conf`
   - Call `configureTmux()` after `installGenieCli()` in the main flow
3. Update `src/genie-commands/update.ts` → `syncPlugin()`:
   - Copy `scripts/tmux/*.sh` from npm package root to `~/.genie/scripts/`
   - Do NOT overwrite `~/.tmux.conf` on update (only scripts)

**Acceptance Criteria:**
- [ ] `install.sh` creates `~/.genie/scripts/` with all 4 scripts + writes `.tmux.conf`
- [ ] `bun install -g` + new CC session → `smart-install.js` deploys scripts + config
- [ ] `genie update` refreshes scripts but not `.tmux.conf`
- [ ] Scripts are executable after all 3 install paths
- [ ] Existing `.tmux.conf` backed up before overwrite

**Validation:**
```bash
ls -la ~/.genie/scripts/genie-git.sh ~/.genie/scripts/cpu-info.sh ~/.genie/scripts/ram-info.sh
bun run typecheck && bun run lint && bun test
```

**depends-on:** Group 1

---

### Group 3: Validate

**Goal:** Full CI pass + manual TUI verification.

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1, Group 2

---

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Bundle tmux scripts |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Install + update integration |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | reviewer | Full validation |

---

## QA Criteria

- [ ] Fresh install produces working TUI with theme
- [ ] `genie update` refreshes scripts without breaking config
- [ ] Top bar shows version, git, CPU, RAM, clock
- [ ] Tabs are clickable and styled (purple active)
- [ ] No references to Dracula plugin

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
scripts/tmux/genie-git.sh — NEW
scripts/tmux/cpu-info.sh — NEW
scripts/tmux/ram-info.sh — NEW
scripts/tmux/genie-update-check.sh — NEW
scripts/tmux/genie.tmux.conf — NEW (template)
install.sh — update configure_tmux_defaults()
plugins/genie/scripts/smart-install.js — add configureTmux()
src/genie-commands/update.ts — update syncPlugin() to copy tmux scripts
```
