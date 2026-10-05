import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { mergeCustomProviders, parseCustomProviders, } from "./custom-providers.js";
import { loadSettings } from "./settings.js";
import { parseValidateMd } from "./sdk/validate.js";
// ─── Defaults ────────────────────────────────────────────
const DEFAULT_MODEL = {
    provider: "google",
    model: "gemini-3.1-flash-lite-preview",
};
const DEFAULT_BUDGET = {
    maxCost: null,
    maxTokens: null,
    maxDepth: null,
};
const DEFAULT_CACHE_CONFIG = {
    enabled: false,
    strategy: "full",
    retention: "long",
};
const DEFAULT_CONTEXT_CONFIG = {
    extensions: [".md"],
    exclude: ["node_modules", ".git", "dist"],
};
const DEFAULT_GEMINI_CONFIG = {
    thinkingLevel: null,
    googleSearch: false,
    urlContext: false,
    codeExecution: false,
    mediaResolution: null,
    computerUse: false,
    mapsGrounding: false,
    fileSearch: false,
};
const DEFAULT_OUTPUT_CONFIG = {
    schema: null,
};
export const DEFAULT_STORAGE_CONFIG = {
    enabled: "auto",
    mode: "persistent",
    dataDir: "~/.mikro/data",
    port: 0,
    chunkSize: null,
    chunkUtilization: 0.6,
    charsPerToken: 4,
};
export const DEFAULT_PROMPT_CONFIG = {
    appendStopProtocol: true,
};
/**
 * Inclusive bounds for `temperature`, shared by all three surfaces that accept
 * it (mikro.yaml, `agent.yaml`, `--temperature`). `2` is the widest ceiling any
 * supported provider accepts; providers with a narrower range reject the excess
 * themselves, which is a clearer failure than mikro guessing per model.
 */
export const TEMPERATURE_MIN = 0;
export const TEMPERATURE_MAX = 2;
/**
 * The one definition of "a usable temperature". Rejects non-numbers, `NaN` and
 * `Infinity` before the range comparison — `NaN < 0` and `NaN > 2` are both
 * false, so a bare range check would wave `NaN` straight through to the wire.
 */
export function isValidTemperature(value) {
    return (typeof value === "number" &&
        Number.isFinite(value) &&
        value >= TEMPERATURE_MIN &&
        value <= TEMPERATURE_MAX);
}
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
export function parseTemperatureFlag(raw) {
    if (raw === undefined || raw === null)
        return null;
    const trimmed = raw.trim();
    const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
    if (!isValidTemperature(parsed)) {
        throw new Error(`--temperature must be a number between ${TEMPERATURE_MIN} and ${TEMPERATURE_MAX} (got "${raw}")`);
    }
    return parsed;
}
/**
 * Write a parsed temperature override onto a loaded config.
 *
 * Exists as a named function rather than an inline `if` because the guard is
 * the whole risk of this field: `if (temperature)` drops `0`, and `0` is greedy
 * decoding — the single most likely value anyone pins a temperature *to*. One
 * `!= null` in one place, reused by every caller.
 */
export function applyTemperatureOverride(config, temperature) {
    if (temperature != null) {
        config.temperature = temperature;
    }
}
// ─── File Helpers ────────────────────────────────────────
/**
 * Try to read a file, returning null if it doesn't exist.
 */
async function readOptionalFile(path) {
    try {
        return await readFile(path, "utf-8");
    }
    catch {
        return null;
    }
}
/**
 * Validate a budget value is a positive number or null.
 */
function validatePositiveBudget(value, field) {
    if (value !== null && (typeof value !== "number" || value <= 0)) {
        throw new Error(`Invalid ${field}: must be a positive number or null, got ${value}.`);
    }
}
// ─── Model References ────────────────────────────────────
/**
 * Split a `"<provider>/<model>"` reference into its parts.
 *
 * Returns null when the string carries no usable provider prefix, in which
 * case the caller should keep the ambient configured provider and treat the
 * whole string as a model id.
 */
