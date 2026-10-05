import type { ThinkingLevel } from "./gemini.js";
import { type CustomProviderConfig } from "./custom-providers.js";
import { type ValidateSchema } from "./sdk/validate.js";
/** Parsed tool: name → Python code */
export interface ToolDef {
    name: string;
    code: string;
}
/** Model configuration */
export interface ModelConfig {
    provider: string;
    model: string;
    subCallModel?: string;
    /**
     * Config-declared providers (see src/custom-providers.ts). Carried on the
     * model config — not just on `MikroConfig` — so every resolution site that
     * receives a `ModelConfig` (llmComplete, the SDK driver, recursive children)
     * can register them before lookup without threading a second argument
     * through the call graph. `applyModelRef` spreads it forward untouched.
     */
    providers?: CustomProviderConfig[];
}
/** Budget limits (all optional — null means unlimited) */
export interface BudgetConfig {
    maxCost: number | null;
    maxTokens: number | null;
    maxDepth: number | null;
}
/** Cache configuration for CAG mode */
export interface CacheConfig {
    enabled: boolean;
    strategy: "full";
    sessionPrefix?: string;
    retention: "short" | "long";
    ttl?: number;
    expireTime?: string;
}
/** Context loading configuration */
export interface ContextConfig {
    extensions: string[];
    exclude: string[];
}
/** Media resolution configuration per content type */
export interface MediaResolutionConfig {
    images?: string;
    pdfs?: string;
    video?: string;
}
/** Gemini-specific configuration */
export interface GeminiConfig {
    thinkingLevel: ThinkingLevel | null;
    googleSearch: boolean;
    urlContext: boolean;
    codeExecution: boolean;
    mediaResolution: MediaResolutionConfig | null;
    computerUse: boolean;
    mapsGrounding: boolean;
    fileSearch: boolean;
}
/** Structured output schema configuration */
export interface OutputConfig {
    schema: Record<string, unknown> | null;
}
/** Storage configuration for pgserve-backed large context handling */
export interface StorageConfig {
    enabled: "auto" | "always" | "never";
    mode: "persistent" | "memory";
    dataDir: string;
    port: number;
    chunkSize: number | null;
    chunkUtilization: number;
    charsPerToken: number;
}
/** System-prompt assembly config */
export interface PromptConfig {
    /**
     * Append mikro's REPL/FINAL termination protocol to the system prompt
     * (`src/stop-protocol.ts`). Default true.
     *
     * The append is already skipped when the pack's own `SYSTEM.md` teaches the
     * protocol, so this switch is for the rarer case: a prompt that terminates
     * some other way, or a benchmark that needs the pre-protocol prompt
     * byte-for-byte.
     */
    appendStopProtocol: boolean;
}
/** Tool level — controls which functions are available in the REPL */
export type ToolsLevel = "core" | "standard" | "full";
/** Full mikro config */
export interface MikroConfig {
    system: string | null;
    tools: ToolDef[];
    criteria: string | null;
    model: ModelConfig;
    /** Directory the config was loaded from */
    configDir: string;
    /** Budget limits */
    budget: BudgetConfig;
    /** Context loading settings */
    contextConfig: ContextConfig;
    /** Tool level */
    toolsLevel: ToolsLevel;
    /** Cache configuration for CAG mode */
    cache: CacheConfig;
    /** Gemini-specific configuration */
    gemini: GeminiConfig;
    /** Structured output configuration */
    output: OutputConfig;
    /** Storage configuration for pgserve */
    storage: StorageConfig;
    /**
     * System-prompt assembly settings.
     *
     * Optional purely for source compatibility — `MikroConfig` is a published
     * SDK type, and every config this repo builds (`loadConfig`, including the
     * defaults-only path) sets it. Absent therefore means "defaults", which for
     * `appendStopProtocol` is `true`.
     */
    prompt?: PromptConfig;
    /**
     * Sampling temperature for the root loop's model calls, `0`–`2`.
     *
     * Top-level rather than under `gemini:`, deliberately. `gemini.thinking-level`
     * is the standing reminder of what nesting a provider-wide knob costs: pi-ai
     * maps `reasoning` on every api family it supports, so the prefix has misled
     * every reader of that key since (see the note above `piOptions.reasoning`,
     * `src/llm.ts`). `temperature` is mapped just as widely and starts un-nested.
     *
     * `null`/absent means **unset**, and unset is not "the provider's documented
     * default": `llmComplete` omits the key from the pi-ai options entirely, so
     * whatever the provider does with no temperature at all is what happens. This
     * is why the field is nullable and why every guard on it is `!= null` — `0`
     * is greedy decoding, a real and deliberate setting that a truthiness check
     * would silently drop.
     *
     * Optional for the same reason `prompt?` is: `MikroConfig` is a published SDK
     * type and full-literal test helpers should not have to churn. Every config
     * this repo builds sets it.
     */
    temperature?: number | null;
    /**
     * Providers declared in config (settings.json merged with mikro.yaml; the
     * yaml wins per id). Also mirrored on `model.providers`.
     */
    providers: CustomProviderConfig[];
    /** Config source: "yaml" | "defaults" */
    configSource: "yaml" | "defaults";
    /**
     * The pack's `VALIDATE.md` contract for `emit_done` payloads, or null when
     * the pack ships none. See `ValidateConfig` for why "ships none" and "ships
     * a broken one" are deliberately the same value.
     */
    validate: ValidateConfig | null;
}
/**
 * A pack's `VALIDATE.md`, loaded by convention rather than declared: the file
 * sits next to `mikro.yaml` (project) or next to `agent.yaml` (microagent) and
 * needs no key to switch it on.
 *
 * Only ever constructed when the markdown yielded a schema we could actually
 * parse, so `schema` and `rawBlock` are both non-null here. A missing file and
 * a malformed one collapse to the same `null` on `MikroConfig` on purpose: a
 * contract we could not read must not be enforced as if it were one, and it
 * must not stop the run from loading either. `rawBlock` rides along because
 * the retry hint quotes the schema back at the model verbatim
 * (`buildRetryHint`, src/sdk/validate.ts).
 */
