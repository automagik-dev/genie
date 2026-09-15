import { DEADLINE_MS, MAX_OUTPUT } from './process';

/**
 * Per-row configuration for the four Genie rows, and the one place their
 * defaults live.
 *
 * Every key has a default, so an operator who inserts a row with no `config`
 * block gets exactly today's behaviour. Each `resolve*` function below is pure
 * and is the ONLY implementation: the Standard Schema objects the DSH loader
 * validates against (`Config`) are thin wrappers around the same function, so a
 * unit test and a live profile can never disagree about what a config means.
 *
 * A hand-written validator is deliberate. The Host bundle is fully bundled by
 * esbuild from a dependency-free source tree, and cordis only requires a
 * Standard Schema object (`runtime.Config['~standard'].validate`, cordis
 * lib/index.js resolveConfig) — not schemastery specifically. Adding
 * schemastery would mean either bundling a library into every release tarball
 * or resolving a peer that the link:-installed profile does not hoist.
 */

/**
 * The socket idle deadline MUST outlive the Genie budget the handler itself
 * enforces. Armed at or below it, Node's socket timer destroys the connection
 * before the handler can answer, so the deadline 400 is written to a dead
 * socket and the browser sees a network error instead of the message (F6).
 */
export const SOCKET_MARGIN_MS = 5_000;
/** The absolute ceiling for the derived socket deadline, whatever an operator asks for. */
export const MAX_SOCKET_DEADLINE_MS = 120_000;
/** The smallest handler budget that can survive a cold `genie --version`. */
export const MIN_DEADLINE_MS = 1_000;
/** The smallest output budget a single board aggregate can plausibly need. */
export const MIN_OUTPUT_BUDGET_BYTES = 64 * 1024;

export interface ManagerConfig {
  deadlineMs: number;
  outputBudgetBytes: number;
}
export interface BoardConfig {
  order: number;
}
export interface SkillsConfig {
  order: number;
  groupBy: 'category' | 'name';
}
export interface WorkflowsConfig {
  order: number;
}

/** The socket deadline is DERIVED from the same value the handler budget uses; it is never configured apart from it. */
export function socketDeadlineOf(config: ManagerConfig): number {
  return config.deadlineMs + SOCKET_MARGIN_MS;
}

/** One issue per rejected key, in the shape cordis renders into `invalid config:`. */
export interface ConfigIssue {
  message: string;
  path: [string];
}
export class ConfigError extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(issues.map((issue) => `${issue.message} (at ${issue.path.join('.')})`).join('; '));
    this.name = 'ConfigError';
  }
}

function fields(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input))
    throw new ConfigError([{ message: 'expected an object', path: ['config'] }]);
  return input as Record<string, unknown>;
}

function integer(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  issues: ConfigIssue[],
): number {
  const raw = source[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    issues.push({ message: `expected an integer between ${min} and ${max}`, path: [key] });
    return fallback;
  }
  return raw;
}

function choice<T extends string>(
  source: Record<string, unknown>,
  key: string,
  fallback: T,
  allowed: readonly T[],
  issues: ConfigIssue[],
): T {
  const raw = source[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    issues.push({ message: `expected one of ${allowed.join(', ')}`, path: [key] });
    return fallback;
  }
  return raw as T;
}

function settled<T>(value: T, issues: ConfigIssue[]): T {
  if (issues.length) throw new ConfigError(issues);
  return value;
}

export function resolveManagerConfig(input?: unknown): ManagerConfig {
  const source = fields(input);
  const issues: ConfigIssue[] = [];
  const config: ManagerConfig = {
    // Refinement: the derived socket deadline must strictly outlive the handler
    // budget AND stay under the hard ceiling, so the upper bound is expressed
    // against MAX_SOCKET_DEADLINE_MS rather than as a second free number.
    deadlineMs: integer(
      source,
      'deadlineMs',
      DEADLINE_MS,
      MIN_DEADLINE_MS,
      MAX_SOCKET_DEADLINE_MS - SOCKET_MARGIN_MS,
      issues,
    ),
    // Refinement: a hard maximum. A larger budget cannot help — `execute`
    // buffers the whole answer in memory before the browser sees any of it.
    outputBudgetBytes: integer(source, 'outputBudgetBytes', MAX_OUTPUT, MIN_OUTPUT_BUDGET_BYTES, MAX_OUTPUT, issues),
  };
  return settled(config, issues);
}

export function resolveBoardConfig(input?: unknown): BoardConfig {
  const source = fields(input);
  const issues: ConfigIssue[] = [];
  return settled({ order: integer(source, 'order', 10, 0, 1_000, issues) }, issues);
}

export function resolveSkillsConfig(input?: unknown): SkillsConfig {
  const source = fields(input);
  const issues: ConfigIssue[] = [];
  return settled(
    {
      order: integer(source, 'order', 11, 0, 1_000, issues),
      groupBy: choice(source, 'groupBy', 'category', ['category', 'name'] as const, issues),
    },
    issues,
  );
}

export function resolveWorkflowsConfig(input?: unknown): WorkflowsConfig {
  const source = fields(input);
  const issues: ConfigIssue[] = [];
  return settled({ order: integer(source, 'order', 12, 0, 1_000, issues) }, issues);
}

/** Minimal Standard Schema surface: exactly what cordis `resolveConfig` reads. */
export interface StandardSchema<T> {
  '~standard': {
    version: 1;
    vendor: string;
    validate(value: unknown): { value: T } | { issues: ConfigIssue[] };
  };
}

/** Wrap a pure resolver as the Standard Schema the DSH loader validates a row's `config` against. */
export function schemaOf<T>(resolve: (input?: unknown) => T): StandardSchema<T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'automagik-genie',
      validate(value: unknown) {
        try {
          return { value: resolve(value) };
        } catch (failure) {
          if (failure instanceof ConfigError) return { issues: failure.issues };
          return {
            issues: [
              { message: failure instanceof Error ? failure.message : 'invalid config', path: ['config'] as [string] },
            ],
          };
        }
      },
    },
  };
}
