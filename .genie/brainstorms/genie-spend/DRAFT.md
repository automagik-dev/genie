# DRAFT: genie-spend (Domain A — umbrella G7)

**Parent:** [genie-token-efficiency-program](../genie-token-efficiency-program/DESIGN.md) · **Status:** Raw

## KNOWN (evidence)
- Baseline: $17,857 / 95.77M billable tokens / 11.79B cache-read tokens / 1097 traces in 21d (~1000 in last 4 days). Fable $13.8k · Opus $7.1k · Haiku $1.2k · Sonnet $0.5k (span-attributed shares).
- Working analytics recipes (archived in parent DRAFT): tokens+cost by model (groupBy metadata.model), top sessions (groupBy metadata.thread_id), by effort (filter-loop on gen_ai.request.reasoning_effort — no effort groupBy exists), top-N traces (trace/search + client sort, scrollId pagination).
- `metadata.labels` groupBy EXISTS but CC's OTel export emits no genie labels; thread_id = whole CC session (no per-subagent split); model lives on spans, not traces.
- LangWatch CLI (`npm i -g langwatch`) wraps the same endpoints, `--format json`, designed to be agent-driven. **Access proven 2026-07-10: the existing OTLP-ingest key authenticates fine through the CLI; hand-rolled REST `POST /api/analytics` + `/api/trace/search` returned 403 (payload/route shape, not the key). Phase 1 should shell out to the `langwatch` CLI, NOT hand-roll REST.** Substrate + recipes archived in [genie-spend-calibration-20260710.md](genie-spend-calibration-20260710.md).
- Hermes north star: **cost per group accepted without reopening** — measure decisions, not calls.

## 7-DAY BURN ANALYSIS (run 2026-07-09 — first real analysis pass)

Daily (total ≈ **$18.2k/7d**, avg $2.6k/day, peak 07-05 **$6.4k**):
| date | cost$ | prompt | completion | cache_read |
|---|---|---|---|---|
| 07-04 | 2,445 | 3.2M | 12.7M | 1.35B |
| 07-05 | 6,440 | 4.0M | 14.9M | **4.03B** |
| 07-06 | 4,010 | 3.0M | 13.6M | 2.26B |
| 07-07 | 1,500 | 2.6M | 14.7M | 1.17B |
| 07-08 | 3,447 | 6.7M | 20.1M | 2.97B |

