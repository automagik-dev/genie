# Mikro model and runtime selection — 2026-09-02

## Decision

- Keep `mikro` as the default backend.
- Keep `prime-sdk` available only as an experimental opt-in.
- Do not promote the Prime CLI backend for the required feature set.
- Use DeepSeek V4 Pro through the official direct DeepSeek API as the selected model circuit for future controlled experiments.
- Do not remove the legacy Mikro backend or `pi-ai` integration.

## Model benchmark

The frozen campaign completed 240 cells: four model/provider circuits over 60 deterministic cases each. Selection was quality-first.

| Rank | Circuit | Semantic | Reliable | Format | Median | p90 | Estimated cost | Cost / solve |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | DeepSeek V4 Pro / official direct | 51/60 | 60/60 | 60/60 | 12.286 s | 30.461 s | $0.165440 | $0.003244 |
| 2 | DeepSeek V4 Flash / official direct | 46/60 | 59/60 | 59/60 | 5.707 s | 18.111 s | $0.055205 | $0.001200 |
| 3 | GLM-5.3 Flash / OpenRouter→GMICloud FP8 | 25/60 | 51/60 | 51/60 | 16.849 s | 98.685 s | $0.015611 | $0.000624 |
| 4 | GLM-5.3 / OpenRouter→GMICloud FP8 | 23/60 | 57/60 | 57/60 | 5.645 s | 23.469 s | $0.184843 | $0.008037 |

DeepSeek V4 Pro won on semantic quality and reliability. This is a circuit ranking, not a provider-independent model leaderboard: GLM used a pinned OpenRouter/GMICloud route while DeepSeek used its official API.

## Runtime benchmark

The selected DeepSeek V4 Pro direct circuit was held fixed. Mikro and Prime SDK each ran three real context/output journeys three times. Prime CLI was statically ineligible because it rejects `output.schema`, dict context, and `budget.maxDepth`.

| Runtime | Solved | Format | Runtime errors | Median | p90 | Estimated cost | Cost / solve |
|---|---:|---:|---:|---:|---:|---:|---:|
| Mikro | 4/9 | 9/9 | 0 | 39.396 s | 123.564 s | $0.065204 | $0.016301 |
| Prime SDK | 1/9 | 8/9 | 0 | 6.630 s | 63.571 s | $0.027764 | $0.027764 |

Prime SDK was faster and cheaper per attempt, but failed the predeclared no-quality-loss gate and cost more per successful journey. No default switch is justified.

## Integration finding fixed during the run

A live Prime SDK run emitted a terminal `turn_end` after an iteration-cap abort, inflating the reported iteration count. The backend now ignores that post-abort terminal event, with a regression test reproducing the provider behavior.

## Billing and security

- Runtime observed DeepSeek balance spend: $0.080000.
- Runtime token-estimated spend: $0.092968.
- Billing remains `unsettled`; no zero-cost claim is made.
- Parallel model arms contaminated provider account deltas, so model costs are token-derived estimates.
- Raw model answers were not persisted.
- No API key was persisted in source or evidence.
- The temporary DeepSeek key was supplied only to ephemeral processes and should be rotated.

## Evidence

- Model decision: `.genie/evidence/prime-runtime-benchmark/model-benchmark-sdk-v2-model-decision.json`
- Runtime full: `.genie/evidence/prime-runtime-benchmark/runtime-benchmark-v2-full.json`
- Runtime decision: `.genie/evidence/prime-runtime-benchmark/runtime-benchmark-v2-decision.json`
