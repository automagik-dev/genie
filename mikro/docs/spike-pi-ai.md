# Spike: pi/ai Support for Gemini 3 Features

**Date:** 2026-03-26
**Scope:** Historical spike originally run against the previous pi-ai package scope at version `0.62.0`.
**Current package:** live MIKRO imports the maintained package `@earendil-works/pi-ai`.
**Verdict:** 3 features are NATIVE, 3 features require mikro-side implementation

---

## Package rename note

The pi-ai package moved from its deprecated previous npm scope to `@earendil-works/pi-ai`.
This document preserves the historical version-0.62.0 spike context and evidence paths without retaining the deprecated package scope string.
Live code and dependency manifests use `@earendil-works/pi-ai`.

---

## Summary

| Feature | Status | Evidence | Fallback |
|---------|--------|----------|----------|
| **1. Thinking Levels** | ✅ NATIVE | GoogleOptions.thinking config + GoogleThinkingLevel type | N/A |
| **2. Thought Signatures** | ✅ NATIVE | ThinkingContent.thinkingSignature + TextContent.textSignature fields | N/A |
| **3. onPayload Hook** | ✅ NATIVE | StreamOptions.onPayload in types.d.ts | N/A |
| **4. Media Resolution** | ❌ MIKRO-SIDE | No media_resolution field in GoogleOptions | Use onPayload to inject |
| **5. Structured Outputs** | ❌ MIKRO-SIDE | No response_json_schema field in GoogleOptions | Use onPayload to inject |
| **6. Built-in Tools** | ❌ MIKRO-SIDE | No google_search/url_context/code_execution in tool defs | Use REPL batteries + onPayload |

---

## Feature Details

### ✅ NATIVE: Thinking Levels (Features #1)

**Status:** Full support
**Code Location:** live package path `node_modules/@earendil-works/pi-ai/dist/providers/google.d.ts`.
**Historical note:** the original spike inspected the previous package scope at version `0.62.0`.

```typescript
export interface GoogleOptions extends StreamOptions {
    thinking?: {
        enabled: boolean;
        budgetTokens?: number;           // Gemini 2.x
        level?: GoogleThinkingLevel;     // Gemini 3
    };
}

// From google-gemini-cli.d.ts
export type GoogleThinkingLevel =
    "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
```

**How mikro uses it:**
- Map `--thinking minimal|low|medium|high` → GoogleOptions.thinking.level
- streamSimple() already handles thinking level selection (SimpleStreamOptions.reasoning)

**Fallback:** N/A — built-in to pi/ai

---

### ✅ NATIVE: Thought Signatures (Feature #2)

**Status:** Full support for circulation across RLM iterations
**Code Location:** live package path `node_modules/@earendil-works/pi-ai/dist/types.d.ts`.
**Historical note:** the original spike inspected the previous package scope at version `0.62.0`.

```typescript
// Line 79: TextContent
export interface TextContent {
    type: "text";
    text: string;
    textSignature?: string;  // ← circulates across turns
}

// Line 84: ThinkingContent
export interface ThinkingContent {
    type: "thinking";
    thinking: string;
    thinkingSignature?: string;  // ← preserves reasoning context
    redacted?: boolean;
}

// Line 100: ToolCall
export interface ToolCall {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, any>;
    thoughtSignature?: string;  // ← can appear on any part
}
```

**Implementation in pi/ai:** `google-shared.d.ts` lines 10-20 explain the protocol:
- `thought: true` marks thinking content
- `thoughtSignature` is an encrypted representation for multi-turn continuity
- Can appear on ANY part type (text, functionCall, etc.)
- Must be preserved as-is during persistence/replay

**Fallback:** Store signatures in mikro message history and replay manually if pi/ai drops them

---

### ✅ NATIVE: onPayload Hook (Feature #3)

**Status:** Full support for provider-specific params
**Code Location:** live package path `node_modules/@earendil-works/pi-ai/dist/types.d.ts`.
**Historical note:** the original spike inspected the previous package scope at version `0.62.0`.

```typescript
export interface StreamOptions {
    // ... other options ...
    onPayload?: (payload: unknown, model: Model<Api>)
        => unknown | undefined | Promise<unknown | undefined>;
}
```

**How mikro uses it:**
- Intercept payload before sending to API
- Inject Gemini-specific fields not exposed in GoogleOptions
- Return modified payload or undefined (leave unchanged)

**Example flow:**
```typescript
const options = {
    onPayload: (payload, model) => {
        if (model.api === "google-generative-ai") {
            // Inject media_resolution, response_json_schema, etc.
            payload.generationConfig.mediaResolution = "HIGH";
            payload.generationConfig.responseSchema = { ... };
        }
        return payload;
    }
};
```

**Fallback:** Direct @google/genai SDK calls for features onPayload can't reach

---

## ❌ MIKRO-SIDE: Media Resolution (Feature #4)

**Status:** No pi/ai support found
**Where to inject:** GoogleOptions via onPayload hook

**Gemini API Support:**
- `generationConfig.mediaResolution` in Gemini API
- Values: "LOW" (92 tokens/image), "MEDIUM" (256 tokens/image), "HIGH" (1120 tokens/image)

**mikro Implementation Path:**
1. Add `gemini.media-resolution.images: low|medium|high` to mikro.yaml
2. In RLM loop, use onPayload hook to inject:
   ```typescript
   payload.generationConfig.mediaResolution = config.gemini["media-resolution"].images;
   ```
