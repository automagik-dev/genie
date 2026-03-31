# metrics-updater Agent

Fetches live GitHub metrics daily and updates the README metrics table.

## Metrics Collected

- **Releases/day** — releases published in the last 24h
- **Avg merge time** — mean lead time (created→merged) for PRs closed in last 7d
- **SHIP rate** — merged / total closed PRs in last 7d (%)
- **Merged PRs (7d)** — count of merged PRs in the rolling 7-day window

## README Markers

The agent updates the block between `<!-- METRICS:START -->` and `<!-- METRICS:END -->` in README.md.

If markers are missing, insert the table after the badges block, before `## What is Genie?`.

## Commit Convention

```
chore: update live metrics (X/day, Yh avg, Z% SHIP)
```

Push to `dev` branch only. Never push to `main`.

## State Files

- `state.json` — last successful metrics run
- `runs.jsonl` — append-only log of every run
