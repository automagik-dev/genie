import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { clientError } from './runtime';
import type { Registry } from './service';
import { SKILL_CATEGORIES, SKILL_MUTATES_LEVELS, type SkillCategory, type SkillMutates } from './taxonomy';

/**
 * Read-only catalog of a workspace's Genie skills and saved workflows.
 * Both are documents in git: `skills/<name>/SKILL.md` (YAML frontmatter) and
 * `.claude/workflows/<name>.js` (a pure-literal `export const meta` block).
 * Nothing is executed and nothing is written. Every path is derived from the
 * DSH workspace registry, never from the browser.
 */

export interface SkillEntry {
  name: string;
  description: string;
  /** Repository-relative path to the SKILL.md. */
  path: string;
  /** Sibling files shipped with the skill (references, templates, agents). */
  resources: string[];
  /** Optional flat `category:` frontmatter key, when it names a known category. */
  category?: SkillCategory;
  /** Optional flat `mutates:` frontmatter key: the widest blast radius the skill claims. */
  mutates?: SkillMutates;
}

export interface WorkflowEntry {
  name: string;
  description: string;
  whenToUse?: string;
  phases: { title: string; detail?: string }[];
  /** Repository-relative path to the script. */
  path: string;
  /** Script size in bytes, so the panel can hint at cost without reading the body. */
  bytes: number;
}

const MAX_FILE = 256 * 1024;
const SAFE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const META = /^export const meta = (\{[\s\S]*?\n\})\n/;

function frontmatterField(block: string, key: string): string | undefined {
  const line = block.split(/\r?\n/).find((entry) => entry.startsWith(`${key}:`));
  if (!line) return undefined;
  const raw = line.slice(key.length + 1).trim();
  return raw.replace(/^(['"])([\s\S]*)\1$/, '$2');
}

/** Parse a pure-literal meta block without executing arbitrary code: strings, numbers, booleans, arrays and objects only. */
export function parseMetaLiteral(literal: string): Record<string, unknown> | undefined {
  const stripped = literal.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""');
  if (/[A-Za-z_$][\w$]*\s*\(|\.\.\.|\$\{|`/.test(stripped)) return undefined;
  const bare = stripped.replace(/:\s*(?:true|false|null)\b/g, ': 0');
  if (/:\s*[A-Za-z_$][\w$]*\s*[,}\n]/.test(bare)) return undefined;
  try {
    return new Function(`"use strict"; return (${literal});`)() as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isCategory(value: string | undefined): value is SkillCategory {
  return value !== undefined && (SKILL_CATEGORIES as readonly string[]).includes(value);
}

function isMutates(value: string | undefined): value is SkillMutates {
  return value !== undefined && (SKILL_MUTATES_LEVELS as readonly string[]).includes(value);
}

async function bounded(path: string): Promise<string | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_FILE) return undefined;
  return readFile(path, 'utf8');
}

export async function readSkills(root: string): Promise<SkillEntry[]> {
  const dir = join(root, 'skills');
  const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const entries: SkillEntry[] = [];
  for (const entry of names) {
    if (!entry.isDirectory() || !SAFE_NAME.test(entry.name)) continue;
    const text = await bounded(join(dir, entry.name, 'SKILL.md'));
    if (!text) continue;
    const block = FRONTMATTER.exec(text)?.[1] ?? '';
    const name = frontmatterField(block, 'name') ?? entry.name;
    if (name !== entry.name) continue;
    const siblings = await readdir(join(dir, entry.name)).catch(() => []);
    const category = frontmatterField(block, 'category');
    const mutates = frontmatterField(block, 'mutates');
    entries.push({
      name,
      description: frontmatterField(block, 'description') ?? '',
      path: `skills/${entry.name}/SKILL.md`,
      resources: siblings.filter((file) => file !== 'SKILL.md').sort(),
      ...(isCategory(category) ? { category } : {}),
      ...(isMutates(mutates) ? { mutates } : {}),
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readWorkflows(root: string): Promise<WorkflowEntry[]> {
  const dir = join(root, '.claude', 'workflows');
  const files = await readdir(dir).catch(() => []);
  const entries: WorkflowEntry[] = [];
  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    const stem = file.slice(0, -3);
    if (!SAFE_NAME.test(stem)) continue;
    const text = await bounded(join(dir, file));
    if (!text) continue;
    const literal = META.exec(text)?.[1];
    const meta = literal ? parseMetaLiteral(literal) : undefined;
    if (!meta || meta.name !== stem || typeof meta.description !== 'string') continue;
    const phases = Array.isArray(meta.phases)
      ? meta.phases
          .filter(
            (phase): phase is { title: string; detail?: string } =>
              typeof phase === 'object' && phase !== null && typeof (phase as { title?: unknown }).title === 'string',
          )
          .map((phase) => ({
            title: phase.title,
            ...(typeof phase.detail === 'string' ? { detail: phase.detail } : {}),
          }))
      : [];
    entries.push({
      name: stem,
      description: meta.description,
      ...(typeof meta.whenToUse === 'string' ? { whenToUse: meta.whenToUse } : {}),
      phases,
      path: `.claude/workflows/${file}`,
      bytes: Buffer.byteLength(text),
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export class CatalogService {
  constructor(private readonly registry: Registry) {}
  private async root(workspaceId: string): Promise<string> {
    const workspace = this.registry.list().find((entry) => entry.id === workspaceId);
    if (!workspace) throw clientError('Unknown workspace');
    const path = await realpath(workspace.path);
    if (!(await stat(path)).isDirectory()) throw new Error('Workspace is not a directory');
    return path;
  }
  async skills(workspaceId: string): Promise<SkillEntry[]> {
    return readSkills(await this.root(workspaceId));
  }
  async workflows(workspaceId: string): Promise<WorkflowEntry[]> {
    return readWorkflows(await this.root(workspaceId));
  }
  /** The document body for one entry, read-only, path derived from the catalog listing only. */
  async document(workspaceId: string, kind: 'skill' | 'workflow', name: string): Promise<string> {
    if (!SAFE_NAME.test(name)) throw clientError('Invalid name');
    const root = await this.root(workspaceId);
    const path =
      kind === 'skill' ? join(root, 'skills', name, 'SKILL.md') : join(root, '.claude', 'workflows', `${name}.js`);
    const text = await bounded(path);
    if (text === undefined) throw clientError('Document not found');
    return text;
  }
}