3. Verify token usage in AssistantMessage.usage stats
4. Test: `--thinking medium --media-resolution high` should use ~1120 tokens per image

**Fallback:** If onPayload can't reach generationConfig, mikro must build full request manually via @google/genai

---

## ❌ MIKRO-SIDE: Structured Outputs (Feature #5)

**Status:** No pi/ai support found
**Where to inject:** GoogleOptions via onPayload hook

**Gemini API Support:**
- `generationConfig.responseSchema` in Gemini API
- Takes JSON Schema, enforces structure

**mikro Implementation Path:**
1. Add `output.schema` to mikro.yaml (already referenced in wish design)
2. In RLM loop, use onPayload hook to inject:
   ```typescript
   if (config.output.schema) {
       payload.generationConfig.responseSchema = config.output.schema;
   }
   ```
3. Verify: assertions that output matches schema
4. Fallback to text parsing (FINAL() detection) if schema rejected

**Fallback:** If onPayload can't reach generationConfig, implement schema validation post-hoc on response text

---

## ❌ MIKRO-SIDE: Built-in Tools (Feature #6)

**Status:** No built-in Gemini tools (web_search, url_context, code_execution) in pi/ai
**How to provide:** REPL batteries + onPayload hook

**Options:**

### Option A: REPL Batteries (Recommended)
- Implement web_search() as REPL function calling Gemini Search API
- Implement fetch_url() as HTTP library
- Implement code_execution as localhost Python REPL
- **Advantage:** Works on all providers, consistent with v0.3 design
- **Disadvantage:** Network round-trips instead of single API call

### Option B: Gemini Native Tools via onPayload (Advanced)
- Use onPayload to inject `tools` array with Google's function declarations
- Pass web_search, code_execution directly to Gemini
- **Advantage:** One API call, native performance
- **Disadvantage:** Gemini-only, requires manual function handling

### Recommended Approach:
- **Primary:** Use REPL batteries for portability
- **Optional:** Add onPayload support for Gemini-native tools as optimization
- **Fallback:** If tools API unavailable, graceful error with helpful message

**mikro Implementation Path:**
```typescript
// Group 7: REPL batteries (v0.3 already has this structure)
REPL.define("web_search", async (query: string) => {
    return await googleSearchAPI(query);
});

REPL.define("fetch_url", async (url: string) => {
    return await fetch(url).then(r => r.text());
});

// Group 8: Optional Gemini native tools via onPayload
const options = {
    onPayload: (payload) => {
        if (model.provider === "google" && config.gemini?.["native-tools"]) {
            payload.tools = [
                { functionDeclarations: [ googleWebSearchTool, ... ] }
            ];
        }
        return payload;
    }
};
```

---

## Implementation Sequence

### Phase 1: Verify (Group 0 — Complete)
- ✅ Thinking levels: pi/ai native
- ✅ Thought signatures: pi/ai native
- ✅ onPayload hook: pi/ai native
- ❌ Media resolution: needs mikro + onPayload
- ❌ Structured outputs: needs mikro + onPayload
- ❌ Built-in tools: needs REPL batteries or Gemini native via onPayload

### Phase 2: Native Features (Groups 1-3)
- Group 1: Thinking levels (use GoogleOptions.thinking)
- Group 2: Thought signatures (use TextContent.thinkingSignature, replay in context)
- Group 3: Context caching (already in v0.3, validate on Gemini 3)

### Phase 3: Provider Integration (Groups 4-5)
- Group 4: Media resolution + function calling via onPayload + REPL batteries
- Group 5: Structured outputs + code execution via onPayload + REPL

### Phase 4: Advanced (Groups 6-11)
- Groups 6-11: Remaining features, all using onPayload or REPL batteries

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| onPayload hook doesn't reach generationConfig | HIGH | Test early in Group 1 with sample payload inspection. Have @google/genai direct call as backup. |
| Thought signatures corrupted in multi-turn | MEDIUM | Validate signatures persist through message history. Implement retainThoughtSignature logic locally if needed. |
| Media resolution values don't match enum | MEDIUM | Reference Gemini API docs explicitly. Pin to specific enum values in mikro.yaml. |
| Structured output conflicts with FINAL() detection | MEDIUM | When schema enforced, skip FINAL() — schema IS the output contract. Document in config. |
| Built-in tools only work on Gemini, break multi-provider | MEDIUM | Graceful degradation: tools throw "X requires provider: google". Non-Google users fall back to standard behavior. |

---

## Evidence Files

- Historical worktree package files for the previous pi-ai package scope at version `0.62.0` — core message types and `onPayload` hook.
- Historical worktree package files for the previous pi-ai package scope at version `0.62.0` — Google provider options and streaming functions.
- Historical worktree package files for the previous pi-ai package scope at version `0.62.0` — Gemini CLI thinking-level types.
- Historical worktree package files for the previous pi-ai package scope at version `0.62.0` — thought-signature handling helpers.
- Live package path after migration: `node_modules/@earendil-works/pi-ai/`.

---

## Conclusion

**pi/ai is foundation-ready for v0.4 Gemini 3 integration.**

- 3/6 features already native (thinking, signatures, onPayload)
- 3/6 features require mikro-side impl (media, schema, tools) — all are onPayload hooks or REPL batteries
- No breaking changes needed in pi/ai
- Graceful degradation on non-Google providers is straightforward (test onPayload conditions)

**Next Step:** Execute Group 1 (thinking levels) as proof-of-concept of onPayload integration. If thinking levels work end-to-end, remaining 5 features follow the same pattern.
