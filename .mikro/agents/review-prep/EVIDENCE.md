# review-prep — evidence

Every row below is a real run recorded by `scripts/mikro/bench.ts`; nothing is estimated. Bars: yield ≥ 0.9, fabrications 0, recall ≥ 0.6, median cost ≤ $0.05, p90 ≤ 240 s.

## 2026-09-18T00:34Z — round 1 — range-mode-exact-path-resolver

model: deepseek-api/deepseek-flash · fixtures: 2932, 2937, 2928, 2910, 2901 · reps 1 · trace `bench:review-prep:2026-09-18T00:27:03.259Z`

| fixture | rep | ok | att | $ | s | iter | recall | prec | type | cites (dropped) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2901 | 0 | ✖ | 2 | 0.0371 | 374 | 28 | 1.00 | 1.00 | — | 14 (2) | citation: skills/refine/README.md — no such file (did you mean .claude/workflows/README.md or README.md or plugins/dsh-g |
| 2910 | 0 | ✔ | 1 | 0.0100 | 117 | 14 | 1.00 | 1.00 | — | 19 (0) |  |
| 2928 | 0 | ✔ | 1 | 0.0100 | 72 | 12 | 1.00 | 1.00 | — | 27 (0) |  |
| 2932 | 0 | ✔ | 1 | 0.0064 | 48 | 12 | 1.00 | 1.00 | — | 19 (0) |  |
| 2937 | 0 | ✔ | 1 | 0.0066 | 52 | 8 | 1.00 | 1.00 | — | 15 (0) |  |

runs 5 · yield 0.80 · fabrications 0 · recall 1.00 · precision 1.00 · type 0.00 · $ median 0.0100 mean 0.0140 · s p50 72 p90 374 · retries 1 · bars yield:✖ fabrication:✔ recall:✔ cost:✔ latency:✖ → FAIL
