/**
 * Agent YAML — Single source of truth for `agent.yaml` schema, parsing, and writing.
 *
 * Mirrors {@link DirectoryEntry} (src/lib/agent-directory.ts) field-for-field
 * using the exact TypeScript field names. Zod schema is `.strict()` at every
 * object level so unknown keys are rejected with a clear, field-named error.
 *
 * Derived fields:
 *   - `name` — derived from the agent directory name
 *   - `dir` — derived from the absolute path where the yaml lives
 *   - `registeredAt` — derived from file mtime
 *
 * All three are accepted by the schema for round-trip ergonomics but are
 * STRIPPED by {@link writeAgentYaml} before serialization so they never leak
 * into the on-disk representation.
 *
 * Concurrent writes are safe: `writeAgentYaml` uses the shared `lockfile`
 * module to serialize writers and writes atomically via `${path}.tmp` +
 * `rename`, so a reader can never observe a partial/spliced file.
 *
 * Scope guard: top-level keys that are OUT of scope for the current wish
 * (notably `skill`, `extraArgs`) are rejected by `.strict()` with an error
 * that names the offending key.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { acquireLock, releaseLock } from './lockfile.js';

// ============================================================================
// Zod Schemas — mirror SdkDirectoryConfig + DirectoryEntry
// ============================================================================

// Primitive / union building blocks from SdkDirectoryConfig.
const SdkPermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
  'remoteApproval',
]);

const SdkEffortLevelSchema = z.union([z.enum(['low', 'medium', 'high', 'max']), z.number()]);

const SdkThinkingConfigSchema = z.union([
  z.object({ type: z.literal('adaptive') }).strict(),
  z.object({ type: z.literal('enabled'), budgetTokens: z.number().optional() }).strict(),
  z.object({ type: z.literal('disabled') }).strict(),
]);

const SdkMcpStdioServerConfigSchema = z
  .object({
    type: z.literal('stdio').optional(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  })
  .strict();

const SdkMcpSSEServerConfigSchema = z
  .object({
    type: z.literal('sse'),
    url: z.string(),
    headers: z.record(z.string()).optional(),
  })
  .strict();

const SdkMcpHttpServerConfigSchema = z
  .object({
    type: z.literal('http'),
    url: z.string(),
    headers: z.record(z.string()).optional(),
  })
  .strict();

const SdkMcpServerConfigSchema = z.union([
  SdkMcpStdioServerConfigSchema,
  SdkMcpSSEServerConfigSchema,
  SdkMcpHttpServerConfigSchema,
]);

const SdkSubagentConfigSchema = z
  .object({
    description: z.string(),
    prompt: z.string(),
    tools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    model: z.string().optional(),
    mcpServers: z.array(z.union([z.string(), z.record(SdkMcpStdioServerConfigSchema)])).optional(),
    skills: z.array(z.string()).optional(),
    maxTurns: z.number().optional(),
    background: z.boolean().optional(),
    memory: z.enum(['user', 'project', 'local']).optional(),
    effort: SdkEffortLevelSchema.optional(),
    permissionMode: SdkPermissionModeSchema.optional(),
  })
  .strict();

const SdkCustomToolConfigSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.unknown()),
    handler: z.string().optional(),
  })
  .strict();

const SdkOutputFormatSchema = z
  .object({
    type: z.literal('json_schema'),
    schema: z.record(z.unknown()),
  })
  .strict();

const SdkPluginConfigSchema = z
  .object({
    type: z.literal('local'),
    path: z.string(),
  })
  .strict();

const SdkSandboxConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    autoAllowBashIfSandboxed: z.boolean().optional(),
    failIfUnavailable: z.boolean().optional(),
    network: z
      .object({
        allowLocalBinding: z.boolean().optional(),
        allowUnixSockets: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const SdkHookMatcherConfigSchema = z
  .object({
    toolName: z.string().optional(),
    agentName: z.string().optional(),
  })
  .strict();

const SdkHookEventSchema = z.enum([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
]);

const SdkBetaSchema = z.enum(['context-1m-2025-08-07']);

const SdkSystemPromptSchema = z.union([
  z.string(),
  z
    .object({
      type: z.literal('preset'),
      preset: z.literal('claude_code'),
      append: z.string().optional(),
    })
    .strict(),
]);

const SdkDirectoryConfigSchema = z
  .object({
    permissionMode: SdkPermissionModeSchema.optional(),
    tools: z
      .union([z.array(z.string()), z.object({ type: z.literal('preset'), preset: z.literal('claude_code') }).strict()])
      .optional(),
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    maxTurns: z.number().optional(),
    maxBudgetUsd: z.number().optional(),
    effort: SdkEffortLevelSchema.optional(),
    thinking: SdkThinkingConfigSchema.optional(),
    agent: z.string().optional(),
    agents: z.record(SdkSubagentConfigSchema).optional(),
    mcpServers: z.record(SdkMcpServerConfigSchema).optional(),
    plugins: z.array(SdkPluginConfigSchema).optional(),
    customTools: z.array(SdkCustomToolConfigSchema).optional(),
    persistSession: z.boolean().optional(),
    enableFileCheckpointing: z.boolean().optional(),
    outputFormat: SdkOutputFormatSchema.optional(),
    includePartialMessages: z.boolean().optional(),
    includeHookEvents: z.boolean().optional(),
    promptSuggestions: z.boolean().optional(),
    agentProgressSummaries: z.boolean().optional(),
    systemPrompt: SdkSystemPromptSchema.optional(),
    sandbox: SdkSandboxConfigSchema.optional(),
    betas: z.array(SdkBetaSchema).optional(),
    settingSources: z.array(z.enum(['user', 'project', 'local'])).optional(),
    settings: z.union([z.string(), z.record(z.unknown())]).optional(),
    hooks: z.record(SdkHookEventSchema, z.array(SdkHookMatcherConfigSchema)).optional(),
  })
  .strict();

/**
 * Zod schema mirroring `DirectoryEntry` from `src/lib/agent-directory.ts`.
 *
 * All object levels are `.strict()` so unknown keys (including out-of-scope
 * fields like `skill` or `extraArgs`) produce an error naming the offender.
 *
 * The three derived fields (`name`, `dir`, `registeredAt`) are accepted on
 * parse for round-trip ergonomics but {@link writeAgentYaml} strips them
 * before serialization so they never land on disk.
 */
