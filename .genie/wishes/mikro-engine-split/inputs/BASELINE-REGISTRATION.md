# Unpatched diagnostic baseline registration

Registered 2026-10-04 before this session observes any new benchmark outcomes.

## Purpose and limits

Run the handoff's immediate unpatched wish-context baseline using the existing Genie verifier. This is a diagnostic baseline, NOT the production-representative engine-selection experiment: the existing five fixtures are HEAD-existing Genie tasks and do not cover brain or genuinely absent/new-directory paths. Freeze the full production/new-file suite and all scored arms separately before comparing engines. No engine or routing winner may be declared from this run.

## Fixed method

- Runtime: installed `mikro v1.260909.1`, installed repository HEAD `15164cf55e9094cb42e95c3ea7dd1a24888a68ea`; no build/install/update during the run.
- Source under investigation: mikro HEAD `62894e49314bad07382492ac074ea96df6776f61`. Existing dirty installer/CLI/test/CHANGELOG changes belong to another lane and are preserved.
- Harness: Genie checkout HEAD `6354ff1cc672b5ed563ffe64203714f882a81872`, `bun scripts/mikro/bench.ts`; installed Genie reports `6.261004.15` but the checkout harness is the measured caller.
- Agent: working-tree `.mikro/agents/wish-context/agent.yaml` and `SYSTEM.md`; hash both and the fixture file before execution. No coaching/prompt mutation during this baseline.
- Model: agent-pinned `deepseek-api/deepseek-flash`, thinking low; max_iterations 16, max_cost 0.30, max_depth 0. Provider settings/credentials stay operator-owned; no secret copied to evidence.
- Fixtures: existing `scripts/mikro/fixtures/wish-context.json`: `issue-2921`, `observability-fold-in`, `wish-run-learnings`, `slice-0`, `issue-2927`. Three repetitions each: 15 fixture-runs. Every failed attempt retained; existing host retry policy is one full-run retry, so report first-attempt and final-run success separately when reading the ledger.
- Concurrency: 1. No facts acceleration (`MIKRO_FACTS` unset in session), default `boundary=none`, Phoenix disabled explicitly. This measures the current production-shaped engine, not a sandbox security certification.
- No shared agent EVIDENCE.md write. The harness writes only its normal `.mikro/runs` records and the baseline transcript is copied into this brainstorm's evidence after completion.

```bash
bun scripts/mikro/bench.ts wish-context --dir /home/genie/workspace/repos/genie --reps 3 --concurrency 1 --tag round=baseline-2026-10-04 --tag engine=rlm-unpatched --no-phoenix
```

## Report and selection rule

Report attempted runs, first-attempt/final verified success, verifier precision/recall, failure categories, p50/p90 end-to-end latency, all-attempt cost, cost per verified success, iteration-cap share, and per-fixture repetition dispersion. Preserve unknown cost as unknown rather than inventing zero-priced successes. Compare the harness summary with its attributable raw run records; existing summary uses recall/precision only on successful rows.

For the subsequent frozen cross-engine experiment: a faster/cheaper arm can win only at equal or better verified-success rate, with failures and retries included in latency/cost. Three repetitions are a minimum, not confidence that a small difference is real. No default routing change without the full production/new-file comparison and real-workflow SHIP/repairs evidence.
