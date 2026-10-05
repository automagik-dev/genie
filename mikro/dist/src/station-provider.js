/**
 * "station" provider — runs any agent against the local Lemonade gateway
 * (OpenAI-compatible) as a first-class pi-ai provider.
 *
 * Registered at BOTH model-resolution sites (src/llm.ts and
 * src/sdk/rlm-driver.ts) via {@link registerStationProvider} so `station/<id>`
 * resolves identically on the CLI and SDK paths — no copy-paste duplication.
 *
 * Gateway paths are `/api/v1/models` and `/api/v1/chat/completions`
 * (the base URL therefore ends in `/api/v1`, NOT `/v1`).
 *
 * Compat intel (live QA, 2026-07-20, this machine):
 *   - FastFlowLM / NPU models (recipe "flm") stream real `content` with a
 *     minimal entry — no thinking format needed.
 *   - llama.cpp GGUF Qwen MTP models emit `preserve_thinking` reasoning. In
 *     STREAMING mode the 35B (Qwen3.6-35B-A3B-MTP-GGUF) dumps everything into
 *     `reasoning_content` and never emits a `content` delta within a normal
 *     token budget, so it parses as EMPTY. Setting `reasoning: true` +
 *     `thinkingFormat: "qwen-chat-template"` makes pi-ai send
 *     `chat_template_kwargs.enable_thinking = false` (because no reasoning
 *     effort is requested by default), which forces the model to answer
 *     directly. Verified: all three baseline models return non-empty content.
 */
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
/** Provider id used everywhere: `station/<model>`. */
export const STATION_PROVIDER_ID = "station";
/**
 * Base URL of the local Lemonade gateway. The real endpoints are
 * `/api/v1/models` and `/api/v1/chat/completions`. Override with
 * `STATION_BASE_URL` (or the legacy `LEMONADE_BASE_URL`) for a non-default
 * host/port.
 */
export const STATION_BASE_URL = process.env.STATION_BASE_URL ??
    process.env.LEMONADE_BASE_URL ??
    "http://localhost:13305/api/v1";
/**
 * Keyless auth for a local server. pi-ai's `ProviderAuth` contract requires an
 * `apiKey` auth even for keyless local servers — its `resolve()` reports
 * whether the provider is configured. We always report configured with a
 * placeholder key (the gateway ignores Authorization on localhost).
 */
const keylessAuth = {
    name: "Lemonade (local, keyless)",
    resolve: async () => ({
        auth: { apiKey: "local" },
        source: "local keyless server",
    }),
};
function stationModel(id, name, engine, contextWindow) {
    const base = {
        id,
        name,
        api: "openai-completions",
        provider: STATION_PROVIDER_ID,
        baseUrl: STATION_BASE_URL,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 8192,
    };
    if (engine === "qwen-gguf") {
        return {
            ...base,
            reasoning: true,
            compat: {
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
                // Sends chat_template_kwargs.{enable_thinking,preserve_thinking};
                // enable_thinking stays false unless a reasoning effort is requested,
                // which forces direct content instead of an endless reasoning_content
                // stream (fixes the 35B "empty content" case).
                thinkingFormat: "qwen-chat-template",
            },
        };
    }
    // FastFlowLM / NPU: minimal, no thinking format.
    return {
        ...base,
        reasoning: false,
        compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
        },
    };
}
/**
 * Static baseline models. The NPU station default plus the two GGUF baselines the
 * wish requires. Dynamic discovery (see `fetchModels`) adds any further
 * chat-capable models the gateway advertises.
 */
export const STATION_BASELINE_MODELS = [
    stationModel("qwen3.6-moe-35b-a3b-FLM", "Qwen3.6 35B A3B (NPU / FastFlowLM)", "flm", 32768),
    stationModel("Qwen3.6-35B-A3B-MTP-GGUF", "Qwen3.6 35B A3B MTP (iGPU / llama.cpp)", "qwen-gguf", 32768),
    stationModel("Qwen3.5-4B-MTP-GGUF", "Qwen3.5 4B MTP (Vulkan / llama.cpp)", "qwen-gguf", 32768),
];
/** Model ids/recipes the gateway exposes but that are not chat completions. */
const NON_CHAT_LABELS = new Set([
    "embeddings",
    "reranking",
    "transcription",
    "realtime-transcription",
    "tts",
    "image",
    "edit",
]);
/**
 * Best-effort dynamic overlay: discover chat-capable models from the gateway's
 * `/models`. Never throws — resolution must not depend on network. Known
 * baseline ids re-emit their tuned compat (so the overlay never regresses the
 * 35B); unknown models are classified by recipe (`flm` → NPU-minimal, anything
 * else Qwen → `qwen-chat-template`).
 */
