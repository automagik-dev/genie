# Wish: Fix Onboarding Production Bugs (tmux defaults + silent prompt failure)

| Field | Value |
|-------|-------|
| **Status** | SUPERSEDED by `unify-install-kill-fragmentation` |
| **Slug** | `fix-onboarding-prod-bugs` |
| **Date** | 2026-03-09 |

## Summary

Two bugs discovered during clean-machine onboarding testing. Bug 1 (low): `genie install` never writes base tmux settings, so users on distros with `mouse on` system defaults can't scroll. Bug 2 (critical): `TEAM_LEAD_PROMPT.md` is loaded via filesystem path that resolves correctly in dev (`src/lib/`) but breaks in the production flat bundle (`dist/genie.js`), causing Claude to launch without any orchestration instructions — silently.

## Scope

### IN

- Inline `TEAM_LEAD_PROMPT.md` content as a TypeScript constant (eliminate filesystem dependency)
- Add explicit CRITICAL-level warning when orchestration prompt is empty/null
- Fix misleading `tui.ts` warning that only mentions `AGENTS.md`
- Add sensible tmux base defaults to `generateTmuxConfig()` in shortcuts.ts
- Keep `TEAM_LEAD_PROMPT.md` file for documentation/reference (add header noting it's inlined)

### OUT

- No changes to the build pipeline or bundler configuration
- No changes to `AGENTS.md` loading logic (that works correctly via `process.cwd()`)
- No tmux mouse-mode detection or auto-configuration beyond static defaults
- No changes to `install.ts` prerequisite installation flow
- No new CLI flags or user-facing options

## Decisions

| Decision | Rationale |
|----------|-----------|
| Inline prompt as TS constant (Option 1) | Eliminates entire class of "file not found at runtime" bugs. No bundler config needed. Content already ships with the package — just needs to be compiled in. |
| Keep `TEAM_LEAD_PROMPT.md` file | Serves as human-readable documentation; easier to review/edit prompt content before copying into the constant. |
| `set -g mouse off` as default | Users on clean machines expect terminal-native scroll. Power users who want mouse can override in their own config. Matches tmux's own default (pre-distro overrides). |
| Add CRITICAL warning, not throw | Throwing would block `genie command` entirely. Warning lets it proceed degraded while making the failure visible. |

## Success Criteria

- [ ] `genie command` on a clean install injects `TEAM_LEAD_PROMPT.md` content into the system prompt
- [ ] Running from `dist/genie.js` (production bundle) produces identical orchestration prompt as running from `src/genie.ts` (dev)
- [ ] If orchestration prompt is somehow empty, a CRITICAL warning is logged to stderr
- [ ] `generateTmuxConfig()` output includes `set -g mouse off` and `set -g base-index 0`
- [ ] `tui.ts` warning distinguishes between missing `AGENTS.md` (optional) and missing orchestration prompt (critical)
- [ ] `bun run check` passes (typecheck + lint + dead-code + tests)
- [ ] No runtime `fs.readFileSync` or `fs.existsSync` calls for `TEAM_LEAD_PROMPT.md`

## Execution Groups

### Group 1: Inline orchestration prompt (CRITICAL fix)

**Goal:** Eliminate filesystem dependency for TEAM_LEAD_PROMPT.md. Make the orchestration prompt a compile-time constant.

**Deliverables:**
1. Create a new constant `TEAM_LEAD_PROMPT` in `src/lib/team-lead-command.ts` containing the full content of `TEAM_LEAD_PROMPT.md`
2. Replace `getTeamLeadPrompt()` filesystem-based function with a simple getter returning the constant
3. Remove unused `fs` imports (`readFileSync`, `existsSync` for prompt loading — keep others if used elsewhere)
4. Remove unused `path` imports (`dirname`, `join` for prompt path — keep if used elsewhere)
5. Remove unused `url` import (`fileURLToPath` — keep if used elsewhere)

**Acceptance criteria:**
- `getTeamLeadPrompt()` returns the prompt content without any filesystem access
- No `import.meta.url` usage remains for prompt resolution
- The returned string matches `TEAM_LEAD_PROMPT.md` content exactly

**Validation:**
```bash
# Verify no filesystem loading for the prompt
grep -n 'import.meta.url' src/lib/team-lead-command.ts && echo "FAIL: import.meta.url still present" || echo "PASS"
grep -n 'TEAM_LEAD_PROMPT' src/lib/team-lead-command.ts | head -5
bun run typecheck
```

### Group 2: Add failure warnings + fix misleading tui.ts message

**Goal:** Make prompt loading failures loud and distinguishable.

**Deliverables:**
1. In `persistSystemPrompt()` (`team-lead-command.ts`), add a `console.error('CRITICAL: ...')` if `getTeamLeadPrompt()` returns empty/null
2. In `tui.ts`, update the warning at lines 198-201:
   - If `AGENTS.md` is missing, log it as informational (not a problem)
   - After `buildClaudeCommand` is called, if no `--system-prompt` flag was emitted, log a CRITICAL warning mentioning both AGENTS.md and orchestration prompt

**Acceptance criteria:**
- Warning text clearly distinguishes optional `AGENTS.md` from mandatory orchestration prompt
- CRITICAL warning fires when orchestration prompt is null/empty
- Warning does NOT fire during normal operation (prompt is inlined, so it should always be present)

**Validation:**
```bash
grep -n 'CRITICAL' src/lib/team-lead-command.ts src/genie-commands/tui.ts
bun run typecheck
```

### Group 3: tmux base defaults

**Goal:** Ensure clean-machine tmux installs get sensible defaults.

**Deliverables:**
1. Prepend base settings to `generateTmuxConfig()` output in `src/term-commands/shortcuts.ts`:
   ```
   # Base settings (generated by genie-cli)
   set -g mouse off
   set -g base-index 0
   setw -g pane-base-index 0
   ```

**Acceptance criteria:**
- `generateTmuxConfig()` output starts with base settings before keyboard shortcuts
- Existing keyboard shortcuts remain unchanged
- The "generated by genie-cli" marker is present (used for install/uninstall detection)

**Validation:**
```bash
grep -n 'mouse off' src/term-commands/shortcuts.ts && echo "PASS" || echo "FAIL"
grep -n 'base-index' src/term-commands/shortcuts.ts && echo "PASS" || echo "FAIL"
bun run typecheck
```

### Group 4: Update TEAM_LEAD_PROMPT.md + final validation

**Goal:** Mark the file as documentation-only and run full quality gates.

**Deliverables:**
1. Add a header comment to `TEAM_LEAD_PROMPT.md`:
   ```
   <!-- NOTE: This file is kept for documentation. The actual prompt is inlined
        as a constant in src/lib/team-lead-command.ts. Edits here must be
        copied to that constant. -->
   ```
2. Run full quality gates

**Acceptance criteria:**
- `bun run check` exits 0
- `bun run build` succeeds
- Built `dist/genie.js` contains the inlined prompt string

**Validation:**
```bash
bun run check
bun run build
grep -c 'MANDATORY Agent Orchestration' dist/genie.js  # should be >= 1
```

## Assumptions / Risks

| Risk | Mitigation |
|------|------------|
| Inlined prompt constant becomes stale vs. TEAM_LEAD_PROMPT.md edits | Header comment in .md file warns to sync changes; could add a CI check later |
| `set -g mouse off` may surprise users who expect mouse | Matches tmux's own compiled default; users can override in their own config block below genie's |
| Large string constant in source may trigger linter warnings | Use template literal; biome doesn't flag long template strings |
