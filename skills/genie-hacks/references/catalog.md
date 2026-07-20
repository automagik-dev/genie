# Genie Hacks Catalog

The local registry powering `genie-hacks list|search|show|help`. Canonical published page: https://docs.automagik.dev/genie/hacks (source `genie/hacks.mdx` in automagik-dev/docs). Every entry is grounded against the live v5 CLI (`genie --help`); entries born in the v4 daemon era carry a *v4 note* with the live replacement.

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
- **Problem:** One model and reasoning level is being used for every task even though exploration, implementation, and adversarial review have different needs.
- **Solution:** Pick the terminal client per wish with `genie launch --agent`, then configure model, effort, and permissions in that client's named-agent surface. Codex uses `~/.codex/agents/*.toml`; Claude/Hermes use their native role configuration. Keep host-specific routing out of shared `SKILL.md` frontmatter.
- **Code:**
  ```bash
  # Fast scaffolding wish: drive the cockpit panes with Codex
  genie launch my-scaffold-wish --agent codex

  # Define review roles in the selected client's agent configuration with a
  # read-only sandbox and higher reasoning only when the task warrants it.
  ```
  Use a fast read-heavy configuration for exploration and the strongest justified configuration for demanding review.
- **Benefit:** Match latency and depth to the cognitive demand without encoding host-specific model settings in skills.
- **When to use:** Mixed workloads — boilerplate generation vs. nuanced code review. When cost or speed matters per task.
- ***v4 note:*** daemon per-role provider flags are gone. Provider choice now lives on `genie launch --agent`; role behavior lives in each client's native agent configuration.

### hack: team-coordination
- **ID:** `team-coordination`
- **Title:** Multi-Team Coordination at Scale
- **Category:** teams
- **Problem:** You have multiple wishes that depend on each other, and running them sequentially wastes time.
- **Solution:** Use `dream` to batch-execute wishes with dependency ordering, or open one `genie launch` cockpit per independent wish. Use the active runtime's native subagents for independent work, steer the same thread with follow-up messaging, and give every concurrent execution group a dedicated branch and worktree. The PM merges reviewed commits into the wish integration branch and removes clean merged lanes so worktrees and branches reflect active work. Track shared wish state in the task DB.
- **Code:**
  ```bash
  # Queue wishes for overnight execution
  # Invoke the dream skill in the active client.

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
- ***v4 note:*** daemon-era create/status/send verbs are gone. Orchestration now uses native subagents plus the SQLite task DB.

### hack: overnight-batch
- **ID:** `overnight-batch`
- **Title:** Overnight Batch Execution with dream
- **Category:** batch
- **Problem:** You have a backlog of approved wishes but limited daytime hours to supervise execution.
- **Solution:** Use `dream` to queue SHIP-ready wishes, set dependency order, and let agents execute overnight. Wake up to PRs and a DREAM-REPORT.md.
- **Code:**
  ```bash
  # 1. Sanity-check what is ready to run
  genie task list --status ready

  # 2. Launch the dream run
  # Invoke the dream skill in the active client.
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
- **Solution:** Use the active client's skill-authoring workflow. In Codex, `$skill-creator` creates personal skills under `~/.agents/skills/<name>/` or repository skills under `.agents/skills/<name>/`. Keep shared `SKILL.md` frontmatter to `name` and `description`; Codex UI policy belongs in `agents/openai.yaml`.
- **Code:**
  ```bash
  # Ask Codex:
  $skill-creator create a deploy-check skill with tests, migrations,
  env validation, and build verification.

  # Then invoke it:
  $deploy-check
  ```
- **Benefit:** Encode tribal knowledge as reusable skills. New team members get instant access to workflows.
- **When to use:** Any workflow you've explained more than twice. CI-like checks you want to run locally before pushing.

### hack: hook-automation
- **ID:** `hook-automation`
- **Title:** Event Automation with Genie Hooks
- **Category:** hooks
- **Problem:** You want automatic reactions to development events — guarding branches, injecting agent identity, blocking unsafe tool calls.
- **Solution:** Use the selected client's documented hook surface and keep commands deterministic and local. In Codex, non-managed hooks are skipped until the user reviews and trusts the exact definition hash; use canonical tool names (`Bash`, `apply_patch`, MCP names) and plugin `PLUGIN_ROOT`/`PLUGIN_DATA`. Claude/Hermes keep their own event envelopes. Never use lifecycle hooks for silent installers or self-updates.
- **Code:**
  ```bash
  # Identity used by hook dispatch (also the default task-checkout worker)
  export GENIE_AGENT_NAME=my-agent

  # In an interactive Codex session, inspect and trust with /hooks.
  ```
  Project hook in `.codex/hooks.json`:
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
- **Solution:** Match the model and reasoning effort to each named-agent role, scope wishes tightly, run `refine` on prompts before dispatch, and use the selected client's usage telemetry for evidence (Codex JSONL/app indicators or the equivalent client surface).
- **Code:**
  ```bash
  # 1. Cheaper driver for bulk scaffolding wishes
  genie launch my-scaffold-wish --agent codex

  # 2. Tight wish scoping
  # BAD:  "Refactor the entire codebase"
  # GOOD: "Extract auth middleware into src/middleware/auth.ts"

  # 3. Refine prompts before dispatching
  # Invoke the refine skill in the active client.

  # 4. In automation, capture turn usage
  codex exec --json "run the bounded task" | jq
  ```
- **Benefit:** 30-50% cost reduction by matching provider to task complexity. Tighter scoping means fewer fix loops.
- **When to use:** Budget-conscious teams. High agent concurrency. Before scaling to `dream` batch runs.
- ***v4 note:*** token math over daemon transcript logs is gone. Use the active client's supported usage surface instead.

### hack: integration-patterns
- **ID:** `integration-patterns`
- **Title:** Integration Patterns — Connect Genie to Your Stack
- **Category:** integration
- **Problem:** You want Genie to integrate with existing tools — Slack notifications, CI/CD pipelines, monitoring.
- **Solution:** Prefer installed connectors for GitHub and messaging actions, and use shell or webhooks only for gaps. External messages, issue creation, workflow dispatch, and other outward writes require explicit authorization and exact target confirmation.
- **Code:**
  ```bash
  # Post to Slack via webhook
  curl -X POST "$SLACK_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d '{"text": "Genie: wish auth-refactor done. PR #123"}'

  # Create GitHub issues from findings
  gh issue create --title "Bug: auth token expiry" \
    --body "Found during trace: refresh fails silently"

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
- **Solution:** Use `trace` for root-cause analysis, `genie doctor` for install health, and the task DB for where work is stuck. Native clients return each subagent's final summary to the orchestrator; cockpit panes from `genie launch` remain visible in the terminal.
- **Code:**
  ```bash
  # Systematic investigation of an unknown failure
  # Invoke the trace skill in the active client.

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
- ***v4 note:*** daemon-era log/status/reset verbs are gone; state moved to SQLite (`genie task ...`, `genie board`) and live output to native subagent threads.