async function fetchStationModels() {
    try {
        // 5s abort: a gateway that accepts the connection but never responds must
        // not hang refreshModels() forever — fall back to the static baseline.
        const res = await fetch(`${STATION_BASE_URL}/models`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok)
            return STATION_BASELINE_MODELS;
        const body = (await res.json());
        const baselineIds = new Set(STATION_BASELINE_MODELS.map((m) => m.id));
        const discovered = [];
        for (const gm of body.data ?? []) {
            if (!gm.id || baselineIds.has(gm.id))
                continue;
            const labels = gm.labels ?? [];
            if (labels.some((l) => NON_CHAT_LABELS.has(l)))
                continue;
            const recipe = (gm.recipe ?? "").toLowerCase();
            // Only image/audio/embedding recipes are excluded; keep chat recipes.
            if (recipe.startsWith("sd-") ||
                recipe.startsWith("whisper") ||
                recipe.startsWith("kokoro") ||
                recipe.startsWith("collection")) {
                continue;
            }
            const isFlm = recipe === "flm";
            const isQwen = /qwen/i.test(gm.id) || /qwen/i.test(gm.checkpoint ?? "");
            // Failure mode: a future non-Qwen THINKING GGUF falls through to "flm"
            // here and would parse as EMPTY content (no thinking format applied) —
            // same bug class this provider fixes for the Qwen MTP baselines.
            const engine = isFlm ? "flm" : isQwen ? "qwen-gguf" : "flm";
            const ctx = gm.max_context_window
                ? Math.min(gm.max_context_window, 32768)
                : 32768;
            discovered.push(stationModel(gm.id, gm.id, engine, ctx));
        }
        return [...STATION_BASELINE_MODELS, ...discovered];
    }
    catch {
        return STATION_BASELINE_MODELS;
    }
}
/** Build the station provider (pi-ai `createProvider`). */
export function stationProvider(catalog = STATION_BASELINE_MODELS) {
    return createProvider({
        id: STATION_PROVIDER_ID,
        name: "Station (local Lemonade gateway)",
        baseUrl: STATION_BASE_URL,
        auth: { apiKey: keylessAuth },
        models: catalog,
        fetchModels: fetchStationModels,
        api: openAICompletionsApi(),
    });
}
/**
 * Apply the dynamic overlay so gateway-only model ids resolve.
 *
 * `fetchModels` is a pi-ai hook that only runs on `Models.refresh()`, and
 * nothing called it — so `getModel()` saw only STATION_BASELINE_MODELS and any
 * model the gateway serves under a custom id (e.g. `Brain-35B`) was reported
 * as unknown despite being live. `Models.refresh()` itself is not the fix: it
 * fans out to every dynamic provider, so resolving one local model would hit
 * the network for all of them.
 *
 * Instead fetch station's catalog directly and re-register the provider with
 * the merged list. Memoized on the in-flight promise so concurrent runs share
 * one fetch; cleared on failure so a later call can retry (the gateway may
 * simply have been down). Never throws — resolution must not depend on the
 * network, and the baseline still resolves offline.
 */
let stationOverlay = null;
export async function ensureStationModels(models) {
    if (!stationOverlay) {
        stationOverlay = (async () => {
            const catalog = await fetchStationModels();
            // fetchStationModels already falls back to the baseline and never
            // throws; only re-register when it actually found more.
            if (catalog.length > STATION_BASELINE_MODELS.length) {
                models.setProvider(stationProvider(catalog));
            }
        })().catch(() => {
            stationOverlay = null;
        });
    }
    await stationOverlay;
}
/** Test seam: forget the memoized overlay. */
export function resetStationModelsCache() {
    stationOverlay = null;
}
/**
 * Register the station provider on a pi-ai `Models` runtime. Call once per
 * runtime, right after `builtinModels()`, at every resolution site.
 */
export function registerStationProvider(models) {
    models.setProvider(stationProvider());
}
//# sourceMappingURL=station-provider.js.map