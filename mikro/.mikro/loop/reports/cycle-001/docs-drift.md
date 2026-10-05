# docs-drift — cycle-001

- when: 2026-08-17T02:04:16.766Z
- tool: mikro_docs-drift · status: ok · wall: 112.3s

---
Target: docs/TTL_CONTROL.md
Verdict: The doc mostly describes what the config parses but not what actually reaches the LLM layer — `ttl` and `expire-time` are parsed yet never passed to pi/ai, and the "v0.3 MVP" framing is long past the current version.
Coverage: Read all 152 lines of the doc. Checked 19 claims against source (harvested ~24; the provider-behavior claims about pi/ai/Google/Bedrock internals are unverifiable without pi/ai source installed). Sections covered: Anthropic, OpenAI, Google, Bedrock, Cache Config Reference, sessionId. Sections skipped: none — all were examined.

Findings, severity-ordered:
1. [WRONG] docs/TTL_CONTROL.md:21 — "Setting `cache.ttl: 1800` in your config will be rounded up to 3600s by Anthropic." The `ttl` config is parsed at src/config.ts:434-436 but is NEVER passed to pi/ai — only `cacheRetention` and `sessionId` are forwarded in src/llm.ts:270-273. `cache.ttl` appears only in the `mikro cache --estimate` display (src/cli.ts:564).
   Suggest: Rewrite as "The `ttl` field is parsed but not yet wired through to the provider call; only `retention` maps to Anthropic's cache_control behavior."

2. [WRONG] docs/TTL_CONTROL.md:134-135 — The Cache Config Reference presents `ttl` and `expire-time` as active working options. Both are parsed (src/config.ts:434-438) but never reach the LLM layer — confirmed absent from `CacheLLMConfig` (src/llm.ts:111-115) and from rlm.ts's `cacheConfig` construction (src/rlm.ts:365-369).
   Suggest: Mark both as "parsed but not yet wired to provider calls" or remove from the config reference until implemented.

3. [STALE] docs/TTL_CONTROL.md:76 — "This is an optional stretch goal for v0.3 MVP." The current version is 0.260817.1 (package.json:3). Also, `onPayload` is already implemented in src/llm.ts:320-331 for Gemini features (media resolution, structured outputs, tools) — just not yet for `cachedContent` injection (src/gemini.ts:117-169 has no cache logic). The feature remains unimplemented, but referencing "v0.3" is inaccurate.
   Suggest: Replace with "Not yet implemented — a future enhancement."

4. [POLISH] docs/TTL_CONTROL.md:143 — The sessionId formula `{session-prefix}-{sha256(context-content)[0:12]}` is only accurate for single-string contexts. For list contexts (the common case), the hash also includes the file path and null separators (src/cache.ts:77-86). The doc's "context-content" is imprecise.
   Suggest: Change to `sha256(hash-of-context-content)` or describe the actual hash: "paths and content interleaved with null separators, sorted by path."

Checked, holds:
- docs/TTL_CONTROL.md:3 — cacheRetention/sessionId passed to completeSimple — verified src/llm.ts:270-273.
- docs/TTL_CONTROL.md:18-19 — short=300s, long=3600s — matches default fallback at src/cli.ts:564.
- docs/TTL_CONTROL.md:23 — usage.cacheRead/cacheWrite token counts — verified src/llm.ts:345-346.
- docs/TTL_CONTROL.md:43 — cacheRetention passed but informational for OpenAI — code passes it (src/llm.ts:272); pi/ai behavior unverifiable but plausible.
- docs/TTL_CONTROL.md:65 — implicit caching for Google is default when cache.enabled — no source contradicts; pi/ai behavior.
- docs/TTL_CONTROL.md:131 — strategy only "full" — verified src/config.ts:420-424.
- docs/TTL_CONTROL.md:132 — retention short/long default long — verified src/config.ts:136, 414.
- docs/TTL_CONTROL.md:133 — session-prefix — verified src/config.ts:431-432.
- docs/TTL_CONTROL.md:150 — "Deterministic ordering — file paths are sorted" — verified src/cache.ts:80.
- docs/TTL_CONTROL.md:152 — sessionId passed to pi/ai — verified src/llm.ts:273.

References:
- src/llm.ts:270-273 — cacheRetention + sessionId form the only cache options passed to pi/ai.
- src/llm.ts:345-346 — cacheRead/cacheWrite are read from pi/ai response.usage.
- src/config.ts:29-36 — CacheConfig interface includes ttl and expireTime.
- src/config.ts:434-438 — ttl and expire-time parsed but go nowhere.
- src/rlm.ts:365-369 — cacheConfig object contains only enabled/retention/sessionId.
- src/cache.ts:74-92 — computeContentHash includes paths + separators for list contexts, returns 12 hex chars.
- src/cache.ts:98-103 — buildSessionId joins prefix + hash.
- src/cli.ts:564 — the only consumer of cache.ttl is the estimate display.
- src/gemini.ts:117-169 — onPayload hook exists for tools/media/schema, no cachedContent injection.
- package.json:3 — current version 0.260817.1.


---
mikro · agent=docs-drift · deepseek/deepseek-v4-flash · 12 iterations · 41,776 in / 14,053 out · $0.01 · 112.3s · session sess_4e083b718ba836f0
