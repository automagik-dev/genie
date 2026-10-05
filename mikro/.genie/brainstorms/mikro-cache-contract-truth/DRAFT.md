# DRAFT — Cache contract truth

Date: 2026-08-31
Status: READY

WRS: ██████████ 100/100

- Problem ✅ — two accepted cache keys are inert.
- Scope ✅ — remove all live surfaces; preserve retention presets.
- Decisions ✅ — either old key hard-fails before provider work and prints the two valid alternatives `cache.retention: short` and `cache.retention: long`; no semantic auto-migration.
- Risks ✅ — `.mikro` and legacy `.rlmx` discovery, exact exit/stderr, zero provider calls, migration preservation, and preset regression have exact gates.
- Criteria ✅ — one 40-hex `EXPECTED_SHA` is frozen before the suite; all eight rejection/migration/provider journeys require fresh before+after remote `dev`, selected successful CI run, and installed `HEAD` equality to it. Exact detached-SHA install and installed CLI commands, complete YAML/context fixtures, an ESM `completeSimple` capture hook, deterministic `FINAL` response, and short/long JSONL assertions are prescribed; provider witnesses use the normal query path so warmup cannot swallow failures.

Simplest complete design: reject false keys and point users to the existing preset contract.

Next Step: independent review, then `wish` for this child only.