export const AgentConfigSchema = z
  .object({
    name: z.string().optional(),
    dir: z.string().optional(),
    repo: z.string().optional(),
    team: z.string().optional(),
    promptMode: z.enum(['system', 'append']).optional(),
    model: z.string().optional(),
    roles: z.array(z.string()).optional(),
    omniAgentId: z.string().optional(),
    registeredAt: z.string().optional(),
    description: z.string().optional(),
    color: z.string().optional(),
    provider: z.string().optional(),
    permissions: z
      .object({
        preset: z.string().optional(),
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
        bashAllowPatterns: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    disallowedTools: z.array(z.string()).optional(),
    omniScopes: z.array(z.string()).optional(),
    hooks: z.record(z.unknown()).optional(),
    sdk: SdkDirectoryConfigSchema.optional(),
    bridgeTmuxSession: z.string().optional(),
  })
  .strict();

/**
 * The parsed, validated shape of an `agent.yaml` file.
 *
 * All fields are optional because derived fields (`name`, `dir`, `registeredAt`)
 * are NOT written to disk and callers may want to construct partial configs.
 * Callers requiring a fully-specified `DirectoryEntry` should hydrate the
 * derived fields from filesystem context.
 */
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ============================================================================
// Derived-field handling
// ============================================================================

/** Keys derived from filesystem context — stripped before writing to disk. */
const DERIVED_KEYS = ['name', 'dir', 'registeredAt'] as const;

function stripDerivedFields(config: AgentConfig): AgentConfig {
  const out: Record<string, unknown> = { ...config };
  for (const key of DERIVED_KEYS) {
    delete out[key];
  }
  return out as AgentConfig;
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Read, parse, and validate an `agent.yaml` file at the given absolute path.
 *
 * Throws a descriptive `Error` on:
 *   - I/O failures (file missing, unreadable)
 *   - Malformed YAML (surfaces the js-yaml error verbatim)
 *   - Schema violations (surfaces the Zod error, which names the offending
 *     path including any unknown key or wrong type)
 */
export async function parseAgentYaml(path: string): Promise<AgentConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read agent.yaml at ${path}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed YAML in ${path}: ${message}`);
  }

  // `null`/empty files parse to `null`/`undefined` — treat as an empty object.
  const input = parsed === null || parsed === undefined ? {} : parsed;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(
      `agent.yaml at ${path} must be a YAML mapping, got ${Array.isArray(input) ? 'array' : typeof input}`,
    );
  }

  const result = AgentConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid agent.yaml at ${path}: ${formatZodError(result.error)}`);
  }
  return result.data;
}

