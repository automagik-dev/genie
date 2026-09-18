# issue-triage — evidence

Rounds dated before 2026-09-18T05:00Z were priced at the placeholder basis (0.14 in / 0.28 out per M); list prices are 0.30 / 1.20 peak — see README "Prices".

Every row below is a real run recorded by `scripts/mikro/bench.ts`; nothing is estimated. Bars: yield ≥ 0.9, fabrications 0, recall ≥ 0.6, median cost ≤ $0.05, p90 ≤ 240 s.

## 2026-09-18T00:20Z — round 1 — first-draft

model: deepseek-api/deepseek-flash · fixtures: 2921, 2927, 2926, 2941, 2942, 2924 · reps 1 · trace `bench:issue-triage:2026-09-18T00:18:24.521Z`

| fixture | rep | ok | att | $ | s | iter | recall | prec | type | cites (dropped) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2921 | 0 | ✔ | 1 | 0.0063 | 55 | 12 | 0.40 | 1.00 | yes | 2 (0) |  |
| 2924 | 0 | ✔ | 1 | 0.0064 | 41 | 7 | 1.00 | 0.50 | yes | 6 (0) |  |
| 2926 | 0 | ✔ | 1 | 0.0074 | 53 | 12 | 1.00 | 0.67 | yes | 10 (0) |  |
| 2927 | 0 | ✔ | 1 | 0.0074 | 52 | 12 | 0.45 | 1.00 | yes | 5 (0) |  |
| 2941 | 0 | ✔ | 1 | 0.0052 | 50 | 12 | 1.00 | 0.50 | yes | 4 (0) |  |
| 2942 | 0 | ✔ | 1 | 0.0039 | 38 | 12 | 0.50 | 0.40 | no | 5 (0) |  |

runs 6 · yield 1.00 · fabrications 0 · recall 0.73 · precision 0.68 · type 0.83 · $ median 0.0064 mean 0.0061 · s p50 52 p90 55 · retries 0 · bars yield:✔ fabrication:✔ recall:✔ cost:✔ latency:✔ → PASS

## 2026-09-18T00:25Z — round 2 — 14-iterations-sibling-guidance

model: deepseek-api/deepseek-flash · fixtures: 2921, 2927, 2926, 2941, 2942, 2924 · reps 2 · trace `bench:issue-triage:2026-09-18T00:20:49.870Z`

| fixture | rep | ok | att | $ | s | iter | recall | prec | type | cites (dropped) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2921 | 0 | ✔ | 1 | 0.0100 | 90 | 14 | 0.60 | 1.00 | yes | 3 (0) |  |
| 2921 | 1 | ✔ | 1 | 0.0054 | 47 | 14 | 0.40 | 0.67 | yes | 3 (0) |  |
| 2924 | 0 | ✔ | 1 | 0.0082 | 69 | 14 | 1.00 | 0.43 | yes | 7 (0) |  |
| 2924 | 1 | ✔ | 2 | 0.0140 | 130 | 25 | 1.00 | 0.43 | yes | 7 (0) |  |
| 2926 | 0 | ✔ | 1 | 0.0088 | 68 | 14 | 1.00 | 0.86 | yes | 9 (0) |  |
| 2926 | 1 | ✔ | 1 | 0.0063 | 56 | 14 | 1.00 | 0.60 | yes | 13 (0) |  |
| 2927 | 0 | ✔ | 1 | 0.0059 | 51 | 14 | 0.45 | 1.00 | yes | 5 (0) |  |
| 2927 | 1 | ✔ | 1 | 0.0066 | 68 | 14 | 0.36 | 0.80 | yes | 5 (0) |  |
| 2941 | 0 | ✔ | 1 | 0.0064 | 54 | 14 | 1.00 | 0.50 | yes | 4 (0) |  |
| 2941 | 1 | ✔ | 1 | 0.0052 | 52 | 14 | 1.00 | 0.50 | yes | 4 (0) |  |
| 2942 | 0 | ✔ | 1 | 0.0048 | 41 | 14 | 0.50 | 0.40 | no | 5 (0) |  |
| 2942 | 1 | ✔ | 1 | 0.0047 | 40 | 14 | 0.75 | 0.50 | yes | 6 (0) |  |

runs 12 · yield 1.00 · fabrications 0 · recall 0.76 · precision 0.64 · type 0.92 · $ median 0.0064 mean 0.0072 · s p50 56 p90 90 · retries 1 · bars yield:✔ fabrication:✔ recall:✔ cost:✔ latency:✔ → PASS
