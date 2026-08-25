# Routing-Matrix Pin — Day-2 Live QA (2026-07-11)

**Destination:** `.genie/wishes/routing-matrix/qa/`
**Analyst run:** 2026-07-11 ~19:42Z · source: LangWatch (`https://langwatch.khal.ai`) via `langwatch` CLI (subagent pull; auth = OTLP bearer from `~/.claude/settings.json`, key never stored).
**Predecessor:** [routing-pin-qa-20260710.md](routing-pin-qa-20260710.md) (day-1: inconclusive by delivery gap).
**Windows:** 07-09 full · 07-10 **full** (day-1 doc used a ~6.85h partial — trajectory, not exact deltas) · 07-11 partial 00:00–19:42Z (~19.7h).

---

## Verdict — first pro-design movement, but pins are STILL not mechanically delivered

**Delivery re-check (the day-1 acceptance test) FAILS again.** In a fresh session on 2026-07-11 ~19:40Z
(host fully current: CLI 5.260711.6, installed plugin cache 5.260711.6 updated 19:38Z, `agents/` present
with all seven role files), the pinned role agents **still did not surface as subagent types** (only
`omni:*` plugin agents + built-ins offered). Two root-cause candidates under investigation:
1. Frontmatter: genie agents carry `model:` + `effort:` and no `tools:`; the omni plugin's agents
   (name/description/tools only) load fine on the same host → suspect the `effort:` key (or another
   validation rule) silently skips the file.
2. agent-sync fans skills + workflows but never fans `agents/`; `~/.claude/agents/` does not exist on
   this host — if plugin-dir auto-discovery is the unreliable surface, fan-out is the fix.
Session-start timing is not the whole story: day-1 saw the same gap on cache 5.260710.2, which already
carried the agents.

**Despite that, the numbers moved the right way for the first time** — consistent with hand-applied
routing discipline (behavioral), not mechanical pins:

- **Opus engineering share recovered**: token share 33.0%→41.7% (+8.7pt), touch-rate 28.6%→**59.7%**
  (+31pt). The counterbalancing signal day-1 could not observe is now visible.
- **Fable did NOT collapse**: cost share 59.7%→55.9%, but token share 49.9%→**51.7%** and touch-rate
  **98.5%** — still on essentially every trace, nowhere near the ~11% gate-only benchmark.
- **Haiku scout lane stirring**: touch-rate 6.4%→19.4% (absolute traces flat at 13).
- **Cheap effort lanes fired for the first time ever**: 1 low-effort trace (07-10), 2 medium (07-11),
  vs hard zero in all prior windows.

## The numbers

### $/day trend (trace-level `total_cost` = `cost_billed`, ungrouped)

| Day | Window | Cost | Note |
|---|---|---:|---|
| 07-08 | full | $3,447 | heavy dogfood |
| 07-09 | full | $658 | quiet day |
| 07-10 | full | $2,499 | heavy dogfood |
| 07-11 | ~19.7h | $1,391 → **~$1,694/day run-rate** | day-2; cooling off the spike |

> Two cost figures exist and must not be mixed: trace-level ungrouped (above) vs span-level
> grouped-by-model (07-09 $1,230 · 07-10 $3,977 · 07-11 $2,488 — ~1.7× higher; multi-model traces count
> under each model). **Span-level grouped = authoritative for model shares; trace-level = day totals.**
> Absolute totals differ from the 07-10 06:51Z pull (late-ingested traces); fresh pull supersedes.

### Model share (span-level cost / tokens / touch-rate)

| Model | 07-09 | 07-10 full | 07-11 (~19.7h) | Design intent |
|---|---|---|---|---|
| Fable | 45.7% / 33.4% / — | 59.7% / 49.9% / 94.1% | **55.9% / 51.7% / 98.5%** | ▼ toward gates-only (~11% token benchmark) |
| Opus | 40.8% / 42.5% / — | 29.6% / 33.0% / 28.6% | **25.6% / 41.7% / 59.7%** | ▲ engineering ladder — RECOVERING |
| Haiku | 13.6% / 24.1% / — | 9.8% / 16.2% / 6.4% | 18.5% / 6.6% / 19.4% | ▲ scouts — stirring |

Distinct traces: 07-10 = 203, 07-11 = 67. A single Sonnet trace on 07-10 (0.9% cost) disappeared on
07-11 — the no-Sonnet rule holds. Haiku's cost/token mismatch on 07-11 ($460 on 161K tokens) is
cache-read-dominated span cost, not fresh generation.

### Effort distribution (per-trace, from trace search; analytics effort-filter remains broken)

| Effort | 07-10 full (n=203) | 07-11 (n=67) | 07-11 lane cost |
|---|---:|---:|---:|
| max | 101 (49.8%) | 26 (38.8%) | $458 (32.6%) |
| xhigh | 69 (34.0%) | 26 (38.8%) | **$766 (54.4%)** — p90 $73.79 |
| high | 32 (15.8%) | 13 (19.4%) | $160 (11.4%) |
| medium | 0 | **2 (3.0%)** | $22 (1.6%) |
| low | **1 (0.5%)** | 0 | — |

### Concentration + cache economics (07-11)

- Only **7 threads** active; **top-3 = 80.7%** of thread-grouped cost ($1,136 of $1,408); top-1 alone
  39.3%. Character unchanged: high-effort orchestration threads (the 07-10 team-lead orchestrator and
  the QA session are still in the top-5 as carryovers).
- **cache_read_tokens = 962M = 95.6% of processed tokens** (762× the 1.26M fresh prompt tokens;
  completion 4.18M = 0.4%). Context re-send is the throughput; fresh generation is ~0.5%.
  This is the strongest evidence yet for the context-diet/fan-out-shape lever (umbrella Decision 5):
  a few long orchestration threads re-feeding large contexts per turn drive the bill, and model price
  is a multiplier on top of that volume.

## Disposition

- Day-2 acceptance test (role agents as subagent types): **FAIL at 19:40Z → root cause found → FIXED and
  VERIFIED same day.** Root cause: the genie Claude Code plugin — the only surface that shipped
  `agents/` — is disabled in `~/.claude/settings.json` (`"genie@automagik": false`); frontmatter is
  valid per official docs (`effort:` is a supported key). Interim fix: the seven files hand-copied into
  `~/.claude/agents/` (live-watched user surface). **Verification 2026-07-11 ~20:15Z:** a fresh headless
  session (`claude -p`, haiku) listed all seven as subagent types with bare names —
  `engineer-complex, engineer-standard, engineer-trivial, final-gate, fixer, reviewer, scout`.
  The acceptance test PASSES on this host from now on; permanent fix (fan-out via `genie update`) is
  wish 1 of `token-efficiency-rebaseline`. Day-3 LangWatch pull should now measure pins that are
  mechanically live for the first time.
- Trajectory evidence: **first pro-design movement** (Opus recovery, cheap lanes firing, spend cooling)
  — recorded as the interim baseline for the rebaseline's success criteria.
- Full pull with command shapes: session scratchpad `langwatch-analysis-20260711.md` (session
  `a49fcea3`); durable content is this file.
