---
name: onboarding
description: "Interactive first-run onboarding — validate workspace, welcome new users/agents, gather preferences, inject hooks, and configure a ready-to-work environment."
---

# /onboarding — Welcome to Genie

The **single canonical entry point** for new users and freshly-cloned agents. Validates the workspace structure, gathers identity and preferences interactively, injects hooks, and scaffolds a complete working environment.

This skill replaces the fragmented `install-workspace.sh` → `apply-blank-init.sh` → `genie` chain with one unified, validated flow.

## When to Use
- First-time `genie` launch (no AGENTS.md exists)
- User explicitly invokes `/onboarding`
- New agent clone needs workspace configuration
- `genie-blank-init` detects a blank persona and hands off here
- After a fresh `git clone` of a genie-managed repo
- When `genie` starts without required workspace files

## Flow

### Phase 0: Workspace Validation (Silent)

Before any user interaction, validate the workspace structure. Fix gaps silently — only report what was created in the final summary.

**Required structure:**

```
<workspace>/
├── .genie/
│   ├── wishes/          # Planning documents
│   ├── brainstorms/     # Exploration notes
│   └── brainstorm.md    # Jar index
├── .claude/             # Claude Code config
├── memory/              # Session continuity
├── AGENTS.md            # Workspace identity (created in Phase 4)
```

**Validation steps:**

```bash
# Create genie workspace directories
mkdir -p .genie/wishes .genie/brainstorms

# Create brainstorm jar if missing
[ -f .genie/brainstorm.md ] || cat > .genie/brainstorm.md << 'EOF'
# Brainstorm Jar
## Raw
## Simmering
## Ready
## Poured
EOF

# Create Claude Code config dir
mkdir -p .claude

# Create memory directory
mkdir -p memory
```

**If AGENTS.md already exists:**

```
AskUserQuestion({
  questions: [{
    question: "An AGENTS.md already exists in this workspace. What would you like to do?",
    header: "Existing Configuration Found",
    options: [
      "Reconfigure from scratch",
      "Keep existing and only fix missing pieces",
      "Cancel onboarding"
    ]
  }]
})
```

If "Cancel" — exit gracefully. If "Keep existing" — skip to Phase 3 (integrations) and Phase 4c-4d only.

### Phase 1: Welcome

Display the ASCII art banner. Then introduce yourself warmly in 2-3 sentences — explain that you'll walk them through a quick setup.

```
              /\
             /  \
            / /\ \
           / /  \ \
          / / /\ \ \
         /_/ /  \_\_\
             \/

        ██████  ███████ ███    ██ ██ ███████
       ██       ██      ████   ██ ██ ██
       ██   ███ █████   ██ ██  ██ ██ █████
       ██    ██ ██      ██  ██ ██ ██ ██
        ██████  ███████ ██   ████ ██ ███████

                    )
                   ( )
                  (   )
                   ) (
                    |
               _.--' '--._
              /            \
             |    ~~~~~~    |
              \            /
               '-.______.-'
                \________/
```

### Phase 2: Identity (AskUserQuestion)

Use `AskUserQuestion` for each prompt. One question per step — never batch.

**Step 1 — Name**

```
AskUserQuestion({
  questions: [{
    question: "What should I call you?",
    header: "Your Name"
  }]
})
```

Free-text response. Store as `$USER_NAME`.

**Step 2 — Role**

```
AskUserQuestion({
  questions: [{
    question: "What best describes your work?",
    header: "Your Role",
    options: [
      "Software Development",
      "DevOps / Infrastructure",
      "Data Engineering / Analytics",
      "Product / Design",
      "Security / Compliance",
      "Research / Exploration",
      "Other (I'll describe it)"
    ]
  }]
})
```

If "Other" is selected, follow up with a free-text question asking them to describe their role. Store as `$USER_ROLE`.

**Step 3 — Work Style**

```
AskUserQuestion({
  questions: [{
    question: "How do you prefer to work with AI?",
    header: "Work Style",
    options: [
      "Autonomous — do the work, show me results",
      "Collaborative — let's think together, then you execute",
      "Supervised — check with me before each step"
    ]
  }]
})
```

Store as `$WORK_STYLE`. This maps to the agent's autonomy level in AGENTS.md.

### Phase 3: Integrations (AskUserQuestion)

**Step 4 — Integrations**

```
AskUserQuestion({
  questions: [{
    question: "Which integrations do you want to set up now? (You can add more later)",
    header: "Integrations",
    options: [
      "GitHub (repos, PRs, issues)",
      "Telegram (notifications, commands)",
      "None for now"
    ],
    multiSelect: true
  }]
})
```