export interface ValidateConfig {
    readonly schema: ValidateSchema;
    readonly rawBlock: string;
}
export declare const DEFAULT_STORAGE_CONFIG: StorageConfig;
export declare const DEFAULT_PROMPT_CONFIG: PromptConfig;
/**
 * Inclusive bounds for `temperature`, shared by all three surfaces that accept
 * it (mikro.yaml, `agent.yaml`, `--temperature`). `2` is the widest ceiling any
 * supported provider accepts; providers with a narrower range reject the excess
 * themselves, which is a clearer failure than mikro guessing per model.
 */
export declare const TEMPERATURE_MIN = 0;
export declare const TEMPERATURE_MAX = 2;
/**
 * The one definition of "a usable temperature". Rejects non-numbers, `NaN` and
 * `Infinity` before the range comparison — `NaN < 0` and `NaN > 2` are both
 * false, so a bare range check would wave `NaN` straight through to the wire.
 */
export declare function isValidTemperature(value: unknown): value is number;
/**
 * Parse a `--temperature` flag value. `node:util`'s `parseArgs` hands every
 * `{ type: "string" }` flag back as a string, so the parse has to happen here
 * rather than at the range check.
 *
 * Returns `null` for an absent flag — the same "unset" `MikroConfig.temperature`
 * uses — and throws on anything that is not a number in `[0, 2]`.
 *
 * The conversion is `Number`, not `Number.parseFloat`: `parseFloat` stops at the
 * first character it cannot read, so `--temperature 1oops` and `--temperature
 * 0.5.3` would parse as `1` and `0.5` and silently run at a temperature nobody
 * asked for. `Number` demands the *whole* trimmed token be numeric. Its one trap
 * is that `Number("")` and `Number("   ")` are `0` rather than `NaN`, so an
 * empty or whitespace-only value is rejected explicitly before the conversion —
 * `--temperature ""` is a malformed flag, not an absent one.
 */
