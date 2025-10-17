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

// Resolve npm package location for core agents
const getPackageAgentsDir = (): string | null => {
  try {
    // Resolve from compiled dist location: dist/ -> package root
    const packageRoot = path.resolve(__dirname, '../../../..');
    const agentsDir = path.join(packageRoot, '.genie', 'agents');

    if (fs.existsSync(agentsDir)) {
      return agentsDir;
    }

    return null;
  } catch {
    return null;
  }
};

const resolveAgentPath = (id: string): string | null => {
  const normalized = id.replace(/\\/g, '/');
  const candidates = new Set<string>([normalized]);
  if (!normalized.includes('/')) {
    ['core', 'qa'].forEach((prefix) => {
      candidates.add(`${prefix}/${normalized}`);
    });
  }

  // Check local .genie/agents first (user project - takes precedence)
  for (const candidate of candidates) {
    const file = path.join('.genie', 'agents', `${candidate}.md`);
    if (fs.existsSync(file)) return candidate;
  }

  // Fallback to npm package location (core agents)
  const packageAgentsDir = getPackageAgentsDir();
  if (packageAgentsDir) {
    for (const candidate of candidates) {
      const file = path.join(packageAgentsDir, `${candidate}.md`);
      if (fs.existsSync(file)) return candidate;
    }
  }

  return null;
};

interface ListedAgent {
  id: string;
  displayId: string;
  label: string;
  meta: any;
  folder: string | null;
}

/**
 * Transforms agent paths for display by stripping template/category folders
 * while preserving parent/child workflow relationships.
 *
 * Template folders (code/, create/): Stripped entirely
 * Category folders (neurons/, workflows/): Stripped for top-level, preserved for children
 *
 * @param {string} normalizedId - Full agent path (e.g., "code/implementor", "neurons/git/issue")
 * @returns {{ displayId: string; displayFolder: string | null }} - Transformed path for display
 *
 * @example
 * transformDisplayPath("code/implementor") // { displayId: "implementor", displayFolder: null }
 * transformDisplayPath("neurons/git/git") // { displayId: "git", displayFolder: null }
 * transformDisplayPath("neurons/git/issue") // { displayId: "git/issue", displayFolder: "git" }
 * transformDisplayPath("workflows/plan") // { displayId: "plan", displayFolder: null }
 */
function transformDisplayPath(normalizedId: string): { displayId: string; displayFolder: string | null } {
  const parts = normalizedId.split('/');

  // Template folders: code/, create/ (strip entirely)
  const templateFolders = ['code', 'create'];
  if (templateFolders.includes(parts[0])) {
    const displayId = parts.slice(1).join('/');
    const displayFolder = parts.length > 2 ? parts.slice(1, -1).join('/') : null;
    return { displayId, displayFolder };
  }

  // Category folders: neurons/, workflows/
  const categoryFolders = ['neurons', 'workflows'];
  if (categoryFolders.includes(parts[0])) {
    if (parts.length === 2) {
      // Top-level agent (e.g., neurons/git.md, workflows/plan.md)
      return { displayId: parts[1], displayFolder: null };
    }
    if (parts.length === 3 && parts[1] === parts[2]) {
      // Parent neuron (e.g., neurons/git/git.md)
      return { displayId: parts[1], displayFolder: null };
    }
    // Child workflow (e.g., neurons/git/issue.md)
    const displayId = parts.slice(1).join('/');
    const displayFolder = parts[1]; // Parent folder name
    return { displayId, displayFolder };
  }

  // Fallback: no transformation (backward compatibility)
  const displayFolder = parts.length > 1 ? parts.slice(0, -1).join('/') : null;
  return { displayId: normalizedId, displayFolder };
}

/**
 * Lists all available agent definitions from both local and npm package locations.
 *
 * Recursively scans for .md files, extracts metadata, and filters out hidden/disabled agents.
 * Checks local .genie/agents first (user agents), then npm package (core agents).
 *
 * @returns {ListedAgent[]} - Array of agent records with id, label, metadata, and folder path
 */
export function listAgents(): ListedAgent[] {
  const records: ListedAgent[] = [];
  const seenIds = new Set<string>();

  const visit = (baseDir: string, relativePath: string | null) => {
    if (!fs.existsSync(baseDir)) return;

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    entries.forEach((entry) => {
      const entryPath = path.join(baseDir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath, relativePath ? path.join(relativePath, entry.name) : entry.name);
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

      records.push({ id: normalizedId, displayId, label, meta: metaObj, folder: displayFolder });
    });
  };

  // Visit local agents first (user project)
  visit('.genie/agents', null);

  // Visit npm package agents second (core agents)
  const packageAgentsDir = getPackageAgentsDir();
  if (packageAgentsDir) {
    visit(packageAgentsDir, null);
  }

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
 * Checks local .genie/agents first, then npm package location.
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

  // Try local .genie/agents first
  let agentPath = path.join('.genie', 'agents', `${normalized}.md`);
  let content: string;

  if (fs.existsSync(agentPath)) {
    content = fs.readFileSync(agentPath, 'utf8');
  } else {
    // Fallback to npm package location
    const packageAgentsDir = getPackageAgentsDir();
    if (packageAgentsDir) {
      agentPath = path.join(packageAgentsDir, `${normalized}.md`);
      if (fs.existsSync(agentPath)) {
        content = fs.readFileSync(agentPath, 'utf8');
      } else {
        throw new Error(`❌ Agent '${name}' not found`);
      }
    } else {
      throw new Error(`❌ Agent '${name}' not found`);
    }
  }

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
