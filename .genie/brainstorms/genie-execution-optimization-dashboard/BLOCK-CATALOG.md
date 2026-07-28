# Execution lab: 20 dashboard blocks

Each block must change an execution-policy decision. This is a catalog, not a proposed one-screen layout.

## Speed and quality

| # | Processing block | Visual | Calculation and decision |
|---:|---|---|---|
| 1 | **Accepted-wish speed** | KPI + ECDF | `accepted_at - work_started_at`, with p50/p90 by strategy and complexity. This is the north star. |
| 2 | **Time to acceptance** | Survival curve | Includes active, failed, aborted, and timed-out runs as censored observations instead of hiding them. Sets the realistic SLO. |
| 3 | **Critical path** | Operation waterfall | Longest dependency path through typed operations, split into active, queued, blocked, and human-wait time. Finds the wall-time bottleneck. |
| 4 | **Parallelism and idle tax** | Lane Gantt | Active-time union, peak concurrency, queue gaps, and idle share. Shows when another agent shortens the path versus adds coordination. |
| 5 | **Operation bottlenecks** | Ranked table | p50/p90 time, token vector, quota delta, and failure rate for each operation kind. Decides which lifecycle step to redesign. |
| 6 | **First-pass SHIP** | Funnel | Runs accepted without `FIX-FIRST` or failed validation divided by terminal runs. Tests whether the executable spec is sufficient. |
| 7 | **Rework tax** | Sankey | Time, token vector, and quota after the first failed gate, grouped by typed failure cause. Finds expensive ambiguity and weak validation. |

## Context and session packing

| # | Processing block | Visual | Calculation and decision |
|---:|---|---|---|
| 8 | **200k working-set curve** | Session timeline | `(current input + current output) / 200,000`, with peak and reserved headroom. Shows where each session approaches the Genie budget. |
| 9 | **Zero-compaction proof** | Hard guardrail | Counts blocked compact attempts separately from actual `PostCompact`, `SessionStart(source=compact)`, and successful compaction events. Any actual compaction invalidates the run. |
| 10 | **Handoff threshold response** | Response curve | Accepted time, quota, and first-pass rate at the utilization where a handoff occurred. Chooses the safest fast boundary. |
| 11 | **Rewarm tax** | Box plot | Session/subagent start to its first typed productive milestone, in wall time and each token class. Decides whether a split paid for itself. |
| 12 | **Session fragmentation** | Stratified scatter | Sessions per wish versus accepted time, quota, and first-pass SHIP within matched complexity cohorts. Chooses a session-count policy. |
| 13 | **Context productivity decay** | Utilization bands | Accepted operations per minute and per processed token by working-set band at operation start. Detects when a warm context becomes a burden. |
| 14 | **Token and cache composition** | Stacked area | Fresh input, output, cache creation, and cache read over the session and wish. Distinguishes useful reuse from repeated processing. |

## Routing and quota

| # | Processing block | Visual | Calculation and decision |
|---:|---|---|---|
| 15 | **Fable → Opus allocation** | Transition matrix | Ordered model transitions by operation, with accepted time, quota, and rework. Locates the useful reasoning-to-execution boundary. |
| 16 | **Reasoning-effort yield** | Heatmap | Matched `model × operation × effort × complexity` cohorts, reporting speed, quota, and first-pass SHIP. Safely lowers effort after decisions are closed. |
| 17 | **Quota per accepted wish** | Waterfall | Five-hour and seven-day quota percentage-point deltas allocated by typed operation in isolated runs; modeled cost remains a separate secondary field. |
| 18 | **Quota runway** | Burn chart | Observed quota delta per hour and per accepted wish against both reset timestamps. Decides safe concurrency and how many wishes fit before reset. |

## Experiment and trust

| # | Processing block | Visual | Calculation and decision |
|---:|---|---|---|
| 19 | **Strategy leaderboard** | Paired leaderboard | Ranks benchmark arms by accepted-wish speed only after zero compaction and quality non-inferiority; always shows sample size and confidence interval. |
| 20 | **Measurement integrity** | Coverage matrix | Join rate, outcome coverage, quota-isolation status, usage reconciliation, and context-source confidence. Suppresses conclusions whose evidence is incomplete. |

## Signals required

- Typed Genie lifecycle: repo, wish, run, operation, dependency, attempt, timestamps, outcome, validation, review, rework,
  acceptance, base commit, and worktree.
- Claude runtime: native session/prompt/agent IDs, resolved Fable/Opus model, actual effort, request durations, fresh input,
  output, cache creation/read, and estimated cost.
- Live execution snapshots: current working-set tokens, five-hour/seven-day quota percentages and resets, and visible
  subagent model/context/token state.
- Strategy evidence: strategy/version, configured 200k budget, handoff threshold/reason, compaction controls, benchmark
  cohort, and telemetry coverage/confidence.

