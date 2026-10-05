# TTL Control — Provider-Specific Cache Behavior

mikro passes `cacheRetention` and `sessionId` to pi/ai's `completeSimple`, which maps them to each provider's native caching mechanism. This document describes the TTL (time-to-live) semantics for each supported provider.

## Overview

| Provider | Cache Mechanism | TTL Support | Default Retention |
|----------|----------------|-------------|-------------------|
| Anthropic | `cache_control` header | Yes — rounds to 300s or 3600s | long = 3600s |
| OpenAI | `prompt_cache_key` (sessionId) | No explicit TTL | Automatic (server-managed) |
| Google | Implicit caching (default) / `cachedContents` (explicit) | Explicit: 1h–24h ISO 8601 | Implicit: API defaults |
| Bedrock | `cachePoint` per model | Model-dependent | Varies by model |

## Anthropic

Anthropic supports explicit cache control via the `cache_control` header on message blocks. pi/ai maps `cacheRetention` to Anthropic's cache TTL:

- **`short`** (retention) → TTL rounds to **300 seconds** (5 minutes)
- **`long`** (retention) → TTL rounds to **3600 seconds** (1 hour)

Anthropic rounds all TTL values to the nearest supported increment (300s or 3600s). Note: the `cache.ttl` field is parsed by config but **not yet wired through to the provider call** — only `retention` (as `cacheRetention`) and `sessionId` reach pi/ai (`src/llm.ts`); `ttl` is used only by the `mikro cache --estimate` display.

Cache hits return tokens in `usage.cacheRead`; initial caching reports tokens in `usage.cacheWrite`.

### Example config

```yaml
# mikro.yaml — Anthropic with long cache retention
model:
  provider: anthropic
  model: claude-sonnet-4-5
cache:
  enabled: true
  retention: long        # maps to 3600s TTL
  session-prefix: my-project
```

## OpenAI

OpenAI uses a `prompt_cache_key` derived from the `sessionId` for stable cache routing. There is **no explicit TTL support** — OpenAI manages cache eviction internally.

- The `sessionId` ensures repeated requests with the same context hit the same cache slot.
- `cacheRetention` is passed but treated as informational only by the OpenAI adapter.
- Cache read/write token counts are reported in `usage.cacheRead` / `usage.cacheWrite` when available.

### Example config

```yaml
# mikro.yaml — OpenAI with cache routing
model:
  provider: openai
  model: gpt-4o
cache:
  enabled: true
  retention: long        # informational only for OpenAI
  session-prefix: qa-bot
```

## Google (Gemini)

Google supports two caching modes:

### Implicit Caching (Default)

When `cache.enabled: true`, repeated prefixes are cached automatically by the Gemini API. No special configuration is needed. This is the recommended approach for most use cases.

### Explicit Caching (cachedContents API)

For fine-grained control, Google's `cachedContents` API allows creating named cache resources with explicit expiry times:

- **Minimum TTL:** 1 hour (3600 seconds)
- **Maximum TTL:** 24 hours (86400 seconds)
- **Format:** ISO 8601 duration or timestamp (e.g., `"2026-03-27T12:00:00Z"`)
- Values outside the 1h–24h range will be rejected by Google's API.

Explicit caching requires the `onPayload` hook in pi/ai to inject `cachedContent` references. The hook exists and is used for other Gemini features (`src/llm.ts`), but `cachedContent` injection is not yet implemented — a future enhancement.

### Example config

```yaml
# mikro.yaml — Google implicit caching (recommended)
model:
  provider: google
  model: gemini-2.0-flash
cache:
  enabled: true
  retention: long
  session-prefix: paper-review

# mikro.yaml — Google explicit caching with expiry
model:
  provider: google
  model: gemini-2.0-flash
cache:
  enabled: true
  retention: long
  expire-time: "2026-03-27T12:00:00Z"  # ISO 8601 expiry
  session-prefix: paper-review
```

## Bedrock (AWS)

Bedrock supports caching via `cachePoint` configuration, but support varies by model:

- **Supported models:** Claude models on Bedrock support `cachePoint` with optional TTL.
- **TTL format:** Seconds, passed via the `cachePoint` configuration object.
- **Behavior:** When a model does not support `cachePoint`, the parameter is silently ignored.

pi/ai maps `cacheRetention` to the appropriate `cachePoint` TTL when the underlying model supports it.

### Example config

```yaml
# mikro.yaml — Bedrock with cache
model:
  provider: bedrock
  model: anthropic.claude-sonnet-4-5-v2
cache:
  enabled: true
  retention: long
  session-prefix: codebase-qa
```

## Cache Config Reference

Full `cache` block options in `mikro.yaml`:

```yaml
cache:
  enabled: true              # Enable/disable caching (default: false)
  strategy: full             # Cache strategy — only "full" supported (default: full)
  retention: long            # "short" or "long" (default: long)
  session-prefix: my-project # Optional prefix for sessionId (default: none)
  ttl: 3600                  # Parsed but NOT yet wired to provider calls — only the cache --estimate display reads it
  expire-time: "..."         # Parsed but NOT yet wired to provider calls (Google explicit caching is unimplemented)
```

## How sessionId Works

The `sessionId` is computed as:

```
{session-prefix}-{sha256(context-content)[0:12]}
```

Or just the hash if no prefix is set. This ensures:

1. **Same context** produces the **same sessionId** across runs
2. **Different contexts** produce **different sessionIds** (no cache collisions)
3. **Deterministic ordering** — file paths are sorted before hashing

The sessionId is passed to pi/ai, which routes it to the provider's native cache key mechanism (Anthropic's cache_control, OpenAI's prompt_cache_key, etc.).
