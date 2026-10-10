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

import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type {
  Api,
  Model,
  MutableModels,
  Provider,
  ProviderStreams,
} from "@earendil-works/pi-ai";

/** Provider id used everywhere: `khal/<model>`. */
export const KHAL_PROVIDER_ID = "khal";

/**
 * Base URL of the khal LiteLLM gateway. Real endpoints are `/v1/models`,
 * `/v1/model/info` and `/v1/chat/completions`, so the base URL ends in `/v1`.
 * Override with `KHAL_BASE_URL` for a different deployment.
 */
export const KHAL_BASE_URL = process.env.KHAL_BASE_URL ?? "https://llm.khal.ai/v1";

/**
 * The exact message a keyless `khal/<model>` run fails with. Thrown from
 * {@link ensureKhalModels} — i.e. *before* model lookup — so the failure names
 * the missing credential instead of surfacing as a misleading "unknown model"
 * from an empty catalog.
 */
export const KHAL_MISSING_KEY_ERROR = "khal provider requires KHAL_API_KEY";

/**
 * Prefix of the message a run fails with when the gateway *has* a key and
 * rejects it (401/403). A rejected key is not an outage — the fallback
 * endpoint answers the same 401 — so it must not degrade into an empty
 * catalog, which resolves three layers later as "unknown model".
 */
export const KHAL_REJECTED_KEY_ERROR = "khal gateway rejected";

/**
 * Prefix of the message a run fails with when the key is accepted but no
 * catalog could be loaded from either endpoint and nothing was registered
 * earlier. Same reason as above: an empty catalog must never reach
 * `resolveModel`.
 */
export const KHAL_EMPTY_CATALOG_ERROR = "khal catalog unavailable";

/** Env vars carrying the gateway key, in precedence order. Key is env-only. */
export const KHAL_API_KEY_ENV = ["KHAL_API_KEY", "MIKRO_KHAL_API_KEY"] as const;

type KhalKeyEnv = (typeof KHAL_API_KEY_ENV)[number];

function khalCredential(): { name: KhalKeyEnv; value: string } | undefined {
  for (const name of KHAL_API_KEY_ENV) {
    const value = process.env[name];
    if (value && value.trim()) return { name, value: value.trim() };
  }
  return undefined;
}

/** Resolve the gateway key from the environment. Read lazily, never cached. */
export function khalApiKey(): string | undefined {
  return khalCredential()?.value;
}

/**
 * Which env var actually supplied the key. Failure messages name *this* var
 * rather than the canonical one, so an operator running off the
 * `MIKRO_KHAL_API_KEY` fallback is not sent to edit the wrong variable.
 */
export function khalApiKeySource(): KhalKeyEnv | undefined {
  return khalCredential()?.name;
}

type KhalModel = Model<"openai-completions">;

/** LiteLLM `mode` values that are not chat completions. */
const NON_CHAT_MODES = new Set([
  "embedding",
  "rerank",
  "image_generation",
  "audio_transcription",
  "audio_speech",
  "moderation",
  "moderations",
  "responses",
  "video_generation",
]);

/** One `/model/info` row, narrowed to the fields we consume. */
interface ModelInfoEntry {
  model_name?: unknown;
  model_info?: {
    mode?: unknown;
    max_input_tokens?: unknown;
    max_output_tokens?: unknown;
    max_tokens?: unknown;
    input_cost_per_token?: unknown;
    output_cost_per_token?: unknown;
    cache_read_input_token_cost?: unknown;
    cache_creation_input_token_cost?: unknown;
    supports_vision?: unknown;
    supports_reasoning?: unknown;
  } | null;
}

/** One `/v1/models` row (the cost-free fallback catalog). */
interface ModelListEntry {
  id?: unknown;
  max_input_tokens?: unknown;
  max_output_tokens?: unknown;
}

/**
 * LiteLLM prices in dollars **per token**; pi-ai's `Model.cost` is dollars
 * **per million tokens** (`calculateCost` divides by 1e6). Missing/invalid
 * fields degrade to 0 rather than poisoning the catalog with NaN.
 *
 * The rounding is not cosmetic: `1e-7 * 1e6` is `0.09999999999999999` in
 * IEEE-754, so without it the catalog would carry float noise instead of the
 * rate the gateway actually quoted.
 */
export function perMillionDollars(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 1e6 * 1e10) / 1e10;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

/**
 * Strip the gateway's redundant `khal/` alias prefix. mikro refs are already
 * `<provider>/<model>`, so the alias `khal/deepseek-v4-flash` becomes the
 * catalog id `deepseek-v4-flash` and the ref stays `khal/deepseek-v4-flash`.
 * Aliases that are not so prefixed pass through untouched.
 */
