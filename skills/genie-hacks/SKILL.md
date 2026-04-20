---
name: genie-hacks
description: "Browse, search, and contribute community hacks — real-world patterns for provider switching, teams, skills, hooks, cost optimization, and more."
---

# /genie-hacks — Community Hacks & Patterns

Browse real-world Genie patterns contributed by the community. Search by problem, explore by category, or contribute your own.

## When to Use
- User wants to discover Genie tips, tricks, or advanced patterns
- User asks "how do I optimize costs?", "how do teams work?", or similar problem-oriented questions
- User wants to contribute a hack they discovered
- User invokes `/genie-hacks` with any subcommand
- If no subcommand is given, default to `list`

## Commands

| Command | Description |
|---------|-------------|
| `/genie-hacks` | List all hacks (same as `list`) |
| `/genie-hacks list` | List all hacks with title, problem, and category |
| `/genie-hacks search <keyword>` | Search hacks by keyword in title/problem/solution |
| `/genie-hacks show <hack-id>` | Display full hack details |
| `/genie-hacks contribute` | Submit a new hack via automated PR flow |
| `/genie-hacks help <problem>` | Describe a problem, get matched to relevant hacks |

---

## Hacks Registry

The canonical hacks live in the docs at `genie/hacks.mdx`. Below is the embedded registry for `list`, `search`, `show`, and `help` commands. Use this data directly — do not require an external file.

### hack: provider-switching
- **ID:** `provider-switching`
- **Title:** Provider Switching — Right Model for the Job
- **Category:** providers
- **Problem:** You're using one provider for everything, but some tasks need speed (Codex) and others need precision (Claude).
- **Solution:** Use `--provider` flag to switch per-task. Configure provider per agent role in team config.
- **Code:**
  ```bash
  # Fast scaffolding with Codex
  genie agent spawn engineer --provider codex

  # Careful review with Claude
  genie agent spawn reviewer --provider claude

  # Team-level: set default per role
  genie team create my-feature --repo . --wish my-slug
  genie team hire engineer --provider codex
  genie team hire reviewer --provider claude
  ```
- **Benefit:** 2-3x faster scaffolding with Codex, higher-quality reviews with Claude. Match the model to the cognitive demand.
- **When to use:** Teams with mixed workloads — boilerplate generation vs. nuanced code review. When cost or speed matters per task.

### hack: team-coordination
- **ID:** `team-coordination`
- **Title:** Multi-Team Coordination at Scale
- **Category:** teams
- **Problem:** You have multiple wishes that depend on each other, and running them sequentially wastes time.
- **Solution:** Use `/dream` to batch-execute wishes with dependency ordering. Same-layer wishes run in parallel.
- **Code:**
  ```bash
  # Queue wishes for overnight execution
  /dream

  # Or manually create parallel teams
  genie team create auth-refactor --repo . --wish auth-refactor
  genie team create api-v2 --repo . --wish api-v2

  # Monitor both
  genie wish status auth-refactor
  genie wish status api-v2

  # Cross-team messaging
  genie agent send 'auth-refactor is done, you can proceed' --to api-v2-team-lead
  ```
- **Benefit:** Parallel execution of independent wishes. Overnight batch runs that produce PRs by morning.
- **When to use:** Projects with 3+ wishes queued. Sprint planning where multiple features can be parallelized.

