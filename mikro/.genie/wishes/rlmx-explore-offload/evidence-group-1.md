# Group 1 evidence — khal provider

Live capture backing the Group 1 acceptance boxes and success criterion A3.
Host: this machine, `~/prod/rlmx` on `wish/rlmx-explore-offload`, 2026-07-26.
`KHAL_API_KEY` is env-only and never appears here or in any tracked file.

## Harness

`rlmx` has **no `-m`/`--model` flag** (absent from the parseArgs table,
`src/cli.ts:151-175`; `strict: false` swallows unknown flags, so
`rlmx -m khal/deepseek-v4-flash "…"` runs the *configured* model with
`khal/deepseek-v4-flash` as the query). The plain-text CLI also prints no cost
footer. So the model is selected by config and cost is read from `--stats`
(stderr JSON), `--output json`, or the MCP footer.

```bash
W=<tmp>; mkdir -p "$W/home/.rlmx" "$W/cwd"
printf '{"model.provider":"khal","model.model":"deepseek-v4-flash"}\n' > "$W/home/.rlmx/settings.json"
cd "$W/cwd"            # empty dir: auto-scaffolds, no repo rlmx.yaml in the way
```

`HOME` is redirected so the host's real `~/.rlmx/settings.json`
(`station/qwen3.5-2b-FLM`) does not override the khal selection — settings.json
beats `rlmx.yaml` (`applySettingsModelOverrides`, `src/cli.ts:38-53`).

## 1. Keyed run — nonzero, arithmetically correct cost (AC1)

```bash
HOME="$W/home" node ~/prod/rlmx/dist/src/cli.js --stats "What is 2+2? Answer with the number only."
```

```
4
{"iterations":2,"total_tokens":4725,"total_cost":0.0004808000000000001,"time_ms":6492,"tools_level":"core","batteries_used":[],"budget_hit":null,"model":"khal/deepseek-v4-flash","run_id":"79da8e76-d31f-46b1-a670-1497be8a4661","usage_split":{"root":{"input_tokens":4642,"output_tokens":83,"total_tokens":4725,"total_cost":0.0004808000000000001,"llm_calls":2},...}}
exit=0
```

The number is the point, not just its nonzero-ness — it is the ×1e6 conversion
observed end to end:

```
4642 in  × $0.10/Mtok = $0.00046420
  83 out × $0.20/Mtok = $0.00001660
                        ----------
                        $0.00048080   = reported total_cost
```

`$0.10`/`$0.20` per Mtok are exactly what `/model/info`'s `1e-7`/`2e-7` per
token become after `perMillionDollars` — the rate the fixture test pins.

A second run picked up DeepSeek prompt caching, exercising the third rate:

```
{"iterations":2,"total_tokens":2827,"total_cost":0.00034836000000000003,...,"model":"khal/deepseek-v4-flash","run_id":"5e7ce374-c8d2-4a52-9928-61450ec994c0","usage_split":{"root":{"input_tokens":2580,"output_tokens":247,...}}}
```

`2580 × 0.10/1e6 + 247 × 0.20/1e6 + 2048 × 0.02/1e6 = 0.00034836` — the residual
is exactly 2048 cache-read tokens at the converted `cache_read_input_token_cost`
(`2e-8`/token → `$0.02`/Mtok), which `--stats` does not itemise.

## 2. MCP footer (A3)

`rlmx_query` driven over stdio by the MCP SDK client, `model` override
`khal/deepseek-v4-flash`, server spawned with cwd `$W/cwd`:

```
42

---
rlmx · query · khal/deepseek-v4-flash · 1 iteration · 2,290 in / 33 out · $0.0002 · 2.0s
isError=false
```

`2290 × 0.10/1e6 + 33 × 0.20/1e6 = $0.0002356` → `$0.0002` at the footer's
4-decimal format (`formatCost`, `src/mcp/server.ts`).

## 3. No usable key fails fast, naming the credential (AC2, decision 2)

Missing key:

```
$ env -u KHAL_API_KEY -u RLMX_KHAL_API_KEY … rlmx --stats "What is 2+2?"
rlmx error: khal provider requires KHAL_API_KEY
exit=1
```

Key present but rejected — the case a verification pass found still surfacing as
`rlmx error: Unknown model "deepseek-v4-flash" for provider "khal"`, preceded by
a warning claiming models would resolve from `/v1/models`:

```
$ KHAL_API_KEY=sk-totally-invalid-key … rlmx --stats "What is 2+2?"
rlmx error: khal gateway rejected KHAL_API_KEY (HTTP 401) — the key is invalid, expired, or revoked; set a working key in KHAL_API_KEY (env-only)
exit=1
```

No `/model/info unavailable` line is printed: a rejected key is not an outage,
and the fallback endpoint is not tried (it answers the same 401). The message
names whichever env var supplied the key, so a run on the `RLMX_KHAL_API_KEY`
fallback is not sent to edit the wrong variable.

Both failures stay isolated over MCP — tool error, server alive:

```
rlmx rlmx_query failed: khal provider requires KHAL_API_KEY
isError=true
rlmx rlmx_query failed: khal gateway rejected KHAL_API_KEY (HTTP 401) — the key is invalid, expired, or revoked; set a working key in KHAL_API_KEY (env-only)
isError=true
```

## 4. Gates (AC3)

```
$ cd ~/prod/rlmx && npm run build && node --test dist/tests/khal-provider.test.js && node --test dist/tests/station-provider.test.js
--- khal-provider.test.js ---   # tests 37  # pass 37  # fail 0
--- station-provider.test.js ---# tests  9  # pass  9  # fail 0
$ npm run check                 # tsc --noEmit, clean
$ npm test                      # tests 472  # pass 472  # fail 0
```

Station is untouched: its own suite is green, and `tests/khal-provider.test.ts`
carries a case asserting the station baseline still resolves alongside a
registered khal provider.

## Caveat handed to Group 4 — reported khal cost is an upper bound

Aliases fronting several gateway deployments fold with `Math.max` on every price
field (`fold`, `src/khal-provider.ts`), deliberately, so reported cost never
depends on `/model/info` ordering and never under-reports against `--max-cost`.
The divergence is real on the live gateway (2026-07-26):

Enumerated live from `/model/info` (12 aliases; only two diverge):

| alias | input $/token per deployment | max/min |
|-------|------------------------------|---------|
| `khal/kimi-k2.6` | 7.5e-7, 9.5e-7, 1.2e-6 | **1.60×** |
| `khal/kimi-k2.7-code` | 7.4e-7, 9.5e-7, 9.5e-7 | **1.28×** |
| every other alias | uniform | 1.00× |

**The four tiers of the escalation ladder are all exact**, which corrects the
assumption that Group 4 inherits the skew: `khal/deepseek-v4-flash` is
1e-7 ×2, `khal/mimo-v2.5` is a single deployment at 4e-7, `khal/kimi-code`
(≠ `kimi-k2.7-code`) is 7.4e-7 ×3, `khal/claude-haiku` is a single deployment
at 1e-6. So the parity report's cost figures are exact as long as it runs the
ladder's aliases.

It stops being exact the moment a run uses `kimi-k2.6`/`kimi-k2.7-code`, or the
gateway adds a differently-priced deployment behind a ladder alias — neither is
visible in the reported number. So **`docs/parity-explore.md` should state that
khal costs are upper bounds** and re-check the table above for whatever aliases
it actually ran. The same note lives in the `fold` doc comment and the
CHANGELOG.
