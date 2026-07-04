# Genie Hacks Catalog

The local registry powering `/genie-hacks list|search|show|help`. Canonical published page: https://docs.automagik.dev/genie/hacks (source `genie/hacks.mdx` in automagik-dev/docs). Every entry is grounded against the live v5 CLI (`genie --help`); entries born in the v4 daemon era carry a *v4 note* with the live replacement.

## Categories

| Category | ID | Description |
|----------|----|-------------|
| Providers | `providers` | Provider switching, model selection, BYOA |
| Teams | `teams` | Multi-agent coordination, team patterns |
| Skills | `skills` | Custom skills, skill chains, automation |
| Hooks | `hooks` | Git hooks, event-driven flows |
| Cost | `cost` | Token optimization, model routing, budget control |
| Integration | `integration` | External tools, APIs, CI/CD, Slack, etc. |
| Debugging | `debugging` | Agent debugging, tracing, fixing bad behavior |
| Batch | `batch` | Overnight execution, queued processing |
| Other | `other` | Uncategorized community patterns |

## Hacks

### hack: provider-switching
- **ID:** `provider-switching`
- **Title:** Provider Switching — Right Model for the Job
- **Category:** providers
- **Problem:** You're using one provider for everything, but some tasks need speed (Codex) and others need precision (Claude).
- **Solution:** Pick the terminal agent per wish with `genie launch --agent`, and pin the model per subagent role inside Claude Code via `model:` frontmatter in `.claude/agents/<role>.md` (or a model override when dispatching with the Agent tool).
- **Code:**
  ```bash
  # Fast scaffolding wish: drive the cockpit panes with Codex
  genie launch my-scaffold-wish --agent codex

  # Careful review wish: drive with Claude (default)
  genie launch my-review-wish --agent claude
  ```
  Inside Claude Code, match model to role — e.g. `model: haiku` for a scaffolder subagent, `model: opus` for a reviewer.
- **Benefit:** 2-3x faster scaffolding with Codex, higher-quality reviews with Claude. Match the model to the cognitive demand.
- **When to use:** Mixed workloads — boilerplate generation vs. nuanced code review. When cost or speed matters per task.
- ***v4 note:*** originally used the daemon CLI's per-role `--provider` flags on spawn/hire verbs — that CLI is dead. Provider choice now lives on `genie launch --agent` and on Claude Code subagent definitions.

### hack: team-coordination
- **ID:** `team-coordination`
- **Title:** Multi-Team Coordination at Scale
- **Category:** teams
- **Problem:** You have multiple wishes that depend on each other, and running them sequentially wastes time.
- **Solution:** Use `/dream` to batch-execute wishes with dependency ordering, or open one `genie launch` cockpit per independent wish — each ready group gets its own worktree. Cross-agent coordination runs over Claude Code native teams: dispatch subagents with the Agent tool, message them with SendMessage, and track shared state in the task DB.
- **Code:**
  ```bash
  # Queue wishes for overnight execution
  /dream

  # Or run independent wishes in parallel — one cockpit each
  genie launch auth-refactor
  genie launch api-v2

  # Monitor both from any terminal (state is shared SQLite)
  genie board --wish auth-refactor
  genie board --wish api-v2
  genie task list --status in_progress
  ```
- **Benefit:** Parallel execution of independent wishes. Overnight batch runs that produce PRs by morning.
- **When to use:** Projects with 3+ wishes queued. Sprint planning where multiple features can be parallelized.
- ***v4 note:*** originally built on daemon-era create/status/send verbs — dead. Orchestration moved to Claude Code native teams (Agent tool + SendMessage) plus the SQLite task DB.

### hack: overnight-batch
- **ID:** `overnight-batch`
- **Title:** Overnight Batch Execution with /dream
- **Category:** batch
- **Problem:** You have a backlog of approved wishes but limited daytime hours to supervise execution.
- **Solution:** Use `/dream` to queue SHIP-ready wishes, set dependency order, and let agents execute overnight. Wake up to PRs and a DREAM-REPORT.md.
- **Code:**
  ```bash
  # 1. Sanity-check what is ready to run
  genie task list --status ready

  # 2. Launch the dream run
  /dream
  # Select wishes: 1 3 5 (or "all")
  # Confirm the execution plan
  # Go to sleep

  # 3. Morning: check results
  cat .genie/DREAM-REPORT.md
  gh pr list --author @me
  ```
- **Benefit:** 8+ hours of unattended execution. Multiple PRs ready for review by morning.
- **When to use:** End of day with 2+ SHIP-ready wishes. Sprint velocity needs a boost without more human hours.

### hack: custom-skills
- **ID:** `custom-skills`
- **Title:** Custom Skills for Repeated Workflows
- **Category:** skills
- **Problem:** You keep typing the same sequence of commands or giving the same instructions repeatedly.
- **Solution:** Create a custom skill in `skills/<name>/SKILL.md` with YAML frontmatter. Claude loads it when invoked via `/<name>`.
- **Code:**
  ```bash
  mkdir -p skills/deploy-check
  cat > skills/deploy-check/SKILL.md << 'EOF'
  ---
  name: deploy-check
  description: "Pre-deploy checklist — tests, migrations, env vars."
  ---
  # /deploy-check
  1. Run `bun test`
  2. Check migrations: `bunx prisma migrate status`
  3. Verify env vars are set
  4. Build: `bun run build`
  5. Report pass/fail table
  EOF

  # Use it
  /deploy-check
  ```
