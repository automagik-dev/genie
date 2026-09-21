/**
 * Loader configuration.
 *
 * The row is deliberately small: the tool name, the model-facing result budget,
 * where full results are journalled, and how many roots can shadow each other.
 * Everything else is a decision the catalog makes, not this plugin.
 */

export interface LoaderConfig {
  /** The model-facing tool name. */
  toolName: string;
  /** Characters of the run's return value rendered to the model; the rest is journal-only. */
  maxResultChars: number;
  /** Where a full result is written. Empty resolves to `<DSH_HOME>/workflow-runs`. */
  journalDir: string;
  /** Refuse a name that exists in both roots — contract: never rely on shadowing. */
  allowShadowing: boolean;
  /** The personal root. Empty resolves to `~/.claude/workflows`. */
  userRoot: string;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: Array<{ message: string; path: string[] }>,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

function fields(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigError('expected an object', [{ message: 'expected an object', path: ['config'] }]);
  }
  return input as Record<string, unknown>;
}

export function resolveLoaderConfig(input?: unknown): LoaderConfig {
  const source = fields(input);
  const issues: Array<{ message: string; path: string[] }> = [];
  const rawName = source.toolName;
  if (rawName !== undefined && (typeof rawName !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(rawName))) {
    issues.push({ message: 'expected a lowercase tool name', path: ['toolName'] });
  }
  const rawChars = source.maxResultChars;
  if (
    rawChars !== undefined &&
    (typeof rawChars !== 'number' || !Number.isInteger(rawChars) || rawChars < 1000 || rawChars > 500000)
  ) {
    issues.push({ message: 'expected an integer between 1000 and 500000', path: ['maxResultChars'] });
  }
  const rawDir = source.journalDir;
  // `''` is the shipped patch's spelling for "not configured" and resolves to
  // `<DSH_HOME>/workflow-runs`; only a non-string is a fault.
  if (rawDir !== undefined && typeof rawDir !== 'string') {
    issues.push({ message: 'expected a path string', path: ['journalDir'] });
  }
  const rawShadow = source.allowShadowing;
  if (rawShadow !== undefined && typeof rawShadow !== 'boolean') {
    issues.push({ message: 'expected a boolean', path: ['allowShadowing'] });
  }
  const rawUserRoot = source.userRoot;
  // `''` is what this resolver itself emits for "not configured", so it must
  // accept it back: cordis validates the patch through `validate()` and then
  // hands the RESOLVED object to `apply`, which resolves again. A resolver that
  // rejects its own output hangs the boot (found by the loader smoke).
  if (rawUserRoot !== undefined && typeof rawUserRoot !== 'string') {
    issues.push({ message: 'expected a path string', path: ['userRoot'] });
  }
  if (issues.length) {
    throw new ConfigError(issues.map((issue) => `${issue.message} (at ${issue.path.join('.')})`).join('; '), issues);
  }
  return {
    toolName: typeof rawName === 'string' ? rawName : 'workflow_run',
    maxResultChars: typeof rawChars === 'number' ? rawChars : 20000,
    journalDir: typeof rawDir === 'string' ? rawDir : '',
    allowShadowing: rawShadow === true,
    userRoot: typeof rawUserRoot === 'string' ? rawUserRoot : '',
  };
}

/** The standard-schema wrapper cordis validates a row's config with. */
export function schemaOf(resolve: (input?: unknown) => LoaderConfig) {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'automagik-genie',
      validate(value: unknown) {
        try {
          return { value: resolve(value) };
        } catch (failure) {
          if (failure instanceof ConfigError) return { issues: failure.issues };
          return {
            issues: [{ message: failure instanceof Error ? failure.message : 'invalid config', path: ['config'] }],
          };
        }
      },
    },
  };
}
