# Wish: Fix broken tmux dual status bar — awk escaping + clickable tabs

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `fix-tmux-dual-statusbar` |
| **Date** | 2026-03-17 |
| **Priority** | HOTFIX |

## Summary

PR #646 (tmux-split-tabbar) introduced a dual status bar with project tabs (top) and agent/task tabs (bottom). Two bugs make it completely non-functional: (1) a broken awk escaping in the version guard means the dual bar never activates, and (2) the bottom bar renders plain text instead of native clickable window tabs. This hotfix restores the dual bar and makes window tabs clickable while preserving agent enrichment (counts + state emoji).

## Scope

### IN
- Fix awk `$1`/`$2` shell expansion bug in version guard (`genie.tmux.conf:97`)
- Make window tabs in bottom bar (`status-format[1]`) mouse-clickable using `#{W}`
- Enrich `window-status-format` / `window-status-current-format` with agent count + emoji
- Verify dual bar activates on tmux 3.2+ and falls back on older versions
- Add overflow handling for projects bar when many sessions exist

### OUT
- Redesigning the status bar layout or color scheme
- Adding new scripts or metrics to the status bar
- Changing pane border color behavior
- Modifying session/window creation logic

## Decisions

| Decision | Rationale |
|----------|-----------|
| Use `#{W}` in `status-format[1]` instead of `#()` script | `#{W}` provides native tmux clickable window tabs. Shell script output is always plain text — no mouse interactivity. |
| Move agent enrichment into `window-status-format` templates | Since `#{W}` expands using `window-status-format` and `window-status-current-format`, we enrich those templates to include agent data. This keeps clickability + enrichment together. |
| Replace awk with simpler numeric comparison | Avoids the `$1`/`$2` escaping minefield entirely. Use: `tmux -V \| sed 's/[^0-9.]//g' \| awk -F. '{print ($1*100)+$2}'` with proper escaping, or a shell-only version check. |
| Create per-window enrichment script (`genie-window-label.sh`) | Called from `window-status-format` via `#()`. Lightweight: reads cached workers.json, outputs `×count emoji` for a given window. Avoids expensive jq per-window by using a pre-aggregated cache. |

## Success Criteria

- [ ] Dual status bar (2 lines) activates on tmux >= 3.2
- [ ] Single status bar fallback works on tmux < 3.2
- [ ] Top bar shows project/session tabs with agent counts
- [ ] Bottom bar shows clickable window tabs (clicking switches window)
- [ ] Agent state emoji and counts display per window tab
- [ ] No regression on pane border colors or keybindings
- [ ] `tmux source ~/.tmux.conf` applies cleanly without errors

## Execution Strategy

### Wave 1 (sequential — single engineer, hotfix)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix version guard + clickable tabs + enrichment |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review the fix against acceptance criteria |

## Execution Groups

### Group 1: Fix tmux status bar

**Goal:** Fix both bugs and restore full dual status bar functionality.

**Deliverables:**

1. **Fix version guard escaping** (`scripts/tmux/genie.tmux.conf:97-99`)
   - Replace the broken awk command with a properly escaped version comparison
   - Recommended approach — shell-only comparison avoiding awk escaping entirely:
     ```
     if-shell '[ "$(tmux -V | tr -dc "0-9." | awk -F. "{v=\$1*100+\$2; print v}")" -ge 302 ]' \
       'set -g status 2' \
       'set -g status on'
     ```
   - OR use a heredoc/temp-file approach to isolate awk from shell expansion

2. **Make bottom bar use native clickable window tabs** (`scripts/tmux/genie.tmux.conf:65`)
   - Replace `#($HOME/.genie/scripts/genie-tasks.sh #{session_name})` with `#{W}` in `status-format[1]`
   - The `#{W}` token expands using `window-status-format` and `window-status-current-format` templates, providing native mouse click support

