import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ZodDefault, ZodEffects, ZodNullable, ZodObject, ZodOptional, type ZodTypeAny } from 'zod';
import { type GenieConfig, GenieConfigSchema } from '../types/genie-config.js';
import { atomicWriteFileSync } from './atomic-fs.js';
import { genieHome } from './workspace.js';

/**
 * Get the path to the genie config directory.
 * Honors GENIE_HOME (which relocates ALL global state) and resolves lazily so
 * env overrides in tests and spawned subprocesses take effect.
 */
export function getGenieDir(): string {
  return genieHome();
}

/**
 * Get the path to the genie config file
 */
export function getGenieConfigPath(): string {
  return join(genieHome(), 'config.json');
}

/**
 * Check if genie config exists
 */
export function genieConfigExists(): boolean {
  return existsSync(getGenieConfigPath());
}

/**
 * Ensure the genie config directory exists
 */
function ensureGenieDir(): void {
  const dir = getGenieDir();
  if (!existsSync(dir)) {
    // GENIE_HOME itself — 0o700 so it is safe even when this runs before any
    // lease-owning creator, rather than relying on call ordering.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load genie config, returning defaults if not found
 */
export async function loadGenieConfig(): Promise<GenieConfig> {
  const configPath = getGenieConfigPath();
  if (!existsSync(configPath)) {
    return GenieConfigSchema.parse({});
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const data = JSON.parse(content) as Record<string, unknown>;
    // Configs written before runtime selection launched Claude implicitly.
    if (data.runtime === undefined) data.runtime = { defaultAgent: 'claude' };
    return GenieConfigSchema.parse(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: Invalid genie config, using defaults: ${message}`);
    return GenieConfigSchema.parse({});
  }
}

/**
 * Save genie config to disk
 */
export async function saveGenieConfig(config: GenieConfig): Promise<void> {
  ensureGenieDir();

  try {
    const validated = GenieConfigSchema.parse(config);
    const content = JSON.stringify(validated, null, 2);
    // Atomic publish (private staging sibling -> fsync -> rename): a crash mid-write
    // leaves the PRIOR config intact rather than a truncated one that would fail the
    // next parse and silently fall back to defaults.
    atomicWriteFileSync(getGenieConfigPath(), content, { mode: 0o600 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to save genie config: ${message}`);
  }
}

/**
 * Get the default genie config
 */
function getDefaultGenieConfig(): GenieConfig {
  return GenieConfigSchema.parse({});
}

/**
 * Contract home directory to ~ in a path (for display)
 */
export function contractPath(path: string): string {
  const home = homedir();
  if (path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  if (path === home) {
    return '~';
  }
  return path;
}

// ============================================================================
// New helper functions for v2 config
// ============================================================================

/**
 * Mark setup as complete
 */
export async function markSetupComplete(): Promise<void> {
  const config = await loadGenieConfig();
  config.setupComplete = true;
  config.lastSetupAt = new Date().toISOString();
  await saveGenieConfig(config);
}

/**
 * Reset config to defaults
 */
export async function resetConfig(): Promise<void> {
  const defaultConfig = getDefaultGenieConfig();
  await saveGenieConfig(defaultConfig);
}

// ============================================================================
// Worker Profile helpers
// ============================================================================

// ============================================================================
// Council preset helpers
// ============================================================================

// ============================================================================
// Read-only dotted-key resolution (`genie config get <dotted.key>`)
// ============================================================================
//
// The schema is the key namespace. A dotted path is walked against
// `GenieConfigSchema` itself, so only keys the schema declares are readable and
// a typo is refused instead of answering `undefined` — which an operator would
// read as "the knob exists and is unset". The VALUE comes from the parsed
// config (defaults applied); the SOURCE says whether the on-disk file actually
// carried that path, which is the difference between "genie's default" and
// "someone configured this".

/** Where a resolved value came from: the schema's default, or the config file on disk. */
export type ConfigValueSource = 'default' | 'file';

export interface ResolvedConfigValue {
  key: string;
  /** Parsed value at `key`; `undefined` when the key is optional and unset. */
  value: unknown;
  source: ConfigValueSource;
}

/** A dotted key that the config schema does not declare. Carries the operator-facing text. */
export class UnknownConfigKeyError extends Error {
  constructor(public readonly key: string) {
    super(`unknown config key: ${key}`);
    this.name = 'UnknownConfigKeyError';
  }
}

/** Strip the wrappers that carry a value type (`.default()`, `.optional()`, `.transform()`, ...). */
function unwrapSchema(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof ZodDefault || current instanceof ZodOptional || current instanceof ZodNullable) {
      current = current._def.innerType as ZodTypeAny;
    } else if (current instanceof ZodEffects) {
      current = current._def.schema as ZodTypeAny;
    } else {
      return current;
    }
  }
}

function splitConfigKey(key: string): string[] {
  const segments = key.split('.');
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) return [];
  return segments;
}

/**
 * True when `segments` names a leaf or branch the schema declares. Open-ended
 * containers (`z.record`, `z.array`) stop the walk: their members are user data,
 * not schema keys, so they are deliberately not addressable here.
 */
export function configSchemaHasKey(key: string): boolean {
  const segments = splitConfigKey(key);
  if (segments.length === 0) return false;
  let current: ZodTypeAny = GenieConfigSchema;
  for (const segment of segments) {
    const unwrapped = unwrapSchema(current);
    if (!(unwrapped instanceof ZodObject)) return false;
    const shape = unwrapped.shape as Record<string, ZodTypeAny>;
    if (!Object.hasOwn(shape, segment)) return false;
    current = shape[segment];
  }
  return true;
}

function readPath(root: unknown, segments: string[]): { present: boolean; value: unknown } {
  let current = root;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || Array.isArray(current))
      return { present: false, value: undefined };
    const record = current as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) return { present: false, value: undefined };
    current = record[segment];
  }
  return { present: true, value: current };
}

/**
 * The on-disk config object, or `null` when it did not contribute to the loaded
 * value. A file that is absent, unreadable, or REJECTED by the schema is `null`
 * on purpose: `loadGenieConfig` defaults past all three, so reporting `file` for
 * one of them would attribute a default to a config that was never honoured —
 * exactly the case a `.max()` ceiling creates when someone edits a budget past it.
 */
function readHonouredConfigObject(): unknown {
  const configPath = getGenieConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    GenieConfigSchema.parse({ runtime: { defaultAgent: 'claude' }, ...data });
    return data;
  } catch {
    return null;
  }
}

/**
 * Resolve one schema key to its effective value and its provenance.
 * Throws {@link UnknownConfigKeyError} for a key the schema does not declare.
 */
export async function resolveConfigKey(key: string): Promise<ResolvedConfigValue> {
  if (!configSchemaHasKey(key)) throw new UnknownConfigKeyError(key);
  const segments = splitConfigKey(key);
  const config = await loadGenieConfig();
  const { value } = readPath(config, segments);
  const raw = readHonouredConfigObject();
  const source: ConfigValueSource = raw !== null && readPath(raw, segments).present ? 'file' : 'default';
  return { key, value, source };
}
