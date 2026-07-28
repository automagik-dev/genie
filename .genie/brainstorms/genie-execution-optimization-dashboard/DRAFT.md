# DRAFT: Genie execution-optimization dashboard

**Status:** Simmering · **Started:** 2026-07-11 · **Dashboard:** [20-block catalog](BLOCK-CATALOG.md)

## Problem

Genie does not yet know which execution strategy turns a ready wish into independently accepted work fastest without
draining Felipe's Claude quota. Existing Claude telemetry measures activity, not wish outcomes, operation boundaries,
context reuse, handoff cost, or compaction.

## North star and guardrails

- **North star:** elapsed time from the first implementation operation to typed `accepted_at`.
- **Acceptance:** every required group complete, required validations passing, and an independent final review at `SHIP`.
- **Models:** Fable and Opus only.
- **Context:** optimize for a 200,000-token Genie working-set budget first. Fable 5 and Opus 4.8 currently expose a
  native 1M window; 300k/400k and native-window use are later experiments.
- **Compaction:** forbidden. An attempted compact fails the strategy boundary; an actual compact invalidates the run.
- **Quality:** speed and quota comparisons include accepted work only; failed or reopened work remains visible.
- **Privacy:** operation identity comes from typed Genie events, never prompt or terminal-content inference.

## What the old data teaches us

The observed Claude dataset contains 1,430 traces across 88 threads, with 121.29M prompt-plus-completion tokens,
15.38B processed tokens including cache traffic, and $22,755.24 of LangWatch-modeled cost. Average trace completion is
9.3 minutes and P95 is 28.8 minutes. Cache reads are 95.3% of processed tokens.

The latest 100-trace sample used `xhigh` or `max` 83 times. Those traces account for 88.6% of modeled cost, 76.6% of
completion tokens, and 91.6% of cache-read tokens in that sample. The first optimization candidate is therefore
reasoning allocation, especially after Fable has already produced an executable specification. This is correlation, not
proof that lower effort would have succeeded. The second candidate is execution packing: current data cannot tell
productive in-session reuse from repeated rewarming across sessions.

These figures are not yet comparable by wish, operation, model, or outcome because those join keys are absent. They are
diagnostic hypotheses, not routing conclusions.

## One program, three tracks

1. **Typed telemetry envelope:** join Genie wish/run/operation truth to Claude runtime observations in LangWatch.
2. **200k strategy benchmark:** compare session packing and reasoning policies under identical acceptance gates.
3. **Decision dashboard:** exactly 20 processing blocks that expose speed, quota, context, rework, and benchmark evidence.

The dashboard is the read model. Genie owns lifecycle and acceptance truth; LangWatch owns observed runtime, token,
latency, and modeled-cost evidence.

## Working hypotheses

1. Defaulting implementation and routine review to `xhigh`/`max` wastes quota after Fable has resolved the design.
2. Too many sessions increase rewarm time and tokens; too few push a session toward compaction and degrade execution.
3. Dependency-coherent adaptive packing will outperform both one-session monoliths and one-session-per-group splitting.
4. The useful handoff threshold is below 200k because instructions, tools, skills, and output need reserved headroom.
5. Critical-path idle time and fix loops may dominate wall time even after token efficiency improves.

## Decisions still open

- Whether to lock the recommended 100k/140k/170k threshold calibration, with 140k as the starting policy.
- How a runtime-neutral context snapshot is measured when a client exposes only partial token state.
- Whether Opus medium is the default for closed implementation and Opus high for integration/review.
- Whether the proposed 12-to-24 paired-wish stopping rule is affordable enough for the first experiment.

## Recommended telemetry path

```text
Genie typed event ledger          Claude Code native signals             LangWatch
wish/run/operation/outcome   +   OTel + status-line snapshots      ->   joined evidence
```

1. `genie launch` stamps process-static repo, wish-run, strategy, base-SHA, and worktree identifiers with
   `OTEL_RESOURCE_ATTRIBUTES`. The resolved model ID is recorded; floating `fable`/`opus` aliases are not benchmark IDs.
2. Trusted lifecycle hooks record `SessionStart/End`, `SubagentStart/Stop`, `PreCompact/PostCompact`, and failures into a
   local outbox keyed by native session, prompt, and agent IDs. Operations still begin/end through explicit typed Genie
   events; hooks never infer an operation from prompt text.
3. A backup-first status-line multiplexer tees Claude's live context, effort, cost estimate, and subscription quota
   snapshots to the outbox, then invokes the user's existing token-optimizer status line unchanged. A silent
   `subagentStatusLine` collector records visible agent model/context/token samples without replacing default rows.
4. The outbox exports companion spans with LangWatch `metadata` after the interactive path, so status lines and hooks do
   no network work. Genie DB remains authoritative for acceptance, review, validation, and rework.
5. Every field carries availability and source. Missing quota is not zero; modeled USD is not subscription quota; a
   global quota delta is attributable to a wish only during an isolated benchmark window.