3. **Enrich window-status-format with agent data** (`scripts/tmux/genie.tmux.conf:82-85`)
   - Modify `window-status-format` to include `#($HOME/.genie/scripts/genie-window-label.sh #{session_name} #{window_name})`
   - Modify `window-status-current-format` similarly
   - Output: ` ×count emoji` suffix (empty string if no agents in that window)

4. **Create per-window enrichment script** (`scripts/tmux/genie-window-label.sh`)
   - Input: `$1` = session_name, `$2` = window_name
   - Reads `~/.genie/workers.json`, filters by session + windowName
   - Outputs: `×count emoji` (e.g., `×3 🔨`) or empty string
   - Must be fast: single jq query, < 50ms
   - Falls back to empty string on any error

5. **Add overflow handling to genie-projects.sh** (`scripts/tmux/genie-projects.sh`)
   - If > 8 sessions, truncate and show `+N more` indicator
   - Active session always shown regardless of truncation

6. **Verify locally** — run `tmux source ~/.tmux.conf` and confirm:
   - Dual bar appears (2 lines)
   - Window tabs are clickable
   - Agent enrichment displays correctly
   - No tmux errors in `~/.tmux.conf` sourcing

**Acceptance Criteria:**
- [ ] `if-shell` version guard exits 0 on tmux >= 3.2, exits non-zero on < 3.2
- [ ] `status-format[1]` contains `#{W}` for native clickable window tabs
- [ ] `window-status-format` and `window-status-current-format` include agent enrichment
- [ ] `genie-window-label.sh` runs in < 50ms and handles missing workers.json gracefully
- [ ] `genie-projects.sh` handles > 8 sessions without overflow
- [ ] `tmux source ~/.tmux.conf` shows no errors

**Validation:**
```bash
# Test version guard escaping (should exit 0 on tmux >= 3.2)
/bin/sh -c '[ "$(tmux -V | tr -dc "0-9." | awk -F. "{v=\$1*100+\$2; print v}")" -ge 302 ]' && echo "PASS: version guard" || echo "FAIL: version guard"

# Test status bar has 2 lines
[ "$(tmux show -gv status 2>/dev/null)" = "2" ] && echo "PASS: dual bar" || echo "FAIL: dual bar"

# Test window-label script exists and runs
[ -x "$HOME/.genie/scripts/genie-window-label.sh" ] && echo "PASS: script exists" || echo "FAIL: script missing"

# Test conf sources without error
tmux source ~/.tmux.conf 2>&1 | grep -i error && echo "FAIL: source errors" || echo "PASS: clean source"
```

**depends-on:** none

---

## QA Criteria

- [ ] Dual status bar visible with 2 distinct lines on tmux >= 3.2
- [ ] Top bar shows Genie version, project session tabs, git/cpu/ram info
- [ ] Bottom bar shows native clickable window tabs with agent enrichment
- [ ] Clicking a window tab in the bottom bar switches to that window
- [ ] Ctrl+)/Ctrl+( switch between project sessions
- [ ] Single-line fallback activates gracefully on tmux < 3.2 (test with mock)
- [ ] Agent state emoji updates when agent state changes (idle→working→done)
- [ ] No pane border color regressions
- [ ] Config reload (`prefix + r`) works without errors

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Per-window `#()` calls may slow status refresh | Medium | Keep script < 50ms; use single jq query with early exit |
| `#{W}` in `status-format[1]` may not render exactly like custom script | Low | Test styling; adjust window-status-format templates to match design |
| tmux versions between 3.0-3.1 may have partial `status-format` support | Low | Version guard explicitly checks >= 3.2; tested on 3.5a |

---

## Files to Create/Modify

```
scripts/tmux/genie.tmux.conf          — Fix version guard + use #{W} in status-format[1] + enrich window-status-format
scripts/tmux/genie-window-label.sh    — NEW: per-window agent enrichment script
scripts/tmux/genie-projects.sh        — Add overflow handling for many sessions
scripts/tmux/genie-tasks.sh           — Keep for backward compat, but no longer called from status-format
```
