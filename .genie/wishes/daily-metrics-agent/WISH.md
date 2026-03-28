# Wish: Daily Metrics Agent — Self-Improving Autonomous Loop

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `daily-metrics-agent` |
| **Date** | 2026-03-24 |

## Summary

Deploy a self-evolving persistent agent that runs daily on a single cron job. Its sole purpose: update README.md with live metrics (releases/day, avg bug-fix time, SHIP rate). After each run, it uses /refine to improve its own prompt based on performance data. Generates tools to optimize its execution. Faster, smarter, more efficient every day.

## Problem

Manual metrics updates don't scale. Static data rots. README becomes stale.

But if the agent _itself_ improves, compounds, and auto-generates tools to make metrics updates faster—the README becomes truly self-healing. The agent becomes the product.

## Solution

1. **Agent persistence** — Stores refined prompt + generated tools in `.genie/agents/metrics-updater/`
2. **Single cron trigger** — `0 9 * * *` fires the agent daily
3. **Self-improvement loop:**
   - Agent runs: fetch metrics, update README, commit
   - Agent analyzes: run duration, API calls, errors, missed optimizations
   - Agent calls `/refine`: "Here's my performance data. Make me faster."
   - Agent stores: refined prompt + new tools for tomorrow
4. **Tool generation** — Agent creates helpers:
   - GitHub API wrapper (caches results, retries on failure)
   - Metrics parser (extracts numbers reliably)
   - Commit formatter (clean, consistent messages)
   - Performance logger (tracks execution time, bottlenecks)

## Scope

### IN
- Deploy self-improving metrics agent to `.genie/agents/metrics-updater/`
- Agent purpose: daily README metrics update (releases/day, bug-fix time, SHIP rate)
- Persistence: agent stores refined prompt + tools in shared state
- Cron trigger: `0 9 * * *` (daily, 9am BRT)
- Self-refinement: `/refine` called after each run with performance data
- Tool generation: agent creates helpers to optimize next run
- Error handling: graceful failures, fallback to yesterday's metrics
- Logging: capture execution time, API calls, tool generation in `.genie/agents/metrics-updater/runs.jsonl`

### OUT
- Real-time metrics dashboard (static README updates only, not live dashboard)
- Slack/Discord notifications on failures
- Manual intervention required to update metrics
- Agent runs more than once per day
- Persistent learning across multiple agents (single-purpose agent only)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Single cron, not multiple runs | Bounded, predictable behavior. One invocation = one improvement cycle. |
| `/refine` after each run | Agent learns from its own performance data, not external feedback. |
| Tool generation inside agent | Agent decides what helpers it needs, not predefined by us. |
| Shared state persistence | Refined prompt + tools survive agent restarts, available for next cron trigger. |
| Graceful fallback | If GitHub API fails, keep yesterday's metrics. Better stale data than no data. |
| Performance logging | Agent tracks its own speed; /refine uses this to optimize. |

## Success Criteria

- [ ] Agent deployed to `.genie/agents/metrics-updater/` with valid frontmatter
- [ ] Daily cron trigger (`0 9 * * *`) fires the agent
- [ ] Agent successfully fetches: releases (24h), avg issue-to-ship time, SHIP rate, parallel agents active
- [ ] Agent updates README.md metrics table with live numbers
- [ ] Agent commits with clean message: `chore: update live metrics (27/day, 2.4h avg, 100% SHIP)`
- [ ] Agent calls `/refine` after each run with performance data
- [ ] Refined prompt stored in `.genie/agents/metrics-updater/AGENT.md`
- [ ] Generated tools stored in `.genie/agents/metrics-updater/tools/` (shell scripts, Python helpers)
- [ ] Run log captured in `.genie/agents/metrics-updater/runs.jsonl` with: timestamp, duration, tools_generated, api_calls, errors
- [ ] Day 7: agent is measurably faster (compare Day 1 vs Day 7 execution time)
- [ ] No manual intervention required for 7 consecutive days
- [ ] Graceful fallback: if API fails on Day X, metrics table shows Day X-1 values

## Execution Strategy

### Wave 1 (parallel with genie-hacks)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Deploy metrics agent scaffold + cron trigger + first run |
| 2 | engineer | Implement GitHub API fetching + README parsing + metric extraction |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Integrate `/refine` workflow + performance logging + tool generation |
| 4 | reviewer | Verify agent runs cleanly, metrics are accurate, refinement loop works |

## Execution Groups

### Group 1: Agent Scaffold + Cron Setup

**Goal:** Deploy self-improving agent to persistent storage. Set up daily trigger.