/** Produce a concise, field-named error message from a ZodError. */
function formatZodError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    // Zod v3 emits `unrecognized_keys` for strict() violations — surface the key names.
    if (issue.code === 'unrecognized_keys') {
      const keys = (issue as z.ZodIssue & { keys: string[] }).keys.join(', ');
      return `unknown field(s) at ${path}: ${keys}`;
    }
    return `${path}: ${issue.message}`;
  });
  return issues.join('; ');
}

// ============================================================================
// Writing
// ============================================================================

/**
 * Serialize `config` to YAML and write it atomically to `path`.
 *
 * Derived fields (`name`, `dir`, `registeredAt`) are stripped before
 * serialization so they never appear on disk.
 *
 * The write is protected by {@link acquireLock} and performed atomically
 * (`${path}.tmp` + `rename`) so concurrent writers and concurrent readers
 * never observe a partial/spliced file.
 */
export async function writeAgentYaml(path: string, config: AgentConfig): Promise<void> {
  const stripped = stripDerivedFields(config);
  const yamlStr = yaml.dump(stripped, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
  });

  await acquireLock(path);
  try {
    const tmpPath = `${path}.tmp`;
    await writeFile(tmpPath, yamlStr, 'utf-8');
    await rename(tmpPath, path);
  } finally {
    await releaseLock(path);
  }
}

// ============================================================================
// Frontmatter extraction (pure helper — no I/O)
// ============================================================================

/**
 * Split an AGENTS.md string into its leading YAML frontmatter block and body.
 *
 * Detects the `---\n...\n---\n` fence AT THE VERY START of the content (byte 0).
 * Returns `{ frontmatter: <YAML text, no fences>, body: <everything after
 * the closing fence including any following newline> }` when found, else
 * `{ frontmatter: null, body: content }`.
 *
 * Body preservation is byte-for-byte: CRLF endings, trailing newlines, and
 * Unicode characters round-trip without modification.
 *
 * Pure function — no I/O, no mutation, safe to call from any context.
 */
export function extractFrontmatterFromAgentsMd(content: string): { frontmatter: string | null; body: string } {
  // Must start at byte 0 with exactly `---\n` (no leading BOM, no leading
  // whitespace). Without this anchor we'd accidentally match mid-file HR.
  if (!content.startsWith('---\n')) {
    return { frontmatter: null, body: content };
  }

  // Find the closing fence. A line that is exactly `---`:
  //   - when the frontmatter has content, the fence is preceded by `\n` →
  //     match `\n---`.
  //   - when the frontmatter is empty (`---\n---\n...`), the fence begins
  //     immediately after the opener at position 0 of `after`.
  const after = content.slice(4); // skip the opening `---\n`
  let frontmatter: string;
  let afterClose: string;

  if (after.startsWith('---')) {
    frontmatter = '';
    afterClose = after.slice(3);
  } else {
    const closeIdx = after.indexOf('\n---');
    if (closeIdx === -1) {
      // Unclosed frontmatter — treat as "no frontmatter" rather than
      // swallowing the entire file body.
      return { frontmatter: null, body: content };
    }
    frontmatter = after.slice(0, closeIdx);
    afterClose = after.slice(closeIdx + 4);
  }

  // A trailing `\n` after the closing fence is optional — when present we
  // consume it so the body does not begin with a stray newline.
  const body = afterClose.startsWith('\n') ? afterClose.slice(1) : afterClose;

  return { frontmatter, body };
}
