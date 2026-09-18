# wish-context — evidence

Every row below is a real run recorded by `scripts/mikro/bench.ts`; nothing is estimated. Bars: yield ≥ 0.9, fabrications 0, recall ≥ 0.6, median cost ≤ $0.05, p90 ≤ 240 s.

## 2026-09-18T00:25Z — round 1 — first-draft-plus-path-hint

model: deepseek-api/deepseek-flash · fixtures: issue-2921, observability-fold-in, wish-run-learnings, observe-bundle, slice-0 · reps 1 · trace `bench:wish-context:2026-09-18T00:21:44.616Z`

| fixture | rep | ok | att | $ | s | iter | recall | prec | type | cites (dropped) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| issue-2921 | 0 | ✔ | 1 | 0.0077 | 66 | 16 | 1.00 | 1.00 | — | 17 (0) |  |
| observability-fold-in | 0 | ✔ | 1 | 0.0080 | 52 | 8 | 0.82 | 1.00 | — | 17 (0) |  |
| observe-bundle | 0 | ✖ | 2 | 0.0190 | 146 | 32 | 0.77 | 1.00 | — | 29 (2) | citation: build-binary.sh:72 — no such file (did you mean scripts/build-binary.sh? cite the path exactly as printed, fro |
| slice-0 | 0 | ✔ | 2 | 0.0159 | 122 | 32 | 0.80 | 1.00 | — | 12 (0) |  |
| wish-run-learnings | 0 | ✔ | 2 | 0.0193 | 145 | 32 | 1.00 | 1.00 | — | 16 (0) |  |

runs 5 · yield 0.80 · fabrications 0 · recall 0.90 · precision 1.00 · type 0.00 · $ median 0.0159 mean 0.0140 · s p50 122 p90 146 · retries 3 · bars yield:✖ fabrication:✔ recall:✔ cost:✔ latency:✔ → FAIL

## 2026-09-18T00:30Z — round 2 — exact-path-rule-plus-resolver

model: deepseek-api/deepseek-flash · fixtures: issue-2921, observability-fold-in, wish-run-learnings, observe-bundle, slice-0 · reps 1 · trace `bench:wish-context:2026-09-18T00:27:01.162Z`

| fixture | rep | ok | att | $ | s | iter | recall | prec | type | cites (dropped) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| issue-2921 | 0 | ✔ | 1 | 0.0095 | 62 | 9 | 0.40 | 0.67 | — | 16 (0) |  |
| observability-fold-in | 0 | ✔ | 1 | 0.0053 | 38 | 10 | 0.91 | 1.00 | — | 21 (0) |  |
| observe-bundle | 0 | ✔ | 2 | 0.0180 | 165 | 31 | 0.15 | 0.50 | — | 15 (0) |  |
| slice-0 | 0 | ✔ | 2 | 0.0143 | 116 | 32 | 1.00 | 1.00 | — | 17 (0) |  |
| wish-run-learnings | 0 | ✔ | 1 | 0.0091 | 67 | 16 | 1.00 | 1.00 | — | 19 (0) |  |

runs 5 · yield 1.00 · fabrications 0 · recall 0.69 · precision 0.83 · type 0.00 · $ median 0.0095 mean 0.0112 · s p50 67 p90 165 · retries 2 · bars yield:✔ fabrication:✔ recall:✔ cost:✔ latency:✔ → PASS

## 2026-09-18T00:33Z — round 3 — coverage-guidance-kinds

model: deepseek-api/deepseek-flash · fixtures: issue-2921, observe-bundle · reps 2 · trace `bench:wish-context:2026-09-18T00:31:59.790Z`

| fixture | rep | ok | att | $ | s | iter | recall | prec | type | cites (dropped) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| issue-2921 | 0 | ✔ | 1 | 0.0093 | 73 | 16 | 0.40 | 0.67 | — | 11 (0) |  |
| issue-2921 | 1 | ✔ | 1 | 0.0100 | 86 | 16 | 1.00 | 1.00 | — | 12 (0) |  |
| observe-bundle | 0 | ✔ | 1 | 0.0087 | 72 | 16 | 0.54 | 0.70 | — | 23 (0) |  |
| observe-bundle | 1 | ✔ | 1 | 0.0099 | 75 | 15 | 0.38 | 1.00 | — | 20 (0) |  |

runs 4 · yield 1.00 · fabrications 0 · recall 0.58 · precision 0.84 · type 0.00 · $ median 0.0099 mean 0.0095 · s p50 75 p90 86 · retries 0 · bars yield:✔ fabrication:✔ recall:✖ cost:✔ latency:✔ → FAIL
