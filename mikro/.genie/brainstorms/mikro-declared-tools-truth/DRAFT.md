# Draft: declared tools truth (M1 + M2)

| Field | Value |
|-------|-------|
| **Slug** | `mikro-declared-tools-truth` |
| **Date** | 2026-09-03 |
| **WRS** | 100/100 |
| **Parent** | `mikro-brain-consumer-handoff` (decomposition record) |
| **Crystallized** | `DESIGN.md` (this directory) |

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```

Decisions closed 2026-09-03: D4 confirmed — `tests/sdk-rlm-driver-tools.test.ts:105` pins the silent fallback and is rewritten to pin the throw. Full rationale lives in DESIGN.md.

Review round 1 (2026-09-03): checklist SHIP with MEDIUM/LOW gaps; architecture and dx-docs lenses found statements false at HEAD. DESIGN.md amended before stamping: bridge never rejects `execute`, plugin timeout below REPL timeout, at-least-once on recovery, `ToolResolver` seam, single `unavailable` field, reserved set includes `context` and battery names, TOOLS.md collision rule, `expose`-aware driver check, `docs/tool-authoring.md` extended not created, full doc-drift list. Re-review required on the new digest.

## Problem

A microagent that declares `tools:` in `agent.yaml` runs tool-less on the
default `mikro mcp` backend with no warning, and even on the SDK path its
file-loaded tools carry no schema, so `rlmDriver` silently degrades to
one-shot — the agent fabricates instead of calling what it declared.

## Scope

### IN
- Default backend (`LegacyMikroBackend`) loads `tools/*.{mjs,js,py}` declared in `agent.yaml` and exposes them to the REPL loop.
- A declared tool that resolves to no plugin file makes the agent `UNAVAILABLE — missing tools: …` in `tools/list` and refuses `tools/call`, exactly like `modelProblem` today.
- `tools/list` description states the backend and the tool set a call will actually get.
- A schema channel for file-loaded tools: sidecar `tools/<name>.schema.json` attached by both loaders.
- `rlmDriver` raises an explicit error when `tools` is configured but the registry exposes zero schemas (no silent one-shot fallback).

### OUT
- Host-shipped agent roots, registration API, origin namespace (M3 → `mikro-host-agent-roots`).
- Native function-calling in the legacy engine; the REPL stays the dispatch surface.
- Changing `prime`/`prime-sdk` backend behaviour beyond reusing the same schema channel.
- Positional-argument Python stubs, streaming tool output, tool sandboxing.
- RTK schema (RTK's args are already documented in code; it can adopt the same `ToolSchema` in a one-liner but is not required here).

## Decisions (pending Simplicity Gate confirmation)

- D1 REPL tool bridge, not a driver switch.
- D2 Sidecar JSON schema, single channel.
- D3 Unresolved tools fail at discovery, mirroring `modelProblem`.
- D4 `rlmDriver` throws at construction when tools configured but none schema'd. (Confirm no test pins the silent fallback.)

## Risks
- REPL protocol change (`tool_request`/`tool_response`) touches `python/repl_server.py` and `src/repl.ts`; Gemini code-execution path never sees bridged tools.
- Python plugin handlers spawn subprocesses per call; inside a REPL turn the 30 s REPL timeout wraps them.
- Breaking change for SDK consumers relying on schema-less `tools` config falling back to one-shot.

## Criteria
- Repro from handoff M1 (`_ask-maestro` via `mikro mcp`) calls at least one declared tool.
- Agent with a declared-but-missing tool is listed `UNAVAILABLE — missing tools: …` and `tools/call` refuses.
- Sidecar schema appears in `registry.describe(name)` for `.mjs` and `.py`.
- `rlmDriver({tools:{registry}})` with zero schemas throws a named error.
