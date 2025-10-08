import fs from 'fs';
import path from 'path';
import type { AgentSpec } from './types';
import { recordStartupWarning } from './config';

let YAML: typeof import('yaml') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  YAML = require('yaml');
} catch (_) {
  // yaml module optional
}

const fallbackParseFrontMatter = (raw: string): Record<string, any> => {
  const meta: Record<string, any> = {};
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) return;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) return;
    meta[key] = value;
  });
  return meta;
};

const resolveAgentPath = (id: string): string | null => {
  const normalized = id.replace(/\\/g, '/');
  const candidates = new Set<string>([normalized]);
  if (!normalized.includes('/')) {
    ['core', 'qa'].forEach((prefix) => {
      candidates.add(`${prefix}/${normalized}`);
    });
  }
  for (const candidate of candidates) {
    const file = path.join('.genie', 'agents', `${candidate}.md`);
    if (fs.existsSync(file)) return candidate;
  }
  return null;
};

interface ListedAgent {
  id: string;
  label: string;
  meta: any;
  folder: string | null;
}

/**
 * Lists all available agent definitions from .genie/agents directory.
 *
 * Recursively scans for .md files, extracts metadata, and filters out hidden/disabled agents.
 *
 * @returns {ListedAgent[]} - Array of agent records with id, label, metadata, and folder path
 */
export function listAgents(): ListedAgent[] {
  const baseDir = '.genie/agents';
  const records: ListedAgent[] = [];
  if (!fs.existsSync(baseDir)) return records;
  const visit = (dirPath: string, relativePath: string | null) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    entries.forEach((entry) => {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath, relativePath ? path.join(relativePath, entry.name) : entry.name);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'README.md') return;
      const rawId = relativePath ? path.join(relativePath, entry.name) : entry.name;
      const normalizedId = rawId.replace(/\.md$/i, '').split(path.sep).join('/');
      const content = fs.readFileSync(entryPath, 'utf8');
      const { meta } = extractFrontMatter(content);
      const metaObj = meta || {};
      if (metaObj.hidden === true || metaObj.disabled === true) return;
      const label = (metaObj.name || normalizedId.split('/').pop() || normalizedId).trim();
      const folder = normalizedId.includes('/') ? normalizedId.split('/').slice(0, -1).join('/') : null;
      records.push({ id: normalizedId, label, meta: metaObj, folder });
    });
  };

  visit(baseDir, null);
  return records;
}

/**
 * Resolves agent identifier to canonical agent path.
 *
 * Tries multiple resolution strategies: direct path match, exact ID match,
 * label match, legacy prefix handling (genie-, template-), and special cases (forge-master).
 *
 * @param {string} input - Agent identifier (e.g., "plan", "core/tracer", "forge-master")
 * @returns {string} - Canonical agent ID (path without .md extension)
 * @throws {Error} - If agent cannot be found
 *
 * @example
 * resolveAgentIdentifier('plan') // Returns: 'plan'
 * resolveAgentIdentifier('implementor') // Returns: 'core/implementor'
 * resolveAgentIdentifier('forge-master') // Returns: 'forge' (legacy alias)
 */
export function resolveAgentIdentifier(input: string): string {
  const trimmed = (input || '').trim();
  if (!trimmed) {
    throw new Error('Agent id is required');
  }
  const normalized = trimmed.replace(/\.md$/i, '');
  const normalizedLower = normalized.toLowerCase();

  const directCandidates = [normalized, normalizedLower];
  for (const candidate of directCandidates) {
    const resolved = resolveAgentPath(candidate);
    if (resolved) return resolved.replace(/\\/g, '/');
  }

  const agents = listAgents();
  const byExactId = agents.find((agent) => agent.id.toLowerCase() === normalizedLower);
  if (byExactId) return byExactId.id;

  const byLabel = agents.find((agent) => agent.label.toLowerCase() === normalizedLower);
  if (byLabel) return byLabel.id;

  const legacy = normalizedLower.replace(/^genie-/, '').replace(/^template-/, '');
  const legacyCandidates = [legacy, `core/${legacy}`];
  for (const candidate of legacyCandidates) {
    if (agentExists(candidate)) return candidate;
  }

  if (normalizedLower === 'forge-master' && agentExists('forge')) return 'forge';

  throw new Error(`❌ Agent '${input}' not found. Try 'genie list agents' to see available ids.`);
}

/**
 * Checks if an agent exists at the given path.
 *
 * @param {string} id - Agent identifier (without .md extension)
 * @returns {boolean} - True if agent file exists
 */
export function agentExists(id: string): boolean {
  if (!id) return false;
  return resolveAgentPath(id) !== null;
}

/**
 * Loads agent specification from markdown file with frontmatter metadata.
 *
 * @param {string} name - Agent name/path (with or without .md extension)
 * @returns {AgentSpec} - Object containing metadata and instructions
 * @throws {Error} - If agent file doesn't exist
 *
 * @example
 * const spec = loadAgentSpec('plan');
 * // Returns: { meta: { name: 'plan', ... }, instructions: '...' }
 */
export function loadAgentSpec(name: string): AgentSpec {
  const base = name.endsWith('.md') ? name.slice(0, -3) : name;
  let normalized = base;
  try {
    normalized = resolveAgentIdentifier(base);
  } catch (_) {
    if (!agentExists(normalized)) {
      throw new Error(`❌ Agent '${name}' not found in .genie/agents`);
    }
  }
  const agentPath = path.join('.genie', 'agents', `${normalized}.md`);
  if (!fs.existsSync(agentPath)) {
    throw new Error(`❌ Agent '${name}' not found in .genie/agents`);
  }
  const content = fs.readFileSync(agentPath, 'utf8');
  const { meta, body } = extractFrontMatter(content);
  return {
    meta,
    instructions: body.replace(/^(\r?\n)+/, '')
  };
}

/**
 * Extracts YAML frontmatter and body content from markdown source.
 *
 * Parses frontmatter delimited by `---` markers at the start of the file.
 * Falls back to empty metadata if YAML module unavailable or parsing fails.
 *
 * @param {string} source - Markdown source content
 * @returns {{ meta?: Record<string, any>; body: string }} - Parsed metadata and remaining body
 *
 * @example
 * const { meta, body } = extractFrontMatter('---\nname: plan\n---\n# Content');
 * // Returns: { meta: { name: 'plan' }, body: '# Content' }
 */
export function extractFrontMatter(source: string): { meta?: Record<string, any>; body: string } {
  if (!source.startsWith('---')) {
    return { meta: {}, body: source };
  }
  const end = source.indexOf('\n---', 3);
  if (end === -1) {
    return { meta: {}, body: source };
  }
  const raw = source.slice(3, end).trim();
  const body = source.slice(end + 4);
  if (!YAML) {
    recordStartupWarning('[genie] YAML module unavailable; falling back to basic front matter parsing.');
    return { meta: fallbackParseFrontMatter(raw), body };
  }
  try {
    const parsed = YAML.parse(raw) || {};
    return { meta: parsed, body };
  } catch {
    return { meta: fallbackParseFrontMatter(raw), body };
  }
}
