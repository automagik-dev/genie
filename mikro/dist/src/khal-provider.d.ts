/**
 * "khal" provider — every model behind the khal LiteLLM gateway
 * (OpenAI-compatible) as a first-class pi-ai provider.
 *
 * Registered at BOTH model-resolution sites (src/llm.ts and
 * src/sdk/rlm-driver.ts) via {@link registerKhalProvider} so `khal/<model>`
 * resolves identically on the CLI and SDK paths — the same seam the station
 * provider uses.
 *
 * Two gateway facts drive the shape of this module:
 *
 *   1. **Prices are per token, pi-ai's `Model.cost` is per million.** LiteLLM's
 *      `/model/info` reports `input_cost_per_token: 1e-7`; pi-ai divides
 *      `model.cost.*` by 1e6 at usage time (`pi-ai/dist/models.js`
 *      `calculateCost`). Without the ×1e6 in {@link perMillionDollars} every
 *      khal run reports $0.0000. Pinned by `tests/khal-provider.test.ts`.
 *
 *   2. **The gateway's aliases carry a redundant `khal/` prefix.** The live
 *      registry advertises `khal/deepseek-v4-flash`, and the request body must
 *      use that exact string — a bare `deepseek-v4-flash` is a 400. But mikro
 *      already namespaces by provider, so the ref users write is
 *      `khal/deepseek-v4-flash`, which every mikro resolution path reduces to
 *      the bare `deepseek-v4-flash` (`splitModel` in src/mcp/agents.ts, then
 *      `normalizeProviderModelId` in src/llm.ts). The catalog therefore holds
 *      the bare id and {@link khalStreams} restores the wire alias on the way
 *      out — see that function for why this cannot live in the model id.
 */
import type { Model, MutableModels, Provider } from "@earendil-works/pi-ai";
/** Provider id used everywhere: `khal/<model>`. */
export declare const KHAL_PROVIDER_ID = "khal";
/**
 * Base URL of the khal LiteLLM gateway. Real endpoints are `/v1/models`,
 * `/v1/model/info` and `/v1/chat/completions`, so the base URL ends in `/v1`.
 * Override with `KHAL_BASE_URL` for a different deployment.
 */
export declare const KHAL_BASE_URL: string;
/**
 * The exact message a keyless `khal/<model>` run fails with. Thrown from
 * {@link ensureKhalModels} — i.e. *before* model lookup — so the failure names
 * the missing credential instead of surfacing as a misleading "unknown model"
 * from an empty catalog.
 */
export declare const KHAL_MISSING_KEY_ERROR = "khal provider requires KHAL_API_KEY";
/**
 * Prefix of the message a run fails with when the gateway *has* a key and
 * rejects it (401/403). A rejected key is not an outage — the fallback
 * endpoint answers the same 401 — so it must not degrade into an empty
 * catalog, which resolves three layers later as "unknown model".
 */
export declare const KHAL_REJECTED_KEY_ERROR = "khal gateway rejected";
/**
 * Prefix of the message a run fails with when the key is accepted but no
 * catalog could be loaded from either endpoint and nothing was registered
 * earlier. Same reason as above: an empty catalog must never reach
 * `resolveModel`.
 */
export declare const KHAL_EMPTY_CATALOG_ERROR = "khal catalog unavailable";
/** Env vars carrying the gateway key, in precedence order. Key is env-only. */
export declare const KHAL_API_KEY_ENV: readonly ["KHAL_API_KEY", "MIKRO_KHAL_API_KEY"];
type KhalKeyEnv = (typeof KHAL_API_KEY_ENV)[number];
/** Resolve the gateway key from the environment. Read lazily, never cached. */
export declare function khalApiKey(): string | undefined;
/**
 * Which env var actually supplied the key. Failure messages name *this* var
 * rather than the canonical one, so an operator running off the
 * `MIKRO_KHAL_API_KEY` fallback is not sent to edit the wrong variable.
 */
export declare function khalApiKeySource(): KhalKeyEnv | undefined;
type KhalModel = Model<"openai-completions">;
/**
 * LiteLLM prices in dollars **per token**; pi-ai's `Model.cost` is dollars
 * **per million tokens** (`calculateCost` divides by 1e6). Missing/invalid
 * fields degrade to 0 rather than poisoning the catalog with NaN.
 *
 * The rounding is not cosmetic: `1e-7 * 1e6` is `0.09999999999999999` in
 * IEEE-754, so without it the catalog would carry float noise instead of the
 * rate the gateway actually quoted.
 */
export declare function perMillionDollars(value: unknown): number;
/**
 * Parse a LiteLLM `/model/info` payload into a pi-ai catalog. Exported as the
 * fixture seam: the ×1e6 conversion is pinned here, not through the network.
 * Tolerant by construction — a payload whose shape drifted yields cost 0 and
 * default limits rather than throwing (the shape is LiteLLM-internal).
 */
export declare function parseModelInfo(payload: unknown): readonly KhalModel[];
/**
 * Parse a plain `/v1/models` payload. This endpoint carries no pricing, so
 * every model lands with cost 0 — the degraded catalog that keeps `khal/<id>`
 * resolvable when `/model/info` is unavailable.
 */
export declare function parseModelList(payload: unknown): readonly KhalModel[];
/**
 * Fetch the gateway catalog: priced from `/model/info`, degrading to the
 * cost-0 `/v1/models` list when *that endpoint* is down.
 *
 * Throws only when the gateway rejects the key — the one failure a fallback
 * cannot repair, and the one that must not reach `resolveModel` as an empty
 * catalog. Every other failure yields an empty catalog plus one honest stderr
 * line, leaving the caller whatever was registered before.
 */
export declare function fetchKhalModels(): Promise<readonly KhalModel[]>;
/**
 * Build the khal provider (pi-ai `createProvider`). The catalog is entirely
 * dynamic — there is no static baseline to go stale — so a bare
 * `khalProvider()` serves nothing until {@link ensureKhalModels} overlays it.
 */
export declare function khalProvider(catalog?: readonly KhalModel[]): Provider<"openai-completions">;
export declare function ensureKhalModels(models: MutableModels): Promise<void>;
/** Test seam: forget the memoized catalog and the one-shot stderr warning. */
export declare function resetKhalModelsCache(): void;
/**
 * Register the khal provider on a pi-ai `Models` runtime. Call once per
 * runtime, right after `builtinModels()`, at every resolution site.
 */
export declare function registerKhalProvider(models: MutableModels): void;
export {};
//# sourceMappingURL=khal-provider.d.ts.map