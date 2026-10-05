# Wish: Explicit TTL cache control

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `feat-cache-ttl-control` |
| **Date** | 2026-03-27 |
| **Issue** | #6 |

## Summary

`cache.ttl` and `cache.expire-time` are already parsed from rlmx.yaml (config.ts:313-318) and displayed in `rlmx cache --estimate` (cli.ts:411), but they are never validated per provider or wired through to the LLM layer. This wish completes the TTL pipeline: validation, passthrough to CacheLLMConfig, injection into provider payloads via onPayload, and a `--ttl` CLI flag.

## Scope

### IN
- Validate `cache.ttl` per provider (Google: 60-86400s, Anthropic: informational only — provider manages TTL)
- Add `ttl` and `expireTime` fields to `CacheLLMConfig` interface
- Wire TTL from config through rlm.ts into CacheLLMConfig
- Pass TTL to pi/ai via the `onPayload` hook for Google (inject into `cachedContent` config)
- Add `--ttl <seconds>` CLI flag that overrides `cache.ttl` from rlmx.yaml
- Log effective TTL in verbose mode during cache warmup

### OUT
- Upstream pi/ai changes (we use onPayload to inject TTL)
- Per-provider TTL behavior for OpenAI (no caching API) or Bedrock (not yet supported)
- Automatic TTL renewal/extension

## Decisions

| Decision | Rationale |
|----------|-----------|
| Inject TTL via onPayload for Google | pi/ai doesn't have native TTL support; onPayload lets us modify the raw API payload |
| Informational-only for Anthropic | Anthropic uses ephemeral cache_control with automatic 5-min TTL, not user-configurable |
| CLI --ttl overrides yaml | Matches --cache, --ext pattern — CLI flags override config |

## Success Criteria

- [ ] `cache.ttl: 7200` in rlmx.yaml → TTL injected into Google API payload via onPayload
- [ ] `cache.ttl: 50` → validation error: "Google cache TTL must be 60-86400 seconds"
- [ ] `--ttl 3600` CLI flag works and overrides rlmx.yaml
- [ ] `rlmx cache --estimate` shows effective TTL
- [ ] Verbose mode logs TTL during cache init
- [ ] TypeScript compiles clean

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | TTL validation + CacheLLMConfig wiring + onPayload injection + CLI flag |

## Execution Groups

### Group 1: TTL pipeline

**Goal:** Complete the TTL passthrough from config → validation → LLM layer → provider API.

**Deliverables:**

1. **config.ts** — Add TTL validation after cache parsing (~line 318):
   ```typescript
   // Validate TTL range (provider-agnostic here; provider-specific in llm.ts)
   if (cache.ttl !== undefined) {
     if (typeof cache.ttl !== "number" || cache.ttl < 0) {
       throw new Error("cache.ttl must be a non-negative number (seconds).");
     }
   }
   if (cache.expireTime !== undefined && typeof cache.expireTime !== "string") {
     throw new Error("cache.expire-time must be an ISO 8601 datetime string.");
   }
   ```

2. **llm.ts** — Add `ttl` and `expireTime` to `CacheLLMConfig` (line 64-68):
   ```typescript
   export interface CacheLLMConfig {
     enabled: boolean;
     retention: "short" | "long";
     sessionId: string;
     ttl?: number;        // seconds
     expireTime?: string;  // ISO 8601
   }
   ```
   In `llmComplete` cache options building (line 162-167), pass TTL through to onPayload context.

3. **rlm.ts** — Wire TTL when building cacheConfig (~line 189):
   ```typescript
   cacheConfig = {
     enabled: true,
     retention: config.cache.retention,
     sessionId,
     ttl: config.cache.ttl,
     expireTime: config.cache.expireTime,
   };
   ```

4. **gemini.ts** — Extend `buildGeminiOnPayload` to accept optional cache TTL and inject it into the Google API payload:
   - Add `cacheTtl?: number` and `cacheExpireTime?: string` params
   - In the onPayload function, if TTL is set: `config.cachedContent = { ...config.cachedContent, ttl: ttl + "s" }` (Google uses Duration format like "3600s")
   - If expireTime is set: `config.cachedContent = { ...config.cachedContent, expireTime }`
   - Validate Google range: 60-86400 seconds (log warning if outside)

5. **llm.ts** — Pass cache TTL to `buildGeminiOnPayload` when cache is enabled (line 182-191):
   ```typescript
   if (isGoogleProvider(modelConfig.provider)) {
     const onPayload = buildGeminiOnPayload(
       options.geminiConfig ?? DEFAULT_GEMINI_CONFIG,
       modelConfig.provider,
       options?.outputSchema,
       options?.cacheConfig  // pass cache config for TTL injection
     );
     ...
   }
   ```

6. **cli.ts** — Add `--ttl` flag:
   - Parse: `ttl: { type: "string" }` in parseArgs options
   - In CliOptions: `ttl: number | null`
   - In runQuery/runCache: `if (opts.ttl !== null) config.cache.ttl = opts.ttl;`

7. **cli.ts runCache** — Log effective TTL in verbose warmup output (already displays ttl at line 411, verify it uses the wired value).

**Acceptance Criteria:**
- [ ] CacheLLMConfig has ttl and expireTime fields
- [ ] TTL flows from config.ts → rlm.ts → llm.ts → gemini.ts onPayload
- [ ] Google payloads include cachedContent.ttl when set
- [ ] Invalid TTL values produce clear config errors
- [ ] --ttl CLI flag overrides yaml
- [ ] TypeScript compiles clean

**Validation:**
```bash
npx tsc --noEmit && echo "types ok"
```

**depends-on:** none

---

## Files to Create/Modify

```
src/config.ts    — TTL validation
src/llm.ts       — CacheLLMConfig interface + pass TTL to onPayload
src/rlm.ts       — wire TTL into cacheConfig
src/gemini.ts    — inject TTL into Google API payload via onPayload
src/cli.ts       — --ttl flag + override
```
