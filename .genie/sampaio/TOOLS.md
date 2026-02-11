# TOOLS.md - My Toolbox

*Skills define how tools work. This file is my specifics — the stuff unique to my setup.*

## Project Build & Run

```bash
# Full dev setup (first time)
make setup-dev

# Start both servers (backend :8000, frontend :3000)
make dev

# Start individually
make dev-ui   # Frontend only
make dev-ai   # Backend only
```

## Quality Gates

```bash
# Run ALL checks (TypeScript + ESLint + ruff + mypy)
make quality

# Auto-fix lint issues
make lint-fix

# Run all tests
make test
make test-ui   # UI tests only
make test-ai   # AI tests only

# E2E tests
make e2e
```

## Database

```bash
make migrate    # Run migrations
make db-reset   # Reset database (careful!)
```

## Beads (Task Tracking)

```bash
bd ready                              # Find available work
bd show <id>                          # View issue details
bd create "Title" --type task --priority 2  # Create issue
bd update <id> --status in_progress   # Claim work
bd close <id>                         # Complete work
bd sync                               # Sync with git
bd list                               # List all issues
```

## Git / GitHub

```bash
# PR workflow
gh pr create --base dev --title "feat: ..." --body "..."
gh pr list
gh pr view <number>
gh pr merge <number>

# Check CI
gh run list --repo namastexlabs/sampa-seeds --limit 5
gh run view <id>

# Commit activity
gh api repos/namastexlabs/sampa-seeds/commits?per_page=10 --jq '.[].commit.message'
```

## Terminal Orchestration (genie-cli)

```bash
# Execute in shared terminal
term exec <session>:<pane> '<command>'

# Read terminal output
term read <session>

# Work on a beads task (creates worktree + spawns worker)
term work <task-id>
```

## WhatsApp (via Omni CLI)

```bash
# Send to group "Genie - The First"
omni send --instance 07a5178e-fb07-4d93-885b-1d361fbd5d6b \
  --to "120363424660366845@g.us" \
  --text "🌱 [Sampaio] message"

# Send to Felipe directly
omni send --instance 07a5178e-fb07-4d93-885b-1d361fbd5d6b \
  --to "5512982298888@s.whatsapp.net" \
  --text "🌱 [Sampaio] message"

# Check recent messages
curl -s "https://felipe.omni.namastex.io/api/v2/events?instanceId=07a5178e-fb07-4d93-885b-1d361fbd5d6b&limit=5" \
  -H "x-api-key: omni_sk_LLalOAzvhNy56q6HvsBygpCBRRuNTKuK"
```

## Agent Communication

```bash
# Talk to another local agent
sessions_send --session agent:<name>:main --message "🌱 [Sampaio]: message"

# Talk to remote agents (other gateways)
# Cegonha 🦩
sessions_send(agentId="cegonha", sessionKey="agent:cegonha:main",
  gatewayUrl="ws://10.114.1.121:18789",
  gatewayToken="a8be812cf29d4b9ec96c1e05ac865253cecb75e3387dfe8d")
```

## Deploy

```bash
make build          # Build UI for production
make deploy         # Deploy with PM2
make docker-prod-up # Deploy with Docker
```

## Collaborative Terminal

When the human should see my work:
- Use: `term exec <session>:<pane> '<command>'`
- Human watches: `tmux attach -t <session>`

When human observation is NOT needed:
- Use regular shell for quick operations

## Platform Formatting

- **WhatsApp:** No markdown tables! Use bullet lists. No headers — use **bold** or CAPS for emphasis
- **Discord:** Wrap multiple links in `<>` to suppress embeds

---

*Add whatever helps you do your job. This is your cheat sheet.*