export declare function parseTemperatureFlag(raw: string | undefined | null): number | null;
/**
 * Write a parsed temperature override onto a loaded config.
 *
 * Exists as a named function rather than an inline `if` because the guard is
 * the whole risk of this field: `if (temperature)` drops `0`, and `0` is greedy
 * decoding — the single most likely value anyone pins a temperature *to*. One
 * `!= null` in one place, reused by every caller.
 */
export declare function applyTemperatureOverride(config: MikroConfig, temperature: number | null | undefined): void;
/**
 * Split a `"<provider>/<model>"` reference into its parts.
 *
 * Returns null when the string carries no usable provider prefix, in which
 * case the caller should keep the ambient configured provider and treat the
 * whole string as a model id.
 */
export declare function parseModelRef(value: string): {
    provider: string;
    model: string;
} | null;
/**
 * Apply a model reference onto a `ModelConfig`, returning a new config.
 *
 * The sub-call model is re-pinned to the referenced model id as well. Without
 * that, a caller that switches provider (an agent's `model:`, or `--model`)
 * keeps the *previous* provider's `sub-call-model`, and the first bare
 * `llm_query()` dies with `Unknown model "<inherited>" for provider "<new>"`.
 */
export declare function applyModelRef(model: ModelConfig, ref: string): ModelConfig;
/**
 * Parse TOOLS.md format:
 *   ## tool_name
 *   ```python
 *   def tool_name(...):
 *       ...
 *   ```
 */
export declare function parseToolsMd(content: string): ToolDef[];
/**
 * Load a `VALIDATE.md` sitting at `path`, by convention.
 *
 * Three inputs, two answers. No file → null. A file whose fenced block is
 * missing or is not valid JSON → also null, and never a throw: `parseValidateMd`
 * reports both as `schema: null`, and a pack that ships a broken schema has to
 * degrade to "unvalidated" rather than fail to load at all — the alternative is
 * a typo in a markdown file taking the whole agent off the air. Only a block we
 * parsed becomes a `ValidateConfig`.
 *
 * Shared by both load paths (project `.mikro/` and a microagent's own
 * directory) so "what counts as a usable schema" has exactly one definition.
 */
export declare function loadValidateMd(path: string): Promise<ValidateConfig | null>;
/**
 * Providers declared globally in ~/.mikro/settings.json under `"providers"`.
 * Read on every load (the file is small) so a `mikro config` edit takes effect
 * on the next run. A malformed block is an error, not a silent skip — the
 * operator wrote it expecting it to work.
 */
export declare function loadGlobalProviders(): Promise<CustomProviderConfig[]>;
/**
 * Load mikro config from .mikro/ directory:
 *   1. .mikro/mikro.yaml (required for yaml source)
 *   2. .mikro/SYSTEM.md (auto-loaded when present)
 *   3. .mikro/CRITERIA.md (auto-loaded when present)
 *   4. .mikro/TOOLS.md (auto-loaded and parsed when present)
 *   5. .mikro/VALIDATE.md (auto-loaded and parsed when present)
 *   6. Defaults if no .mikro/mikro.yaml
 *
 * The auto-loaded `.md` files belong to the yaml branch only. The defaults
 * branch reads no files at all today, and VALIDATE.md does not change that:
 * a directory with no mikro.yaml is not a pack.
 *
 * Config-declared providers come from ~/.mikro/settings.json (`"providers"`)
 * overlaid by mikro.yaml (`providers:`), in both the yaml and the defaults
 * branch — a project with no mikro.yaml can still run on a globally declared
 * provider.
 */
export declare function loadConfig(dir: string): Promise<MikroConfig>;
/**
 * Check if any config exists in a directory.
 * Checks .mikro/mikro.yaml, then the legacy .rlmx/rlmx.yaml.
 */
export declare function hasConfig(dir: string): Promise<boolean>;
//# sourceMappingURL=config.d.ts.map