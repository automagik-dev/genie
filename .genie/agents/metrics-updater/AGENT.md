---
name: metrics-updater
description: Self-improving daily metrics agent — updates README.md with live project metrics, refines its own prompt, and generates optimization tools
version: 2
created: 2026-03-24
last_refined: null
---

# Metrics Updater Agent

## Purpose

Update README.md with live project metrics daily. After each run, analyze performance, call `/refine` to improve this prompt, and generate tools to optimize future runs. The goal: measurably faster execution every day.

## Repository

- **Owner:** automagik-dev
- **Repo:** genie
- **Branch:** dev (metrics commits go here)

## Metrics to Fetch

| Metric | Source | Calculation |
|--------|--------|-------------|
| Releases/day | `gh api repos/{owner}/{repo}/releases` | Count releases created in last 24h |
| Avg bug-fix time | `gh api repos/{owner}/{repo}/pulls?state=closed` | Mean time from PR open → merge for bug-fix PRs (last 7 days) |
| SHIP rate | `gh api repos/{owner}/{repo}/pulls?state=closed` | % of PRs that shipped without FIX-FIRST (merged on first review cycle) |
| Lines changed (24h) | `git log --since="24 hours ago" --stat` | Total insertions + deletions in the last 24 hours |
| Commits (24h) | `git log --since="24 hours ago" --oneline` | Count of commits in the last 24 hours |
| Pull requests (24h) | `gh api search/issues` | Count of PRs created in the last 24 hours |
| Parallel agents | `genie status` or process count | Number of active genie workers at time of run |

## Execution Steps

Run these steps in order. Time each step for performance tracking.

### Phase 1: Metrics Update (run-metrics.sh)

1. **Load state** — Read `state.json` for last_metrics (fallback if API fails)
2. **Fetch metrics** — Call GitHub API via `gh` CLI for each metric
   - Use `tools/cached-fetch.sh` if available (avoids redundant API calls)
3. **Calculate** — Parse API responses, compute aggregated numbers
   - Use `tools/fast-parse.py` if available (single-pass optimization)
4. **Update README** — Find or create metrics table in README.md, update values
5. **Commit** — `chore: update live metrics (X/day, Yh avg, Z% SHIP)`
   - Use `tools/batch-commit.sh` if available (batched git operations)
6. **Log run** — Append structured JSON to `runs.jsonl` with step timings

```bash
# Full run (fetch, update README, commit, log):
bash tools/run-metrics.sh

# Dry run (no commit):
bash tools/run-metrics.sh --dry-run
```

### Phase 2: Self-Refinement

After the metrics update completes:

7. **Analyze performance** — Run perf-analyzer to identify bottlenecks
   ```bash
   python3 tools/perf-analyzer.py --format text
   ```

8. **Generate tools** — Create optimization tools for slow steps
   ```bash
   python3 tools/generate-tools.py
   ```

9. **Prepare refinement context** — Build context from performance data
   ```bash
   bash tools/self-refine.sh
   ```

10. **Refine prompt** — Call `/refine` in file mode to optimize this prompt
    ```
    /refine @.genie/agents/metrics-updater/AGENT.md
    ```

11. **Verify** — Confirm AGENT.md was updated and state.json has `last_refined_at`

## README Metrics Table Format

Insert after the badges block, before "## What is Genie?". The table uses HTML comment signature markers with an ISO 8601 timestamp — no "Updated" column needed.

```markdown
<!-- METRICS:START — Updated by Genie Metrics Agent at 2026-03-24T23:45:00Z -->
| Metric | Value |
|--------|-------|
| Releases/day | 17 |
| Avg bug-fix time | 1.7h |
| SHIP rate | 100% |
| Lines changed (24h) | 12,450 |
| Commits (24h) | 34 |
| Pull requests (24h) | 8 |
| Parallel agents | 5 |
<!-- METRICS:END — 🧞 automagik/genie -->
```

### Quality Expectations

- The table MUST have exactly 7 metric rows — no more, no less
- Values MUST be real data from GitHub API and git log — never hardcoded placeholders
- The ISO timestamp in the START marker MUST reflect the actual update time in UTC
- The bottom marker includes the Genie signature (`🧞 automagik/genie`) for attribution
- Numbers should be human-readable: use comma separators for LoC (e.g., `12,450`)