function bareId(alias: string): string {
  const prefix = `${KHAL_PROVIDER_ID}/`;
  return alias.startsWith(prefix) ? alias.slice(prefix.length) : alias;
}

/** Accumulator for the several gateway deployments that share one alias. */
interface Draft {
  id: string;
  wireId: string;
  contextWindow: number;
  maxTokens: number;
  vision: boolean;
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * Fold one deployment into the alias it belongs to.
 *
 * A single alias (`khal/kimi-k2.6`) can front several deployments with
 * different credentials *and different prices*, and LiteLLM's router picks one
 * per request. We take the max of every numeric field: the result is
 * independent of `/model/info` ordering (which is not contractual) and errs
 * toward over-reporting cost, which is the safe direction for `--max-cost`.
 *
 * The skew is real, not theoretical: on the live gateway (2026-07-26)
 * `khal/kimi-k2.6` fronts three deployments at 7.5e-7 / 9.5e-7 / 1.2e-6 input
 * and `khal/kimi-k2.7-code` three at 7.4e-7 / 9.5e-7 / 9.5e-7, so a reported
 * cost can sit up to ~60% above what the router billed. Reported khal cost is
 * therefore an **upper bound** for multi-deployment aliases; any cost analysis
 * built on it (the parity report's premium-token accounting) must say so.
 * Single-deployment aliases and uniformly-priced ones — including the
 * `deepseek-v4-flash` default, whose deployments are priced identically — are
 * exact.
 */
function fold(into: Draft | undefined, next: Draft): Draft {
  if (!into) return next;
  return {
    id: into.id,
    wireId: into.wireId,
    contextWindow: Math.max(into.contextWindow, next.contextWindow),
    maxTokens: Math.max(into.maxTokens, next.maxTokens),
    vision: into.vision || next.vision,
    reasoning: into.reasoning || next.reasoning,
    cost: {
      input: Math.max(into.cost.input, next.cost.input),
      output: Math.max(into.cost.output, next.cost.output),
      cacheRead: Math.max(into.cost.cacheRead, next.cost.cacheRead),
      cacheWrite: Math.max(into.cost.cacheWrite, next.cost.cacheWrite),
    },
  };
}

function toModel(draft: Draft): KhalModel {
  return {
    id: draft.id,
    // Load-bearing, not cosmetic: `name` carries the gateway alias verbatim and
    // {@link khalStreams} reads it back to build the request. It also happens to
    // be the right thing to display — it matches the `khal/<model>` mikro ref.
    name: draft.wireId,
    api: "openai-completions",
    provider: KHAL_PROVIDER_ID,
    baseUrl: KHAL_BASE_URL,
    reasoning: draft.reasoning,
    input: draft.vision ? ["text", "image"] : ["text"],
    cost: { ...draft.cost },
    contextWindow: draft.contextWindow,
    maxTokens: Math.min(draft.maxTokens, draft.contextWindow),
    compat: {
      // LiteLLM forwards unknown OpenAI-only params to non-OpenAI upstreams,
      // and `developer` is rejected by several of the models behind this
      // gateway (Anthropic, DeepSeek). `system` + `max_tokens` are accepted by
      // every upstream LiteLLM translates for.
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    },
  };
}

/**
 * Parse a LiteLLM `/model/info` payload into a pi-ai catalog. Exported as the
 * fixture seam: the ×1e6 conversion is pinned here, not through the network.
 * Tolerant by construction — a payload whose shape drifted yields cost 0 and
 * default limits rather than throwing (the shape is LiteLLM-internal).
 */
export function parseModelInfo(payload: unknown): readonly KhalModel[] {
  const rows = (payload as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  const drafts = new Map<string, Draft>();
  for (const row of rows as ModelInfoEntry[]) {
    const alias = typeof row?.model_name === "string" ? row.model_name.trim() : "";
    if (!alias) continue;
    const info = row.model_info ?? {};
    const mode = typeof info.mode === "string" ? info.mode : "";
    if (mode && NON_CHAT_MODES.has(mode)) continue;
    const contextWindow =
      positiveInt(info.max_input_tokens) ?? positiveInt(info.max_tokens) ?? 128000;
    const id = bareId(alias);
    drafts.set(
      id,
      fold(drafts.get(id), {
        id,
        wireId: alias,
        contextWindow,
        maxTokens: positiveInt(info.max_output_tokens) ?? 8192,
        vision: info.supports_vision === true,
        reasoning: info.supports_reasoning === true,
        cost: {
          input: perMillionDollars(info.input_cost_per_token),
          output: perMillionDollars(info.output_cost_per_token),
          cacheRead: perMillionDollars(info.cache_read_input_token_cost),
          cacheWrite: perMillionDollars(info.cache_creation_input_token_cost),
        },
      }),
    );
  }
  return [...drafts.values()].map(toModel);
}

/**
 * Parse a plain `/v1/models` payload. This endpoint carries no pricing, so
 * every model lands with cost 0 — the degraded catalog that keeps `khal/<id>`
 * resolvable when `/model/info` is unavailable.
 */
export function parseModelList(payload: unknown): readonly KhalModel[] {
  const rows = (payload as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  const drafts = new Map<string, Draft>();
  for (const row of rows as ModelListEntry[]) {
    const alias = typeof row?.id === "string" ? row.id.trim() : "";
    if (!alias) continue;
    const id = bareId(alias);
    const contextWindow = positiveInt(row.max_input_tokens) ?? 128000;
    drafts.set(
      id,
      fold(drafts.get(id), {
        id,
        wireId: alias,
        contextWindow,
        maxTokens: positiveInt(row.max_output_tokens) ?? 8192,
        vision: false,
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    );
  }
  return [...drafts.values()].map(toModel);
}

/** One stderr warning per process about a degraded or unavailable catalog. */
let warnedCatalog = false;

function warnOnce(message: string): void {
  if (warnedCatalog) return;
  warnedCatalog = true;
  process.stderr.write(`mikro: ${message}\n`);
}

/**
 * Why the last fetch came back empty (both endpoints, with their reasons).
 * Read by {@link ensureKhalModels} so a dead gateway names the endpoints that
 * failed instead of surfacing as "unknown model".
 */
let lastCatalogFailure: string | null = null;

/**
 * A non-2xx answer from the gateway, carrying the status so callers can tell a
 * rejected credential from an outage — the distinction the fallback logic and
 * every error message below turn on.
 */
class KhalHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "KhalHttpError";
    this.status = status;
  }
}

/**
 * 401 = key unknown/expired, 403 = key known but not entitled. Either way the
 * credential is the problem and no endpoint on this gateway will answer, so
 * falling back is pointless and reporting an outage would be a lie.
 */
function authFailureStatus(err: unknown): number | undefined {
  return err instanceof KhalHttpError && (err.status === 401 || err.status === 403)
    ? err.status
    : undefined;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function rejectedKeyError(status: number): Error {
  const source = khalApiKeySource() ?? KHAL_API_KEY_ENV[0];
  return new Error(
    `${KHAL_REJECTED_KEY_ERROR} ${source} (HTTP ${status}) — the key is invalid, ` +
      `expired, or revoked; set a working key in ${source} (env-only)`,
  );
}

async function getJson(path: string, key: string): Promise<unknown> {
  const res = await fetch(`${KHAL_BASE_URL}${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
    // A gateway that accepts the connection but never answers must not hang
    // model resolution forever.
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new KhalHttpError(res.status);
  return await res.json();
}

/** Record the two-endpoint failure and warn once; the caller gets no catalog. */
function noCatalog(infoReason: string, listReason: string): readonly KhalModel[] {
  lastCatalogFailure = `/model/info: ${infoReason}; /models: ${listReason}`;
  warnOnce(
    `khal catalog refresh failed (${lastCatalogFailure}); ` +
      `no models loaded from ${KHAL_BASE_URL}`,
  );
  return [];
}

/**
 * Fetch the gateway catalog: priced from `/model/info`, degrading to the
 * cost-0 `/v1/models` list when *that endpoint* is down.
 *
 * Throws only when the gateway rejects the key — the one failure a fallback
 * cannot repair, and the one that must not reach `resolveModel` as an empty
 * catalog. Every other failure yields an empty catalog plus one honest stderr
 * line, leaving the caller whatever was registered before.
 */
export async function fetchKhalModels(): Promise<readonly KhalModel[]> {
  const key = khalApiKey();
  if (!key) return [];
  let infoReason: string;
  try {
    const models = parseModelInfo(await getJson("/model/info", key));
    if (models.length > 0) {
      lastCatalogFailure = null;
      return models;
    }
    infoReason = "empty payload";
  } catch (err) {
    const status = authFailureStatus(err);
    if (status !== undefined) throw rejectedKeyError(status);
    infoReason = reasonOf(err);
  }
  try {
    const catalog = parseModelList(await getJson("/models", key));
    if (catalog.length === 0) return noCatalog(infoReason, "empty payload");
    // Emitted here rather than at the `/model/info` failure: "models resolve
    // from /v1/models" is only true once the fallback has actually answered.
    warnOnce(
      `khal /model/info unavailable (${infoReason}); ` +
        `models resolve from /v1/models with cost 0`,
    );
    lastCatalogFailure = null;
    return catalog;
  } catch (err) {
    const status = authFailureStatus(err);
    if (status !== undefined) throw rejectedKeyError(status);
    return noCatalog(infoReason, reasonOf(err));
  }
}

/**
 * Wrap the OpenAI-completions transport so the request body carries the
 * gateway's alias (`khal/deepseek-v4-flash`) while the catalog is keyed by the
 * bare id (`deepseek-v4-flash`).
 *
 * This has to be a transport wrapper rather than a field on the model: pi-ai
 * uses `model.id` both as the `getModel()` lookup key and as the request-body
 * `model`, and mikro's own `normalizeProviderModelId` strips the `khal/` prefix
 * off any ref before lookup — so a catalog keyed by the alias could never be
 * resolved from a `khal/<model>` ref.
 *
 * The alias is read off `model.name` rather than a lookup table so the mapping
 * travels with the model: models injected later by pi-ai's `refreshModels`
 * hook are rewritten correctly too, and the wrapper holds no state.
 */
function khalStreams(): ProviderStreams {
  const base = openAICompletionsApi();
  const onWire = (model: Model<Api>): Model<Api> =>
    model.provider === KHAL_PROVIDER_ID && model.name && model.name !== model.id
      ? { ...model, id: model.name }
      : model;
  return {
    stream: (model, context, options) => base.stream(onWire(model), context, options),
    streamSimple: (model, context, options) =>
      base.streamSimple(onWire(model), context, options),
  };
}

/**
 * Build the khal provider (pi-ai `createProvider`). The catalog is entirely
 * dynamic — there is no static baseline to go stale — so a bare
 * `khalProvider()` serves nothing until {@link ensureKhalModels} overlays it.
 */
export function khalProvider(
  catalog: readonly KhalModel[] = [],
): Provider<"openai-completions"> {
  return createProvider<"openai-completions">({
    id: KHAL_PROVIDER_ID,
    name: "khal (LiteLLM gateway)",
    baseUrl: KHAL_BASE_URL,
    auth: { apiKey: envApiKeyAuth("khal API key", KHAL_API_KEY_ENV) },
    models: catalog,
    fetchModels: fetchKhalModels,
    api: khalStreams(),
  });
}

/**
 * Pre-resolution hook: guarantee the key exists, the gateway accepts it, and
 * the dynamic catalog is applied — in that order. Every khal-specific failure
 * is named *here*, because `resolveModel` downstream has one error for all of
 * them ("unknown model"), which is true of none of them.
 *
 *   - no key            → `khal provider requires KHAL_API_KEY`
 *   - key rejected      → `khal gateway rejected <ENV_VAR> (HTTP 401) …`
 *   - gateway unusable  → `khal catalog unavailable (/model/info: …; /models: …)`
 *
 * The key check is deliberately outside the memo and ahead of every network
 * call. The memo holds the *catalog*, not the side effect of applying it, so
 * two runtimes in one process (`src/llm.ts` and `src/sdk/rlm-driver.ts`) share
 * the single fetch and both end up serving it. Cleared on failure so a later
 * call can retry.
 */
let khalCatalog: Promise<readonly KhalModel[]> | null = null;

/** Runtimes already serving the memoized catalog; weak so nothing is pinned. */
let khalApplied = new WeakSet<MutableModels>();

export async function ensureKhalModels(models: MutableModels): Promise<void> {
  if (!khalApiKey()) throw new Error(KHAL_MISSING_KEY_ERROR);
  if (!khalCatalog) {
    const inflight = fetchKhalModels();
    khalCatalog = inflight;
    // Clear the memo so a later call retries, but keep the rejection on the
    // promise the caller awaits — a rejected key must surface, not vanish.
    inflight.catch(() => {
      if (khalCatalog === inflight) khalCatalog = null;
    });
  }
  const catalog = await khalCatalog;
  if (catalog.length > 0) {
    if (!khalApplied.has(models)) {
      models.setProvider(khalProvider(catalog));
      khalApplied.add(models);
    }
    return;
  }
  // Nothing fetched: fine if an earlier overlay is still registered (a
  // transient outage must not un-resolve working models), fatal otherwise.
  if (models.getModels(KHAL_PROVIDER_ID).length === 0) {
    throw new Error(
      `${KHAL_EMPTY_CATALOG_ERROR} (${lastCatalogFailure ?? "empty catalog"}) — ` +
        `no khal models to resolve from ${KHAL_BASE_URL}`,
    );
  }
}

/** Test seam: forget the memoized catalog and the one-shot stderr warning. */
export function resetKhalModelsCache(): void {
  khalCatalog = null;
  khalApplied = new WeakSet<MutableModels>();
  warnedCatalog = false;
  lastCatalogFailure = null;
}

/**
 * Register the khal provider on a pi-ai `Models` runtime. Call once per
 * runtime, right after `builtinModels()`, at every resolution site.
 */
export function registerKhalProvider(models: MutableModels): void {
  models.setProvider(khalProvider());
}
