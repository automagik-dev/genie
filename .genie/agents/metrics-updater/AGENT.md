# metrics-updater Agent

> Autonomous velocity dashboard agent. Collects git-based metrics, generates SVG charts, builds VELOCITY.md and README hero line. Runs daily on `dev` branch.

## Quick Start

```bash
cd "$(git rev-parse --show-toplevel)"
bash .genie/agents/metrics-updater/tools/run-metrics.sh          # Full run: collect, chart, publish, commit
bash .genie/agents/metrics-updater/tools/run-metrics.sh --dry-run # Generate all outputs without commit/push
```

## Pipeline Steps

| Step | Tool | Input | Output | Exit 0 |
|------|------|-------|--------|--------|
| 1. Collect today | `collect-stats.sh --date YYYY-MM-DD` | git history | JSON line → `daily-stats.jsonl` | Stats appended |
| 2. Backfill | `backfill.sh` (if <30 entries) | git history (30d) | `daily-stats.jsonl` filled | 30+ entries |
| 3. Charts | `generate-charts.py --input ... --output-dir ...` | `daily-stats.jsonl` | `.genie/assets/*.svg` (3 files) | SVGs written |
| 4. Dashboard | `generate-velocity.py --stats-dir ... --output ...` | `daily-stats.jsonl` + cumulative | `VELOCITY.md` | File written |
| 5. README hero | `generate-readme-hero.py --stats-dir ... --readme ...` | `daily-stats.jsonl` | `README.md` updated | Markers replaced |
| 6. Commit + push | git add/commit/push | Changed files | Commit on `dev` | Pushed |
| 7. State update | inline python | Run results | `state.json` + `runs.jsonl` | State persisted |

## Tool Inventory

### `collect-stats.sh`
- **`--date YYYY-MM-DD`**: Extract single-day metrics from git history (all branches). Returns JSON with `date`, `commits`, `loc_added`, `loc_removed`, `releases`, `contributors`.
- **`--cumulative`**: Returns all-time totals: `total_commits`, `total_tags`, `first_commit_date`, `total_contributors`.
- Release detection: tags matching `v4.YYMMDD.*` pattern.

### `backfill.sh`
- **`--days N`** (default: 30): Runs `collect-stats.sh` for each of the last N days, writes `daily-stats.jsonl`.
- Clears and rebuilds the entire file. Safe to re-run.

### `generate-charts.py`
- **`--input PATH`**: Path to `daily-stats.jsonl`.
- **`--output-dir DIR`**: Directory for SVG output (created if missing).
- **`--sample`**: Use generated sample data (for testing).
- Produces: `commits-30d.svg`, `releases-30d.svg`, `loc-30d.svg`.
- Dark theme (#0d1117), 800x200px, no external fonts or deps.

### `generate-velocity.py`
- **`--stats-dir DIR`**: Directory containing `daily-stats.jsonl` and `author-aliases.json`.
- **`--assets-dir PATH`**: Relative path for SVG image links in markdown.
- **`--output PATH`**: Output path for `VELOCITY.md`.
- Calls `collect-stats.sh --cumulative` internally for all-time numbers.

### `generate-readme-hero.py`
- **`--stats-dir DIR`**: Directory containing `daily-stats.jsonl` and `author-aliases.json`.
- **`--readme PATH`**: Path to README.md.
- Replaces content between `<!-- METRICS:START -->` and `<!-- METRICS:END -->` markers.

### `run-metrics.sh` (orchestrator)
- **`--dry-run`**: Run full pipeline but skip git commit/push.
- Calls all tools in sequence, handles backfill decision, updates state.

## Data Files

| File | Format | Purpose |
|------|--------|---------|
| `daily-stats.jsonl` | JSONL | One JSON object per day, last 30+ days of metrics |
| `state.json` | JSON | Last run status, stats count, charts generated |
| `runs.jsonl` | JSONL | Append-only log of every run with step timings |
| `author-aliases.json` | JSON | Git author name normalization map |

## Author Aliases

`author-aliases.json` maps variant git author names to canonical names:
```json
{"felipe": "Felipe Rosa", "filipexyz": "Felipe Rosa", "genie": "Genie"}
```
Edit this file to add new aliases. Used by `generate-velocity.py` and `generate-readme-hero.py`.

## Commit Convention

```
chore: update live metrics (N commits, N releases, +N/-N LoC)
```

Push to `dev` branch only. Never push to `main`.

## Error Handling

| Condition | Behavior |
|-----------|----------|
| `git` unavailable | `collect-stats.sh` exits 1, pipeline aborts |
| `daily-stats.jsonl` missing | Backfill runs automatically |
| `daily-stats.jsonl` < 30 entries | Backfill runs automatically |
| Chart generation fails | Pipeline aborts with error in `runs.jsonl` |
| README missing METRICS markers | `generate-readme-hero.py` exits 1 |
| `author-aliases.json` missing | Aliases ignored, raw git names used |
| No changes to commit | Commit step skipped, run logged as success |
| Push fails | Logged as error, run continues |

## Backfill Decision Tree

```
daily-stats.jsonl exists?
  NO  → backfill.sh (creates file with 30 days)
  YES → count entries
         < 30 → backfill.sh (rebuilds with 30 days)
         >= 30 → skip backfill, append today only
```

## Self-Diagnosis Checklist

If output looks wrong, check in order:

1. **No commits showing**: Run `git log --all --oneline | head -5` — is git history accessible?
2. **0 releases**: Run `git tag -l "v4.*" | head -5` — are v4.YYMMDD.* tags present?
3. **Stale data**: Check `daily-stats.jsonl` dates — is today's entry present?
4. **Wrong contributor names**: Check `author-aliases.json` — missing alias?
5. **Charts empty**: Check `daily-stats.jsonl` — are values all zero?
6. **README not updated**: Check for `<!-- METRICS:START -->` and `<!-- METRICS:END -->` markers.
7. **State not persisted**: Check `state.json` — does it have `daily_stats_count`?

## State Schema

### state.json
```json
{
  "last_run": "2026-04-12T00:00:00Z",
  "last_run_status": "success",
  "daily_stats_count": 31,
  "charts_generated": 3,
  "velocity_md_updated": true,
  "duration_ms": 12345
}
```

### runs.jsonl (each line)
```json
{
  "timestamp": "2026-04-12T00:00:00Z",
  "duration_ms": 12345,
  "status": "success",
  "dry_run": false,
  "daily_stats_count": 31,
  "charts_generated": 3,
  "velocity_md_updated": true,
  "errors": [],
  "steps": [{"name": "collect_stats", "duration_ms": 500}, ...]
}
```
