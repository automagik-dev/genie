# Wish: Fix session hook channel + release workflow skip

**Status:** DRAFT
**Slug:** `fix-session-hook-channel`
**Created:** 2026-03-16

---

## Summary

Two related CI/release bugs: (1) The `smart-install.js` SessionStart hook always installs `@automagik/genie@<pluginVersion>` from npm `latest`, overwriting dev builds. (2) The release workflow skips when `[skip ci]` appears anywhere in the squash merge body, even though only version bump sub-commits have that tag.

---

## Scope

### IN
- Read `updateChannel` from `~/.genie/config.json` in `smart-install.js`
- When `next`: skip version-mismatch reinstall (never overwrite dev builds)
- When `latest` (default): keep current behavior (pin to plugin version)
- Remove hardcoded `worktreeBase: '.worktrees'` from `createDefaultConfig()`
- Fix release workflow `[skip ci]` check to only match the commit title, not the full body

### OUT
- Changes to `genie update` command
- Auto-updating `@next` builds (dev users update manually)
- Changes to the plugin cache sync mechanism

---

## Decisions

- **DEC-1:** When `updateChannel === 'next'`, `genieCliNeedsInstall()` returns `false` — never overwrite a dev build. Dev users run `genie update --next` manually.
- **DEC-2:** `getUpdateChannel()` reads directly from config JSON (no zod parsing needed in this script — it's a standalone hook, not part of the genie runtime).
- **DEC-3:** Remove `worktreeBase` from `createDefaultConfig()` since the schema now handles the default dynamically.
- **DEC-4:** Release workflow `if` condition should check only the first line of the commit message (the title), not the entire body. Use `contains(github.event.head_commit.message | split('\n') | first, '[skip ci]')` or equivalent.

---

## Success Criteria

- [ ] With `updateChannel: "next"` in config, SessionStart does NOT reinstall genie CLI
- [ ] With `updateChannel: "latest"` (or missing), SessionStart behaves as before
- [ ] `createDefaultConfig()` does not set `worktreeBase`
- [ ] Release workflow fires on squash merges that have `[skip ci]` only in sub-commit lines
- [ ] `bun run check` passes

---

## Assumptions

- **ASM-1:** Dev users always set `updateChannel: "next"` via `genie update --next` (which already sets this).

## Risks

- **RISK-1:** User on `next` never gets auto-updated — acceptable, dev users expect manual control.

---

## Execution Groups

### Group 1: Fix smart-install.js

**Goal:** Make the SessionStart hook respect `updateChannel` config.

**Deliverables:**
1. Add `getUpdateChannel()` function — reads `~/.genie/config.json`, returns `'latest'` or `'next'`
2. Update `genieCliNeedsInstall()` — return `false` when channel is `next`
3. Update `installGenieCli()` — use `@next` tag when channel is `next`
4. Remove `worktreeBase: '.worktrees'` from `createDefaultConfig()` terminal config

**Acceptance Criteria:**
- [ ] `getUpdateChannel()` returns `'latest'` when config missing
- [ ] `getUpdateChannel()` returns `'next'` when config has `updateChannel: "next"`
- [ ] `genieCliNeedsInstall()` returns `false` when on `next` channel
- [ ] `createDefaultConfig()` omits `worktreeBase`

**Validation:**
```bash
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 2: Fix release workflow skip-ci check

**Goal:** Prevent `[skip ci]` in squash merge body from skipping the release.

**Deliverables:**
1. In `.github/workflows/release.yml` line 14, change the `if` condition to only check the first line (title) of the commit message, not the full body

**Acceptance Criteria:**
- [ ] `if` condition uses `startsWith` or splits on newline to check only the title
- [ ] A commit like `chore: rolling promotion\n\n* chore(version): bump [skip ci]` would NOT be skipped

**Validation:**
```bash
# Verify YAML is valid
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```

**depends-on:** none

---

### Group 3: Validate

**Goal:** Full CI pass.

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1, Group 2

---

## QA Criteria

- [ ] Start a new Claude Code session with `updateChannel: "next"` — genie version unchanged
- [ ] Start a new Claude Code session with `updateChannel: "latest"` — genie updates to plugin version
- [ ] `~/.genie/config.json` created fresh by hook does not contain `worktreeBase`

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
plugins/genie/scripts/smart-install.js — add getUpdateChannel(), update genieCliNeedsInstall() and installGenieCli(), fix createDefaultConfig()
.github/workflows/release.yml — fix [skip ci] check to title-only
```