Because Fable and Opus expose a native 1M context, Claude's `used_percentage` is relative to 1M. Genie instead computes
its working set as `(current total input + current output) / 200,000`; it never mistakes the native percentage for the
experiment percentage.

The default dashboard telemetry profile should be structured and content-free: prompts, assistant bodies, tool content,
and raw API bodies are unnecessary once typed Genie events exist. A separate time-bounded debug profile can enable them
explicitly. This reduces sensitive payload and LangWatch query load; it does not reduce Claude model quota.

### Minimal correlation envelope

```text
schema_version, event_id, event_type, occurred_at, source
repo_id, wish_id, wish_run_id, strategy_id, strategy_version
base_commit, worktree_id, benchmark_cohort
operation_id, parent_operation_id, operation_kind, group_id, attempt
runtime=claude, agent_instance_id, claude_session_id, claude_prompt_id
model_requested, model_resolved, effort_requested, effort_actual
outcome, evidence_ref, coverage_state
```

### No-compaction enforcement

- Launch every benchmark session with `DISABLE_COMPACT=1`, which disables automatic and manual compaction.
- Keep a trusted `PreCompact` blocker as defense in depth; hook trust remains Felipe's explicit decision.
- A blocked attempt is recorded as a strategy-boundary failure. Any `PostCompact`, compact-sourced session restart, or
  successful Claude OTel compaction event is an actual policy violation and invalidates the run.

## Recommended benchmark

First calibrate handoff at **100k / 140k / 170k** working-set tokens (50/70/85% of the 200k budget). Start at 140k; an
operation may begin only when its predicted p90 demand still preserves a 30k output/tool reserve. Handoffs occur only at
typed operation boundaries.

Then compare three attributable arms:

1. **Fragmented baseline:** one Fable executable spec; fresh Opus context per work/review unit; current high/xhigh policy.
2. **Packed context:** same model and effort policy, but dependency-coherent operations reuse one Opus context until the
   locked threshold. The difference from arm 1 measures session/rewarm cost.
3. **Packed + effort-routed:** same packing; Fable high produces the executable spec, Opus medium handles closed
   implementation, Opus high handles integration/review, and xhigh/max require a typed ambiguity, validation, or risk
   escalation. The difference from arm 2 measures reasoning allocation.

Replay each wish from the same pre-solution base commit in isolated worktrees, with hidden acceptance checks, balanced
arm order, the same concurrency cap, and an independent reviewer. Block comparisons by wish and stratify small/medium/
large using facts known before execution. Never discard timeouts or failed runs.

The first promotion rule should require: zero compactions, no severe quality regression, quality non-inferiority within
5 percentage points, quota no worse than +5%, and at least 15% faster median acceptance with a paired 95% interval that
excludes zero. Start with 12 paired wishes (four per stratum), inspect every four, and cap at 24.

Rewarm is measured without prompt content: session/subagent start to the first typed productive milestone, recording
wall time and the input/output/cache vector. Its causal estimate compares that prefix with a matched warm-continuation
operation of the same kind and complexity.

## Initial acceptance criteria

- Every instrumented run has stable repo, wish, run, operation, session, model, effort, strategy, and outcome identifiers.
- Every native session records context snapshots, handoffs, rewarm, cache, quota evidence where available, and compaction.
- A strategy run with any compaction is automatically excluded from winning and shown as a hard failure.
- The dashboard computes exactly 20 decision-oriented blocks from one versioned metric contract.
- Benchmark comparisons are blocked or matched by wish complexity and use the same acceptance and validation gates.
- Genie can identify a faster accepted-wish strategy without treating missing telemetry as zero or modeled cost as billing.

## Risks

- Provider quota accounting may not map to API-equivalent modeled cost; both need separate labels.
- Context/token fields may differ across Claude Code, Codex, and Hermes; availability must remain explicit.
- Strategy selection bias can make a model or split policy look better on easier wishes.
- Over-reserving headroom creates unnecessary handoffs; under-reserving makes compaction likely.
- A faster first attempt can hide more rework unless acceptance and reopening remain part of the outcome.

## Verified runtime references

- [Claude model aliases and resolved versions](https://code.claude.com/docs/en/model-config#model-aliases)
- [Claude context windows and token accounting](https://platform.claude.com/docs/en/build-with-claude/context-windows)
- [Claude status-line and subagent context/quota fields](https://code.claude.com/docs/en/statusline)
- [Claude hook lifecycle and `PreCompact` blocking](https://code.claude.com/docs/en/hooks)
- [Claude OTel metrics, events, and resource attributes](https://code.claude.com/docs/en/monitoring-usage)
- [LangWatch OTel metadata and labels](https://langwatch.ai/docs/integration/metadata-and-labels)

## WRS

WRS: `████████░░ 80/100`

Problem ✅ | Scope ✅ | Decisions ░ | Risks ✅ | Criteria ✅
