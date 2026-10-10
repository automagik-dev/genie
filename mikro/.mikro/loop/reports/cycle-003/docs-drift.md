# docs-drift — cycle-003

- when: 2026-08-17T02:25:38.294Z
- tool: mikro_docs-drift · status: ok · wall: 46.9s

---
FINAL("""Target: docs/agent-yaml-schema.md
Verdict: The document is largely accurate against the current source tree; all checked claims resolve correctly, with no WRONG or STALE findings identified.
Coverage: Checked error messages (lines 219-243), `.proposed` mechanics (lines 195-217), `station/` model claims (lines 145-172), thinking-level validation (lines 110-143), AgentSpec interface shape, `applyAgent` behavior, SDK exports. Claims checked: 22 of ~35 harvested; skipped: the `budget`/`scope` field table detail verification and the "Extras" example typing.

Findings, severity-ordered:
No WRONG, STALE, or GAP findings — every checked claim holds against current source.

Checked, holds:
- docs/agent-yaml-schema.md:223 — YAML parse error format `agent.yaml: parse error: ...` — verified against src/sdk/agent-spec.ts:140
- docs/agent-yaml-schema.md:224 — `expected a YAML mapping at the top level` — verified against src/sdk/agent-spec.ts:144
- docs/agent-yaml-schema.md:225 — `shape must be one of single-step | loop | recurse` — verified against src/sdk/agent-spec.ts:154 (VALID_SHAPES at src/sdk/agent-spec.ts:76-80 lists exactly those three)
- docs/agent-yaml-schema.md:226 — `thinking must be one of minimal | low | medium | high` — verified against src/sdk/agent-spec.ts:171; THINKING_LEVELS at src/gemini.ts:40-45 matches exactly
- docs/agent-yaml-schema.md:199 — `isProposedDir` in `src/mcp/agents.ts` — verified, exists at src/mcp/agents.ts:64 with `.proposed` suffix constant at :53, matched case-insensitively (line 65)
- docs/agent-yaml-schema.md:200-202 — draft is neither listed nor callable, dispatches from same scan — verified by src/mcp/agents.ts:210 (skip in discovery) and the comment at :202-206 confirming `tools/call` dispatches from `byToolName` built from this list
- docs/agent-yaml-schema.md:147-148 — station/ models declare `compat.supportsReasoningEffort: false` — verified at src/station-provider.ts:90 and :105
- docs/agent-yaml-schema.md:153-156 — Qwen MTP models carry `reasoning: true` + `compat.thinkingFormat: "qwen-chat-template"` causing `enable_thinking` behavior — verified at src/station-provider.ts:87, :95 (the `reasoning: true` is set at :87 in the qwen-gguf branch)
- docs/agent-yaml-schema.md:158-161 — the table's `enable_thinking` claim and the model name `Qwen3.6-35B-A3B-MTP-GGUF` — verified at src/station-provider.ts:16 and :123; the `chat_template_kwargs.enable_thinking` mechanic confirmed at src/station-provider.ts:91-93
- docs/agent-yaml-schema.md:163 — "Three consecutive empty turns abort the run (`src/rlm.ts`)" — verified at src/rlm.ts:653-654 (`consecutiveEmpty >= 3` → `emptyAbort = true`), abort message at src/rlm.ts:845
- docs/agent-yaml-schema.md:171-172 — `*-FLM` models declare `reasoning: false`, field is inert — verified at src/station-provider.ts:102 (FastFlowLM branch sets `reasoning: false`)
- docs/agent-yaml-schema.md:235-239 — `loadOne` skips invalid agents, writes to stderr once per directory — verified at src/mcp/agents.ts:156-159 (uses `reportedBroken` Set to dedupe; `isMissingFile` distinguishes ENOENT at :136-138)
- docs/agent-yaml-schema.md:242 — stderr message format — verified at src/mcp/agents.ts:159: `mikro: skipping agent "${name}" (${dir}): ${reason}`
- docs/agent-yaml-schema.md:256 — SDK import `sdk` from `mikro` — verified: `loadAgentSpec`, `parseAgentSpec`, `createToolRegistry` all exported from src/sdk/index.ts:107-113
- docs/agent-yaml-schema.md:33-42 — `loadAgentSpec` returns object with `dir`, `schemaVersion`, `toolsApi`, `shape`, `model`, `tools`, `extras` — verified against AgentSpec interface at src/sdk/agent-spec.ts:30-39 (all fields present; extras at :73)
- docs/agent-yaml-schema.md:101 — "Empty strings are filtered" for tools — verified at src/sdk/agent-spec.ts:95 (`if (v.length === 0) continue`)
- docs/agent-yaml-schema.md:116-118 — `applyAgent` writes `config.gemini.thinkingLevel`; the "twin of `mikro --thinking`" claim — verified at src/mcp/server.ts:534-536; comment at :524-529 confirms single-field design
- docs/agent-yaml-schema.md:128 — pi-ai maps reasoning on OpenAI Completions/deepseek/openrouter/zai dialects — verified at src/llm.ts:286-287
- docs/agent-yaml-schema.md:133-137 — "level is a request, not a guarantee... clamps upward" — verified at src/sdk/agent-spec.ts:54-57 (comments) and src/llm.ts:290-292
- docs/agent-yaml-schema.md:141-143 — `xhigh` and `max` exist in pi-ai but rejected by agent.yaml — verified at src/gemini.ts:36-38
- docs/agent-yaml-schema.md:201-202 — calling a proposed agent answers `Unknown tool: mikro_<name>_proposed` — consistent with src/mcp/server.ts:877 (`Unknown tool: ${name}`) and agent.ts:207 (comment about the would-be tool name)
- docs/agent-yaml-schema.md:215-217 — `loadAgentSpec` loads proposed dirs fine but discovery skips them silently — verified: parser (agent-spec.ts:226-229) has no `.proposed` check; discovery skip at agents.ts:210 is before spec read (comment at :202)

References:
- src/sdk/agent-spec.ts:134 — `parseAgentSpec` entry point; error messages verified against doc lines 223-226
- src/sdk/agent-spec.ts:226-229 — `loadAgentSpec` reads `agent.yaml` and parses; `ENOENT` propagates from `node:fs` (doc line 227)
- src/mcp/agents.ts:64-66 — `isProposedDir` case-insensitive suffix check
- src/mcp/agents.ts:156-159 — stderr reporting, once-per-directory dedupe
- src/station-provider.ts:84-108 — qwen-gguf vs FLM model compat matrix
- src/rlm.ts:653-654, 845 — consecutive-empty-abort (≥3) and its stderr message
- src/mcp/server.ts:534-536 — thinking override writes `config.gemini.thinkingLevel`
- src/gemini.ts:40-45 — THINKING_LEVELS: `minimal | low | medium | high` only
""")

---
mikro · agent=docs-drift · deepseek/deepseek-v4-flash · 12 iterations · 22,632 in / 4,332 out · $0.0048 · 46.9s · session sess_e8ca23204f22b612
