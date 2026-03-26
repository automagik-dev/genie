/**
 * Manifest — Genie item manifest parsing, validation, and detection.
 *
 * Every registry item (agent, skill, app, board, workflow, stack, template, hook)
 * is described by a `genie.yaml` manifest. This module handles:
 * - Parsing YAML manifests into typed GenieManifest objects
 * - Validating manifests against type-specific rules
 * - Auto-detecting manifests from directory conventions (AGENTS.md, skill.md, etc.)
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as yaml from 'js-yaml';

// ============================================================================
// Types
// ============================================================================

export type ItemType = 'agent' | 'skill' | 'app' | 'board' | 'workflow' | 'stack' | 'template' | 'hook';

const ITEM_TYPES: ItemType[] = ['agent', 'skill', 'app', 'board', 'workflow', 'stack', 'template', 'hook'];

export interface StageConfig {
  name: string;
  label?: string;
  gate: 'human' | 'agent' | 'human+agent';
  action?: string;
  auto_advance?: boolean;
  roles?: string[];
  color?: string;
}

export interface StackItem {
  name: string;
  type: ItemType;
  source?: string;
  inline?: boolean;
  config?: Record<string, unknown>;
}

export interface GenieManifest {
  name: string;
  version: string;
  type: ItemType;
  description?: string;
  author?: { name: string; url?: string };
  agent?: { model?: string; promptMode?: string; roles?: string[]; entrypoint: string };
  skill?: { triggers?: string[]; entrypoint: string };
  app?: { runtime?: string; natsPrefix?: string; icon?: string; entrypoint: string };
  board?: { stages: StageConfig[] };
  workflow?: { cron: string; timezone?: string; command: string; run_spec?: Record<string, unknown> };
  stack?: { items: StackItem[] };
  dependencies?: string[];
  tags?: string[];
  category?: string;
  license?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a YAML string into a typed GenieManifest.
 *
 * Validates that required fields (name, type, version) are present and that
 * the type value is a recognized ItemType. Throws on invalid input.
 */
function parseManifest(yamlContent: string): GenieManifest {
  const raw = yaml.load(yamlContent);
  if (!raw || typeof raw !== 'object') {
    throw new Error('Manifest YAML is empty or not an object');
  }

  const obj = raw as Record<string, unknown>;

  if (!obj.name || typeof obj.name !== 'string') {
    throw new Error('Manifest is missing required field: name');
  }
  if (!obj.type || typeof obj.type !== 'string') {
    throw new Error('Manifest is missing required field: type');
  }
  if (!obj.version || typeof obj.version !== 'string') {
    throw new Error('Manifest is missing required field: version');
  }

  if (!ITEM_TYPES.includes(obj.type as ItemType)) {
    throw new Error(`Invalid item type "${obj.type}". Must be one of: ${ITEM_TYPES.join(', ')}`);
  }

  return obj as unknown as GenieManifest;
}

// ============================================================================
// Validation
// ============================================================================

const VALID_GATES = new Set(['human', 'agent', 'human+agent']);

/**
 * Validate a manifest against type-specific rules.
 *
 * Checks required fields, type-specific sections, entrypoint file existence,
 * board stage structure, cron format, and stack item completeness.
 * Returns a ValidationResult with errors (blockers) and warnings (advisory).
 */
