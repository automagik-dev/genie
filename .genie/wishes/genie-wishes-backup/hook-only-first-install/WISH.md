# Wish: smart-install hook — first-install only, never upgrade

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `hook-only-first-install` |
| **Date** | 2026-03-17 |

## Summary

The `smart-install.js` SessionStart hook crashes tmux sessions by running `bun install -g` with `stdio: 'inherit'` mid-session, and downgrades genie by pinning to the cached plugin version. Fix: the hook should ONLY install genie when the binary is completely missing (first-time setup). Upgrades happen via `genie update`, never automatically.

## Scope

### IN
- `genieCliNeedsInstall()` returns true ONLY when `genie` binary is not found
- `installGenieCli()` installs `@latest` (not `@${pluginVersion}`)
- Remove ALL version comparison logic from the hook
- Remove `getUpdateChannel()` (no longer needed — hook never upgrades)
- All `execSync` calls use `stdio: ['pipe', 'pipe', 'pipe']` (never `inherit`)

### OUT
- Changes to `genie update` (that's the correct upgrade path)
- Changes to plugin cache management
- Changes to dependency installation (`needsInstall` for node_modules is fine)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Hook only installs, never upgrades | Every upgrade attempt risks crashing running sessions. `genie update` is the safe upgrade path. |
| `stdio: ['pipe', 'pipe', 'pipe']` everywhere | `'inherit'` dumps output into CC protocol stream, corrupting it and crashing the session. Pipe everything. |
| Install `@latest`, not `@${pluginVersion}` | Plugin cache version lags behind npm. First-time users should get the latest. |
| Remove version comparison entirely | The hook has no business comparing versions. Binary exists = skip. Binary missing = install. |

## Success Criteria

- [ ] Hook does NOT run `bun install -g` when genie is already installed
- [ ] Hook installs `@latest` when genie is missing
- [ ] No `stdio: 'inherit'` anywhere in smart-install.js
- [ ] No version comparison logic in `genieCliNeedsInstall()`
- [ ] Running sessions survive npm @next publish events
- [ ] `bun run check` passes

## Execution Groups

### Group 1: Simplify smart-install.js

**Goal:** Make the hook first-install-only with safe stdio.

**Deliverables:**
1. `genieCliNeedsInstall()` — return `!installed` only. Remove all version/channel comparison.
2. `installGenieCli()` — install `@automagik/genie@latest`. Remove `pluginVersion` logic.
3. Remove `getUpdateChannel()` function entirely.
4. Change ALL `stdio: 'inherit'` to `stdio: ['pipe', 'pipe', 'pipe']` (including bun install, curl).
5. Remove unused `getPluginVersion()` if no other callers.

**Acceptance Criteria:**
- [ ] `genieCliNeedsInstall` is 3 lines: get version, return !installed
- [ ] No `pluginVersion` or `versionSuffix` in installGenieCli
- [ ] Zero occurrences of `stdio: 'inherit'` in the file
- [ ] `getUpdateChannel` function removed

**Validation:**
```bash
! grep "stdio: 'inherit'" plugins/genie/scripts/smart-install.js && echo "No inherit"
! grep "getUpdateChannel" plugins/genie/scripts/smart-install.js && echo "No channel check"
! grep "pluginVersion" plugins/genie/scripts/smart-install.js | grep -v "getPluginVersion" && echo "No version pinning"
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 2: Validate

**Goal:** Full CI pass.

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1

---

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Simplify smart-install.js |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | reviewer | Full validation |

---

## Files to Create/Modify

```
plugins/genie/scripts/smart-install.js — simplify to first-install only
```
