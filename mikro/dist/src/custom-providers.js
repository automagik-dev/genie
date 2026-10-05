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
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
// ─── Types ───────────────────────────────────────────────
/** Wire protocols a config-declared provider can speak. */
export const CUSTOM_PROVIDER_APIS = [
    "openai-completions",
    "anthropic-messages",
    "openai-responses",
];
// ─── Defaults ────────────────────────────────────────────
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Read a key in either kebab-case or camelCase. */
function pick(raw, kebab) {
    if (kebab in raw)
        return raw[kebab];
    const camel = kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return raw[camel];
}
function fail(source, path, message) {
    throw new Error(`Invalid providers.${path} in ${source}: ${message}`);
}
function readString(raw, key, source, path) {
    const value = pick(raw, key);
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "string" || !value.trim()) {
        fail(source, `${path}.${key}`, "must be a non-empty string.");
    }
    return value.trim();
}
function readNumber(raw, key, source, path) {
    const value = pick(raw, key);
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        fail(source, `${path}.${key}`, `must be a non-negative number, got ${JSON.stringify(value)}.`);
    }
    return value;
}
function readHeaders(raw, source, path) {
    const value = pick(raw, "headers");
    if (value === undefined || value === null)
        return {};
    if (!isRecord(value))
        fail(source, `${path}.headers`, "must be a mapping of header name to value.");
    const out = {};
    for (const [name, v] of Object.entries(value)) {
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
            fail(source, `${path}.headers.${name}`, "must be a string.");
        }
        out[name] = String(v);
    }
    return out;
}
function readApiKeyEnv(raw, source, path) {
    const value = pick(raw, "api-key-env");
    if (value === undefined || value === null)
        return [];
    const list = Array.isArray(value) ? value : [value];
    const out = [];
    for (const entry of list) {
        if (typeof entry !== "string" || !entry.trim()) {
            fail(source, `${path}.api-key-env`, "must be an env var name or a list of them.");
        }
        out.push(entry.trim());
    }
    return out;
}
function parseModel(id, raw, source, path) {
    const inputRaw = pick(raw, "input");
    let input = ["text"];
    if (inputRaw !== undefined && inputRaw !== null) {
        if (!Array.isArray(inputRaw) || inputRaw.some((i) => i !== "text" && i !== "image")) {
            fail(source, `${path}.input`, `must be a list drawn from [text, image].`);
        }
        input = inputRaw.length ? inputRaw : ["text"];
    }
    const reasoningRaw = pick(raw, "reasoning");
    if (reasoningRaw !== undefined && reasoningRaw !== null && typeof reasoningRaw !== "boolean") {
        fail(source, `${path}.reasoning`, "must be true or false.");
    }
    const costRaw = pick(raw, "cost");
    let cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    if (costRaw !== undefined && costRaw !== null) {
        if (!isRecord(costRaw))
            fail(source, `${path}.cost`, "must be a mapping (input/output/cache-read/cache-write).");
        const costPath = `${path}.cost`;
        cost = {
            input: readNumber(costRaw, "input", source, costPath) ?? 0,
            output: readNumber(costRaw, "output", source, costPath) ?? 0,
            cacheRead: readNumber(costRaw, "cache-read", source, costPath) ?? 0,
            cacheWrite: readNumber(costRaw, "cache-write", source, costPath) ?? 0,
        };
    }
    const contextWindow = readNumber(raw, "context-window", source, path) ?? DEFAULT_CONTEXT_WINDOW;
    const maxTokens = readNumber(raw, "max-tokens", source, path) ?? DEFAULT_MAX_TOKENS;
    if (contextWindow <= 0)
        fail(source, `${path}.context-window`, "must be positive.");
    if (maxTokens <= 0)
        fail(source, `${path}.max-tokens`, "must be positive.");
    const model = {
        id,
        contextWindow,
        maxTokens,
        reasoning: reasoningRaw ?? false,
        input,
        cost,
    };
    const name = readString(raw, "name", source, path);
    if (name)
        model.name = name;
    const headers = readHeaders(raw, source, path);
    if (Object.keys(headers).length)
        model.headers = headers;
    return model;
}
function parseModels(raw, source, path) {
    const value = pick(raw, "models");
    if (value === undefined || value === null)
        return [];
    const out = [];
    const seen = new Set();
    const add = (id, entry, entryPath) => {
        if (!id.trim())
            fail(source, entryPath, "model id must be a non-empty string.");
        if (seen.has(id))
            fail(source, entryPath, `model "${id}" is declared twice.`);
        seen.add(id);
        const body = entry === null || entry === undefined ? {} : entry;
        if (!isRecord(body))
            fail(source, entryPath, "must be a mapping of model settings.");
        out.push(parseModel(id.trim(), body, source, entryPath));
    };
    if (Array.isArray(value)) {
        value.forEach((entry, i) => {
            const entryPath = `${path}.models[${i}]`;
            if (typeof entry === "string") {
                add(entry, {}, entryPath);
                return;
            }
            if (!isRecord(entry))
                fail(source, entryPath, "must be a model id or a mapping with an id.");
            const id = pick(entry, "id");
            if (typeof id !== "string")
                fail(source, `${entryPath}.id`, "is required.");
            add(id, entry, entryPath);
        });
        return out;
    }
    if (!isRecord(value))
        fail(source, `${path}.models`, "must be a mapping keyed by model id, or a list.");
    for (const [id, entry] of Object.entries(value)) {
        add(id, entry, `${path}.models.${id}`);
    }
    return out;
}
/**
 * Parse the `providers:` block of a config file. `source` names the file for
 * error messages ("mikro.yaml", "settings.json"). Returns an empty list for an
 * absent block.
 */
