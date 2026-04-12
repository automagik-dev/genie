# Design: velocity-dashboard

| Field | Value |
|-------|-------|
| **Slug** | `velocity-dashboard` |
| **Date** | 2026-04-12 |
| **WRS** | 100/100 |

## Problem

The metrics-updater agent reports shallow vanity metrics (releases/24h on main, merged PRs/7d, avg merge time, SHIP rate) that drastically undercount genie's real development velocity. Actual data shows 273 commits/week, ~20 @next publishes/week, 768 total releases, 10 contributors — none of which appears in the current output. The README should make visitors go "whoa" within 3 seconds of landing.

## Scope

### IN
- Revamp the existing `.genie/agents/metrics-updater/` agent (tools, state, AGENT.md)
- **README hero section** — compact badge row + one-liner velocity summary between existing `<!-- METRICS:START -->` / `<!-- METRICS:END -->` markers
- **`VELOCITY.md`** — full dashboard with:
  - Daily commit histogram (30d, all branches) as SVG chart
  - Release cadence chart (@next tag count per day, 30d) as SVG chart
  - LoC added/removed per day (30d) as SVG chart
  - Contributor leaderboard (ranked by commits, 30d, no human/AI distinction)
  - All-time cumulative stats (total commits, total tags, total LoC, first commit date)
- **SVG chart generation** — agent generates `.genie/assets/*.svg` at update time, referenced from VELOCITY.md via relative paths
- **Historical data** — `runs.jsonl` extended to store daily snapshots so charts have 30+ days of backfill on first run (from git history, not API)
- **Autonomous daily runs** — same trigger mechanism as current agent (Claude Code session), no manual babysitting

### OUT
- External dashboard hosting (Grafana, web app, etc.)
- Real-time / live-updating metrics (daily batch is fine)
- Mermaid or Unicode chart fallbacks (SVG only)
- Separate new agent — this revamps the existing one in-place
- GitHub Actions workflow for running the agent (stays as Claude Code session)
- Per-file or per-module breakdown (repo-level aggregates only)

## Approach

Rewrite the metrics-updater tools to source metrics from **git history directly** (not GitHub API) for commits, LoC, and contributors. Use **GitHub API only** for tag/release metadata and npm publish counts. Generate SVG charts via a Python script using basic SVG templating (no matplotlib/plotly dependency — keep it self-contained).

### Data flow

```
git log --all --since 30d  →  daily-stats.jsonl (append-only, 30d window)
git tag --sort=-creatordate →  release data
gh api /repos/.../tags    →  @next publish timestamps (fallback: git tags)
                           ↓
               generate-charts.py  →  .genie/assets/{commits,releases,loc,contributors}.svg
               generate-readme.py  →  README.md (compact hero)
               generate-velocity.py → VELOCITY.md (full dashboard)
                           ↓
               batch-commit.sh → push to dev
```

### README hero format (between METRICS markers)

```markdown
<!-- METRICS:START -->
**🚀 273 commits** this week · **20 releases** · **+1.1k LoC** · **10 contributors**

[Full velocity dashboard →](VELOCITY.md)
<!-- METRICS:END -->
```

One line. Punchy. Links to the deep dive.

### VELOCITY.md structure

```markdown
# Velocity Dashboard

> Auto-generated daily by the metrics-updater agent. Last run: 2026-04-12.

## At a glance
| Metric | 7d | 30d | All-time |
|--------|----|-----|----------|
| Commits (all branches) | 273 | 1,200 | 12,400 |
| Releases (@next + stable) | 20 | 85 | 768 |
| LoC added (net) | +1,101 | +8,200 | +45,000 |
| Contributors | 10 | 14 | 22 |

## Daily commits (30d)
![Commits per day](.genie/assets/commits-30d.svg)

## Release cadence (30d)
![Releases per day](.genie/assets/releases-30d.svg)

## Lines of code (30d)
![LoC added/removed per day](.genie/assets/loc-30d.svg)

## Contributor leaderboard (30d)
| Rank | Contributor | Commits |
|------|-------------|---------|
| 1 | Claude | 142 |
| 2 | Felipe Rosa | 89 |
| 3 | Genie | 45 |
| ... | ... | ... |
```