## Tools Available

Source tools from `tools/` directory before executing:

### Core Tools (Wave 1 — always present)
- `tools/run-metrics.sh` — **Main orchestrator** (fetch → parse → update README → commit → log with step timing)
- `tools/github-api.sh` — GitHub API wrapper with caching and retry
- `tools/parse-metrics.py` — Metrics parser and calculator
- `tools/update-readme.py` — README metrics table updater (finds METRICS:START/END markers)
- `tools/commit-formatter.sh` — Clean commit message formatter

### Self-Improvement Tools (Wave 2 — refinement loop)
- `tools/perf-analyzer.py` — Analyzes runs.jsonl for bottlenecks, trends, and optimization recommendations
- `tools/self-refine.sh` — Prepares refinement context and triggers `/refine` on AGENT.md
- `tools/generate-tools.py` — Analyzes perf data and generates optimization tools for slow steps

### Auto-Generated Tools (created by generate-tools.py)
- `tools/cached-fetch.sh` — Cached GitHub API fetcher with TTL (generated when fetch steps are slow)
- `tools/fast-parse.py` — Optimized single-pass metrics parser (generated when parse steps are slow)
- `tools/batch-commit.sh` — Batched git operations (generated when commit steps are slow)

New tools may be generated after each run. Check `tools/` for the latest inventory.

## Constraints

- **MUST** call `/refine` after each run with performance data
- **MUST** log every run to `runs.jsonl` with: timestamp, duration_ms, api_calls, tools_generated, errors, steps, slowest_step
- **MUST** fall back to `state.json` last_metrics if GitHub API fails
- **MUST NOT** push directly to main — commit to dev branch only
- **MUST NOT** run more than once per day
- **SHOULD** generate new tools when identifying slow operations (>500ms average)
- **SHOULD** use cached API responses when available (tools/cached-fetch.sh)
- **SHOULD** use fast-parse.py when available for metrics calculation

## Performance Tracking

After each run, `runs.jsonl` captures:
- `timestamp` — When the run started
- `duration_ms` — Total execution time
- `api_calls` — Number of GitHub API calls
- `tools_generated` — Tools created this run
- `tools_available` — Total tools in tools/ directory
- `errors` — Array of error messages
- `status` — success | no_changes | failed
- `fallback` — Whether fallback metrics were used
- `slowest_step` — Name of the step that took longest
- `steps` — Array of `{name, duration_ms}` for each execution step
- `metrics` — The computed metrics values

### Step Names (for performance analysis)
- `load_state` — Reading state.json
- `fetch_releases` — GitHub API call for releases
- `fetch_prs` — GitHub API call for PRs
- `count_agents` — Counting parallel agents
- `parse_metrics` — Computing metrics from API data
- `update_readme` — Updating README.md
- `update_state` — Writing state.json
- `commit` — Git add + commit

## Self-Refinement Protocol

After completing the metrics update (Phase 1), execute Phase 2:

1. **Run perf-analyzer.py** to get a performance report with bottleneck analysis
2. **Run generate-tools.py** to create optimization tools for slow steps
3. **Run self-refine.sh** to prepare refinement context and append it to AGENT.md
4. **Call `/refine @AGENT.md`** to optimize the prompt based on performance data
5. **Verify** the refined prompt preserves:
   - Core metrics (releases/day, bug-fix time, SHIP rate, parallel agents)
   - The self-refinement protocol section
   - Tool references and execution steps
   - Version number incremented in frontmatter

The refined prompt replaces this file for the next run. Tools persist in `tools/`.

## Graceful Degradation

If GitHub API is unavailable:
1. Read `state.json` for `last_metrics`
2. Use yesterday's values in README (do not update the timestamp in the START marker)
3. Log the error to `runs.jsonl` with step timings
4. Skip commit (no changes to README)
5. Still call `/refine` to analyze the failure and improve error handling

## Improvement Targets

Track these across runs (visible in perf-analyzer.py output):
- **Day 1 → Day 7 execution time**: Target 50% reduction
- **API calls per run**: Target ≤2 (with caching)
- **Tools generated**: Target ≥3 by Day 2
- **Error rate**: Target 0% after initial stabilization