**Finding 1 — cache reads are the dominant cost bucket, not fresh tokens.** ~1.2–4B cache-read tokens/day vs 3–7M prompt. At Fable cache-read rates ($1/MTok) the 07-05 peak ≈ $4k of the $6.4k day. Cost ≈ (context size × turn count) first, output second, fresh input noise. Hermes' context-diet thesis is now data-proven as the #1 lever alongside model rate.
**Finding 2 — model split (7d, span-attributed): Fable $14.1k (61%) · Opus $7.4k (32%) · Haiku $1.3k · Sonnet $0.5k.** Routing to Opus halves the rate on BOTH dominant buckets (cache-read $1.00→$0.50/MTok, completion $50→$25).
**Finding 3 — per-trace cost is nearly model-independent: Fable $17.9 · Haiku $16.9 · Opus $15.4.** A Haiku trace with fat context costs as much as a Fable trace — model tier alone does not save money; the brief/context shape does.
**Finding 4 — top sessions are FLAT** ($1.6k max, 12 sessions ≥ $574): the burn is systemic (every session expensive), not one villain workload.
**Finding 5 — instrumentation gaps:** analytics-API effort filter is silently broken (returns whole-window numbers for any filter value — earlier "by effort" recipe invalid); `performance.reasoning_tokens` = 0 (CC doesn't export it); per-trace aggregation is the only truthful effort source (burn-classifier agent running).

## DECIDED (umbrella D13)
- Phase 1: fingerprint attribution (distinct model×effort per role from routing-matrix = role split for free) + `genie spend` command: $/day trend, $/model×effort, top sessions, top traces, `--json`; <5s target.
- Phase 2: outcome labels in genie.db (wish_slug, group_id, role, model, effort, complexity_score, retry_count, escalation_from/reason, fix_first_count, reviewer_verdict, final_gate_verdict, reopened, shipped) joined to LangWatch cost by thread_id + time-window + fingerprint → per-group cost report.
- Phase 2 fallback only if correlation too fuzzy: evaluate LangWatch post-hoc label-update API.

## BURN ANALYSIS — 7 days, 07-02→07-09 (2026-07-09, post-DB-fix)

Totals: **$18,175 · 1,113 traces · 63 sessions.** Token buckets: prompt (fresh) 20.0M · completion 76.9M · **cache-read 11.94B** · cache-write 472M · reasoning 0 (not exported by CC OTel).

**Cost decomposition (rate-weighted estimate):**
| Bucket | Tokens | ~$ share |
|---|---|---|
| Cache reads | 11.94B | **~55–65% ($10–12k)** |
| Cache writes | 472M | ~20% ($4–6k) |
| Completion | 76.9M | ~20% ($3.6k: Fable 45.1M×$50 + Opus 48.4M×$25 + small) |
| Fresh prompt | 20M | ~1% |

**Findings:**
1. **Context re-reads are THE burn** — 10.7M cache-read tokens per trace avg = ~150-250k working context × 30-60 API calls per turn. Both factors compound: session length × context size × tool-calls-per-turn.
2. **Top 10 sessions = $10.1k (55%)** — each 33-72 traces, 0.5-1.1B cache reads, 5-8MB transcripts. Identified: genie /wish session ($1.2k), khal-fde live onboarding ($1.2k), omni session ($1.0k), khal kernel-platform ×2 ($1.4k), desktop /brainstorm ($0.8k); 4 not local to this machine. Monolith long sessions across ALL projects — a workflow pattern, not one repo.
3. **Fable ran 71% of traces (788 vs Opus 484)** — but Fable's completion/trace (57k) is LOWER than Opus's (100k). Verbosity is not the problem; the expensive model reading giant contexts repeatedly is.
4. Per-model cache-read split unavailable (LangWatch ClickHouse bug: `ts.Attributes` unknown in groupBy+attribute-metric path — upstream issue worth filing).

**Lever ranking (data-ordered):**
1. Execution sessions → Opus (routing-matrix): halves BOTH dominant buckets (cache-read $1→$0.5/MTok, completion $50→$25) for ~70% of traffic ≈ **-30% alone**.
2. Context diet + subagent isolation (control-plane-contract G3): subagents carry small fresh contexts instead of the 200k monolith; shorter sessions per stage (Warp panes already do this) ≈ -20-40% on top.
3. Fewer tool calls per turn (batching, scripts over call-chains): every call re-reads full context — new guidance item for work/dispatch contract.
4. Stable prompt prefixes so cache writes stay linear (constraint on always-on-genie inject: deterministic, session-start-only).

## CALIBRATION — 2026-07-10 (day-1 pin-QA window, partial ~6.85h) — [full file](genie-spend-calibration-20260710.md)

Measured via the `langwatch` CLI during the routing-pin day-1 QA. This window is a gate/review-heavy overnight dogfood — good for **shape/recipe** calibration, not a representative full day. Cross-ref [routing-matrix/qa/routing-pin-qa-20260710.md](../../wishes/routing-matrix/qa/routing-pin-qa-20260710.md).

**$/day trend point (span-level `performance.total_cost`):** 07-08 full **$4,352** · 07-09 full **$1,230** (pins merged 21:51Z) · 07-10 00:00–06:51Z **$1,613** partial → **~$5,650/day run-rate** (upper-ish bound, not typical). The 21-day baseline averages ~$850/day, but recent dogfood days sit well above — the exact heavy-spend spike `genie spend` needs to surface.

**$/model split (07-10, billable `cost_billed`):** Fable $956 (**57%**) · Opus $562 (34%) · Haiku $159 (9%) — Fable share rose on every measure this window (see the pin-QA file).

**Per-effort cost-per-trace (SOLID — from trace search's per-trace `reasoning_effort` + `total_cost`):** this is the cleanest per-lane number available and a good basis for a `genie spend --by-effort` view / per-lane budget alerts.
| Effort | n | p50 | p90 | mean |
|---|---:|---:|---:|---:|
| xhigh | 37 | $5.39 | $26.23 | $9.74 |
| high | 27 | $5.00 | $20.81 | $7.83 |
| max | 20 | $18.76 | $43.56 | $23.85 |
| **all** | 84 | **$6.76** | **$32.33** | $12.49 |

`max` is the expensive deep-reasoning/gate tier (~3–4× the p50 of xhigh/high).

**Phase-1 query shapes that proved WORKABLE (all via the CLI, existing key):** cost-by-model, cost-by-day (per-day windows; each query returns the prior period free), token-volume-by-model, trace-count-by-model, top-sessions-by-cost (`--group-by metadata.thread_id`), effort histogram + per-effort cost percentiles. **BROKEN/blocked tonight:** (1) direct REST 403 → use the CLI; (2) **effort-filtered analytics** unavailable (`analytics query` has no `--filter`; underlying effort-filter silently broken) → **effort splits must be computed client-side from trace search**; (3) **per-model p50/p90 NOT derivable** — trace search returns no per-trace model (spans empty; model lives only at span level in analytics) → **parked**; per-effort percentiles are the usable substitute, or span-level export the CLI doesn't expose; (4) **cache-read + `--group-by metadata.model`** hits a known ClickHouse bug → avoid (query cache-read without the model groupBy). Net: a CLI-backed Phase-1 covering model/day/thread/effort splits is achievable now; per-model percentiles and effort-filtered analytics are the two gaps to design around.

## GAPS
- [ ] Key/endpoint source for `genie spend`: read from CC settings env (OTEL_EXPORTER_OTLP_*), from genie config, or both with precedence? (Machine-portability: teammates' machines have the same settings?) — **2026-07-10 evidence: the OTLP-ingest key from `OTEL_EXPORTER_OTLP_HEADERS` in `~/.claude/settings.json` authenticates the CLI; endpoint `https://langwatch.khal.ai`.**
- [ ] Cadence: on-demand only, or a scheduled snapshot (e.g. daily line into .genie/ or omni message)? You already run "live metrics" commits — integrate or keep separate?
- [ ] Consumers: just you, or team/omni-channel reporting?
- [ ] Should `genie doctor` warn when burn-rate exceeds a threshold (needs a threshold from you)?