Store selections as `$INTEGRATIONS[]`.

**Step 5 — GitHub Setup** (only if GitHub selected)

Check if `gh` CLI is authenticated (`gh auth status`). If yes, confirm the authenticated account. If not, tell the user to run `gh auth login` and offer to wait or skip.

**Step 6 — Telegram Setup** (only if Telegram selected)

```
AskUserQuestion({
  questions: [{
    question: "What's your Telegram bot token? (from @BotFather)",
    header: "Telegram Bot Token"
  }]
})
```

Validate the token format (numeric:alphanumeric). If valid, store securely. If the user doesn't have one yet, explain how to get one from @BotFather and offer to skip for now.

### Phase 4: Configure Environment

Based on gathered answers, execute these configuration steps. Report each step briefly as you go.

**4a. Create AGENTS.md**

Write a personalized AGENTS.md using this template, substituting gathered values:

```markdown
# AGENTS.md — $USER_NAME's Workspace

## Identity
- **Name:** $USER_NAME
- **Role:** $USER_ROLE
- **Style:** $WORK_STYLE_DESCRIPTION

## Preferences
- Work style: $WORK_STYLE
- Active integrations: $INTEGRATIONS_LIST

## Conventions
- Use Bun exclusively (never npm/yarn/pnpm)
- Conventional commits: type(scope): description
- Branch workflow: dev (working) → main (production)

## Agent Commands (genie CLI)
- Spawn agent: `genie agent spawn --role <role>`
- List agents: `genie agent list`
- Send message: `genie send "<text>" --to <agent>`
- Kill agent: `genie agent kill <id>`
- Manage teams: `genie team ensure <name>`

## Session Protocol
1. Read this file at session start
2. Check memory/ for recent context
3. Work on assigned tasks
4. Push changes before ending session
```

Adapt the template to the user's role:
- **Software Development**: add git workflow, testing, and PR conventions
- **DevOps / Infrastructure**: add deployment, monitoring, and infra conventions
- **Data Engineering**: add pipeline, schema, and data quality conventions
- **Other roles**: keep it generic but include the basics

**4b. Configure Default Team** (if integrations selected)

```bash
genie team ensure default
```

**4c. Inject Hooks (CRITICAL)**

This step is **mandatory** — hooks must be injected during onboarding, not deferred to first agent spawn.

```bash
genie hook install
```

This writes `genie hook dispatch` entries into `~/.claude/settings.json`, ensuring all Claude Code events are routed through the genie CLI from the very first session — including TUI startup.

**Why this matters:** Without this step, a team-lead spawned via `genie` has NO hooks until its first agent is spawned (via `injectTeamHooks`). This means the first session runs "deaf" — no event routing, no protocol dispatch, no auto-spawn. Onboarding fixes this by front-loading hook injection.

**Verify hooks were injected:**

```bash
genie hook status
```

If `genie` is not in PATH, warn the user and add to the summary as a manual step.

**4d. Validate tmux Configuration**

Genie uses tmux heavily for agent orchestration (panes, windows, sessions). Incorrect tmux settings will cause silent failures.

**Check base-index:**

```bash
tmux show-option -gv base-index 2>/dev/null
tmux show-option -gv pane-base-index 2>/dev/null
```

| Setting | Expected | Why |
|---------|----------|-----|
| `base-index` | `0` | Genie targets windows as `session:0` — a non-zero base-index breaks window resolution |
| `pane-base-index` | `0` | Fallback pane targets use `.0` format (`session:team.0`) |

**If either is NOT 0:**

```
AskUserQuestion({
  questions: [{
    question: "Your tmux base-index is not 0. Genie requires base-index 0 to work correctly. Should I fix your tmux config?",
    header: "tmux Configuration Issue",
    options: [
      "Yes, update my ~/.tmux.conf",
      "No, I'll fix it manually later"
    ]
  }]
})
```

If "Yes", append to `~/.tmux.conf`:

```bash
cat >> ~/.tmux.conf << 'EOF'

# Genie requires base-index 0 for window/pane targeting
set -g base-index 0
setw -g pane-base-index 0
EOF
```

**If tmux is not installed:** Warn the user — tmux is required for agent orchestration. Suggest installation but don't block onboarding (non-interactive features still work).

**4e. Initialize Memory**

Write an initial `memory/YYYY-MM-DD.md` entry noting the onboarding completion:

```markdown
# YYYY-MM-DD

## Onboarding
- Workspace initialized for $USER_NAME ($USER_ROLE)
- Work style: $WORK_STYLE
- Integrations: $INTEGRATIONS_LIST
- Hooks: installed via `genie hook install`
- Workspace structure validated and created
```

### Phase 4f: Omni Plugin (Optional)

Check if the Omni v2 plugin is installed. If the user wants to connect agents to messaging channels (WhatsApp, Telegram, Discord, Slack), the Omni plugin provides the skills for that.

**Detection:**

```bash
# Check if omni plugin is loaded (look for omni skills in current session)
claude plugin list 2>/dev/null | grep -q omni
# Or check if omni CLI is available
command -v omni >/dev/null 2>&1
```

**If Omni is NOT installed:**

Use AskUserQuestion:
```
header: "Omni v2 — Connect agents to messaging channels"
question: "Want to connect genie agents to WhatsApp, Telegram, Discord, or Slack? The Omni plugin adds channel management and agent routing skills."
options: ["Yes, install Omni plugin", "Skip for now"]
```

If "Yes":
```bash
# 1. Add the marketplace (if not already added)
claude plugin marketplace add https://github.com/automagik-dev/omni.git

# 2. Install the plugin
claude plugin install omni@automagik-dev

# 3. Restart Claude Code to load the plugin
```

Tell the user to restart Claude Code after install for the plugin to take effect.

**If Omni IS installed:**

Suggest the agent setup skill:
```
Omni plugin detected! To connect an agent to a channel, run /omni-agent-setup
```

### Phase 5: Summary

Present a clear summary of everything configured:

```
Setup Complete!

  Name:         $USER_NAME
  Role:         $USER_ROLE
  Work Style:   $WORK_STYLE
  Integrations: $INTEGRATIONS_LIST

Files created/validated:
  .genie/wishes/         (planning)
  .genie/brainstorms/    (exploration)
  .genie/brainstorm.md   (jar index)
  memory/                (session continuity)
  AGENTS.md              (workspace persona)

Hooks:
  genie hook dispatch    (installed globally)

tmux:
  base-index             0 (verified/fixed)
  pane-base-index        0 (verified/fixed)

Next steps:
  - Run /brainstorm to explore an idea
  - Run /wish to plan a task
  - Run /work to execute
  - Run /omni-agent-setup to connect an agent to a channel (if Omni installed)
```

End with a brief, friendly message welcoming them and suggesting their first action based on their role.

## AskUserQuestion Protocol

**When to use AskUserQuestion:**
- Gathering user input (name, role, preferences, tokens)
- Presenting choices with defined options
- Any question where you need the user's answer to proceed

**When to just speak (no AskUserQuestion):**
- Showing the welcome banner
- Explaining what you're doing during configuration
- Presenting the final summary
- Providing guidance or next steps
- Error messages or status updates

**Rules for AskUserQuestion:**
- One question per call — never batch multiple questions
- Always include a `header` for context
- Use `options` when choices are predefined
- Use `multiSelect: true` only for integration selection
- Free-text (no options) for name and tokens

## CLI Command Reference

**IMPORTANT:** The genie CLI uses `genie agent`, NOT `genie worker`. The worker→agent rename is complete. Always use:

| Action | Correct Command | WRONG (deprecated) |
|--------|----------------|---------------------|
| Spawn agent | `genie agent spawn --role <role>` | ~~genie worker spawn~~ |
| List agents | `genie agent list` | ~~genie worker list~~ |
| Kill agent | `genie agent kill <id>` | ~~genie worker kill~~ |
| Agent history | `genie agent history <name>` | ~~genie worker history~~ |
| Send message | `genie send "<text>" --to <agent>` | ~~genie msg send~~ |
| Manage teams | `genie team ensure <name>` | (same) |
| Install hooks | `genie hook install` | (none) |

If the generated AGENTS.md or any documentation references `genie worker`, replace with `genie agent`.

## tmux Best Practices

Genie orchestrates agents via tmux sessions, windows, and panes. These settings ensure reliable operation.

### Required Settings

These MUST be set for genie to function correctly:

```bash
# ~/.tmux.conf — Required by genie
set -g base-index 0          # Windows start at 0 (genie targets session:0)
setw -g pane-base-index 0    # Panes start at 0 (genie targets team.0)
```

**Why:** Genie resolves windows/panes using `:0` and `.0` suffixes. If `base-index` is 1, commands like `tmux rename-window -t session:0` silently fail or target the wrong window.

