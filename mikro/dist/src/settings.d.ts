/**
 * Global settings management for mikro.
 *
 * Stores API keys and defaults in ~/.mikro/settings.json.
 *
 * Priority: CLI flags > settings.json > mikro.yaml > hardcoded defaults.
 *
 * settings.json beats mikro.yaml, not the other way round: the point of
 * `mikro config set model.provider …` is that it takes effect in a checkout that
 * already has its own `model:` block, so `applySettingsModelOverrides`
 * (src/cli.ts:33-39) is applied *after* `loadConfig` (src/cli.ts:324-325). This
 * comment said the reverse until 2026-07-27; the ordering was never what it
 * claimed, and it matters — pinning a recursive child's model works only
 * because settings.json outranks the ambient yaml.
 */
export interface GlobalSettings {
    [key: string]: unknown;
}
export declare function getSettingsDir(): string;
export declare function getSettingsPath(): string;
export declare function loadSettings(): Promise<GlobalSettings>;
export declare function saveSettings(settings: GlobalSettings): Promise<void>;
/**
 * Inject API keys from settings into process.env.
 * Only sets env vars that are NOT already set (env takes priority).
 */
export declare function injectApiKeysToEnv(settings: GlobalSettings): void;
/** Check if a key is sensitive (contains API_KEY, SECRET, or TOKEN) */
export declare function isSensitiveKey(key: string): boolean;
/** Mask a value for display: "val...lue" (first 3 + last 3) */
export declare function maskValue(value: string): string;
/** Format a value for display, masking if sensitive */
export declare function formatValue(key: string, value: unknown): string;
/**
 * Parse a settings value with type coercion.
 * Numbers, booleans, and arrays (comma-separated) are auto-detected.
 */
export declare function parseSettingValue(value: string): unknown;
//# sourceMappingURL=settings.d.ts.map