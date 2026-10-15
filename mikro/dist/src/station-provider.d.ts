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
import type { Model, MutableModels, Provider } from "@earendil-works/pi-ai";
/** Provider id used everywhere: `station/<model>`. */
export declare const STATION_PROVIDER_ID = "station";
/**
 * Base URL of the local Lemonade gateway. The real endpoints are
 * `/api/v1/models` and `/api/v1/chat/completions`. Override with
 * `STATION_BASE_URL` (or the legacy `LEMONADE_BASE_URL`) for a non-default
 * host/port.
 */
export declare const STATION_BASE_URL: string;
type StationModel = Model<"openai-completions">;
/**
 * Static baseline models. The NPU station default plus the two GGUF baselines the
 * wish requires. Dynamic discovery (see `fetchModels`) adds any further
 * chat-capable models the gateway advertises.
 */
export declare const STATION_BASELINE_MODELS: readonly StationModel[];
/** Build the station provider (pi-ai `createProvider`). */
export declare function stationProvider(catalog?: readonly StationModel[]): Provider<"openai-completions">;
export declare function ensureStationModels(models: MutableModels): Promise<void>;
/** Test seam: forget the memoized overlay. */
export declare function resetStationModelsCache(): void;
/**
 * Register the station provider on a pi-ai `Models` runtime. Call once per
 * runtime, right after `builtinModels()`, at every resolution site.
 */
export declare function registerStationProvider(models: MutableModels): void;
export {};
//# sourceMappingURL=station-provider.d.ts.map