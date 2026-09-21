# Genie Hacks Catalog

The local registry powering `genie-hacks list|search|show|help`. Canonical published page: https://docs.automagik.dev/genie/hacks (source `genie/hacks.mdx` in automagik-dev/docs). Every entry is grounded on the live CLI (`genie --help` is the source of truth). `genie task` and `genie board` commands apply in standalone lifecycle mode; under explicitly selected Orca authority, Orca owns dispatch and task state.

## Categories

| Category | ID | Description |
|----------|----|-------------|
| Planning | `planning` | Task vs wish, acceptance criteria, linting a plan |
| Parallel | `parallel` | Wave shape, worktrees, the shared per-repo database |
| Ops | `ops` | Doctor, budgets, install hygiene, release verification |
| Providers | `providers` | Provider switching, model selection, BYOA |
| Teams | `teams` | Multi-agent coordination, team patterns |
| Skills | `skills` | Custom skills, skill chains, automation |
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
- **Problem:** One model and reasoning level serves every task, although exploration, implementation, and adversarial review have different needs.
- **Solution:** Choose the client per wish through the dispatch role, then set model, effort, and permissions in that client's named-agent surface (Codex: `~/.codex/agents/*.toml`; every other client: whatever named-role configuration it ships). Use a fast read-heavy configuration for exploration and the strongest justified configuration for demanding review. Keep host-specific routing out of shared `SKILL.md` frontmatter.
- **Code:**
  ```bash
  genie task checkout <task-id> --worker engineer   # standalone claim, then dispatch via the client's named role
  ```
- **Benefit:** Latency and depth match the cognitive demand without encoding model settings in skills.
- **When to use:** Mixed workloads, or when cost or speed matters per task.

### hack: team-coordination
- **ID:** `team-coordination`
- **Title:** Multi-Wish Coordination
- **Category:** teams
- **Problem:** Several approved wishes depend on each other and running them one at a time wastes time.
- **Solution:** Use `dream` to batch-execute `APPROVED` wishes in dependency order. Run independent work through the runtime's native subagents, steer a running thread with follow-up messaging, and give parallel writers disjoint files or isolated worktrees per `AGENTS.md` and the `work` skill.
- **Code:**
  ```bash
  genie board --wish auth-refactor        # standalone: shared SQLite state, readable from any terminal
  genie board --wish api-v2
  genie task list --status in_progress
  ```
- **Benefit:** Independent wishes run in parallel with one shared view of state.
- **When to use:** Several approved wishes queued, or sprint planning with parallelizable features.

### hack: overnight-batch
- **ID:** `overnight-batch`
- **Title:** Overnight Batch Execution with dream
- **Category:** batch
- **Problem:** A backlog of approved wishes and limited hours to supervise execution.
- **Solution:** Invoke the `dream` skill in the active client, pick the `APPROVED` wishes, confirm the dependency-ordered plan, and let it run. In the morning read the report.
- **Code:**
  ```bash
  genie task list --status ready          # standalone: what is claimable
  cat .genie/DREAM-REPORT.md              # next morning
  gh pr list --author @me
  ```
- **Benefit:** Unattended execution of approved work, with PRs and a report ready for review.
- **When to use:** End of day with approved wishes waiting.

### hack: custom-skills
- **ID:** `custom-skills`
- **Title:** Custom Skills for Repeated Workflows
- **Category:** skills
- **Problem:** The same command sequence or instructions get typed repeatedly.
- **Solution:** Use the active client's skill-authoring workflow. In Codex, the skill creator writes personal skills under `~/.agents/skills/<name>/` or repository skills under `.agents/skills/<name>/`; ask it, for example, to create a `deploy-check` skill covering tests, migrations, env validation, and build verification, then invoke `deploy-check` by name. Keep shared `SKILL.md` frontmatter to `name` and `description`; Codex UI metadata belongs in `agents/openai.yaml`.
- **Benefit:** Tribal knowledge becomes a reusable skill new team members can invoke.
- **When to use:** Any workflow explained more than twice; local pre-push checks.

### hack: hook-automation
- **ID:** `hook-automation`
- **Title:** Event Automation with Runtime Hooks
- **Category:** other
- **Problem:** You want automatic reactions to development events: guarding branches, injecting agent identity, blocking unsafe tool calls.
- **Solution:** Genie installs no hooks into any runtime. If the active client offers hooks, discover its documented hook surface and schema in that client's own reference and follow them; do not copy a schema from memory. Keep hook commands deterministic and local, review each definition before trusting it, and never use lifecycle hooks for silent installers or self-updates.
- **Code:**
  ```bash
  export GENIE_AGENT_NAME=my-agent        # identity the genie CLI reads; the default task-checkout worker
  ```