- **Benefit:** Encode tribal knowledge as reusable skills. New team members get instant access to workflows.
- **When to use:** Any workflow you've explained more than twice. CI-like checks you want to run locally before pushing.

### hack: hook-automation
- **ID:** `hook-automation`
- **Title:** Event Automation with Genie Hooks
- **Category:** hooks
- **Problem:** You want automatic reactions to development events — guarding branches, injecting agent identity, blocking unsafe tool calls.
- **Solution:** Genie's hook middleware handles Claude Code events in-process: each event runs a short-lived `genie hook dispatch` fork (JSON in on stdin, allow/deny decision out on stdout — no daemon). Combine with your own Claude Code hooks in `.claude/settings.json`.
- **Code:**
  ```bash
  # Identity used by hook dispatch (also the default task-checkout worker)
  export GENIE_AGENT_NAME=my-agent

  # Trust a custom .ts hook file (omit the path to list current entries)
  genie hook trust .claude/hooks/my-hook.ts
  ```
  Plain Claude Code hook in `.claude/settings.json`:
  ```json
  {
    "hooks": {
      "PreToolUse": [{
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "echo 'Tool being used: Bash'" }]
      }]
    }
  }
  ```
- **Benefit:** Automated reactions to development events. Less manual orchestration.
- **When to use:** Teams wanting CI-like automation within the agent workflow. Projects where wish-to-PR should be fully autonomous.

### hack: cost-optimization
- **ID:** `cost-optimization`
- **Title:** Cost Optimization Strategies
- **Category:** cost
- **Problem:** Agent usage costs add up, especially with large teams or long-running dream runs.
- **Solution:** Match the driver to the task (`genie launch --agent codex` for bulk, `claude` for review), scope wishes tightly, run `/refine` on prompts before dispatch, and watch usage with Claude Code's `/cost` and `/context`.
- **Code:**
  ```bash
  # 1. Cheaper driver for bulk scaffolding wishes
  genie launch my-scaffold-wish --agent codex

  # 2. Tight wish scoping
  # BAD:  "Refactor the entire codebase"
  # GOOD: "Extract auth middleware into src/middleware/auth.ts"

  # 3. Refine prompts before dispatching
  /refine

  # 4. Monitor usage inside Claude Code
  /cost      # session spend
  /context   # what is filling the window
  ```
- **Benefit:** 30-50% cost reduction by matching provider to task complexity. Tighter scoping means fewer fix loops.
- **When to use:** Budget-conscious teams. High agent concurrency. Before scaling to `/dream` batch runs.
- ***v4 note:*** token math over daemon transcript logs is dead; usage introspection now lives in Claude Code itself (`/cost`, `/context`).

### hack: integration-patterns
- **ID:** `integration-patterns`
- **Title:** Integration Patterns — Connect Genie to Your Stack
- **Category:** integration
- **Problem:** You want Genie to integrate with existing tools — Slack notifications, CI/CD pipelines, monitoring.
- **Solution:** Use shell commands in skills for custom integrations, GitHub CLI for PR/issue management, webhooks for notifications.
- **Code:**
  ```bash
  # Post to Slack via webhook
  curl -X POST "$SLACK_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d '{"text": "Genie: wish auth-refactor done. PR #123"}'

  # Create GitHub issues from findings
  gh issue create --title "Bug: auth token expiry" \
    --body "Found during /trace: refresh fails silently"

  # Trigger CI after PR
  gh workflow run ci.yml --ref feat/my-feature
  ```
- **Benefit:** Genie becomes part of your existing workflow. Notifications go where your team already looks.
- **When to use:** Teams with Slack/Discord channels. Projects with CI/CD pipelines that should trigger on agent PRs.

### hack: debugging-tips
- **ID:** `debugging-tips`
- **Title:** Debugging Agent Issues Like a Pro
- **Category:** debugging
- **Problem:** An agent is stuck, producing wrong output, or a team isn't making progress.
- **Solution:** Use `/trace` for root-cause analysis, `genie doctor` for install health, and the task DB for where work is stuck. Subagent output lands in the orchestrator's transcript in Claude Code native teams; cockpit panes from `genie launch` are visible directly in the terminal.
- **Code:**
  ```bash
  # Systematic investigation of an unknown failure
  /trace

  # Health-check the genie installation
  genie doctor

  # Where is work stuck? Task and board state live in SQLite
  genie task list --status blocked
  genie task status <task-id>
  genie board --wish my-wish-slug

  # Full state dump for post-mortems (JSON)
  genie task export

  # Unstick: closing the blocker recomputes the ready set
  genie task done <task-id>
  ```
- **Benefit:** Full visibility into agent behavior. Systematic debugging instead of guessing.
- **When to use:** Agent taking too long. Output quality dropping. Team progress stalled. Post-mortem on failed dream run.
- ***v4 note:*** daemon-era log/status/reset verbs are dead; state moved to SQLite (`genie task ...`, `genie board`) and live agent output to Claude Code transcripts.
