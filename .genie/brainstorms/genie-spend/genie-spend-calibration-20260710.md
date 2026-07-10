# `genie spend` — Calibration Evidence (2026-07-10)

**For:** the genie-spend DRAFT (Phase-1 query design).
**Source:** LangWatch `https://langwatch.khal.ai` via `langwatch` CLI. Measured 2026-07-10 ~06:51Z.
**Scope note:** 07-10 is a **partial ~6.85h overnight window** (00:00–06:51Z) from a gate/review-heavy multi-agent dogfood run — good for *shape/recipe* calibration, not representative of a normal full day's absolute spend.

---

## $/day trend point

Span-level `performance.total_cost`, per UTC calendar day:

| Day | Window | Total cost | Note |
|---|---|---:|---|
| 07-08 | full | **$4,352** | full pre-pin day |
| 07-09 | full | **$1,230** | pre-pin (pins merged 21:51Z) |
| 07-10 | 00:00–06:51Z (~6.85h) | **$1,613** partial → **~$5,650/day run-rate** | overnight dogfood; run-rate is an upper-ish bound, not typical |

Context: the 21-day baseline averages ~$850/day ($17,857 / 21d), but recent dogfood days (07-08 at $4.3k, the 07-10 overnight run-rate at ~$5.6k) sit well above that average — the spend curve is in a heavy-dogfood spike, which is exactly the regime `genie spend` needs to surface.

## $/model split (07-10, billable `cost_billed`)

| Model | Billable cost | Share |
|---|---:|---:|
| Fable | $956 | **57%** |
| Opus | $562 | 34% |
| Haiku | $159 | 9% |
| **Total** | **$1,677** | |

(For directional trend vs 07-09 and token/trace shares, see `routing-pin-qa-20260710.md` — Fable share rose on every measure this window.)

## Per-lane cost calibration

**Per-effort cost-per-trace (solid — derived from trace search, per-trace effort + cost):**

| Effort lane | 07-10 n | p50 | p90 | mean |
|---|---:|---:|---:|---:|
| xhigh | 37 | $5.39 | $26.23 | $9.74 |
| high | 27 | $5.00 | $20.81 | $7.83 |
| max | 20 | $18.76 | $43.56 | $23.85 |
| **all** | 84 | **$6.76** | **$32.33** | $12.49 |

`max` is the expensive deep-reasoning/gate tier (~3–4× the p50 of xhigh/high). This is the cleanest per-lane number available and is a good basis for a `genie spend --by-effort` view or per-lane budget alerts.

**Per-model mean cost-per-trace (rough — use with caution):** Fable ≈ $12.8, Opus ≈ $13.4 per model-touch (07-10). These divide span-level cost by *overlapping* model-touch counts (a multi-model trace counts under each model), so they are means, not medians, and denominators are inflated. **Per-model p50/p90 is NOT derivable via the CLI** — trace search returns no per-trace model (spans empty; model lives only at span level inside analytics). If `genie spend` wants per-model percentiles, it needs span-level export, which the CLI does not expose.

---

## Which Phase-1 queries proved workable vs broken tonight

**Workable — all through the `langwatch` CLI (`analytics query` + `trace search`), no bespoke REST layer needed, and the existing OTLP-ingest key authenticates fine:** cost-by-model, cost-by-day (via per-day windows; each query also returns the prior period free), token-volume-by-model (`performance.total_tokens`), trace-count-by-model (`trace-count`/cardinality), top-sessions-by-cost (`--group-by metadata.thread_id`), and the effort histogram with per-effort cost percentiles (from trace search's per-trace `reasoning_effort` + `total_cost`). Any `genie spend` Phase-1 that maps to those six shapes can be built directly on the CLI. **Broken or blocked tonight:** (1) direct REST `POST /api/analytics` and `/api/trace/search` returned **403** — the CLI wraps the same endpoints and works, so Phase-1 should shell out to the CLI rather than hand-roll REST; (2) **effort-filtered analytics** is unavailable — the CLI `analytics query` has no `--filter` flag and the underlying effort-filter is reported silently broken, so any effort-scoped spend number must be computed client-side from trace search; (3) **per-model cost distributions (p50/p90)** are not derivable (no per-trace model attribution); (4) **cache-read-by-model** hits a known ClickHouse bug when combined with `--group-by metadata.model` and must be avoided (query cache-read without the model groupBy). Net: a CLI-backed Phase-1 covering model/day/thread/effort splits is achievable now; per-model percentiles and effort-filtered analytics are the two gaps to design around.