**Deliverables:**
1. Create `.genie/agents/metrics-updater/` directory structure:
   ```
   metrics-updater/
   ├── AGENT.md          (agent prompt, evolves daily)
   ├── runs.jsonl        (execution log: timestamp, duration, tools, errors)
   ├── tools/            (auto-generated helpers)
   │   ├── github-api.sh
   │   ├── parse-metrics.py
   │   └── commit-formatter.sh
   └── state.json        (shared state: last_metrics, last_refined_at)
   ```

2. Initial AGENT.md prompt:
   - Purpose: "Update README.md metrics daily"
   - Inputs: GitHub repo (automagik-dev/genie), metrics to fetch
   - Outputs: Updated README.md + clean commit
   - Constraints: Must call /refine after run with perf data

3. Cron trigger setup:
   - Schedule: `0 9 * * *` (9am daily)
   - Command: `genie spawn metrics-updater --agent-path .genie/agents/metrics-updater/AGENT.md`
   - Logging: output to `.genie/agents/metrics-updater/runs.jsonl`

4. First manual run to verify scaffold works

**Acceptance Criteria:**
- [ ] Directory structure created
- [ ] AGENT.md written with clear purpose + constraints
- [ ] Cron job registered and testable
- [ ] First run completes without errors
- [ ] Run log captures execution (timestamp, duration)

**Validation:**
```bash
# Test cron trigger manually
genie spawn metrics-updater --agent-path .genie/agents/metrics-updater/AGENT.md

# Verify output
cat .genie/agents/metrics-updater/runs.jsonl | tail -1
```

**depends-on:** none

---

### Group 2: Metrics Fetching + README Updates

**Goal:** Implement GitHub API calls + metrics extraction + README table updates.

**Deliverables:**
1. GitHub API fetcher:
   - Fetch releases in last 24h: count + average per day
   - Fetch PRs: average time from open → merge (bug-fix time)
   - Fetch issues: % closed by agent vs manual
   - Fetch team status: estimate parallel agents active (from genie status output)

2. Metrics extractor:
   - Parse API responses
   - Calculate: releases/day, avg bug-fix time, SHIP rate %, parallel agents
   - Handle edge cases (no data, API failures)

3. README updater:
   - Find metrics table in README.md
   - Update 4 cells: releases/day, bug-fix time, SHIP rate, parallel agents
   - Preserve markdown formatting

4. Commit + push:
   - Message: `chore: update live metrics (X/day, Yh avg, Z% SHIP)`
   - Push to main branch (auto-approved, no review gate)

**Acceptance Criteria:**
- [ ] GitHub API calls work reliably
- [ ] Metrics extracted correctly (verified against manual API check)
- [ ] README table updates with correct numbers
- [ ] Commit message is clean and informative
- [ ] Push succeeds without conflicts
- [ ] Graceful fallback: if API fails, use yesterday's metrics (read from state.json)

**Validation:**
```bash
# Verify metrics match GitHub API manually
gh api repos/automagik-dev/genie/releases --jq 'length'

# Run agent
genie spawn metrics-updater --agent-path .genie/agents/metrics-updater/AGENT.md

# Check README was updated
git diff HEAD~1 README.md | grep -A5 "metrics"
```

**depends-on:** 1

---

### Group 3: Self-Refinement Loop + Tool Generation

**Goal:** Agent improves itself daily using /refine + generates tools to optimize future runs.

**Deliverables:**
1. Performance data collection:
   - Capture: execution start time, API call count, API latency, parsing duration, commit time
   - Identify: slowest step, most retried API call, parsing errors
   - Store in: runs.jsonl as structured JSON

2. /refine integration:
   - After each run, call `/refine` skill with:
     - Current prompt (AGENT.md)
     - Performance data (run duration, bottlenecks)
     - Request: "Make me faster. Generate tools for slow steps."
   - Read refined prompt from `/tmp/prompts/<agent>/` (refine output location)
   - Store refined prompt to AGENT.md

3. Tool generation:
   - Agent identifies slow operations (API calls, parsing)
   - Creates shell/Python helpers in `tools/` directory:
     - GitHub API wrapper with caching (avoid redundant calls)
     - Metrics parser optimized for common patterns
     - Batch commit formatter (handle edge cases seen in past runs)
   - Tools persist across runs (next day's agent uses yesterday's tools)

4. Tool usage:
   - Next run: agent sources tools/ helpers before executing
   - Faster execution because parsing is optimized, API calls are cached

**Acceptance Criteria:**
- [ ] Performance metrics captured in runs.jsonl (timestamp, duration, API calls, errors)
- [ ] `/refine` called after each run with performance context
- [ ] Refined prompt stored to AGENT.md
- [ ] At least 1 tool generated by Day 2 (e.g., cached GitHub API wrapper)
- [ ] Day 7 execution time < Day 1 execution time (measurable improvement)
- [ ] Tools are idempotent (safe to run multiple times)
- [ ] No errors from tool execution

