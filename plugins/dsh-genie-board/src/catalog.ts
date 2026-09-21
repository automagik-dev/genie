import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { clientError } from './runtime';
import type { Registry } from './service';

/**
 * Read-only catalog of a workspace's saved Genie workflows: documents in git
 * at `.claude/workflows/<name>.js`, each a pure-literal `export const meta`
 * block. Nothing is executed and nothing is written. Every path is derived
 * from the DSH workspace registry, never from the browser.
 *
 * This module used to carry a second catalog beside it — the retired skills
 * row's read of `skills/<name>/SKILL.md`. `@namastexlabs/dsh-skills` owns every
 * skills surface now, so this plugin reads workflows only.
 */

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
const META = /^export const meta = (\{[\s\S]*?\n\})\n/;

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

async function bounded(path: string): Promise<string | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_FILE) return undefined;
  return readFile(path, 'utf8');
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

/** The requested document name, unvetted here: `CatalogService.document` is the one gate. */
export function documentName(url: string | undefined): string {
  return new URL(url ?? '/', 'http://localhost').searchParams.get('name') ?? '';
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
  async workflows(workspaceId: string): Promise<WorkflowEntry[]> {
    return readWorkflows(await this.root(workspaceId));
  }
  /** The document body for one entry, read-only, path derived from the catalog listing only. */
  async document(workspaceId: string, name: string): Promise<string> {
    if (!SAFE_NAME.test(name)) throw clientError('Invalid name');
    const text = await bounded(join(await this.root(workspaceId), '.claude', 'workflows', `${name}.js`));
    if (text === undefined) throw clientError('Document not found');
    return text;
  }
}