export function parseCustomProviders(raw, source) {
    if (raw === undefined || raw === null)
        return [];
    if (!isRecord(raw)) {
        throw new Error(`Invalid providers in ${source}: must be a mapping keyed by provider id.`);
    }
    const out = [];
    for (const [id, entry] of Object.entries(raw)) {
        if (!PROVIDER_ID_PATTERN.test(id)) {
            fail(source, id, `provider id must match ${PROVIDER_ID_PATTERN}.`);
        }
        if (!isRecord(entry))
            fail(source, id, "must be a mapping (base-url, api-key-env, models, ...).");
        const baseUrl = readString(entry, "base-url", source, id);
        if (!baseUrl)
            fail(source, `${id}.base-url`, "is required.");
        try {
            new URL(baseUrl);
        }
        catch {
            fail(source, `${id}.base-url`, `"${baseUrl}" is not a valid URL.`);
        }
        const apiRaw = readString(entry, "api", source, id) ?? "openai-completions";
        if (!CUSTOM_PROVIDER_APIS.includes(apiRaw)) {
            fail(source, `${id}.api`, `"${apiRaw}" is not supported. Must be one of: ${CUSTOM_PROVIDER_APIS.join(", ")}.`);
        }
        out.push({
            id,
            name: readString(entry, "name", source, id) ?? id,
            api: apiRaw,
            baseUrl: baseUrl.replace(/\/+$/, ""),
            apiKeyEnv: readApiKeyEnv(entry, source, id),
            headers: readHeaders(entry, source, id),
            models: parseModels(entry, source, id),
        });
    }
    return out;
}
/**
 * Merge provider lists by id; a later list overrides an earlier one entirely
 * for the same id (a project's mikro.yaml beats the global settings.json).
 */
