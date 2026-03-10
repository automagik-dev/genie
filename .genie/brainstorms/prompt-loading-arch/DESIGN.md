# Design: Unify Installation & Kill Prompt Fragmentation

## Problem

Four redundant installers, three onboarding paths, orchestration prompt silently fails in production. User should do ONE thing (`curl | bash` or `genie` command given to Claude) and everything works.

## Scope

### IN
- `install.sh` becomes the single zero-touch installer (no confirmations, just do it)
- `install.sh` gains: tmux install, orchestration prompt injection, config defaults, tmux base-index
- `install.sh` output: clear next steps mentioning `genie` command and `/onboarding`
- `install.sh` never opens Claude Code — installs and prints instructions
- `smart-install.js` becomes maintenance-only (version checks, re-inject rules if version changed)
- New setting `promptMode: 'append' | 'system'` in `~/.genie/config.json`
- `buildTeamLeadCommand` reads `promptMode` and uses correct flag
- Orchestration prompt lives in `~/.claude/rules/genie-orchestration.md` (auto-loaded by CC)
- `/onboarding` skill stays as optional workspace identity setup (AGENTS.md, name, role)

### OUT
- No changes to `/onboarding` skill internals (just remove infra concerns it shouldn't own)
- No changes to session-context.cjs or first-run-check.cjs logic
- No new CLI commands
- No changes to AGENTS.md loading (works fine via process.cwd())
- No changes to hooks dispatch system

## Decisions

| Decision | Rationale |
|----------|-----------|
| Kill `genie install` (install.ts) | Redundant with install.sh + smart-install.js |
| Kill `install-genie-cli.sh` | Redundant with smart-install.js |
| install.sh stops asking confirmations | One command, zero interaction. User already consented by running curl pipe |
| Orchestration prompt in ~/.claude/rules/ | Auto-loaded by Claude Code, zero flags needed, survives bundles |
| promptMode default is 'append' | Preserves CC default prompt. Power users switch to 'system' via genie setup |
| install.sh never opens Claude Code | Often run by an agent or in CI. Output next steps for human/agent to follow |
| /onboarding stays as skill, not command | Runs inside Claude, uses AskUserQuestion for identity. Not part of install |

## Key Changes by File

### install.sh (modify)
- Remove all `confirm()` calls — just do everything
- Add `install_tmux_if_needed()` using detected package manager (already has `install_package()`)
- Add `inject_orchestration_prompt()`: write TEAM_LEAD_PROMPT content to `~/.claude/rules/genie-orchestration.md`
- Add `create_default_config()`: write `~/.genie/config.json` with `promptMode: 'append'` if not exists
- Add `configure_tmux_defaults()`: ensure `base-index 0` and `pane-base-index 0` in `~/.tmux.conf`
- Update `print_success()`: output `genie` as entry point, mention `/onboarding`
- Update `output_agent_prompt()`: same info for agent/pipe mode

### smart-install.js (modify)
- Add orchestration prompt injection (same as install.sh, for marketplace installs)
- Add config defaults creation (same as install.sh)
- Add tmux base-index check
- Remove genie CLI global install (install.sh already did it, or marketplace install doesn't need it separately)
- Keep: bun install, deps install, version marker

### src/types/genie-config.ts (modify)
- Add `promptMode: z.enum(['append', 'system']).default('append')` to GenieConfigSchema

### src/lib/team-lead-command.ts (modify)
- Remove `getTeamLeadPrompt()` function entirely (no more filesystem loading)
- Remove `import.meta.url`, `dirname`, `fileURLToPath` imports
- `persistSystemPrompt()` only handles AGENTS.md content (orchestration is in ~/.claude/rules/)
- Read `promptMode` from config
- Use `--append-system-prompt` or `--system-prompt` based on promptMode

### src/genie-commands/install.ts (delete)
- Remove entirely
- Update CLI router to remove `genie install` command

### plugins/genie/scripts/src/install-genie-cli.sh (delete)
- Remove entirely — redundant with smart-install.js

### src/genie-commands/tui.ts (modify)
- Fix misleading warning: distinguish AGENTS.md (optional) from orchestration (now in rules/, always present)

### src/genie-commands/setup.ts (modify)
- Remove prerequisites check phase (install.sh/smart-install handles it)
- Add promptMode configuration phase
- Keep: session, terminal, shortcuts, worker profiles

### TEAM_LEAD_PROMPT.md (keep, add header)
- Add comment: "Source of truth. Injected to ~/.claude/rules/genie-orchestration.md by install.sh"
- Content stays identical

## Install Flow (after changes)

```
curl -fsSL .../install.sh | bash
  ├─ detect platform
  ├─ install bun (if missing)
  ├─ install tmux (if missing, via package manager)
  ├─ install genie CLI (bun install -g @automagik/genie)
  ├─ install Claude Code plugin (claude plugin marketplace add + install)
  ├─ write ~/.claude/rules/genie-orchestration.md
  ├─ write ~/.genie/config.json (if not exists, with promptMode: 'append')
  ├─ ensure tmux base-index 0 in ~/.tmux.conf
  └─ print:
       ✔ Genie installed successfully!

         Get started:
           genie              Launch genie

         First time? Genie will suggest /onboarding to set up your workspace.
```

## Runtime Flow (after changes)

```
User runs: genie
  ├─ SessionStart hooks fire automatically:
  │   ├─ smart-install.js: version check, re-inject rules if updated
  │   ├─ first-run-check.cjs: suggest /onboarding if no AGENTS.md
  │   └─ session-context.cjs: show active wishes
  ├─ Orchestration prompt loaded from ~/.claude/rules/ (automatic, no flag)
  ├─ If AGENTS.md exists in cwd:
  │   └─ passed via --append-system-prompt (or --system-prompt per promptMode)
  └─ Claude knows about genie agent spawn, genie send, etc. (from rules/)
```
