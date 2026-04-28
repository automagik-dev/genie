/**
 * Cascading Defaults — Pure-function resolver for agent configuration fields.
 *
 * Resolution chain (first non-absent value wins):
 *   1. Agent frontmatter (explicit declaration in AGENTS.md)
 *   2. Parent agent frontmatter (sub-agents only — top-level agent whose .genie/agents/ contains this sub-agent)
 *   3. Workspace defaults (workspace.json → agents.defaults)
 *   4. Built-in defaults (BUILTIN_DEFAULTS constant)
 *
 * Zero runtime dependencies on filesystem, PG, or tmux — pure functions only.
 */

// ============================================================================
// Constants
// ============================================================================

/**
 * Built-in defaults — the last fallback in the resolution chain.
 * Every field that supports cascading defaults must appear here.
 */
export const BUILTIN_DEFAULTS: AgentDefaults = {
  model: 'opus',
  promptMode: 'append',
  color: 'blue',
  effort: 'high',
  thinking: 'enabled',
  permissionMode: 'auto',
};

/** Type of the built-in defaults object. Runtime values can be any string (not just the defaults). */
export interface AgentDefaults {
  model: string;
  promptMode: string;
  color: string;
  effort: string;
  thinking: string;
  permissionMode: string;
}

/** Keys that participate in cascading resolution. */
export type DefaultField = keyof AgentDefaults;

/** Fields surfaced in `dir ls` / `dir export`. Additive — future fields just extend this array. */
export const RESOLVED_FIELDS: readonly DefaultField[] = ['model'] as const;

// ============================================================================
// Source taxonomy for dir ls / dir export
// ============================================================================

type ResolvedSource = 'explicit' | `parent:${string}` | 'workspace' | 'built-in';

interface ResolvedValue<T = string> {
  value: T;
  source: ResolvedSource;
}

// ============================================================================
// Resolver context
// ============================================================================

/** Context needed for field resolution. */
export interface ResolveContext {
  /** Workspace-level agent defaults (from workspace.json → agents.defaults). */
  workspaceDefaults?: Partial<AgentDefaults>;
  /** Parent agent's frontmatter fields (sub-agents only). */
  parent?: {
    name: string;
    fields: Partial<Record<DefaultField, unknown>>;
  };
}

/** Minimal agent shape needed by the resolver — avoids coupling to full DirectoryEntry. */
interface AgentFields {
  [key: string]: unknown;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Normalize a value — treats undefined, null, empty string, and the literal
 * "inherit" as absent (returns undefined). Everything else passes through.
 *
 * This is the forgiving layer that prevents unhealed `model: inherit` files
 * from breaking spawn — the resolver treats "inherit" as if the field was absent.
 */
export function normalizeValue<T>(v: T | undefined | null): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === '') return undefined;
  if (v === 'inherit') return undefined;
  return v;
}

// ============================================================================
// Resolver
// ============================================================================

/**
 * Resolve a single field through the 4-step cascading chain.
 * Returns the first non-absent value found, or the built-in default.
 *
 * Chain:
 *   1. Agent's own frontmatter value
 *   2. Parent agent's value (sub-agents only, skipped for top-level)
 *   3. Workspace defaults (workspace.json → agents.defaults)
 *   4. Built-in defaults constant
 */
export function resolveField<K extends DefaultField>(
  agent: AgentFields,
  field: K,
  ctx: ResolveContext,
): AgentDefaults[K] {
  return resolveFieldWithSource(agent, field, ctx).value;
}

/**
 * Resolve a field AND return which level of the chain provided the value.
 * Used by `dir ls` / `dir export` to annotate the source column.
 */
export function resolveFieldWithSource<K extends DefaultField>(
  agent: AgentFields,
  field: K,
  ctx: ResolveContext,
): ResolvedValue<AgentDefaults[K]> {
  // Step 1: Agent's own frontmatter
  const agentVal = normalizeValue(agent[field] as AgentDefaults[K] | undefined | null);
  if (agentVal !== undefined) {
    return { value: agentVal, source: 'explicit' };
  }

  // Step 2: Parent agent (sub-agents only)
  if (ctx.parent) {
    const parentVal = normalizeValue(ctx.parent.fields[field] as AgentDefaults[K] | undefined | null);
    if (parentVal !== undefined) {
      return { value: parentVal, source: `parent:${ctx.parent.name}` };
    }
  }

  // Step 3: Workspace defaults
  if (ctx.workspaceDefaults) {
    const wsVal = normalizeValue(ctx.workspaceDefaults[field] as AgentDefaults[K] | undefined | null);
    if (wsVal !== undefined) {
      return { value: wsVal, source: 'workspace' };
    }
  }

  // Step 4: Built-in defaults (always present)
  return { value: BUILTIN_DEFAULTS[field], source: 'built-in' };
}

/**
 * Compute effective defaults by merging workspace defaults over built-in defaults.
 * Returns the value that would be used for any agent that doesn't declare a field.
 *
 * Shared by:
 *   - Scaffold template (renders commented defaults with effective values)
 *   - Resolver (steps 3-4 collapse to this when no agent/parent value exists)
 */
export function computeEffectiveDefaults(workspaceDefaults?: Partial<AgentDefaults>): AgentDefaults {
  if (!workspaceDefaults) return { ...BUILTIN_DEFAULTS };

  const result = { ...BUILTIN_DEFAULTS } as Record<DefaultField, string>;
  for (const key of Object.keys(BUILTIN_DEFAULTS) as DefaultField[]) {
    const wsVal = normalizeValue(workspaceDefaults[key]);
    if (wsVal !== undefined) {
      result[key] = wsVal as string;
    }
  }
  return result as unknown as AgentDefaults;
}
