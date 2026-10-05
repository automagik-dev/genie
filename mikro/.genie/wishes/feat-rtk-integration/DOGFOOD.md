# DOGFOOD — RTK integration verification

**Date:** 2026-04-21
**Wish:** feat-rtk-integration (Group 4)
**Host:** `rtk 0.37.2` on Linux 6.8
**Workflow driver:** `scripts/dogfood-rtk.mjs` (boots the real Python REPL with `rtkEnabled: true` and calls `run_cli` for a canonical developer workflow)

## Procedure

1. Capture `rtk gain --format json` BEFORE.
2. Run `node scripts/dogfood-rtk.mjs` — the script spawns the same REPL surface used by `rlmLoop`, loads batteries, and invokes `run_cli(...)` for:
   - `ps aux`
   - `ls -la /home/genie`
   - `git log -n 10`
   - `env`
3. Capture `rtk gain --format json` AFTER.
4. Verify each `run_cli` return shape includes `rtk_prefixed: True` (RTK routing actually happened, not a silent fall-through).
5. Compute the delta and extract per-command savings from `rtk gain --history`.

## `run_cli` return shapes (all four routed through RTK)

```json
{
  "calls": [
    { "cmd": "ps aux",            "rc": 0, "stdout_len": 3057, "prefixed": true },
    { "cmd": "ls -la /home/genie","rc": 0, "stdout_len": 380,  "prefixed": true },
    { "cmd": "git log -n 10",     "rc": 0, "stdout_len": 1799, "prefixed": true },
    { "cmd": "env",               "rc": 0, "stdout_len": 1027, "prefixed": true }
  ]
}
```

Every call reports `prefixed: true` — the REPL environment resolved `_RLMX_RTK_MODE=on`, `run_cli` auto-prefixed `rtk`, the stub-free real `rtk` binary filtered the output, and the return dict surfaces the routing flag for the LLM to reason about.

## BEFORE (`rtk gain --format json`)

```json
{
  "summary": {
    "total_commands": 2221,
    "total_input": 5394909,
    "total_output": 934995,
    "total_saved": 4462251,
    "avg_savings_pct": 82.71225705567971,
    "total_time_ms": 5057363,
    "avg_time_ms": 2277
  }
}
```

## AFTER (`rtk gain --format json`)

```json
{
  "summary": {
    "total_commands": 2229,
    "total_input": 5405630,
    "total_output": 936523,
    "total_saved": 4471444,
    "avg_savings_pct": 82.71827705558835,
    "total_time_ms": 5057469,
    "avg_time_ms": 2268
  }
}
```

## Delta (just the dogfood workflow)

| Metric                  | BEFORE      | AFTER       | Δ (this workflow) |
|-------------------------|-------------|-------------|-------------------|
| `total_commands`        | 2,221       | 2,229       | +8                |
| `total_input` (tokens)  | 5,394,909   | 5,405,630   | +10,721           |
| `total_output` (tokens) | 934,995     | 936,523     | +1,528            |
| `total_saved` (tokens)  | 4,462,251   | 4,471,444   | +9,193            |

**Tokens saved: 9193 (85%)**

_9,193 / 10,721 raw input tokens — RTK delivered only 1,528 tokens (14.3%) to the consumer. Target was >50%; actual is 85%._

## Per-command detail (`rtk gain --history`)

```
Recent Commands
──────────────────────────────────────────────────────────
04-21 21:45 ▲ rtk env                   -100% (1.1K)
04-21 21:45 • rtk git log -n 10         -29%  (186)
04-21 21:45 ▲ rtk ls -la /home/genie    -80%  (372)
04-21 21:45 ▲ rtk:toml ps aux           -91%  (7.5K)
```

(`ps aux` is matched against RTK's TOML rule set → -91% / 7.5K tokens saved alone, which dominates the delta.)

## Conclusion

- `run_cli` in the real REPL produces the documented return-dict shape.
- RTK's own telemetry recorded every invocation (`rtk gain --history` above).
- Aggregate delta over the four-call canonical workflow: **9,193 tokens saved (85.7%)**, well above the >50% target.
- No fallback path hit — `prefixed: true` on all four calls.
