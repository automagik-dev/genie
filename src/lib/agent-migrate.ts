/**
 * Agent Migrate — One-shot `AGENTS.md` frontmatter → `agent.yaml` migration.
 *
 * Idempotent: a second call on an already-migrated agent returns
 * `{ migrated: false, reason: 'already-migrated' }` and makes zero
 * filesystem writes.
 *
 * Behavior (on the first call when frontmatter exists):
 *   1. Extract frontmatter from `AGENTS.md` via {@link extractFrontmatterFromAgentsMd}.
 *   2. Parse the frontmatter YAML. Malformed input throws with a clear
 *      error and leaves every file on disk untouched (no partial state).
 *   3. Strip derived fields (`name`) that never belong in `agent.yaml`.
 *   4. Merge with `dbRow` for fields the frontmatter omits. Precedence:
 *      **frontmatter wins** when both set the same field (source-of-truth
 *      principle — the file the human edits is authoritative).
 *   5. Validate the merged config via {@link AgentConfigSchema}. Fields
 *      outside the schema (notably `skill`, `extraArgs` from the DB row)
 *      are filtered before validation so `.strict()` does not reject them.
 *   6. Write `agent.yaml` via {@link writeAgentYaml} (atomic, locked).
 *   7. Copy the original `AGENTS.md` to `AGENTS.md.bak` byte-for-byte.
 *   8. Rewrite `AGENTS.md` with the post-frontmatter body only.
 *
 * Wish: `.genie/wishes/dir-sync-frontmatter-refresh/WISH.md` (Group 2).
 */

import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { type AgentConfig, AgentConfigSchema, extractFrontmatterFromAgentsMd, writeAgentYaml } from './agent-yaml.js';

/**
 * Subset of an `agent_templates` row (or adjacent DB sources) that can carry
 * any `AgentConfig`-shaped fallback. Fields absent from {@link AgentConfigSchema}
 * (e.g. `skill`, `extraArgs` — the DB-only fields carved out by the wish's
 * scope OUT) are silently dropped during merge.
 */
export type AgentTemplateRow = Partial<AgentConfig> & {
  /** Agent id (for error messages only — never written to yaml). */
  id?: string;
  /** Legacy / DB-only fields that must NOT survive into agent.yaml. */
  skill?: string | null;
  extra_args?: unknown;
  extraArgs?: unknown;
};

/**
 * Outcome of a migration attempt.
 *
 * Intentionally NOT exported — callers infer via
 * `Awaited<ReturnType<typeof migrateAgentToYaml>>` so this module owns the
 * shape and downstream groups don't have to re-import a type that's only
 * meaningful here. The dead-code scanner (knip) would otherwise flag a
 * ground export as unused until a later group consumes it.
 */
type MigrationResult =
  | {
      migrated: true;
      yamlPath: string;
      bakPath: string;
    }
  | {
      migrated: false;
      reason: 'already-migrated' | 'no-frontmatter';
      yamlPath: string;
    };

/**
 * Top-level keys allowed in `agent.yaml`, derived once from the Zod schema so
 * this module never drifts from Group 1's source of truth. Derived fields
 * (`name`, `dir`, `registeredAt`) are intentionally EXCLUDED — they are stripped
 * by {@link writeAgentYaml} and must not appear in `agent.yaml`.
 */
const YAML_ALLOWED_KEYS: ReadonlySet<string> = (() => {
  const shape = (AgentConfigSchema as { _def: { shape: () => Record<string, unknown> } })._def.shape();
  const keys = new Set<string>(Object.keys(shape));
  keys.delete('name');
  keys.delete('dir');
  keys.delete('registeredAt');
  return keys;
})();

/**
 * Migrate `<agentDir>/AGENTS.md` frontmatter into `<agentDir>/agent.yaml`.
 *
 * @param agentDir absolute path to the agent's directory
 * @param dbRow    optional fallback source for fields missing from frontmatter
 */
export async function migrateAgentToYaml(agentDir: string, dbRow?: AgentTemplateRow): Promise<MigrationResult> {
  const yamlPath = join(agentDir, 'agent.yaml');
  const agentsMdPath = join(agentDir, 'AGENTS.md');
  const bakPath = `${agentsMdPath}.bak`;

  // (a) idempotency guard — agent.yaml already exists
  if (existsSync(yamlPath)) {
    return { migrated: false, reason: 'already-migrated', yamlPath };
  }

  // (b) read AGENTS.md and split frontmatter
  const agentsMdRaw = await readFile(agentsMdPath, 'utf-8');
  const { frontmatter, body } = extractFrontmatterFromAgentsMd(agentsMdRaw);

  // (c) no frontmatter → nothing to migrate
  if (frontmatter === null) {
    return { migrated: false, reason: 'no-frontmatter', yamlPath };
  }

  // (d) parse frontmatter YAML — malformed input throws before any write
  const fmParsed = parseFrontmatter(frontmatter, agentsMdPath);

  // (e) strip derived/DB-only fields, then merge with dbRow (frontmatter wins)
  const fmClean = pickYamlFields(fmParsed);
  const dbClean = dbRow ? pickYamlFields(dbRow as Record<string, unknown>) : {};
  const merged = { ...dbClean, ...fmClean };

  // Validate the merged config — any remaining unknown key fails here with a
  // field-named error, before any disk write.
  const config = AgentConfigSchema.parse(merged) as AgentConfig;

  // (f) write agent.yaml atomically (locked by writeAgentYaml)
  await writeAgentYaml(yamlPath, config);

  // (g) byte-for-byte backup of the original AGENTS.md
  await copyFile(agentsMdPath, bakPath);

  // (h) rewrite AGENTS.md with the body-only content
  await writeFile(agentsMdPath, body);

  return { migrated: true, yamlPath, bakPath };
}

/** Parse a frontmatter string into a plain object, or throw a descriptive error. */
function parseFrontmatter(frontmatter: string, sourcePath: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = yaml.load(frontmatter);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed frontmatter in ${sourcePath}: ${msg}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Malformed frontmatter in ${sourcePath}: expected a YAML mapping at the top level`);
  }
  return raw as Record<string, unknown>;
}

/**
 * Filter a record to only keys that are valid `agent.yaml` top-level fields.
 * Unknown keys (e.g. `skill`, `extra_args`, derived `name`) are dropped so the
 * merged result passes `AgentConfigSchema.parse` without a `.strict()`
 * violation.
 */
function pickYamlFields(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    if (YAML_ALLOWED_KEYS.has(k) && v !== null && v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}