### Recommended Settings

These improve the genie + tmux experience:

```bash
# ~/.tmux.conf — Recommended for genie users
set -g mouse on              # Click between agent panes, scroll output
set -g history-limit 50000   # More scrollback for long agent sessions
set -g renumber-windows on   # Keep window numbers contiguous after kills
set -g default-terminal "screen-256color"  # Proper color support

# Don't let tmux rename windows — genie sets meaningful names (team, agent)
setw -g automatic-rename off

# Status bar shows agent activity
set -g status-interval 5     # Refresh every 5s

# Prefix key (default is Ctrl-b, some prefer Ctrl-a)
# set -g prefix C-a
# unbind C-b
# bind C-a send-prefix
```

### Useful Shortcuts for Agent Management

| Shortcut | Action |
|----------|--------|
| `prefix + w` | List all windows (see all agents) |
| `prefix + s` | List all sessions |
| `prefix + d` | Detach (agents keep running) |
| `prefix + [` | Enter scroll mode (navigate agent output) |
| `prefix + z` | Zoom pane (fullscreen one agent) |
| `prefix + q` | Show pane numbers |
| `prefix` + `!` | Break pane into its own window |

### Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `window not found` after spawn | `base-index` is not 0 | Set `base-index 0` in tmux.conf, restart tmux |
| Agent panes show in wrong order | `pane-base-index` is not 0 | Set `pane-base-index 0` |
| Window names keep changing | `automatic-rename on` | Set `automatic-rename off` |
| Can't scroll agent output | Mouse mode off | Set `mouse on` or use `prefix + [` |
| Agent output truncated | Low history limit | Set `history-limit 50000` |

## Known Issues

### System Prompt Flattening (BUG — do not fix here)

`buildTeamLeadCommand()` in `src/lib/team-lead-command.ts` does `fullPrompt.replace(/\n/g, ' ')` which destroys all markdown formatting in the system prompt (AGENTS.md content, TEAM_LEAD_PROMPT.md content). This means:
- Tables render as unformatted text
- Code blocks lose structure
- Headers lose hierarchy
- Lists become run-on sentences

**Impact on onboarding:** The AGENTS.md created by onboarding will have its formatting destroyed when injected as system prompt via TUI. This is a known bug to be fixed separately — do NOT attempt to work around it in the AGENTS.md template (e.g., by avoiding markdown). Write proper markdown; the bug is in the prompt builder, not the content.

**Tracked for fix:** `buildTeamLeadCommand()` should preserve newlines or use a proper escaping strategy.

### TEAM_LEAD_PROMPT.md Outdated References

`TEAM_LEAD_PROMPT.md` has been updated to use `genie agent spawn/list/kill/etc.` — consistent with the onboarding skill and all other documentation.

## Error Handling

| Scenario | Action |
|----------|--------|
| AGENTS.md already exists | Ask if reconfigure, keep existing, or cancel |
| `gh` CLI not installed | Skip GitHub setup, note in summary |
| Telegram token invalid | Offer retry or skip, don't block |
| User selects "None" for integrations | Skip Phase 3 steps 5-6 entirely |
| `genie` CLI not in PATH | Warn, skip hook/team setup, add manual steps to summary |
| `.genie/` partially exists | Validate and fill gaps, don't overwrite existing files |
| Hook injection fails | Warn with manual fallback: `genie hook install` |
| Workspace is read-only | Error clearly — onboarding cannot proceed without write access |
| tmux not installed | Warn — required for agent orchestration. Suggest install, don't block |
| `base-index` is not 0 | AskUserQuestion to auto-fix `~/.tmux.conf` or skip |
| `~/.tmux.conf` is read-only | Provide the lines to add manually, don't block |

## Rules
- One question per message. Never batch questions in a single AskUserQuestion call.
- Never skip the welcome banner — first impressions matter.
- Never store secrets (tokens, keys) in plain text files — use environment variables or secure storage.
- Always offer "skip" or "none" as an escape — never force a choice.
- Respect existing configuration — ask before overwriting AGENTS.md.
- Keep the tone warm but efficient — friendly without being verbose.
- If the user seems experienced, adapt — offer to fast-track with sensible defaults.
- The entire onboarding should complete in under 2 minutes of user time.
- Always use `genie agent` commands, NEVER `genie worker` (deprecated).
- Hook injection is mandatory — never defer to first agent spawn.
- Validate workspace structure before user interaction — fix silently, report in summary.