export function parseModelRef(value) {
    const idx = value.indexOf("/");
    if (idx <= 0 || idx === value.length - 1)
        return null;
    return { provider: value.slice(0, idx), model: value.slice(idx + 1) };
}
/**
 * Apply a model reference onto a `ModelConfig`, returning a new config.
 *
 * The sub-call model is re-pinned to the referenced model id as well. Without
 * that, a caller that switches provider (an agent's `model:`, or `--model`)
 * keeps the *previous* provider's `sub-call-model`, and the first bare
 * `llm_query()` dies with `Unknown model "<inherited>" for provider "<new>"`.
 */
export function applyModelRef(model, ref) {
    const trimmed = ref.trim();
    if (!trimmed)
        return model;
    const parsed = parseModelRef(trimmed);
    if (!parsed) {
        return { ...model, model: trimmed, subCallModel: trimmed };
    }
    return {
        ...model,
        provider: parsed.provider,
        model: parsed.model,
        subCallModel: parsed.model,
    };
}
// ─── Tools.md Parsing ────────────────────────────────────
/**
 * Parse TOOLS.md format:
 *   ## tool_name
 *   ```python
 *   def tool_name(...):
 *       ...
 *   ```
 */
export function parseToolsMd(content) {
    const tools = [];
    const headingRegex = /^## (.+)$/gm;
    const codeBlockRegex = /```python\s*\n([\s\S]*?)```/g;
    let headingMatch;
    const headings = [];
    while ((headingMatch = headingRegex.exec(content)) !== null) {
        headings.push({ name: headingMatch[1].trim(), index: headingMatch.index });
    }
    for (let i = 0; i < headings.length; i++) {
        const start = headings[i].index;
        const end = i + 1 < headings.length ? headings[i + 1].index : content.length;
        const section = content.slice(start, end);
        const codeMatch = codeBlockRegex.exec(section);
        codeBlockRegex.lastIndex = 0;
        if (codeMatch) {
            tools.push({
                name: headings[i].name,
                code: codeMatch[1].trim(),
            });
        }
    }
    return tools;
}
// ─── YAML Parsing ────────────────────────────────────────
/**
 * Parse and validate an mikro.yaml file.
 */
