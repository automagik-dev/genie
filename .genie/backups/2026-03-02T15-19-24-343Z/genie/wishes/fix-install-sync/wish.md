# Wish: Fix Install/Sync Process

**Status:** done
**Slug:** fix-install-sync
**Created:** 2026-02-03

## Summary

Fix the broken and confusing genie-cli install/update process. Currently symlinks break silently, there's no easy way to sync local dev changes, and global npm install vs local dev mode is poorly integrated.

**The outcome:** A robust `term sync` command that auto-detects context, validates/repairs broken symlinks, and provides a single unified workflow for both production and development use.

## Scope

### IN Scope
- Add `term sync` command for quick dev iteration
- Hybrid auto-detect mode: symlink when in source dir, copy otherwise
- Broken symlink detection and auto-repair in install.sh
- Proper error messages when things go wrong
- Update install.sh to handle edge cases gracefully

### OUT of Scope
- Changing the npm publish workflow
- Modifying Claude Code's plugin registry format
- Adding GUI/interactive prompts to sync (keep it fast)
- Automatic version bumping on sync
- Remote sync (only local source → local plugin)

## Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| `term sync` as global command | One command works anywhere, no path args needed |
| Auto-detect source location | Check known paths + git origin to find source |
| Prefer symlink in dev mode | Instant feedback, no rebuild needed for non-TS files |
| Fallback to copy mode | Works when source location unknown |
| Validate symlink before use | Prevent silent failures from stale symlinks |
| Use `installed_plugins.json` for dev mode flag | Claude Code already uses this; add `"devMode": true` |

## Success Criteria

- [ ] `term sync` works from any directory
- [ ] Running `term sync` when in genie-cli source creates symlink
- [ ] Running `term sync` when source not found shows clear error
- [ ] `install.sh --local .` creates valid symlink and marks devMode in registry
- [ ] Broken symlinks are detected and user is prompted to repair
- [ ] `install.sh` (no args) from source dir auto-detects and uses local mode
- [ ] npm global install still works for production users

---

## Execution Groups

### Group 1: Add `term sync` Command

**Deliverables:**
- New file `src/term-commands/sync.ts`
- Register command in `src/term.ts`
- Auto-detect genie-cli source location
- Create symlink or copy based on context

**Acceptance Criteria:**
- [ ] `term sync` succeeds when run from genie-cli source dir
- [ ] `term sync` succeeds when run from outside, if source path is in `~/.genie/config.json`
- [ ] Symlink created points to valid directory
- [ ] Clear error message if source cannot be found

**Validation:**
```bash
# From genie-cli source
cd /home/genie/workspace/guga/code/genie-cli
term sync
# Expected: creates/validates symlink

# Check symlink is valid
ls -la ~/.claude/plugins/automagik-genie
readlink -f ~/.claude/plugins/automagik-genie
```

**Files:**
- `src/term-commands/sync.ts` (new)
- `src/term.ts` (edit: register command)
- `src/lib/genie-config.ts` (new: config helpers)

---

### Group 2: Improve install.sh Robustness

**Deliverables:**
- Add broken symlink detection
- Auto-detect when running from source dir (use --local implicitly)
- Better error messages
- Add repair prompt for broken symlinks

**Acceptance Criteria:**
- [ ] `./install.sh` from source dir auto-detects local mode
- [ ] Running install.sh with broken symlink prompts repair
- [ ] `./install.sh --local .` creates valid symlink
- [ ] Clear status messages showing what mode was used

**Validation:**
```bash
# Create broken symlink
ln -sf /nonexistent ~/.claude/plugins/automagik-genie

# Run install and verify it prompts repair
cd /home/genie/workspace/guga/code/genie-cli
./install.sh

# Verify fixed
ls -la ~/.claude/plugins/automagik-genie
```

**Files:**
- `install.sh` (edit)

---

### Group 3: Integrate with Plugin Registry

**Deliverables:**
- Update `installed_plugins.json` to mark dev mode installs
- Ensure Claude Code still recognizes the plugin
- Add helper to read/write plugin registry

**Acceptance Criteria:**
- [ ] After `term sync`, `installed_plugins.json` shows devMode flag
- [ ] Plugin still loads correctly in Claude Code
- [ ] `claude plugin list` shows automagik-genie

**Validation:**
```bash
term sync
cat ~/.claude/plugins/installed_plugins.json | jq '.plugins["automagik-genie@namastexlabs"]'
claude plugin list | grep automagik-genie
```

**Files:**
- `src/lib/plugin-registry.ts` (new)
- `src/term-commands/sync.ts` (edit: use registry)
- `scripts/sync.js` (edit or deprecate in favor of term sync)

---

### Group 4: Documentation and Cleanup

**Deliverables:**
- Update README with dev workflow
- Add CLAUDE.md section on sync
- Remove redundant scripts if replaced

**Acceptance Criteria:**
- [ ] README documents `term sync` command
- [ ] Development workflow is clear
- [ ] No orphaned/redundant sync scripts

**Validation:**
```bash
grep -q "term sync" README.md
```

**Files:**
- `README.md` (edit)
- `CLAUDE.md` (edit if exists)