- **Benefit:** Automated, reviewed reactions to events without hidden workflows.
- **When to use:** CI-like automation inside the agent workflow, once the client's hook surface is confirmed.

### hack: cost-optimization
- **ID:** `cost-optimization`
- **Title:** Cost Optimization Strategies
- **Category:** cost
- **Problem:** Agent usage costs add up with large teams or long dream runs.
- **Solution:** Match model and reasoning effort to each named-agent role (an `implementor-low` role for bulk scaffolding), scope wishes tightly ("Extract auth middleware into src/middleware/auth.ts", not "Refactor the entire codebase"), run the `refine` skill on briefs before dispatch, and take cost evidence from the client's supported usage surface.
- **Code:**
  ```bash
  codex exec --json "run the bounded task" | jq   # in automation, capture turn usage
  ```
- **Benefit:** Spend follows task complexity; tighter scope means fewer fix loops. Measure your own savings; they vary by workload.
- **When to use:** Budget-conscious teams, high agent concurrency, before scaling `dream` runs.

### hack: integration-patterns
- **ID:** `integration-patterns`
- **Title:** Integration Patterns — Connect Genie to Your Stack
- **Category:** integration
- **Problem:** Genie should feed existing tools: Slack notifications, CI/CD pipelines, monitoring.
- **Solution:** Prefer installed connectors for GitHub and messaging; use shell or webhooks only for gaps. External messages, issue creation, workflow dispatch, and other outward writes need explicit authorization and an exact target.
- **Code:**
  ```bash
  curl -X POST "$SLACK_WEBHOOK_URL" -H 'Content-Type: application/json' \
    -d '{"text": "Genie: wish auth-refactor done. PR #123"}'
  gh issue create --title "Bug: auth token expiry" --body-file report.md
  gh workflow run ci.yml --ref feat/my-feature
  ```
- **Benefit:** Notifications and follow-ups land where the team already looks.
- **When to use:** Teams with chat channels or pipelines that should react to agent PRs.

### hack: debugging-tips
- **ID:** `debugging-tips`
- **Title:** Debugging Agent Issues
- **Category:** debugging
- **Problem:** An agent is stuck, producing wrong output, or a run is not making progress.
- **Solution:** Invoke the `report` skill for a root-cause investigation (no issue is filed unless asked), `genie doctor` for install health, and the task DB for where work is stuck. Subagents return their final summary to the orchestrator, so nothing needs watching in a terminal. Before re-claiming a stuck `in_progress` task with `genie task checkout`, confirm who holds the claim and that the worker is no longer live, and act only with the coordinator's recovery authority; elapsed time alone justifies nothing. `genie task done` is never an unstick shortcut, it is the coordinator's call after review and validation.
- **Code:**
  ```bash
  genie doctor                            # install health
  genie task list --status blocked        # standalone task state
  genie task status <task-id>
  genie board --wish my-wish-slug
  genie task export                       # JSON state dump for a post-mortem
  ```
- **Benefit:** Systematic investigation instead of guessing.
- **When to use:** A slow agent, dropping output quality, a stalled run, or a post-mortem on a failed dream run.

### hack: one-task-skips-the-plan
- **ID:** `one-task-skips-the-plan`
- **Title:** Let One Task Skip the Plan
- **Category:** planning
- **Problem:** A `WISH.md` gets written for one execution group, the plan gets reviewed, and one agent is dispatched — three gates for a change that was obvious from the first sentence.
- **Solution:** Hand `wish` one decided task and it skips the plan entirely: it admits the task, builds it in its own worktree, runs the gate, has a different agent review the commit, and opens a merge-ready PR. Only work genuinely bigger than one task becomes a `WISH.md`.
- **Code:**
  ```text
  /wish rename the --lane flag to --to across task move and its tests
  ```
- **Benefit:** One decided change ships in one pass instead of four, and the plan artifact stops being a formality nobody reads.
- **When to use:** Whenever the whole change and its acceptance fit in a sentence. "And also" means it is a wish, not a task.

### hack: lint-the-wish-first
- **ID:** `lint-the-wish-first`
- **Title:** Lint the Wish Before Anything Acts on It
- **Category:** planning
- **Problem:** An agent works for twenty minutes against a wish whose group has no acceptance criteria, and the review has nothing to check against.
- **Solution:** Run `genie wish lint` over the repository's `.genie/wishes`. It writes nothing and exits 0 clean, 1 findings, 2 refused root, so it drops straight into a pre-commit hook or a CI step. Treat 2 as a failure: a typed `--dir` that does not resolve is refused, never reported clean.
- **Code:**
  ```bash
  genie wish lint                 # this repository
  genie wish lint --dir ../other  # any other checkout
  ```