function parseYamlConfig(content, dir, globalProviders = []) {
    let raw;
    try {
        raw = yaml.load(content);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid YAML in mikro.yaml: ${msg}\n` +
            `Hint: check for indentation errors or unquoted special characters.`);
    }
    if (raw === null || raw === undefined || typeof raw !== "object") {
        throw new Error(`mikro.yaml is empty or not a YAML mapping.\n` +
            `Expected a YAML object with keys like model, context, budget, etc.`);
    }
    const cfg = raw;
    // Parse config-declared providers first: the model block may name one.
    const providers = mergeCustomProviders(globalProviders, parseCustomProviders(cfg.providers, "mikro.yaml"));
    // Parse model
    const model = {
        provider: cfg.model?.provider ?? DEFAULT_MODEL.provider,
        model: cfg.model?.model ?? DEFAULT_MODEL.model,
    };
    if (cfg.model?.["sub-call-model"]) {
        model.subCallModel = cfg.model["sub-call-model"];
    }
    if (providers.length)
        model.providers = providers;
    // Parse context config
    const contextConfig = {
        extensions: cfg.context?.extensions ?? DEFAULT_CONTEXT_CONFIG.extensions,
        exclude: cfg.context?.exclude ?? DEFAULT_CONTEXT_CONFIG.exclude,
    };
    // Validate and normalize extensions format
    for (let i = 0; i < contextConfig.extensions.length; i++) {
        const ext = contextConfig.extensions[i];
        if (typeof ext !== "string") {
            throw new Error(`Invalid extension in context.extensions: expected string, got ${typeof ext}.`);
        }
        // Ensure leading dot: "mdx" → ".mdx"
        if (ext.length > 0 && !ext.startsWith(".")) {
            contextConfig.extensions[i] = `.${ext}`;
        }
    }
    // Parse budget
    const budget = {
        maxCost: cfg.budget?.["max-cost"] ?? DEFAULT_BUDGET.maxCost,
        maxTokens: cfg.budget?.["max-tokens"] ?? DEFAULT_BUDGET.maxTokens,
        maxDepth: cfg.budget?.["max-depth"] ?? DEFAULT_BUDGET.maxDepth,
    };
    // Validate budget values
    validatePositiveBudget(budget.maxCost, "budget.max-cost");
    validatePositiveBudget(budget.maxTokens, "budget.max-tokens");
    validatePositiveBudget(budget.maxDepth, "budget.max-depth");
    // Parse tools-level
    const rawLevel = cfg["tools-level"] ?? "core";
    if (!["core", "standard", "full"].includes(rawLevel)) {
        throw new Error(`Invalid tools-level "${rawLevel}" in mikro.yaml. Must be one of: core, standard, full.`);
    }
    const toolsLevel = rawLevel;
    // Parse cache config
    const rawRetention = cfg.cache?.retention ?? "long";
    if (rawRetention && !["short", "long"].includes(rawRetention)) {
        throw new Error(`Invalid cache.retention "${rawRetention}" in mikro.yaml. Must be one of: short, long.`);
    }
    const rawStrategy = cfg.cache?.strategy ?? "full";
    if (rawStrategy && rawStrategy !== "full") {
        throw new Error(`Invalid cache.strategy "${rawStrategy}" in mikro.yaml. Only "full" is currently supported.`);
    }
    const cache = {
        enabled: cfg.cache?.enabled ?? DEFAULT_CACHE_CONFIG.enabled,
        strategy: rawStrategy,
        retention: rawRetention,
    };
    if (cfg.cache?.["session-prefix"]) {
        cache.sessionPrefix = cfg.cache["session-prefix"];
    }
    if (cfg.cache?.ttl !== undefined) {
        cache.ttl = cfg.cache.ttl;
    }
    if (cfg.cache?.["expire-time"]) {
        cache.expireTime = cfg.cache["expire-time"];
    }
    // Parse gemini config
    const gemini = {
        thinkingLevel: cfg.gemini?.["thinking-level"] ?? DEFAULT_GEMINI_CONFIG.thinkingLevel,
        googleSearch: cfg.gemini?.["google-search"] ?? DEFAULT_GEMINI_CONFIG.googleSearch,
        urlContext: cfg.gemini?.["url-context"] ?? DEFAULT_GEMINI_CONFIG.urlContext,
        codeExecution: cfg.gemini?.["code-execution"] ?? DEFAULT_GEMINI_CONFIG.codeExecution,
        mediaResolution: cfg.gemini?.["media-resolution"] ?? DEFAULT_GEMINI_CONFIG.mediaResolution,
        computerUse: cfg.gemini?.["computer-use"] ?? DEFAULT_GEMINI_CONFIG.computerUse,
        mapsGrounding: cfg.gemini?.["maps-grounding"] ?? DEFAULT_GEMINI_CONFIG.mapsGrounding,
        fileSearch: cfg.gemini?.["file-search"] ?? DEFAULT_GEMINI_CONFIG.fileSearch,
    };
    // Validate thinking level if provided
    if (gemini.thinkingLevel !== null) {
        const validLevels = ["minimal", "low", "medium", "high"];
        if (!validLevels.includes(gemini.thinkingLevel)) {
            throw new Error(`Invalid gemini.thinking-level "${gemini.thinkingLevel}" in mikro.yaml. ` +
                `Must be one of: minimal, low, medium, high.`);
        }
    }
    // Validate media resolution values if provided
    if (gemini.mediaResolution) {
        const validResolutions = ["low", "medium", "high", "auto"];
        for (const [key, value] of Object.entries(gemini.mediaResolution)) {
            if (value && !validResolutions.includes(value)) {
                throw new Error(`Invalid gemini.media-resolution.${key} "${value}" in mikro.yaml. ` +
                    `Must be one of: low, medium, high, auto.`);
            }
        }
    }
    // Parse output config
    const output = {
        schema: cfg.output?.schema ?? DEFAULT_OUTPUT_CONFIG.schema,
    };
    // Validate output schema if provided
    if (output.schema !== null && typeof output.schema !== "object") {
        throw new Error(`Invalid output.schema in mikro.yaml: must be a JSON Schema object or null.`);
    }
    // Parse storage config
    const rawEnabled = cfg.storage?.enabled ?? DEFAULT_STORAGE_CONFIG.enabled;
    if (!["auto", "always", "never"].includes(rawEnabled)) {
        throw new Error(`Invalid storage.enabled "${rawEnabled}" in mikro.yaml. Must be one of: auto, always, never.`);
    }
    const rawMode = cfg.storage?.mode ?? DEFAULT_STORAGE_CONFIG.mode;
    if (!["persistent", "memory"].includes(rawMode)) {
        throw new Error(`Invalid storage.mode "${rawMode}" in mikro.yaml. Must be one of: persistent, memory.`);
    }
    const storagePort = cfg.storage?.port ?? DEFAULT_STORAGE_CONFIG.port;
    if (typeof storagePort !== "number" || storagePort < 0 || !Number.isInteger(storagePort)) {
        throw new Error(`Invalid storage.port in mikro.yaml: must be a non-negative integer, got ${storagePort}.`);
    }
    const chunkSize = cfg.storage?.["chunk-size"] ?? DEFAULT_STORAGE_CONFIG.chunkSize;
    if (chunkSize !== null && (typeof chunkSize !== "number" || chunkSize <= 0)) {
        throw new Error(`Invalid storage.chunk-size in mikro.yaml: must be a positive number or null, got ${chunkSize}.`);
    }
    const chunkUtilization = cfg.storage?.["chunk-utilization"] ?? DEFAULT_STORAGE_CONFIG.chunkUtilization;
    if (typeof chunkUtilization !== "number" || chunkUtilization <= 0 || chunkUtilization > 1) {
        throw new Error(`Invalid storage.chunk-utilization in mikro.yaml: must be a number between 0 (exclusive) and 1 (inclusive), got ${chunkUtilization}.`);
    }
    const charsPerToken = cfg.storage?.["chars-per-token"] ?? DEFAULT_STORAGE_CONFIG.charsPerToken;
    if (typeof charsPerToken !== "number" || charsPerToken <= 0) {
        throw new Error(`Invalid storage.chars-per-token in mikro.yaml: must be a positive number, got ${charsPerToken}.`);
    }
    const storage = {
        enabled: rawEnabled,
        mode: rawMode,
        dataDir: cfg.storage?.["data-dir"] ?? DEFAULT_STORAGE_CONFIG.dataDir,
        port: storagePort,
        chunkSize,
        chunkUtilization,
        charsPerToken,
    };
    // Parse prompt config
    const rawAppendStopProtocol = cfg.prompt?.["append-stop-protocol"] ?? DEFAULT_PROMPT_CONFIG.appendStopProtocol;
    if (typeof rawAppendStopProtocol !== "boolean") {
        throw new Error(`Invalid prompt.append-stop-protocol in mikro.yaml: must be true or false, got ${JSON.stringify(rawAppendStopProtocol)}.`);
    }
    const prompt = {
        appendStopProtocol: rawAppendStopProtocol,
    };
    // Parse temperature. A bare `temperature:` key parses as YAML null, which is
    // the same "unset" the absent key means — the convention
    // `prompt.append-stop-protocol` already follows. Anything else must be a
    // number in range: `temperature: hot` reaching the wire is a run that either
    // errors deep inside a provider SDK or, worse, gets silently normalised.
    const rawTemperature = cfg.temperature ?? null;
    if (rawTemperature !== null && !isValidTemperature(rawTemperature)) {
        throw new Error(`Invalid temperature in mikro.yaml: must be a number between ${TEMPERATURE_MIN} and ${TEMPERATURE_MAX}, got ${JSON.stringify(rawTemperature)}.`);
    }
    return {
        model,
        configDir: dir,
        budget,
        contextConfig,
        toolsLevel,
        cache,
        gemini,
        output,
        storage,
        prompt,
        temperature: rawTemperature,
        providers,
        configSource: "yaml",
    };
}
/**
 * Build a config from defaults only (no files).
 */
function defaultConfig(dir, providers = []) {
    const model = { ...DEFAULT_MODEL };
    if (providers.length)
        model.providers = providers;
    return {
        system: null,
        tools: [],
        criteria: null,
        model,
        configDir: dir,
        budget: { ...DEFAULT_BUDGET },
        contextConfig: { ...DEFAULT_CONTEXT_CONFIG },
        toolsLevel: "core",
        cache: { ...DEFAULT_CACHE_CONFIG },
        gemini: { ...DEFAULT_GEMINI_CONFIG },
        output: { ...DEFAULT_OUTPUT_CONFIG },
        storage: { ...DEFAULT_STORAGE_CONFIG },
        prompt: { ...DEFAULT_PROMPT_CONFIG },
        temperature: null,
        providers,
        configSource: "defaults",
        validate: null,
    };
}
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
export async function loadValidateMd(path) {
    const raw = await readOptionalFile(path);
    if (raw === null)
        return null;
    const { schema, rawBlock } = parseValidateMd(raw);
    if (!schema || !rawBlock)
        return null;
    return { schema, rawBlock };
}
/**
 * Providers declared globally in ~/.mikro/settings.json under `"providers"`.
 * Read on every load (the file is small) so a `mikro config` edit takes effect
 * on the next run. A malformed block is an error, not a silent skip — the
 * operator wrote it expecting it to work.
 */
export async function loadGlobalProviders() {
    const settings = await loadSettings();
    return parseCustomProviders(settings.providers, "settings.json");
}
// ─── Main loader ─────────────────────────────────────────
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
export async function loadConfig(dir) {
    let mikroDir = join(dir, ".mikro");
    const globalProviders = await loadGlobalProviders();
    // Try .mikro/mikro.yaml, then the pre-rename .rlmx/rlmx.yaml. The fallback
    // keeps an unmigrated checkout running; the warning (once per process, per
    // dir) points at `mikro migrate` so it does not stay unmigrated for long.
    let yamlContent = await readOptionalFile(join(mikroDir, "mikro.yaml"));
    if (yamlContent === null) {
        const legacyDir = join(dir, ".rlmx");
        const legacy = await readOptionalFile(join(legacyDir, "rlmx.yaml"));
        if (legacy !== null) {
            yamlContent = legacy;
            mikroDir = legacyDir;
            warnLegacyConfig(legacyDir);
        }
    }
    if (yamlContent !== null) {
        const partial = parseYamlConfig(yamlContent, dir, globalProviders);
        // Auto-load .md files from .mikro/
        const [systemRaw, criteriaRaw, toolsRaw, validate] = await Promise.all([
            readOptionalFile(join(mikroDir, "SYSTEM.md")),
            readOptionalFile(join(mikroDir, "CRITERIA.md")),
            readOptionalFile(join(mikroDir, "TOOLS.md")),
            loadValidateMd(join(mikroDir, "VALIDATE.md")),
        ]);
        const system = systemRaw?.trim() || null;
        const criteria = criteriaRaw?.trim() || null;
        const tools = toolsRaw ? parseToolsMd(toolsRaw) : [];
        return {
            ...partial,
            system,
            criteria,
            tools,
            validate,
        };
    }
    // No .mikro/mikro.yaml — return defaults
    return defaultConfig(dir, globalProviders);
}
/**
 * Check if any config exists in a directory.
 * Checks .mikro/mikro.yaml, then the legacy .rlmx/rlmx.yaml.
 */
export async function hasConfig(dir) {
    return ((await readOptionalFile(join(dir, ".mikro", "mikro.yaml"))) !== null ||
        (await readOptionalFile(join(dir, ".rlmx", "rlmx.yaml"))) !== null);
}
const warnedLegacyDirs = new Set();
/** Emit the legacy-config warning once per directory per process. */
function warnLegacyConfig(legacyDir) {
    if (warnedLegacyDirs.has(legacyDir))
        return;
    warnedLegacyDirs.add(legacyDir);
    process.stderr.write(`mikro: reading legacy config from ${legacyDir} — run \`mikro migrate --apply\` to rename it to .mikro/mikro.yaml\n`);
}
//# sourceMappingURL=config.js.map