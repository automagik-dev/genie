# Wish: Unify Installation & Kill Prompt Fragmentation

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `unify-install-kill-fragmentation` |
| **Date** | 2026-03-10 |

## Summary

Four redundant installers and three onboarding paths cause silent failures and confuse users. The orchestration prompt (`TEAM_LEAD_PROMPT.md`) silently fails to load in production bundles, causing Claude to launch without genie CLI knowledge. Unify everything so `curl | bash` does the complete install with zero interaction, the orchestration prompt lives in `~/.claude/rules/` (auto-loaded), and a new `promptMode` setting lets users choose between `--append-system-prompt` and `--system-prompt`.

## Scope

### IN

- `install.sh`: remove all interactive confirmations, add tmux install, orchestration prompt injection, config defaults, tmux base-index config, plugin auto-install
- `install.sh`: output clear next steps (`genie` command + `/onboarding`) without opening Claude Code
- `smart-install.js`: add orchestration prompt injection + config defaults (for marketplace installs)
- New setting `promptMode: 'append' | 'system'` in GenieConfigSchema
- `buildTeamLeadCommand`: read `promptMode`, use correct CLI flag, stop loading TEAM_LEAD_PROMPT.md from filesystem
- `tui.ts`: fix misleading warning about missing system prompt
- `setup.ts`: remove prereqs phase, add `promptMode` config phase
- Delete `genie install` command (install.ts) and CLI router entry
- Delete `install-genie-cli.sh`
- Update `TEAM_LEAD_PROMPT.md` header to note it's source-of-truth for rules/ injection

### OUT

- No changes to `/onboarding` skill internals
- No changes to `first-run-check.cjs` or `session-context.cjs`
- No changes to hooks dispatch system (`src/hooks/`)
- No changes to AGENTS.md loading logic (works via `process.cwd()`)
- No new CLI commands
- No changes to `genie uninstall` command

## Decisions

| Decision | Rationale |
|----------|-----------|
| Kill `genie install` (install.ts) | Redundant with install.sh + smart-install.js |
| Kill `install-genie-cli.sh` | Redundant with smart-install.js |
| install.sh stops asking confirmations | One command, zero interaction — user consented by piping curl to bash |
| Orchestration prompt in `~/.claude/rules/` | Auto-loaded by Claude Code every session, zero flags, survives bundles |
| `promptMode` default is `append` | Preserves CC default system prompt. `system` mode for personal assistant use cases |
| install.sh never opens Claude Code | Often piped to Claude as a command. Outputs next steps for human/agent |
| `/onboarding` stays as skill | Runs inside Claude via AskUserQuestion. Identity/workspace setup, not infra |

## Success Criteria