- **Benefit:** A malformed plan fails in a second instead of after a wasted execution wave.
- **When to use:** Always, in CI. Also by hand right after a large plan is written, before approving it.

### hack: shape-groups-for-waves
- **ID:** `shape-groups-for-waves`
- **Title:** Shape Groups for Waves, Not for Tidiness
- **Category:** parallel
- **Problem:** A wish with six groups runs almost sequentially because every group quietly depends on the one before it.
- **Solution:** Dependencies decide the wave, so write `depends-on` deliberately and keep independent work independent. `work` dispatches each wave through the runtime's own native subagents; groups with no shared dependency run together.
- **Code:**
  ```bash
  genie board                 # the live kanban, derived by query
  genie task status <task-id> # dependencies, stage log, assignment
  ```
- **Benefit:** A six-group wish finishes in roughly the time of its longest chain; the bottleneck moves to review, where it belongs.
- **When to use:** Any wish with three or more groups where at least two touch different files.

### hack: one-database-every-worktree
- **ID:** `one-database-every-worktree`
- **Title:** One Database, Every Worktree
- **Category:** parallel
- **Problem:** A worktree is cut for a group, a task is created in it, and the task appears to be invisible from the main checkout.
- **Solution:** It is not. Every linked worktree resolves the same `.genie/genie.db` through the git common directory, so there is no sync step and nothing to reconcile. Only the canonical board snapshot `.genie/roadmap.json` is a file in git, and `genie task sync` reconciles it three ways on checkout, merge, rewrite and pre-commit.
- **Code:**
  ```bash
  git worktree add ../feature-x -b wish/feature-x origin/dev
  (cd ../feature-x && genie task list)   # same cards, same database
  ```
- **Benefit:** Worktree isolation for the files without fragmenting the state.
- **When to use:** Every time work fans out. Never copy `genie.db` between worktrees — that creates two histories `task sync` then has to merge.

### hack: microagent-taste
- **ID:** `microagent-taste`
- **Title:** Teach a Microagent the Repository's Own Taste
- **Category:** skills
- **Problem:** A general model keeps missing conventions that are obvious to everyone on the team, and there is no way to tell whether a prompt change actually helped.
- **Solution:** `genie mikro` runs repository-local microagents — a prompt plus an answer schema, returning validated JSON whose every citation is checked against the tree. Build a fixture set from the repository's own commits, score the agent mechanically, then run a coaching round that patches a copy of the prompt and benches before and after. Agents resolve repo-first: the flag, then the invoking checkout's `.mikro/agents/<agent>/agent.yaml`, then the release templates — and the answer names which source won.
- **Code:**
  ```bash
  genie mikro init
  genie mikro fixtures --from-commits HEAD~50..HEAD --agent wish-context
  genie mikro bench wish-context
  genie mikro coach wish-context
  ```
- **Benefit:** A prompt change stops being a vibe and becomes a before-and-after number over fixtures drawn from your own commits.
- **When to use:** Any narrow, repeated judgement where the same conventions would otherwise be re-explained in every prompt.

### hack: read-doctors-json
- **ID:** `read-doctors-json`
- **Title:** Read Doctor's JSON, Not Its Prose
- **Category:** ops
- **Problem:** `genie doctor` prints one aggregated line per check — right for a human, useless for a script.
- **Solution:** `--json` carries every entry behind every summarized line, while the human output stays readable. Remember doctor is a read-only observer of the skills channel: not even `--fix` repairs it, and `genie update` owns every mutation there.
- **Code:**
  ```bash
  genie doctor --json | jq '.checks[] | select(.status == "warn") | .name'
  genie doctor --json | jq '[.checks[].modeDrift.entries // empty] | flatten | length'
  ```
- **Benefit:** The full list without a thousand lines of terminal, and the same command works in CI.
- **When to use:** Any time doctor's output is acted on rather than read.

### hack: tighten-budgets-in-config
- **ID:** `tighten-budgets-in-config`
- **Title:** Tighten a Budget in Config, Never in Prose
- **Category:** ops
- **Problem:** The repair loop should give up sooner on this machine, and arguing with a skill about the number is not a plan.
- **Solution:** Budgets live in the resolved global config and the skills read them through the CLI rather than restating a number. Configuration may only tighten a gate: every key has a schema ceiling, and a value past it fails the parse so the default stands and the source reads `default`.
- **Code:**
  ```bash
  genie config get budgets.maxEscalationsPerGroup
  genie config get budgets.maxFableCallsPerWish --json
  ```
- **Benefit:** One place to change, and no drift between what the config says and what a skill believes.
- **When to use:** When a repair loop is burning budget on work that should have gone back to review.