### hack: overnight-batch
- **ID:** `overnight-batch`
- **Title:** Overnight Batch Execution with /dream
- **Category:** batch
- **Problem:** You have a backlog of approved wishes but limited daytime hours to supervise execution.
- **Solution:** Use `/dream` to queue SHIP-ready wishes, set dependency order, and let agents execute overnight. Wake up to PRs and a DREAM-REPORT.md.
- **Code:**
  ```bash
  # 1. Ensure wishes are in brainstorm.md under "Poured"
  cat .genie/brainstorm.md

  # 2. Launch dream run
  /dream
  # Select wishes: 1 3 5 (or "all")
  # Confirm DREAM.md execution plan
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
- **Title:** Git Hook Automation with Genie Hooks
- **Category:** hooks
- **Problem:** You want agents to automatically react to git events — spawning a reviewer on PR creation, running tests on commit.
- **Solution:** Use Genie's hook system and Claude Code hooks in `.claude/settings.json` to trigger actions on events.
- **Code:**
  ```bash
  # Auto-spawn is built in — set GENIE_AGENT_NAME for dispatch:
  export GENIE_AGENT_NAME=my-agent

  # Claude Code hook example (.claude/settings.json):
  {
    "hooks": {
      "PreToolUse": [{
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "echo 'Tool being used: Bash'"
        }]
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
- **Solution:** Provider switching (Codex for bulk, Claude for review), tight wish scoping, `/refine` for prompt optimization, and usage monitoring.
- **Code:**
  ```bash
  # 1. Cheaper providers for boilerplate
  genie team hire engineer --provider codex
  genie team hire reviewer --provider claude

  # 2. Tight wish scoping
  # BAD: "Refactor the entire codebase"
  # GOOD: "Extract auth middleware into src/middleware/auth.ts"

  # 3. Refine prompts before dispatching
  /refine

  # 4. Monitor token usage
  genie agent log engineer --transcript --ndjson | jq '.tokens' | paste -sd+ | bc
  ```
- **Benefit:** 30-50% cost reduction by matching provider to task complexity. Tighter scoping means fewer fix loops.
- **When to use:** Budget-conscious teams. High agent concurrency. Before scaling to `/dream` batch runs.

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
- **Solution:** Use `genie agent log --raw` for live output, `genie agent log --transcript` for transcripts, `/trace` for root cause analysis, and `genie wish reset` for recovery.
- **Code:**
  ```bash
  # Live agent output
  genie agent log engineer --raw

  # Compressed timeline
  genie agent log engineer --transcript

  # Filter to tool calls
  genie agent log engineer --transcript --ndjson | jq 'select(.type == "tool_use") | .name'

  # Systematic investigation
  /trace

  # Check team status
  genie team ls my-team
  genie wish status my-wish-slug

  # Unstick a blocked group
  genie wish reset my-wish-slug#2
  ```
- **Benefit:** Full visibility into agent behavior. Systematic debugging instead of guessing.
- **When to use:** Agent taking too long. Output quality dropping. Team progress stalled. Post-mortem on failed dream run.

---

## Command: `list`

Display all hacks from the registry in a formatted table.

**Output format:**
```
Genie Hacks — Community Patterns & Tips

| ID                   | Title                                    | Category    |
|----------------------|------------------------------------------|-------------|
| provider-switching   | Provider Switching — Right Model for Job | providers   |
| team-coordination    | Multi-Team Coordination at Scale         | teams       |
| overnight-batch      | Overnight Batch Execution with /dream    | batch       |
| custom-skills        | Custom Skills for Repeated Workflows     | skills      |
| hook-automation      | Git Hook Automation with Genie Hooks     | hooks       |
| cost-optimization    | Cost Optimization Strategies             | cost        |
| integration-patterns | Integration Patterns — Connect to Stack  | integration |
| debugging-tips       | Debugging Agent Issues Like a Pro        | debugging   |

8 hacks available. Run `/genie-hacks show <id>` for details.
Contribute your own: `/genie-hacks contribute`
```

## Command: `search <keyword>`

Search hack titles, problems, solutions, and code for the keyword (case-insensitive). Display matching hacks.

**Output format:**
```
Search results for "<keyword>":

1. [provider-switching] Provider Switching — Right Model for the Job
   Problem: You're using one provider for everything...
   Category: providers

2. [cost-optimization] Cost Optimization Strategies
   Problem: Agent usage costs add up...
   Category: cost

2 hacks matched. Run `/genie-hacks show <id>` for full details.
```

If no matches: `No hacks found for "<keyword>". Try broader terms or run /genie-hacks list to browse all.`

## Command: `show <hack-id>`

Display the full hack with all fields. Look up by exact ID (case-insensitive).

**Output format:**
```
## <Title>

**Category:** <category> | **ID:** `<hack-id>`

### Problem
<problem text>

### Solution
<solution text>

### Code
<code block>

### Benefit
<benefit text>

### When to Use
<when-to-use text>

---
Found this useful? Share your own: `/genie-hacks contribute`
Full docs: https://docs.automagik.dev/genie/hacks
```

If not found: `Hack "<id>" not found. Did you mean: <suggest closest IDs>? Run /genie-hacks list to see all.`

## Command: `help <problem>`

Fuzzy-match a problem description to relevant hacks. Extract keywords, score by overlap across all fields, show top 3.

**Keyword mapping hints:**
- "speed", "fast", "slow" → provider-switching, cost-optimization
- "cost", "expensive", "budget", "tokens" → cost-optimization, provider-switching
- "team", "parallel", "coordinate", "multiple" → team-coordination, overnight-batch
- "overnight", "batch", "sleep", "queue" → overnight-batch, team-coordination
- "repeat", "workflow", "automate", "reuse" → custom-skills, hook-automation
- "hook", "event", "trigger", "auto" → hook-automation, custom-skills
- "slack", "ci", "integrate", "notify" → integration-patterns
- "stuck", "debug", "broken", "error", "fail" → debugging-tips
- "codex", "claude", "model", "provider" → provider-switching
- "dream", "night", "unattended" → overnight-batch

**Output format:**
```
Based on your problem: "<problem>"

Best matches:

1. [provider-switching] Provider Switching — Right Model for the Job
   Why: Matches your need for speed/cost optimization across providers
   Quick tip: Use `genie agent spawn engineer --provider codex` for fast scaffolding

2. [cost-optimization] Cost Optimization Strategies
   Why: Directly addresses cost reduction techniques
   Quick tip: Scope wishes tightly and use `/refine` before dispatching

3. [team-coordination] Multi-Team Coordination at Scale
   Why: Parallel execution reduces wall-clock time
   Quick tip: Use `/dream` for batch overnight execution

Run `/genie-hacks show <id>` for full details on any hack.
```

If no reasonable matches: `No hacks closely match your problem. Try describing it differently, or run /genie-hacks list to browse all. Got a solution? Run /genie-hacks contribute!`

## Command: `contribute`

### Overview

Guide the user through contributing a new hack to the community docs via an automated PR to `automagik-dev/docs`. This is the full end-to-end flow.

### Step 1: Gather Hack Details

Prompt the user for each field interactively. Wait for each response before proceeding.

**Prompt sequence:**

1. **Title**: "What's your hack title? (short, descriptive)"
   - Example: "Provider Switching for Speed vs Safety"

2. **Problem**: "What problem does it solve? (1-2 sentences)"
   - Example: "Different tasks need different AI providers — speed for scaffolding, careful reasoning for security-sensitive code."

3. **Solution**: "How does it work? Show the commands, config, or code. (Use code blocks)"
   - Example: multi-line code block with genie commands

4. **Category**: "What category? Pick one: `providers` | `teams` | `skills` | `hooks` | `cost` | `integration` | `debugging` | `batch` | `other`"
   - Validate input is one of the allowed categories. If invalid, re-prompt.

5. **Benefit**: "What's the key benefit? (one line)"
   - Example: "Right tool for each job — 3x faster scaffolding, safer reviews."

6. **When to use**: "When should someone use this? (one line)"
   - Example: "When your project has both speed-critical and safety-critical tasks."

### Step 2: Preview & Confirm

Format the hack in the standard template and show the user:

```markdown
### <Title>

**ID:** `<generated-id>`
**Category:** <category>

**Problem:** <problem>

**Solution:**

<solution with code blocks>

**Benefit:** <benefit>

**When to use:** <when>
```

Ask: "Does this look good? (yes/edit/cancel)"
- **yes** → proceed to Step 3
- **edit** → ask which field to change, re-prompt for that field, re-preview
- **cancel** → abort with "No worries! Run `/genie-hacks contribute` anytime."

### Step 3: GitHub CLI Preflight

Run these checks in order. Stop at first failure with a helpful error.

```bash
# 1. Check gh is installed
command -v gh >/dev/null 2>&1
# If missing: "GitHub CLI (gh) is required. Install: https://cli.github.com/"

# 2. Check gh is authenticated
gh auth status 2>&1
# If not authenticated: "Run `gh auth login` to authenticate with GitHub first."

# 3. Check git is available
command -v git >/dev/null 2>&1
# If missing: "git is required but not found in PATH."
```

If any check fails, display the error message and suggest manual steps:
```
Manual contribution steps:
1. Fork https://github.com/automagik-dev/docs
2. Edit genie/hacks.mdx — add your hack in the correct category section
3. Commit: git commit -m "hack: <title>"
4. Open PR to automagik-dev/docs (base: dev)
```

### Step 4: Fork & Clone

```bash
# Cache directory for docs repo
DOCS_CACHE="$HOME/.genie/cache/docs-fork"

# Fork the docs repo (idempotent — no-op if already forked)
gh repo fork automagik-dev/docs --clone=false 2>/dev/null || true

# Get the user's GitHub username for the fork URL
GH_USER=$(gh api user --jq '.login')

# Clone or update the cached fork
if [ -d "$DOCS_CACHE/.git" ]; then
  cd "$DOCS_CACHE"
  git fetch origin
  git checkout dev
  git pull origin dev
else
  gh repo clone "$GH_USER/docs" "$DOCS_CACHE" -- --branch dev
  cd "$DOCS_CACHE"
  git remote add upstream https://github.com/automagik-dev/docs.git 2>/dev/null || true
  git fetch upstream
fi

# Create a branch for the hack
BRANCH="hack/$(echo '<title>' | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')"
git checkout -b "$BRANCH" origin/dev
```

If clone/fork fails, show the error and fall back to manual steps (same as Step 3 fallback).

### Step 5: Append Hack to hacks.mdx

Read `genie/hacks.mdx` from the cloned repo. Find the correct category section (look for `## <Category>` heading — e.g., `## Providers`, `## Teams`, etc.). Append the new hack entry just before the next `## ` heading or at the end of the category section.

If the category section doesn't exist (e.g., for `other`), append a new section at the end of the file, before the Contributing section:

```markdown
## Other

### <Title>

**ID:** `<generated-id>`

**Problem:** <problem>

**Solution:**

<solution>

**Benefit:** <benefit>

**When to use:** <when>

---
```

### Step 6: Commit & Push

```bash
cd "$DOCS_CACHE"
git add genie/hacks.mdx
git commit -m "hack: <title>"
git push -u origin "$BRANCH"
```

### Step 7: Create PR

```bash
# Create PR targeting the dev branch of the upstream docs repo
PR_URL=$(gh pr create \
  --repo automagik-dev/docs \
  --base dev \
  --head "$GH_USER:$BRANCH" \
  --title "hack: <title>" \
  --body "$(cat <<'PREOF'
## New Community Hack

**Title:** <title>
**Category:** <category>
**Problem:** <problem>

**Solution:**
<solution summary>

**Benefit:** <benefit>
**When to use:** <when>

---

*Submitted via `/genie-hacks contribute`*
PREOF
)")

echo "PR created: $PR_URL"
```

### Step 8: Success

Display the result to the user:

```
Your hack has been submitted!

PR: <PR_URL>
Title: hack: <title>
Target: automagik-dev/docs (dev branch)

What happens next:
- A maintainer will review your hack
- They may suggest edits via PR comments
- Once approved, it'll appear on the hacks page

Thank you for contributing to the Genie community!
Join the discussion on Discord: https://discord.gg/automagik
```

### Error Recovery

At any point if a step fails:

| Error | Recovery |
|-------|----------|
| `gh` not installed | Show install URL, fall back to manual steps |
| `gh` not authenticated | Show `gh auth login` command |
| Fork fails | Check if fork already exists with `gh repo view $GH_USER/docs` |
| Clone fails | Remove cache dir and retry: `rm -rf $DOCS_CACHE && gh repo clone ...` |
| `hacks.mdx` not found | Create a new one with the standard template header |
| Push fails (auth) | Suggest `gh auth refresh` or SSH key setup |
| PR creation fails | Show the branch/commit info so user can create PR manually via GitHub web UI |
| Editor fails | Write the hack content to a temp file, show the path for manual copy |

### Offline / Manual Fallback

If GitHub operations fail entirely, save the hack locally and guide the user:

```bash
# Save hack to local file
mkdir -p ~/.genie/cache/pending-hacks
cat > ~/.genie/cache/pending-hacks/<hack-id>.md << 'EOF'
<formatted hack content>
EOF
```

Then display:
```
Saved your hack locally at: ~/.genie/cache/pending-hacks/<hack-id>.md

To submit manually:
1. Fork https://github.com/automagik-dev/docs
2. Copy the hack content into genie/hacks.mdx under the "<category>" section
3. Commit with message: "hack: <title>"
4. Open PR targeting the `dev` branch
```

## Categories Reference

| Category | ID | Description |
|----------|----|-------------|
| Providers | `providers` | Provider switching, model selection, BYOA |
| Teams | `teams` | Multi-agent coordination, team patterns |
| Skills | `skills` | Custom skills, skill chains, automation |
| Hooks | `hooks` | Git hooks, auto-spawn, event-driven flows |
| Cost | `cost` | Token optimization, model routing, budget control |
| Integration | `integration` | External tools, APIs, CI/CD, Slack, etc. |
| Debugging | `debugging` | Agent debugging, tracing, fixing bad behavior |
| Batch | `batch` | Overnight execution, queued processing |
| Other | `other` | Uncategorized community patterns |

## Docs Cache

The docs repo is cached at `~/.genie/cache/docs-fork/` to avoid re-cloning on every contribute. The cache is updated (`git pull`) on each contribute invocation. If the cache becomes corrupted, delete it and re-run — the contribute flow will re-clone automatically.

## Rules

- All hack IDs are lowercase kebab-case.
- Never invent hacks that don't exist in the registry — only show what's listed above.
- For `help`, always try to find at least one relevant hack. Only say "no matches" if truly nothing fits.
- Keep output concise — tables for `list`, full format only for `show`.
- Always end `list` and `show` with a nudge toward `contribute`.
- The `contribute` command should be friendly and low-friction — one question at a time.
- Link to Discord (https://discord.gg/automagik) for community discussion.
- Link to docs (https://docs.automagik.dev/genie/hacks) for the full hacks page.
- Always target the `dev` branch for PRs — never `main`/`master`.
- Hack IDs must be unique — check existing IDs before appending.
- All hacks must be realistic and tested — do not submit aspirational or untested patterns.
- Preserve the standard format: problem, solution, code, benefit, when to use.
- Keep code examples concise — show the minimum needed to understand the hack.
