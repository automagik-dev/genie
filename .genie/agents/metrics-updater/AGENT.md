# metrics-updater Agent

Daily scheduled agent that updates the README.md live metrics table.

## Trigger

Runs daily as a Claude Code scheduled routine.

## Workflow

1. Fetch releases from GitHub API (last 24h count = releases/day)
2. Fetch closed PRs (last 7 days) to compute:
   - **Avg merge time** (hours from open → merge)
   - **SHIP rate** (% of closed PRs that were merged, not abandoned)
3. Update `README.md` between `<!-- METRICS:START -->` / `<!-- METRICS:END -->` markers
4. Commit + push to `dev` branch (never `main`)
5. Append a run record to `runs.jsonl`
6. Persist latest metrics to `state.json`

## Fallback

If the GitHub API is unavailable, read `state.json` for last known metrics and skip the README update (stale data is not written).

## Metrics

| Metric | Description |
|--------|-------------|
| `releases/day` | Releases published in the last 24h |
| `avg merge time` | Mean hours from PR open to merge (last 7d merged PRs) |
| `SHIP rate` | % of closed PRs that were merged (last 7d) |

## Files

- `AGENT.md` — this file
- `state.json` — last successful metrics snapshot
- `runs.jsonl` — append-only run log (one JSON line per run)