### SVG chart style

- Dark background (#0d1117) matching GitHub dark theme
- Accent colors: green (#3fb950) for additions, red (#f85149) for deletions, blue (#58a6ff) for commits
- Bar charts for daily counts, stacked bars for LoC (add/del)
- No external fonts — system-ui fallback
- Width: 800px, Height: 200px — compact, fits in markdown without scroll
- Axis labels for first/last date + max value

### Contributor leaderboard

- Ranked by commit count over 30d rolling window
- All contributors equal — no human/AI labels
- `git log --all --since='30 days ago' --format='%aN' | sort | uniq -c | sort -rn`
- Normalize author names (collapse duplicates like `felipe` / `Felipe Rosa` / `filipexyz`)

### Historical backfill (first run)

On first run with the new agent, backfill `daily-stats.jsonl` from git history:
```bash
for each day in last 30 days:
  commits = git log --all --after="$day 00:00" --before="$day 23:59" --oneline | wc -l
  loc = git log --all --after="$day 00:00" --before="$day 23:59" --shortstat | awk ...
  releases = git tag --sort=-creatordate | filter by date
  contributors = git log --all --after/before --format='%aN' | sort -u | wc -l
  → append to daily-stats.jsonl
```

Subsequent runs append only the current day's data.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Git history as primary data source (not GitHub API) | Eliminates API rate limits, captures ALL branches, works offline. API used only for tag metadata that git tags already cover. |
| SVG generation via Python string templating | No heavy deps (matplotlib, plotly). Pure SVG is ~50 lines of template code per chart type. GitHub renders inline. Self-contained in the agent's tools/. |
| 30d rolling window for charts, all-time for cumulative stats | 30d shows trends without overwhelming. All-time shows total impact. 7d shown as a subset in the summary table. |
| No human/AI distinction in leaderboard | Contributors ranked by output. The names tell the story — Claude, Genie, Felipe — without needing labels. |
| Revamp existing agent, not new agent | Preserves the trigger mechanism, commit convention, and state file paths. Minimizes coordination. |
| Author name normalization | Git history has duplicates (felipe, Felipe Rosa, filipexyz). Agent maintains a map in a small config file. |
| README hero is one punchy line + link | README shouldn't be a dashboard. The hook is the numbers; the depth is in VELOCITY.md. |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| Git history traversal slow on large repos | Low | `--since 30d` bounds the walk. 30d × all branches is ~1.5k commits — takes <2s on this repo. |
| SVG rendering differences across GitHub themes | Medium | Test in both light and dark mode. Use `prefers-color-scheme` media query in SVG if needed, or just target dark (the default for dev tools). |
| Author name duplicates not caught by normalization | Low | Start with known aliases from git log. Add new ones as they appear. Agent can flag unknowns. |
| `VELOCITY.md` image paths break on forks/mirrors | Low | Use relative paths (`.genie/assets/...`). Works for any clone. |
| Daily runs produce noisy commits on dev | Medium | Same risk as current agent. Mitigated by existing convention (`chore: update live metrics ...`). Could batch to weekly if noise becomes a problem. |
| First-run backfill takes longer than daily runs | Low | 30 days × 4 git commands = ~30s max. One-time cost. |

## Success Criteria

- [ ] Someone lands on the README and immediately sees velocity numbers that make them go "whoa" — one-liner hero with real numbers (commits/week, releases/week, LoC, contributors)
- [ ] `VELOCITY.md` has at least 30 days of historical data with visible SVG chart trends (commits, releases, LoC)
- [ ] Contributor leaderboard is accurate, ranked by commits, updates daily without manual intervention
- [ ] @next npm publishes (git tags matching `v4.YYMMDD.*`) show up as real releases — not hidden behind "0 releases/day"
- [ ] SVG charts look polished enough to screenshot for a pitch deck — dark theme, color-coded, axis labels, no rough edges
- [ ] The whole thing runs autonomously via the existing metrics-updater agent trigger — no human babysitting, no new CI workflows
- [ ] Ships as a revamp of `.genie/agents/metrics-updater/` — existing `AGENT.md`, `state.json`, `runs.jsonl` paths preserved, tools/ rewritten