- [x] `curl -fsSL .../install.sh | bash` on a clean machine results in working genie with zero manual steps
- [x] `~/.claude/rules/genie-orchestration.md` exists after install with TEAM_LEAD_PROMPT content
- [x] `~/.genie/config.json` exists after install with `promptMode: 'append'`
- [x] `~/.tmux.conf` has `base-index 0` and `pane-base-index 0` after install
- [x] Claude Code plugin installed automatically (no confirmation prompt)
- [x] tmux installed automatically if missing (via detected package manager)
- [x] `genie command` launches Claude with orchestration knowledge (uses genie agent spawn, not Agent tool)
- [x] `promptMode: 'system'` in config causes `--system-prompt` flag; `'append'` causes `--append-system-prompt`
- [x] `genie install` command is gone (exits with deprecation message or doesn't exist)
- [x] `install-genie-cli.sh` is deleted
- [x] No `import.meta.url` path resolution for TEAM_LEAD_PROMPT.md remains anywhere
- [x] `bun run check` passes (typecheck + lint + dead-code + tests)

## Execution Groups

### Group A: Delete dead code

**Goal:** Remove redundant installers and the `genie install` CLI command.

**Deliverables:**
1. Delete `src/genie-commands/install.ts`
2. Remove `genie install` command from CLI router in `src/genie.ts` (remove import + `.command('install')` block)
3. Delete `plugins/genie/scripts/src/install-genie-cli.sh`
4. Remove any imports/references to deleted files

**Acceptance criteria:**
- `genie install` is not a valid command (or prints deprecation)
- No dangling imports
- `bun run typecheck` passes

**Validation:**
```bash
bun run typecheck
grep -r 'install-genie-cli' src/ plugins/ && echo "FAIL: dangling ref" || echo "PASS"
grep -r 'installCommand' src/genie.ts && echo "FAIL: still imported" || echo "PASS"
```

### Group B: Orchestration prompt to ~/.claude/rules/

**Goal:** Move TEAM_LEAD_PROMPT content from filesystem-loaded .md to auto-injected rules file.

**Deliverables:**
1. In `install.sh`, add `inject_orchestration_prompt()` function that writes `TEAM_LEAD_PROMPT.md` content to `~/.claude/rules/genie-orchestration.md` (create `~/.claude/rules/` dir if needed)
2. In `smart-install.js`, add same logic (for marketplace installs where install.sh wasn't used): write orchestration prompt to `~/.claude/rules/genie-orchestration.md`, re-write if plugin version changed
3. In `src/lib/team-lead-command.ts`:
   - Remove `getTeamLeadPrompt()` function entirely
   - Remove `fileURLToPath`, `dirname` imports (if only used for prompt)
   - Update `persistSystemPrompt()` to only handle the AGENTS.md systemPrompt parameter (no more teamLeadPrompt concatenation)
4. Update `TEAM_LEAD_PROMPT.md` with header comment noting it's source-of-truth, injected by install.sh/smart-install.js

**Acceptance criteria:**
- `getTeamLeadPrompt()` no longer exists
- No `import.meta.url` usage for prompt loading
- `persistSystemPrompt()` only writes AGENTS.md content
- install.sh writes `~/.claude/rules/genie-orchestration.md`
- smart-install.js writes same file on version change

**Validation:**
```bash
grep -n 'import.meta.url' src/lib/team-lead-command.ts && echo "FAIL" || echo "PASS"
grep -n 'getTeamLeadPrompt' src/lib/team-lead-command.ts && echo "FAIL" || echo "PASS"
grep -n 'MANDATORY Agent Orchestration' install.sh && echo "PASS: prompt in install.sh" || echo "FAIL"
bun run typecheck
```

### Group C: promptMode setting + buildTeamLeadCommand

**Goal:** Add configurable prompt injection mode and wire it into the team-lead launch command.

**Deliverables:**
1. In `src/types/genie-config.ts`, add to GenieConfigSchema:
   ```typescript
   promptMode: z.enum(['append', 'system']).default('append'),
   ```
2. In `src/lib/team-lead-command.ts`:
   - Import and load genie config
   - Read `promptMode` from config
   - Use `--append-system-prompt` when `promptMode === 'append'`
   - Use `--system-prompt` when `promptMode === 'system'`
3. In `src/genie-commands/setup.ts`:
   - Remove prerequisites check phase
   - Add promptMode configuration phase (ask user, save to config)
4. Update test expectations in `src/genie-commands/__tests__/tui.test.ts` (lines 58, 78) and `src/term-commands/msg.test.ts` (line 130): change `--system-prompt` assertions to `--append-system-prompt` for default promptMode. Add test case for `promptMode: 'system'` producing `--system-prompt` flag.

**Acceptance criteria:**
- `promptMode` is a valid field in GenieConfigSchema with default `'append'`
- `buildTeamLeadCommand` output contains `--append-system-prompt` by default
- `buildTeamLeadCommand` output contains `--system-prompt` when config has `promptMode: 'system'`
- `genie setup` offers promptMode configuration
- All existing tests updated and passing with new flag behavior

**Validation:**
```bash
grep -n 'promptMode' src/types/genie-config.ts && echo "PASS" || echo "FAIL"
grep -n 'append-system-prompt' src/lib/team-lead-command.ts && echo "PASS" || echo "FAIL"
bun run typecheck
bun test
```

### Group D: install.sh zero-touch upgrade

**Goal:** Make install.sh do everything without asking. Add missing capabilities.

**Deliverables:**
1. Remove all `confirm()` / `confirm_no()` gated logic — just execute directly
2. Add `install_tmux_if_needed()`: use `install_package tmux` (already has package manager detection)
3. Add `create_default_config()`: write `~/.genie/config.json` with schema v2 defaults including `promptMode: 'append'` (skip if file already exists)
4. Add `configure_tmux_defaults()`: append `set -g base-index 0` and `setw -g pane-base-index 0` to `~/.tmux.conf` if not already present
5. In `offer_claude_plugin()`: remove confirmation, just install directly
6. Update `print_success()`:
   ```
   ✔ Genie installed successfully!

     Get started:
       genie              Launch genie

     First time? Genie will suggest /onboarding to set up your workspace.
   ```
7. Update `output_agent_prompt()` with same next-steps info

**Acceptance criteria:**
- `install.sh` runs end-to-end with zero user prompts (no stdin reads)
- tmux is installed if missing
- `~/.tmux.conf` has base-index settings
- `~/.genie/config.json` created with defaults
- Claude Code plugin installed without confirmation
- Output ends with `genie` command as next step

**Validation:**
```bash
# Verify no interactive prompts remain
grep -n 'confirm\|confirm_no\|read -r' install.sh | grep -v '^#' | grep -v 'function confirm' && echo "WARN: interactive reads found" || echo "PASS"
grep -n 'genie-orchestration' install.sh && echo "PASS" || echo "FAIL"
grep -n 'base-index' install.sh && echo "PASS" || echo "FAIL"
grep -n 'promptMode' install.sh && echo "PASS" || echo "FAIL"
```

### Group E: smart-install.js maintenance mode + tui.ts warning fix

**Goal:** smart-install.js gains orchestration prompt injection for marketplace installs. Fix misleading tui.ts warning.

**Deliverables:**
1. In `smart-install.js`:
   - Add function to write `~/.claude/rules/genie-orchestration.md` with the TEAM_LEAD_PROMPT content **inlined as a string constant** in the script (do NOT read from filesystem — the plugin root path varies by install method and the file may not be reachable)
   - Only rewrite if plugin version changed (use existing version marker)
   - Add function to create `~/.genie/config.json` with defaults if not exists
   - Add tmux base-index check/fix for `~/.tmux.conf`
2. In `src/genie-commands/tui.ts`:
   - Change warning at lines 199-200: AGENTS.md is informational, not a problem
   - Remove "Launching without --system-prompt" wording (orchestration is in rules/ now, always present)

**Acceptance criteria:**
- smart-install.js writes `~/.claude/rules/genie-orchestration.md` on first run or version change
- smart-install.js creates default config if missing
- tui.ts warning no longer says "Launching without --system-prompt"
- `bun run check` passes

**Validation:**
```bash
grep -n 'genie-orchestration' plugins/genie/scripts/smart-install.js && echo "PASS" || echo "FAIL"
grep -n 'without --system-prompt' src/genie-commands/tui.ts && echo "FAIL: old warning" || echo "PASS"
bun run check
bun run build
grep -c 'MANDATORY Agent Orchestration' dist/genie.js || true  # Should be 0 (no longer inlined in bundle)
```

### Group F: Final validation

**Goal:** Full quality gate pass and end-to-end verification.

**Deliverables:**
1. Run `bun run check` (typecheck + lint + dead-code + tests)
2. Run `bun run build`
3. Verify `~/.claude/rules/genie-orchestration.md` content matches TEAM_LEAD_PROMPT.md
4. Verify install.sh runs without errors in dry-run

**Acceptance criteria:**
- `bun run check` exits 0
- `bun run build` succeeds
- No dead code flagged by knip for removed files
- dist/genie.js does NOT contain `import.meta.url` path resolution for TEAM_LEAD_PROMPT

**Validation:**
```bash
bun run check
bun run build
grep 'TEAM_LEAD_PROMPT' dist/genie.js && echo "WARN: still references file" || echo "PASS"
```

## Dependencies

- `depends-on`: none
- `blocks`: `fix-onboarding-prod-bugs` (supersedes — that wish is now obsolete)

## Assumptions / Risks

| Risk | Mitigation |
|------|------------|
| install.sh runs with sudo for tmux install — may fail in containers | Graceful fallback: warn but don't exit. tmux is needed for orchestration only |
| Claude Code plugin install via `claude plugin` may fail if claude not in PATH | Check `command -v claude` first, skip with info message if not found |
| `~/.claude/rules/` may not exist yet on fresh machines | `mkdir -p` before writing |
| Existing `~/.genie/config.json` could have custom settings | Only write defaults if file doesn't exist — never overwrite |
| smart-install.js runs on every session — must be fast | Guard with version marker — only do work if version changed |
| Tests may reference `installCommand` or deleted files | Group A catches these via typecheck |
| `--append-system-prompt` flag may not exist in older Claude Code versions | Check `claude --help` output or just use it — older CC ignores unknown flags gracefully |
