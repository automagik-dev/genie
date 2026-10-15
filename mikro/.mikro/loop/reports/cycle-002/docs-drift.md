# docs-drift — cycle-002

- when: 2026-08-17T02:14:14.178Z
- tool: mikro_docs-drift · status: ok · wall: 145.8s

---
Target: docs/TTL_CONTROL.md
Verdict: The document correctly describes the sessionId mechanism and cacheRetention pass-through, but makes claims about `cache.ttl` and `expire-time` affecting behavior that are not true — these fields are parsed but never wired through to the LLM call.
Coverage: Full 152-line document covered; ~20 claims checked against src/cache.ts, src/llm.ts, src/rlm.ts, src/config.ts, src/cli.ts, and template YAML.

Findings, severity-ordered:
1. [WRONG] docs/TTL_CONTROL.md:21 — Claims "Setting `cache.ttl: 1800` in your config will be rounded up to 3600s by Anthropic." The `ttl` field is parsed at src/config.ts:434-435 but never passed to pi/ai's completeSimple. Only `cacheRetention` and `sessionId` flow to the LLM call (src/llm.ts:270-274, src/llm.ts:111-115). `cache.ttl` is referenced only for verbose CLI display at src/cli.ts:564, 577, 604. The ttl value has no effect on the provider call.
   Suggest: Rewrite as: "The `ttl` field is parsed by config but not yet wired through to the provider call; only `retention` maps to Anthropic's cache_control behavior at this time."

2. [WRONG] docs/TTL_CONTROL.md:134 — The Cache Config Reference lists `ttl: 3600` as a functional option ("TTL in seconds — provider-specific"). It is parsed (src/config.ts:434-435) but not passed to the LLM call — only `cacheRetention` and `sessionId` are transmitted (src/llm.ts:270-274).
   Suggest: Annotate the field: `ttl: 3600  # Parsed but NOT yet wired through — informational only`

3. [WRONG] docs/TTL_CONTROL.md:135 — The Cache Config Reference lists `expire-time: "..."` as if functional ("ISO 8601 expiry — Google explicit caching"). It is parsed at src/config.ts:437-438 into `CacheConfig.expireTime` (src/config.ts:35), but `expireTime` is never included in the CacheLLMConfig that reaches pi/ai (src/llm.ts:111-115). No code path transmits this value.
   Suggest: Annotate: `expire-time: "..." # Parsed but NOT yet wired through — informational only`

4. [STALE] docs/TTL_CONTROL.md:76 — "Explicit caching requires the `onPayload` hook in pi/ai to inject `cachedContent` references. This is an optional stretch goal for v0.3 MVP." The onPayload hook does exist in src/llm.ts:297-331, but it is currently used for `normalizeOpenRouterDeveloperRole` (src/llm.ts:304-306) and Gemini via `buildGeminiOnPayload` (src/llm.ts:309-317). There is no `cachedContents` reference injection anywhere in src/. The sentence describes an aspirational goal, not a requirement already in place — the onPayload mechanism exists but the cachedContents injection does not.
   Suggest: Rewrite as: "Explicit caching via `cachedContents` is a planned feature; mikro's existing `onPayload` infrastructure could support it, but no `cachedContents` injection is implemented."

5. [GAP] docs/TTL_CONTROL.md:128-136 — The Configuration Reference does not indicate that `ttl` and `expire-time` are parsed but inert. A user setting these fields would believe they affect behavior when they do not.
   Suggest: Add a note: "Note: `ttl` and `expire-time` are parsed by mikro but not currently passed through to pi/ai. Only `retention` and `sessionId` are transmitted."

Checked, holds:
- docs/TTL_CONTROL.md:3 — "mikro passes cacheRetention and sessionId to pi/ai's completeSimple" — verified src/llm.ts:270-274, src/rlm.ts:361-369
- docs/TTL_CONTROL.md:23 — "Cache hits return tokens in usage.cacheRead; initial caching reports tokens in usage.cacheWrite" — verified src/llm.ts:345-346
- docs/TTL_CONTROL.md:44 — "Cache read/write token counts in usage.cacheRead / usage.cacheWrite" — verified src/llm.ts:345-346
- docs/TTL_CONTROL.md:130 — "default: false" for enabled — verified src/config.ts:133 (DEFAULT_CACHE_CONFIG) and src/config.ts:427
- docs/TTL_CONTROL.md:131 — "only 'full' supported (default: full)" for strategy — verified src/config.ts:31, 135, 420-424
- docs/TTL_CONTROL.md:132 — "default: long" for retention — verified src/config.ts:414
- docs/TTL_CONTROL.md:142-143 — "sessionId = {session-prefix}-{sha256(context-content)[0:12]}" — verified src/cache.ts:74-92, src/cache.ts:98-103
- docs/TTL_CONTROL.md:146 — "Or just the hash if no prefix is set" — verified src/cache.ts:98-103
- docs/TTL_CONTROL.md:150 — "file paths are sorted before hashing" — verified src/cache.ts:80
- docs/TTL_CONTROL.md:152 — "sessionId is passed to pi/ai" — verified src/llm.ts:270-274

References:
- src/llm.ts:111-115 — CacheLLMConfig interface (enabled, retention, sessionId only — no ttl/expireTime)
- src/llm.ts:270-274 — cacheRetention + sessionId passed to completeSimple
- src/llm.ts:345-346 — cacheRead/cacheWrite read from response.usage
- src/cache.ts:74-92 — computeContentHash: SHA256 of sorted path+content, 12 hex chars
- src/cache.ts:98-103 — buildSessionId: prefix-hash or just hash
- src/config.ts:29-36 — CacheConfig interface with ttl and expireTime fields
- src/config.ts:434-435 — ttl parsed but unused outside logging
- src/config.ts:437-438 — expireTime parsed but unused outside logging
- src/cli.ts:564, 577, 604 — cache.ttl used only for verbose display
- src/rlm.ts:361-369 — cacheConfig constructed with enabled, retention, sessionId — NOT ttl/expireTime
- src/templates/default/mikro.yaml:71-73 — template documents ttl and expire-time as config options


---
mikro · agent=docs-drift · deepseek/deepseek-v4-flash · 7 iterations · 28,594 in / 22,535 out · $0.01 · 145.8s · session sess_3b330c01e06681b8
