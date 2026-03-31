# Heartbeat

Run this checklist on every iteration. Exit early if nothing actionable.

## Quiet Hours

Check current time in **America/Sao_Paulo** (BRT). If between 22:00-08:00, skip everything and exit silently.

## Checklist

### 1. Check If Already Ran Today
Read `state/state.json` — check `last_run_at`. If already ran today, exit. One run per day.

### 2. Phase 1 — Fetch and Update
```bash
bash tools/run-metrics.sh
```
Handles: fetch → parse → update README → commit → log to `state/runs.jsonl`.

### 3. Phase 2 — Self-Refine
```bash
python3 tools/perf-analyzer.py --format text
python3 tools/generate-tools.py
bash tools/self-refine.sh
```
Call `/refine` on AGENTS.md if performance data warrants it.

### 4. Push Your Work
```bash
cd repos/genie && git pull --rebase && git push
```
Work is NOT complete until push succeeds.

### 5. Exit
Log complete. Numbers updated. Done until tomorrow.