**Validation:**
```bash
# Check performance data is logged
cat .genie/agents/metrics-updater/runs.jsonl | jq '.[] | {timestamp, duration_ms, tools_generated}'

# Verify tools exist
ls .genie/agents/metrics-updater/tools/

# Compare execution times (Day 1 vs Day 7)
cat runs.jsonl | jq 'select(.timestamp | startswith("2026-03-25")) | .duration_ms'
cat runs.jsonl | jq 'select(.timestamp | startswith("2026-03-31")) | .duration_ms'
```

**depends-on:** 2

---

### Group 4: Review + Stability Check

**Goal:** Verify agent runs cleanly, improves over time, handles edge cases.

**Deliverables:**
1. Test coverage:
   - [ ] Agent runs successfully on Day 1, Day 2, ..., Day 7
   - [ ] Metrics in README match GitHub API (manual verification on Day 3, Day 7)
   - [ ] Commits are clean (no merge conflicts, no noise)
   - [ ] No false positives: if API fails, metrics don't change unexpectedly
   - [ ] Run logs are complete (no missing data fields)

2. Improvement metrics:
   - [ ] Compare Day 1 execution time vs Day 7
   - [ ] Verify tools were generated and used
   - [ ] Check refined prompts evolved (AGENT.md changed)

3. Rollback plan:
   - [ ] If agent fails, fallback: cron disabled, previous metrics frozen
   - [ ] Escalation: alert on 2 consecutive failures

**Acceptance Criteria:**
- [ ] Agent runs 7 consecutive days without user intervention
- [ ] Each day's commit is valid and pushes cleanly
- [ ] Metrics are accurate (spot-check vs GitHub API)
- [ ] Execution time decreased by at least 20% from Day 1 to Day 7
- [ ] Tools generated and persisted
- [ ] Refined prompts stored and used

**Validation:**
```bash
# Run 7-day test
for day in {1..7}; do
  echo "Day $day..."
  genie spawn metrics-updater --agent-path .genie/agents/metrics-updater/AGENT.md
  sleep 60  # wait for cron-like interval
done

# Verify all commits succeeded
git log --oneline | grep "chore: update live metrics" | wc -l  # should be 7

# Compare performance
cat .genie/agents/metrics-updater/runs.jsonl | jq '[.[] | .duration_ms] | [first, last, ((last / first) * 100 | round)]'
```

**depends-on:** 3

---

## Files to Create/Modify

```
.genie/agents/metrics-updater/
├── AGENT.md               (agent prompt, evolves daily)
├── runs.jsonl             (execution log)
├── state.json             (last_metrics, last_refined_at)
└── tools/                 (auto-generated helpers)
    ├── github-api.sh
    ├── parse-metrics.py
    └── commit-formatter.sh

crontab (or Genie scheduler config)
├── Schedule: 0 9 * * *
├── Command: genie spawn metrics-updater
└── Logging: → .genie/agents/metrics-updater/runs.jsonl
```

---

## Architecture Notes

### State Persistence
- Agent stores state in `.genie/agents/metrics-updater/state.json`
- Includes: last_metrics (for fallback), last_refined_at (timestamp)
- On next run, agent reads state to detect changes, decide if refinement is needed

### Refinement Trigger
- `/refine` is called unconditionally after every run (daily improvement)
- Refined prompt persists to AGENT.md
- Next day's agent starts with yesterday's refined prompt

### Tool Generation Strategy
- Agent analyzes performance data: "API calls took 3.2s total"
- Decides: "I should cache GitHub API responses"
- Creates: `tools/github-api.sh` with built-in caching
- Next run: sources tools before executing main logic
- Result: Day 2 is faster than Day 1

### Graceful Degradation
- If GitHub API is down, agent reads state.json
- Uses last_metrics from yesterday
- Logs error to runs.jsonl
- Commits nothing (no changes to README)
- Next day: try again

---

## Open Questions

1. **Refinement frequency:** /refine after every run, or after N runs? (Proposed: every run for constant improvement)
2. **Tool retention:** Do tools accumulate forever, or prune old ones? (Proposed: keep all, agent decides usage)
3. **Metric sources:** Should agent also track Genie metrics (wishes/day, fix loops)? (Proposed: GitHub metrics only, Genie metrics in separate agent later)
4. **Cron provider:** Use native cron, or Genie's built-in scheduler? (Proposed: Genie scheduler for consistency)

---

## Success Story

> A single agent. One cron job. Runs every morning at 9am. After 3 days, it's generated 5 helpers to optimize metrics fetching. After a week, it runs in 30 seconds (down from 2 minutes). README always shows today's velocity. No human touch. The agent improved itself.
>
> That's the product. Not orchestrating agents. Self-improving agents.