export function mergeCustomProviders(...lists) {
    const byId = new Map();
    for (const list of lists) {
        for (const provider of list ?? [])
            byId.set(provider.id, provider);
    }
    return [...byId.values()];
}
// ─── pi-ai construction ──────────────────────────────────
function streamsFor(api) {
    switch (api) {
        case "openai-completions":
            return openAICompletionsApi();
        case "anthropic-messages":
            return anthropicMessagesApi();
        case "openai-responses":
            return openAIResponsesApi();
    }
}
/** Convert a declared model to the pi-ai `Model` shape. */
export function toPiModel(provider, model) {
    const headers = { ...provider.headers, ...model.headers };
    const built = {
        id: model.id,
        name: model.name ?? model.id,
        api: provider.api,
        provider: provider.id,
        baseUrl: provider.baseUrl,
        reasoning: model.reasoning,
        input: [...model.input],
        cost: { ...model.cost },
        contextWindow: model.contextWindow,
        maxTokens: Math.min(model.maxTokens, model.contextWindow),
    };
    if (Object.keys(headers).length)
        built.headers = headers;
    return built;
}
/** Build a pi-ai provider from its declaration. */
export function buildCustomProvider(config) {
    // Keyless (local servers): pi-ai still requires an auth object, and an
    // empty env list resolves as "unconfigured", so fall back to a var named
    // after the provider — setting it is harmless and documents intent.
    const envVars = config.apiKeyEnv.length
        ? config.apiKeyEnv
        : [`${config.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`];
    return createProvider({
        id: config.id,
        name: config.name,
        baseUrl: config.baseUrl,
        headers: config.headers,
        auth: { apiKey: envApiKeyAuth(`${config.id} API key`, envVars) },
        models: config.models.map((m) => toPiModel(config, m)),
        api: streamsFor(config.api),
    });
}
// ─── Registration ────────────────────────────────────────
/** Per-runtime record of what was registered, keyed by provider id → signature. */
const applied = new WeakMap();
function signature(config) {
    return JSON.stringify(config);
}
/**
 * Register every declared provider on `models`, replacing one whose
 * declaration changed since the last call. Cheap and idempotent — safe to
 * call before every resolution. Returns the ids (re)registered this time.
 */
export function ensureCustomProviders(models, providers) {
    if (!providers || providers.length === 0)
        return [];
    let seen = applied.get(models);
    if (!seen) {
        seen = new Map();
        applied.set(models, seen);
    }
    const changed = [];
    for (const provider of providers) {
        const sig = signature(provider);
        if (seen.get(provider.id) === sig)
            continue;
        models.setProvider(buildCustomProvider(provider));
        seen.set(provider.id, sig);
        changed.push(provider.id);
    }
    return changed;
}
// ─── Introspection ───────────────────────────────────────
/** Find a declared provider by id. */
export function findCustomProvider(providers, id) {
    return providers?.find((p) => p.id === id);
}
/** Which of a provider's key env vars is set, if any. */
export function customProviderKeySource(config) {
    return config.apiKeyEnv.find((name) => Boolean(process.env[name]?.trim()));
}
/**
 * Human hint for an unresolvable `<provider>/<model>` — used by the
 * `Unknown model` error so the operator is pointed at config, not at a file
 * that does not exist.
 */
export function describeProviderHint(providers, provider, 
/** True when the runtime knows the provider (built-in or registered). */
providerKnown = false) {
    const declared = findCustomProvider(providers, provider);
    if (declared) {
        const ids = declared.models.map((m) => m.id);
        return ids.length
            ? `Provider "${provider}" is declared in config with models: ${ids.join(", ")}. Add the model under providers.${provider}.models.`
            : `Provider "${provider}" is declared in config but lists no models. Add it under providers.${provider}.models.`;
    }
    if (providerKnown) {
        return (`Provider "${provider}" is known but does not list that model. ` +
            `Check the model id against the provider's catalog, or declare it under providers.${provider}.models in config.`);
    }
    return (`Provider "${provider}" is not a built-in pi-ai provider and is not declared in config. ` +
        `Declare it under providers: in .mikro/mikro.yaml or ~/.mikro/settings.json, or run \`mikro doctor\`.`);
}
//# sourceMappingURL=custom-providers.js.map