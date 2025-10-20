import fs from 'fs';
import path from 'path';
import type { AgentSpec } from './types';
import { recordStartupWarning } from './config';
import { transformDisplayPath } from './display-transform';

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

const COLLECTIVE_MARKER = 'AGENTS.md';
const AGENT_DIRECTORY_NAME = 'agents';

export interface CollectiveInfo {
  collective: string;
  root: string;
  agentsDir: string | null;
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function toAgentPathSegments(id: string): string[] | null {
  if (!id) return null;
  const segments = id
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }
  return segments;
}

function discoverCollectiveDirectories(genieRoot: string, maxDepth = 1): CollectiveInfo[] {
  const discovered = new Map<string, CollectiveInfo>();
  if (!fs.existsSync(genieRoot) || !fs.statSync(genieRoot).isDirectory()) {
    return [];
  }

  interface QueueEntry {
    dir: string;
    depth: number;
  }

  const queue: QueueEntry[] = [{ dir: genieRoot, depth: 0 }];

  while (queue.length) {
    const { dir, depth } = queue.shift()!;

    const markerPath = path.join(dir, COLLECTIVE_MARKER);
    if (fs.existsSync(markerPath)) {
      const resolvedRoot = realpathOrNull(dir) ?? path.resolve(dir);
      const relative = path.relative(genieRoot, resolvedRoot);
      const segments = relative.split(path.sep).filter(Boolean);
      const collective = segments.length ? segments.join('/') : 'root';

      let agentsDir: string | null = null;
      const candidateAgentsDir = path.join(dir, AGENT_DIRECTORY_NAME);
      if (fs.existsSync(candidateAgentsDir) && fs.statSync(candidateAgentsDir).isDirectory()) {
        agentsDir = realpathOrNull(candidateAgentsDir) ?? path.resolve(candidateAgentsDir);
      }

      if (!discovered.has(resolvedRoot)) {
        discovered.set(resolvedRoot, { collective, root: resolvedRoot, agentsDir });
      }
      // Do not traverse beyond located collectives; they manage their own hierarchy
    }

    if (depth >= maxDepth) continue;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.forEach((entry) => {
      if (!entry.isDirectory()) return;
      if (entry.name.startsWith('.')) return;
      const nextDir = path.join(dir, entry.name);
      queue.push({ dir: nextDir, depth: depth + 1 });
    });
  }

  return Array.from(discovered.values());
}

function getLocalCollectives(): CollectiveInfo[] {
  const dirs = new Map<string, CollectiveInfo>();
  const genieRoot = path.join(process.cwd(), '.genie');
  discoverCollectiveDirectories(genieRoot, 2).forEach((info) => {
    dirs.set(info.root, info);
  });

  return Array.from(dirs.values());
}

function findAgentFile(id: string, collectives: CollectiveInfo[]): { path: string; collective: string } | null {
  const segments = toAgentPathSegments(id);
  if (!segments) return null;

  const relativePath = path.join(...segments) + '.md';

  for (const info of collectives) {
    if (!info.agentsDir) continue;
    const filePath = path.join(info.agentsDir, relativePath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return { path: filePath, collective: info.collective };
    }
  }

  return null;
}

const resolveAgentPath = (id: string): string | null => {
  const normalized = id.replace(/\\/g, '/');
  const candidates = new Set<string>([normalized]);
  if (!normalized.includes('/')) {
    ['core', 'qa'].forEach((prefix) => {
      candidates.add(`${prefix}/${normalized}`);
    });
  }

  const collectives = getLocalCollectives().filter(info => Boolean(info.agentsDir));

  // Check local collectives first (user project - takes precedence)
  for (const candidate of candidates) {
    if (findAgentFile(candidate, collectives)) return candidate;
  }

  return null;
};

interface ListedAgent {
  id: string;
  displayId: string;
  label: string;
  meta: any;
  folder: string | null;
  collective: string | null;
}

// transformDisplayPath imported from ./display-transform (single source of truth)

/**
 * Lists all available agent definitions from both local and npm package locations.
 *
 * Recursively scans for .md files, extracts metadata, and filters out hidden/disabled agents.
 * Checks local collectives (directories with AGENTS.md + agents/) first, then the packaged core agents.
 *
 * @returns {ListedAgent[]} - Array of agent records with id, label, metadata, and folder path
 */
export function listAgents(): ListedAgent[] {
  const records: ListedAgent[] = [];
  const seenIds = new Set<string>();

  const visit = (baseDir: string, relativePath: string | null, collective: string | null) => {
    if (!fs.existsSync(baseDir)) return;

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    entries.forEach((entry) => {
      const entryPath = path.join(baseDir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath, relativePath ? path.join(relativePath, entry.name) : entry.name, collective);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'README.md') return;
      const rawId = relativePath ? path.join(relativePath, entry.name) : entry.name;
      const normalizedId = rawId.replace(/\.md$/i, '').split(path.sep).join('/');

      // Skip if already seen (local agents override npm package agents)
      if (seenIds.has(normalizedId)) return;
      seenIds.add(normalizedId);

      const content = fs.readFileSync(entryPath, 'utf8');
      const { meta } = extractFrontMatter(content);
      const metaObj = meta || {};
      if (metaObj.hidden === true || metaObj.disabled === true) return;

      // Transform display path (strip template/category folders)
      const { displayId, displayFolder } = transformDisplayPath(normalizedId);
      const label = (metaObj.name || displayId.split('/').pop() || displayId).trim();

      records.push({
        id: normalizedId,
        displayId,
        label,
        meta: metaObj,
        folder: displayFolder,
        collective: collective ?? null
      });
    });
  };

  // Visit local agents first (user project)
  const collectives = getLocalCollectives().filter(info => Boolean(info.agentsDir));
  collectives.forEach((info) => visit(info.agentsDir as string, null, info.collective));

  return records;
}

export function listCollectives(): CollectiveInfo[] {
  return getLocalCollectives();
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
 * Checks local collectives first, then npm package location.
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
      throw new Error(`❌ Agent '${name}' not found`);
    }
  }

  const collectives = getLocalCollectives().filter(info => Boolean(info.agentsDir));
  const fileInfo = findAgentFile(normalized, collectives);

  if (!fileInfo) {
    throw new Error(`❌ Agent '${name}' not found`);
  }

  const content = fs.readFileSync(fileInfo.path, 'utf8');
  const { meta, body } = extractFrontMatter(content);
  return {
    meta,
    instructions: body.replace(/^(\r?\n)+/, ''),
    filePath: fileInfo.path
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
