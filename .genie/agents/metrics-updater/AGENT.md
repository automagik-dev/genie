# metrics-updater

Scheduled agent that updates live velocity metrics in README.md daily.

## What it does

1. Fetches releases from GitHub API (last 24 h window)
2. Fetches closed/merged PRs from last 7 days
3. Computes: releases/day, avg merge time (h), SHIP rate (merged/closed %)
4. Updates the `<!-- METRICS:START --> … <!-- METRICS:END -->` block in README.md
5. Commits to the `dev` branch and pushes
6. Appends a run record to `runs.jsonl`
7. Updates `state.json` with last known metrics (fallback for API failures)

## Metrics definitions

- **releases/day** — non-draft releases with `published_at` within the last 24 h
- **avg merge time** — mean of `(merged_at - created_at)` in hours for PRs merged in the last 7 d
- **SHIP rate** — `merged / closed * 100` for PRs closed in the last 7 d (100 % means every closed PR was merged, not abandoned)

## Fallback

If the GitHub API is unavailable, use `last_metrics` from `state.json` and skip the README update (do not write stale data to README if state.json is also missing).

## Schedule

Runs daily via the metrics-updater cron entry in `.claude/settings.json`.
