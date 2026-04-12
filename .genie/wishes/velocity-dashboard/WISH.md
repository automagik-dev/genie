# Wish: Velocity Dashboard

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `velocity-dashboard` |
| **Date** | 2026-04-12 |
| **Design** | [DESIGN.md](../../brainstorms/velocity-dashboard/DESIGN.md) |

## Summary

Revamp the metrics-updater agent to showcase genie's real development velocity. Replace shallow vanity metrics with rich data sourced from git history across all branches: daily commits, @next release cadence, LoC trends, and a contributor leaderboard. README gets a punchy one-liner hero; `VELOCITY.md` gets the full dashboard with SVG charts.

## Scope

### IN
- Rewrite `.genie/agents/metrics-updater/tools/` — new data collection, chart generation, and output scripts
- Update `.genie/agents/metrics-updater/AGENT.md` to reflect new spec
- Create `VELOCITY.md` at repo root with full dashboard (summary table, 4 SVG charts, contributor leaderboard)
- Create `.genie/assets/` directory with generated SVG charts (commits-30d, releases-30d, loc-30d)
- Update README.md `<!-- METRICS:START/END -->` block with compact hero line + link to VELOCITY.md
- Author name normalization config (`.genie/agents/metrics-updater/author-aliases.json`)
- Historical backfill from git history on first run (30d of daily-stats.jsonl)
- Preserve existing `state.json` and `runs.jsonl` paths (extend schema, don't break)

### OUT
- External dashboard hosting (Grafana, web app)
- Real-time / live metrics (daily batch is sufficient)
- Mermaid or Unicode chart fallbacks (SVG only)
- New agent or new CI workflow (revamp in-place, same trigger)
- Per-file or per-module code breakdown (repo-level aggregates only)
- GitHub API for commit/LoC data (git history is the source of truth)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Git history as primary data source | Eliminates API rate limits, captures ALL branches including feature branches, works offline. Tags provide release data without API calls. |
| Pure SVG string templating (no matplotlib/plotly) | Zero external deps. ~50 lines per chart type. Self-contained in agent tools/. GitHub renders inline SVGs natively. |
| 30d rolling window for charts, 7d + all-time in summary | 30d shows trends without overwhelming. 7d is the "this week" hook for README. All-time shows total project scale. |
| Dark theme SVG (#0d1117 background) | Matches GitHub's default dark mode. Dev tools repos skew dark. Looks sharp in screenshots. |
| Author name normalization via JSON config | Git has duplicates (felipe, Felipe Rosa, filipexyz). Small alias file is simpler than heuristic matching. |
| README hero = one punchy line + link | README isn't a dashboard. Hook visitors with numbers, link to depth. |

## Success Criteria

- [ ] README hero shows real weekly numbers (commits, releases, LoC, contributors) between METRICS markers
- [ ] `VELOCITY.md` renders with 4 SVG charts (commits/day, releases/day, LoC/day, contributor leaderboard)
- [ ] Charts cover 30 days of history with visible trends, axis labels, and date range
- [ ] @next tags (v4.YYMMDD.*) counted as releases — not "0 releases/day"
- [ ] Contributor leaderboard ranked by commits, all contributors equal, no human/AI labels
- [ ] SVG charts use dark theme (#0d1117), accent colors (green/red/blue), 800x200px, no external fonts
- [ ] Full run completes in <60s (git history + chart gen + markdown gen + commit)
- [ ] Runs autonomously via existing agent trigger — no manual steps
- [ ] Existing state.json and runs.jsonl paths preserved (schema extended, not broken)

## Execution Strategy

### Wave 1 (parallel — data layer + chart engine)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Data collector: git-based metrics extraction + daily-stats.jsonl + backfill |
| 2 | engineer | SVG chart engine: Python templating for bar charts + stacked bars |

### Wave 2 (after Wave 1 — output generators)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Dashboard generators: VELOCITY.md + README hero + author aliases |

### Wave 3 (after Wave 2 — orchestrator + integration)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Orchestrator rewrite: run-metrics.sh + AGENT.md + state schema update |
| review | reviewer | Review all groups against success criteria |

## Execution Groups

### Group 1: Data Collector

**Goal:** Extract daily metrics from git history across all branches and persist to `daily-stats.jsonl`.

**Deliverables:**
1. `tools/collect-stats.sh` — shell script that extracts per-day metrics for a date range:
   - Commits count (all branches): `git log --all --after --before --oneline | wc -l`
   - LoC added/removed: `git log --all --after --before --shortstat` → parse insertions/deletions
   - Release count: `git tag --sort=-creatordate` filtered by date (pattern `v4.YYMMDD.*`)
   - Contributor list: `git log --all --after --before --format='%aN' | sort -u`
   - All-time cumulative: total commits, total tags, first commit date
2. `tools/backfill.sh` — one-time script that runs collect-stats for last 30 days, writes `daily-stats.jsonl`
3. `daily-stats.jsonl` schema documented in a comment header

**Acceptance Criteria:**
- [ ] `collect-stats.sh --date 2026-04-09` outputs JSON with commits, loc_added, loc_removed, releases, contributors fields
- [ ] `backfill.sh` produces 30 entries in daily-stats.jsonl, one per day
- [ ] Commits count matches `git log --all --after="2026-04-09 00:00" --before="2026-04-09 23:59" --oneline | wc -l`
- [ ] Release count for Apr 9 = 14 (matching the 14 tags on that date)

**Validation:**
```bash
bash .genie/agents/metrics-updater/tools/collect-stats.sh --date 2026-04-09 | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['commits']>50; assert d['releases']>=14; print('OK')"
```

**depends-on:** none

---

### Group 2: SVG Chart Engine

**Goal:** Generate publication-quality SVG bar charts from daily-stats.jsonl data.

**Deliverables:**
1. `tools/generate-charts.py` — Python script that reads daily-stats.jsonl and outputs:
   - `.genie/assets/commits-30d.svg` — blue bar chart, daily commit counts
   - `.genie/assets/releases-30d.svg` — purple bar chart, daily release counts
   - `.genie/assets/loc-30d.svg` — stacked bar chart, green (additions) + red (deletions)
2. SVG style constants: dark bg (#0d1117), accent colors, 800x200px, system-ui font, axis labels

**Acceptance Criteria:**
- [ ] Each SVG is valid XML, renders in a browser, and is under 20KB
- [ ] Charts show 30 bars (one per day) with date labels on first/last bar
- [ ] Max value label shown on Y axis
- [ ] LoC chart has stacked green (added) + red (removed) bars
- [ ] Colors match spec: #3fb950 (green), #f85149 (red), #58a6ff (blue)
- [ ] No external font dependencies — uses system-ui fallback stack

**Validation:**
```bash
python3 .genie/agents/metrics-updater/tools/generate-charts.py --input .genie/agents/metrics-updater/daily-stats.jsonl --output-dir .genie/assets && ls .genie/assets/*.svg | wc -l | grep -q 3 && echo "OK"
```

**depends-on:** none (uses sample data for development; real data from Group 1 for integration)

---

### Group 3: Dashboard Generators

**Goal:** Generate `VELOCITY.md` and update README hero from daily-stats.jsonl + SVG charts.

**Deliverables:**
1. `tools/generate-velocity.py` — writes `VELOCITY.md` at repo root with:
   - Header + last-run timestamp
   - At-a-glance table (7d / 30d / all-time for commits, releases, LoC, contributors)
   - SVG chart image references (relative paths)
   - Contributor leaderboard table (top 15, ranked by 30d commits)
2. `tools/generate-readme-hero.py` — updates README.md between `<!-- METRICS:START/END -->` with:
   - One-liner: `**🚀 X commits** this week · **Y releases** · **+Z LoC** · **N contributors**`
   - Link to VELOCITY.md
3. `.genie/agents/metrics-updater/author-aliases.json` — maps git author variants to canonical names:
   ```json
   {"felipe": "Felipe Rosa", "filipexyz": "Felipe Rosa", "genie": "Genie"}
   ```

**Acceptance Criteria:**
- [ ] `VELOCITY.md` contains all 4 sections: at-a-glance table, 3 chart references, leaderboard
- [ ] README METRICS block is exactly 3 lines: start marker, hero line, end marker + link
- [ ] Contributor names are normalized (no duplicate entries for same person)
- [ ] Numbers in README match 7d column in VELOCITY.md summary table

**Validation:**
```bash
python3 .genie/agents/metrics-updater/tools/generate-velocity.py && \
python3 .genie/agents/metrics-updater/tools/generate-readme-hero.py && \
grep -q "Velocity Dashboard" VELOCITY.md && \
grep -q "commits-30d.svg" VELOCITY.md && \
grep -A1 "METRICS:START" README.md | grep -q "commits" && echo "OK"
```

**depends-on:** Group 1 (daily-stats.jsonl), Group 2 (SVG assets)

---

### Group 4: Orchestrator Rewrite

**Goal:** Rewrite `run-metrics.sh` to call the new tools in sequence, update AGENT.md and state schema.

**Deliverables:**
1. `tools/run-metrics.sh` — rewritten orchestrator:
   - Step 1: `collect-stats.sh --date today` → append to daily-stats.jsonl
   - Step 2: If daily-stats.jsonl has <30 entries → run `backfill.sh`
   - Step 3: `generate-charts.py` �� .genie/assets/*.svg
   - Step 4: `generate-velocity.py` → VELOCITY.md
   - Step 5: `generate-readme-hero.py` → README.md
   - Step 6: git add + commit + push (existing convention: `chore: update live metrics (...)`)
   - Step 7: Update state.json + append to runs.jsonl
   - Supports `--dry-run` flag (skip commit/push)
2. `AGENT.md` rewritten as an **optimized Claude Code agent execution prompt**:
   - Step-by-step execution guide (a fresh Claude session can run end-to-end by reading AGENT.md alone)
   - Tool inventory with expected inputs, outputs, and exit codes
   - Error handling matrix (git unavailable, chart gen fails, stale data, missing aliases)
   - Commit convention and branch rules (dev only, never main)
   - Self-diagnosis checklist (what to check when output looks wrong)
   - Backfill vs append decision tree
3. Extended `state.json` schema: add `daily_stats_count`, `charts_generated`, `velocity_md_updated` fields
4. Clean up old tools and `__pycache__/` that are no longer needed (keep backwards-compatible runs.jsonl)

**Acceptance Criteria:**
- [ ] `bash run-metrics.sh --dry-run` completes in <60s, generates all outputs without pushing
- [ ] state.json updated with new fields after run
- [ ] runs.jsonl entry includes step timings and new metric fields
- [ ] Old tools and `__pycache__/` removed, no dead code left in tools/
- [ ] AGENT.md is a complete autonomous execution guide — a fresh Claude session with no prior context can run the agent end-to-end by following AGENT.md alone

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)" && bash .genie/agents/metrics-updater/tools/run-metrics.sh --dry-run && cat .genie/agents/metrics-updater/state.json | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'daily_stats_count' in d; print('OK')"
```

**depends-on:** Group 1, Group 2, Group 3

---

## QA Criteria

- [ ] `bash run-metrics.sh --dry-run` produces VELOCITY.md + 3 SVGs + README update in <60s
- [ ] VELOCITY.md renders correctly on GitHub (push to a test branch, view in browser)
- [ ] SVG charts render in both GitHub dark and light themes
- [ ] Contributor leaderboard has no duplicate entries after normalization
- [ ] Numbers are internally consistent: README 7d numbers = VELOCITY.md 7d column
- [ ] All-time stats are plausible (cross-check with `git log --all --oneline | wc -l`)
- [ ] No regression: state.json and runs.jsonl still parseable by any code that reads them

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Git history traversal slow on large repos | Low | `--since 30d` bounds the walk; <2s on this repo |
| SVG rendering across GitHub themes | Medium | Test both; use `prefers-color-scheme` media query if needed |
| Author name duplicates missed | Low | Start with known aliases; agent flags unknowns in run log |
| Image paths break on forks | Low | Relative paths; works for any clone |
| Daily commits add noise to dev | Medium | Same convention as current agent; could batch weekly later |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
# Rewrite
.genie/agents/metrics-updater/tools/run-metrics.sh
.genie/agents/metrics-updater/AGENT.md

# New
.genie/agents/metrics-updater/tools/collect-stats.sh
.genie/agents/metrics-updater/tools/backfill.sh
.genie/agents/metrics-updater/tools/generate-charts.py
.genie/agents/metrics-updater/tools/generate-velocity.py
.genie/agents/metrics-updater/tools/generate-readme-hero.py
.genie/agents/metrics-updater/author-aliases.json
.genie/agents/metrics-updater/daily-stats.jsonl
.genie/assets/commits-30d.svg
.genie/assets/releases-30d.svg
.genie/assets/loc-30d.svg
VELOCITY.md

# Modify
README.md (METRICS:START/END block only)
.genie/agents/metrics-updater/state.json (extended schema)

# Remove (old tools, replaced by new ones)
.genie/agents/metrics-updater/tools/cached-fetch.sh
.genie/agents/metrics-updater/tools/commit-formatter.sh
.genie/agents/metrics-updater/tools/fast-parse.py
.genie/agents/metrics-updater/tools/generate-tools.py
.genie/agents/metrics-updater/tools/github-api.sh
.genie/agents/metrics-updater/tools/parse-metrics.py
.genie/agents/metrics-updater/tools/perf-analyzer.py
.genie/agents/metrics-updater/tools/self-refine.sh
.genie/agents/metrics-updater/tools/update-readme.py
.genie/agents/metrics-updater/tools/batch-commit.sh
.genie/agents/metrics-updater/tools/__pycache__/ (entire directory)
```