export function validateManifest(manifest: GenieManifest, itemDir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required top-level fields
  if (!manifest.name) errors.push('Missing required field: name');
  if (!manifest.type) errors.push('Missing required field: type');
  if (!manifest.version) errors.push('Missing required field: version');

  if (manifest.type && !ITEM_TYPES.includes(manifest.type)) {
    errors.push(`Invalid item type "${manifest.type}". Must be one of: ${ITEM_TYPES.join(', ')}`);
  }

  // Type-specific validation
  const { type } = manifest;

  // Warn if the type-specific section is missing
  if (type && !manifest[type as keyof GenieManifest]) {
    warnings.push(`Manifest type is "${type}" but no "${type}" section is defined`);
  }

  // Agent validation
  if (manifest.agent) {
    validateEntrypoint(manifest.agent.entrypoint, itemDir, 'agent', errors);
  }

  // Skill validation
  if (manifest.skill) {
    validateEntrypoint(manifest.skill.entrypoint, itemDir, 'skill', errors);
  }

  // App validation
  if (manifest.app) {
    validateEntrypoint(manifest.app.entrypoint, itemDir, 'app', errors);
  }

  // Board validation
  if (manifest.board) {
    validateStages(manifest.board.stages, errors);
  }

  // Workflow validation
  if (manifest.workflow) {
    validateCron(manifest.workflow.cron, errors);
  }

  // Stack validation
  if (manifest.stack) {
    validateStackItems(manifest.stack.items, errors);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Check that an entrypoint file exists on disk. */
function validateEntrypoint(entrypoint: string | undefined, itemDir: string, section: string, errors: string[]): void {
  if (!entrypoint) {
    errors.push(`${section} section is missing required field: entrypoint`);
    return;
  }
  const fullPath = join(itemDir, entrypoint);
  if (!existsSync(fullPath)) {
    errors.push(`${section} entrypoint not found: ${entrypoint} (expected at ${fullPath})`);
  }
}

/** Validate board stage definitions. */
function validateStages(stages: StageConfig[] | undefined, errors: string[]): void {
  if (!stages || !Array.isArray(stages)) {
    errors.push('board section is missing required field: stages');
    return;
  }
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    if (!stage.name) {
      errors.push(`board.stages[${i}] is missing required field: name`);
    }
    if (!stage.gate) {
      errors.push(`board.stages[${i}] is missing required field: gate`);
    } else if (!VALID_GATES.has(stage.gate)) {
      errors.push(`board.stages[${i}].gate "${stage.gate}" is invalid. Must be one of: human, agent, human+agent`);
    }
  }
}

/**
 * Validate a cron expression has 5 or 6 space-separated fields.
 * This is a basic format check, not full cron syntax validation.
 */
function validateCron(cron: string | undefined, errors: string[]): void {
  if (!cron) {
    errors.push('workflow section is missing required field: cron');
    return;
  }
  const fields = cron.trim().split(/\s+/);
  if (fields.length < 5 || fields.length > 6) {
    errors.push(`workflow.cron "${cron}" is invalid: expected 5 or 6 space-separated fields, got ${fields.length}`);
  }
}

/** Validate stack item definitions. */
function validateStackItems(items: StackItem[] | undefined, errors: string[]): void {
  if (!items || !Array.isArray(items)) {
    errors.push('stack section is missing required field: items');
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.type) {
      errors.push(`stack.items[${i}] is missing required field: type`);
    }
    if (!item.source && !item.inline) {
      errors.push(`stack.items[${i}] must have either "source" or "inline: true"`);
    }
  }
}

// ============================================================================
// Detection
// ============================================================================

/**
 * Detect a manifest from a directory using a fallback chain.
 *
 * Detection order:
 * 1. `genie.yaml` — explicit manifest file
 * 2. `AGENTS.md` — infer agent manifest from YAML frontmatter
 * 3. `manifest.ts` — infer app manifest
 * 4. `skill.md` — infer skill manifest
 * 5. None found — return error
 */
export async function detectManifest(
  dir: string,
): Promise<{ manifest: GenieManifest; source: string } | { error: string }> {
  // 1. Explicit genie.yaml
  const yamlPath = join(dir, 'genie.yaml');
  if (existsSync(yamlPath)) {
    try {
      const content = readFileSync(yamlPath, 'utf-8');
      const manifest = parseManifest(content);
      return { manifest, source: 'genie.yaml' };
    } catch (err) {
      return { error: `Failed to parse genie.yaml: ${(err as Error).message}` };
    }
  }

  const dirName = basename(dir);

  // 2. AGENTS.md — infer agent manifest from frontmatter
  const agentsPath = join(dir, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    const manifest = inferAgentManifest(agentsPath, dirName);
    return { manifest, source: 'AGENTS.md' };
  }

  // 3. manifest.ts — infer app manifest
  const manifestTsPath = join(dir, 'manifest.ts');
  if (existsSync(manifestTsPath)) {
    const manifest: GenieManifest = {
      name: dirName,
      type: 'app',
      version: '0.0.0',
    };
    return { manifest, source: 'manifest.ts' };
  }

  // 4. skill.md — infer skill manifest
  const skillPath = join(dir, 'skill.md');
  if (existsSync(skillPath)) {
    const manifest: GenieManifest = {
      name: dirName,
      type: 'skill',
      version: '0.0.0',
    };
    return { manifest, source: 'skill.md' };
  }

  // 5. Nothing found
  return {
    error:
      'No manifest found. Create a genie.yaml or use a recognized file pattern (AGENTS.md, manifest.ts, skill.md).',
  };
}

/**
 * Extract YAML frontmatter from a markdown file.
 *
 * Looks for content between `---` markers at the top of the file.
 * Returns the parsed object or null if no frontmatter is found.
 */
function extractFrontmatter(filePath: string): Record<string, unknown> | null {
  const content = readFileSync(filePath, 'utf-8');
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  try {
    const parsed = yaml.load(match[1]);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Frontmatter is not valid YAML — ignore
  }
  return null;
}

/** Build an agent manifest from AGENTS.md frontmatter. */
function inferAgentManifest(agentsPath: string, dirName: string): GenieManifest {
  const frontmatter = extractFrontmatter(agentsPath);

  const name = (frontmatter?.name as string) || dirName;
  const model = frontmatter?.model as string | undefined;
  const roles = Array.isArray(frontmatter?.roles) ? (frontmatter.roles as string[]) : undefined;

  const manifest: GenieManifest = {
    name,
    type: 'agent',
    version: '0.0.0',
  };

  if (model || roles) {
    manifest.agent = {
      entrypoint: 'AGENTS.md',
      ...(model && { model }),
      ...(roles && { roles }),
    };
  }

  return manifest;
}
