# Routing-Matrix Pin — Day-1 Live QA (2026-07-10)

**Destination:** `.genie/wishes/routing-matrix/qa/`
**Analyst run:** 2026-07-10 ~06:51Z · source: LangWatch (`https://langwatch.khal.ai`) via `langwatch` CLI
**Pins under test:** routing-matrix (PR #2535, merged 2026-07-09 ~21:51Z, released v5.260710.2) — Fable only at gates, Opus ladder for engineering, Haiku scouts.

---

## Verdict — pins are NOT collapsing Fable on execution work yet (inconclusive as a design test)

On the first partial day under the pins, **Fable's share rose on every measure** — the opposite of the designed collapse — while **Opus per-trace engagement fell from 84% to 48%** and the **Haiku scout lane went nearly silent (10 → 4 traces)**.

This is **not** evidence the pinning *design* is wrong. It is evidence the pins **were not mechanically in effect**: the pinned role agents were not available as subagent types, so the overnight run defaulted to a Fable orchestrator with hand-applied model overrides. The measured rise reflects an atypically gate/review/orchestration-heavy dogfood night on a Fable default, sampled over only ~7 hours — not a refutation of the ladder. Treat day-1 as **inconclusive for the design, conclusive that the expected collapse has not occurred**, and re-verify once pins are actually delivered as subagent types.

> **Observed delivery gap (verbatim, for the record):**
> Pinned role agents (engineer-trivial/standard/complex, fixer, reviewer, final-gate, scout) did NOT appear as available subagent types in a fresh Claude Code session on 2026-07-10 03:06 (plugin cache 5.260710.2) — the session applied the routing ladder manually via model overrides. This is the lazy-delivery gap agent-sync closes; agent-sync merged to dev 2026-07-10 06:47Z (PR #2541) — re-verify after the next stable release + genie update ×2.

---

## The numbers

Comparison is **2026-07-10 00:00→06:51Z (partial, ~6.85h, post-pin but pins not mechanically active)** vs **2026-07-09 full day (pre-pin baseline — pins only merged at 21:51Z that night)**. Shares are ratios, so they remain comparable across a partial vs full day even though absolute volumes do not.

### Model share moved the wrong way on all three measures

| Measure | Model | 07-09 (pre-pin) | 07-10 (post-pin, ~7h) | Direction | Design intent |
|---|---|---:|---:|---|---|
| **Billable cost** | Fable | 46% ($562) | **57% ($956)** | ▲ +11pt | ▼ down (gates only) |
| | Opus | 41% ($501) | 34% ($562) | ▼ | ▲ up (engineering) |
| | Haiku | 14% ($167) | 9% ($159) | ▼ | ▲ up (scouts) |
| **Token volume** (span-level, total_tokens) | Fable | 33% | **50%** | ▲ +17pt | ▼ down |
| | Opus | 43% | 36% | ▼ | ▲ up |
| | Haiku | 24% | 14% | ▼ | ▲ up |
| **Trace touch-rate** (traces touching model ÷ distinct) | Fable | 60% | **86%** | ▲ +26pt | ▼ down |
| | Opus | 84% | 48% | ▼ −36pt | ▲ up |
| | Haiku | 20% | 5% | ▼ | ▲ up |

Totals: 07-09 billable $1,230 / 3.67M tokens / 50 distinct traces (82 model-touches). 07-10 (partial) billable $1,677 / 3.83M tokens / 84 distinct traces (116 model-touches).

**Read:** every lens agrees. Fable is *up*, Opus and Haiku are *down*. The single clearest signal is the flip in dominant model — on 07-09 Opus was the most-engaged model (84% of traces touched it); on 07-10 Fable overtook it (86%) and Opus engagement collapsed to 48%. That is engineering work **not** being routed to the Opus ladder.

### Effort distribution — high-effort throughout, scout lane silent

Effort is a per-trace field (`gen_ai.request.reasoning_effort`), read directly from trace search (the analytics effort-filter is known to be silently broken, so it was not used).

| Effort | 07-09 (n=50) | 07-10 (n=84) |
|---|---:|---:|
| xhigh | 27 (54%) | 37 (44%) |
| high | 6 (12%) | 27 (32%) |
| max | 17 (34%) | 20 (24%) |
| medium / low | 0 | 0 |

**Read:** the population is entirely xhigh/high/max on both days — **zero low/medium-effort traces**. Haiku scouts, which would run cheap/low-effort, essentially did not fire (only 4 Haiku-touching traces on 07-10). The one favorable movement is a modest max→high shift (34%→24% max), consistent with *some* deep-reasoning work sliding down a tier, but it is well within noise for an n=84 sample.

### Top-5 sessions by cost (07-10, by thread)

| # | Thread (trunc) | Cost (trace-level) | Character |
|---|---|---:|---|
| 1 | `ae132245…` | $428.82 | Team-lead orchestrator, **max** effort, Fable — merge/coordination thread ("watch #2542, then genie update ×2") |
| 2 | `4f125d00…` | $210.95 | Long-running work thread |
| 3 | `8050dd5c…` | $108.48 | Carryover thread (was #1 on 07-09 at $442) |
| 4 | `52675102…` | $60.48 | — |
| 5 | `d0554818…` | $56.78 | *This QA analysis session itself* |

**Read:** the cost is concentrated in **orchestration/coordination threads**, led by the team-lead planner running at max effort on Fable. That kind of thread is *legitimately* Fable-heavy under the design (planning/gates). The problem is not that these threads used Fable — it is that we cannot observe the counterbalancing Opus-engineering collapse, because engineering wasn't dispatched to pinned Opus agents. The "first dogfooded wish under pins ran at ~11% Fable tokens" data point shows the ladder *does* work where pins are applied; the aggregate day is simply swamped by unpinned orchestration/review threads.

---

## Why day-1 is inconclusive — caveats that bound every number above

1. **Pins were not mechanically enforced.** The pinned role agents did not exist as subagent types in the fresh session (verbatim finding above); the ladder was applied by hand. So 07-10 does **not** actually exercise the pinning mechanism — it measures an unpinned Fable-default run.
2. **Partial window.** 07-10 is only ~6.85h (00:00–06:51Z) vs a full 07-09. Shares are ratio-based and comparable; absolute volumes and run-rates are not.
3. **Atypical workload.** This window is the genie overnight dogfood — an orchestration/review/council/gate-heavy multi-agent run. That mix is Fable-heavy *by design*. A normal execution-heavy day would look different.
4. **07-09 is a clean-ish pre-pin baseline** (pins merged 21:51Z that night, so <2h of 07-09 was post-pin) — a fair "before".
5. **Trace-count-by-model double-counts.** 116 model-touches across 84 distinct traces → multi-model orchestration traces are counted under every model they touch. **Token share is the cleaner signal**; trace touch-rate is directional only.
6. **Trace-level cost ($1,049) < span-level analytics cost ($1,613) for 07-10** — a Claude Code trace bundles multiple model spans and the trace-level `total_cost` metric under-captures sub-span cost. **Analytics groupBy `metadata.model` is authoritative for model attribution**; trace-search costs are used only for per-trace effort/percentile work.

**Re-verification trigger:** after the next *stable* release carrying agent-sync + `genie update` ×2 on a dogfood host, confirm (a) the seven pinned role agents appear as subagent types in a fresh session, then (b) re-pull this exact comparison. Expect Fable token share to fall toward gate-only levels (~the ~11% seen on the one properly-pinned wish) and Opus engineering share to rise.

---

## Methodology & working query recipes (auth redacted)

**Access resolution (the earlier 403).** Direct REST `POST /api/trace/search` and `/api/analytics` returned HTTP 403 earlier tonight under both `Authorization: Bearer` and `X-Auth-Token`. **Root cause: payload/route shape, not the key.** The same OTLP-ingest key works fine through the official `langwatch` CLI, which wraps those endpoints. Recommendation: **drive LangWatch through the CLI, not hand-rolled REST.**

Auth is supplied to the CLI via two env vars (key read at runtime from the `OTEL_EXPORTER_OTLP_HEADERS` bearer token in `~/.claude/settings.json` — **never printed, never stored in any artifact**):

```
LANGWATCH_API_KEY=<redacted>        # the sk-… bearer token from OTEL_EXPORTER_OTLP_HEADERS
LANGWATCH_ENDPOINT=https://langwatch.khal.ai
```

Verify auth: `npx -y langwatch status` → returns project resource counts (200 = key valid).

**Cost / tokens / trace-count by model** (authoritative for model share):
```
npx -y langwatch analytics query \
  --metric performance.total_cost \      # or performance.cost_billed | performance.total_tokens
  --aggregation sum \                    # trace-count uses: --metric trace-count --aggregation cardinality
  --group-by metadata.model \
  --start-date 2026-07-10T00:00:00Z --end-date 2026-07-10T23:59:59Z \
  --time-scale full --format json
```
Returns `{ currentPeriod, previousPeriod }` — `previousPeriod` is the auto-computed prior equal-length window (a single-day query yields the prior day free; the two reconcile across queries).

Valid metric enum (discovered via a bad-metric error): `performance.total_cost`, `.cost_billed`, `.cost_non_billed`, `.prompt_tokens`, `.completion_tokens`, `.cache_read_tokens`, `.cache_write_tokens`, `.reasoning_tokens`, `.total_processed_tokens`, `.total_tokens`, `.tokens_per_second`; plus `metadata.trace_id|thread_id|user_id|span_type`.

**Top sessions by cost:** same as above with `--group-by metadata.thread_id`.

**Effort distribution + per-trace percentiles** (bypass the broken analytics effort-filter):
```
npx -y langwatch trace search \
  --start-date 2026-07-10T00:00:00Z --end-date 2026-07-10T23:59:59Z \
  --limit 2000 --format json
```
Each trace carries `metadata.gen_ai.request.reasoning_effort` (per-trace) and `metrics.total_cost` — histogram + p50/p90 computed client-side. `pagination.totalHits` gives the true distinct-trace count.

**Traps confirmed tonight:**
- `analytics query` exposes **no `--filter` flag** in the CLI — effort/metadata filtering is not available there. Use trace search for anything effort-scoped. (The underlying analytics effort-filter is also reported silently broken.)
- **Do not** combine `--group-by metadata.model` with a cache-read metric — known ClickHouse bug (avoided; not attempted).
- **Per-trace model is not available from trace search** (spans return empty; trace metadata has no model field). Per-model cost *distributions* (p50/p90) are therefore not derivable via the CLI — only per-model means (analytics cost ÷ trace-count) and per-effort percentiles.
