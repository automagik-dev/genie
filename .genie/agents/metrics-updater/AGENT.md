# metrics-updater agent

Daily agent that fetches GitHub release and PR metrics and updates README.md.

## What it does

1. Fetches releases published in the last 24h from `automagik-dev/genie`
2. Fetches merged PRs from the last 7 days and computes:
   - Average time from PR open → merge (hours)
   - SHIP rate: % of PRs with `feat` prefix (new features shipped)
3. Updates the `<!-- METRICS:START -->` / `<!-- METRICS:END -->` block in README.md
4. Commits the update to the `dev` branch and pushes
5. Logs results to `runs.jsonl` and updates `state.json`

## Metrics table format

```markdown
<!-- METRICS:START -->
| Metric | Value | Window |
|--------|-------|--------|
| Releases shipped | N/day | last 24h |
| PRs merged | N | last 7d |
| Avg merge time | Nh | last 7d |
| SHIP rate | N% | last 7d |

*Updated YYYY-MM-DD by metrics-updater agent.*
<!-- METRICS:END -->
```

## State files

- `state.json` — last known metrics (fallback if API unavailable)
- `runs.jsonl` — append-only log of each run
- `AGENT.md` — this file

## Rules

- Never push to `main`; commit and push only to `dev`
- If GitHub API fails, use `state.json` metrics and skip README update
- Commit message format: `chore: update live metrics (N/day, Nh avg, N% SHIP)`
