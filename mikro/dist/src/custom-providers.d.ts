/**
 * Config-declared LLM providers.
 *
 * pi-ai ships a static registry of providers. Anything outside it — a
 * zero-data-retention gateway, a first-party endpoint pi-ai has not caught up
 * with, a self-hosted OpenAI-compatible server — used to be unreachable from
 * mikro: `resolveModel` consulted the registry, two hand-coded special cases,
 * and then threw `Unknown model`.
 *
 * This module closes that gap. A provider declared under `providers:` in
 * `.mikro/mikro.yaml` (or `"providers"` in `~/.mikro/settings.json`) becomes a
 * first-class pi-ai provider — `<id>/<model>` resolves like any built-in —
 * with the base URL, API flavour, key env var, extra headers and model
 * catalog the operator wrote down. Nothing is hard-coded per vendor.
 *
 * Shape (mikro.yaml — kebab-case; settings.json accepts the same keys or
 * camelCase):
 *
 * ```yaml
 * providers:
 *   wafer:
 *     api: openai-completions          # default; also anthropic-messages, openai-responses
 *     base-url: https://pass.wafer.ai/v1
 *     api-key-env: WAFER_API_KEY       # string or list, first set wins
 *     headers:
 *       Wafer-ZDR: required
 *     models:
 *       GLM-5.3-Flash:
 *         context-window: 128000
 *         max-tokens: 16000
 *         reasoning: true
 *         input: [text]
 *         cost: { input: 0, output: 0 }   # $ per million tokens
 * ```
 *
 * `models:` may also be a list of `{ id: ..., ... }` entries. Keys land in
 * `process.env` through the named variable(s) only — never inline in config.
 *
 * Both resolution sites (src/llm.ts and src/sdk/rlm-driver.ts) call
 * {@link ensureCustomProviders} right before model lookup, the same hook shape
 * the station/khal gateways use, so a declared provider is registered lazily
 * on whichever runtime is about to resolve it and re-registered only when its
 * declaration changes.
 */
import type { Api, Model, MutableModels, Provider } from "@earendil-works/pi-ai";
/** Wire protocols a config-declared provider can speak. */
export declare const CUSTOM_PROVIDER_APIS: readonly ["openai-completions", "anthropic-messages", "openai-responses"];
export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];
/** One model served by a config-declared provider. */
export interface CustomModelConfig {
    /** Model id as sent on the wire and written after `<provider>/`. */
    id: string;
    /** Display name; defaults to `id`. */
    name?: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    input: ("text" | "image")[];
    /** USD per million tokens. */
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    /** Optional per-model header overrides (merged over provider headers). */
    headers?: Record<string, string>;
}
/** A provider declared in mikro.yaml / settings.json. */
export interface CustomProviderConfig {
    id: string;
    name: string;
    api: CustomProviderApi;
    baseUrl: string;
    /** Env vars carrying the key, in precedence order. */
    apiKeyEnv: string[];
    headers: Record<string, string>;
    models: CustomModelConfig[];
}
/**
 * Parse the `providers:` block of a config file. `source` names the file for
 * error messages ("mikro.yaml", "settings.json"). Returns an empty list for an
 * absent block.
 */
export declare function parseCustomProviders(raw: unknown, source: string): CustomProviderConfig[];
/**
 * Merge provider lists by id; a later list overrides an earlier one entirely
 * for the same id (a project's mikro.yaml beats the global settings.json).
 */
export declare function mergeCustomProviders(...lists: readonly (readonly CustomProviderConfig[] | undefined)[]): CustomProviderConfig[];
/** Convert a declared model to the pi-ai `Model` shape. */
export declare function toPiModel(provider: CustomProviderConfig, model: CustomModelConfig): Model<Api>;
/** Build a pi-ai provider from its declaration. */
export declare function buildCustomProvider(config: CustomProviderConfig): Provider;
/**
 * Register every declared provider on `models`, replacing one whose
 * declaration changed since the last call. Cheap and idempotent — safe to
 * call before every resolution. Returns the ids (re)registered this time.
 */
export declare function ensureCustomProviders(models: MutableModels, providers: readonly CustomProviderConfig[] | undefined): string[];
/** Find a declared provider by id. */
export declare function findCustomProvider(providers: readonly CustomProviderConfig[] | undefined, id: string): CustomProviderConfig | undefined;
/** Which of a provider's key env vars is set, if any. */
export declare function customProviderKeySource(config: CustomProviderConfig): string | undefined;
/**
 * Human hint for an unresolvable `<provider>/<model>` — used by the
 * `Unknown model` error so the operator is pointed at config, not at a file
 * that does not exist.
 */
export declare function describeProviderHint(providers: readonly CustomProviderConfig[] | undefined, provider: string, 
/** True when the runtime knows the provider (built-in or registered). */
providerKnown?: boolean): string;
//# sourceMappingURL=custom-providers.d.ts.map