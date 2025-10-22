"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAgents = listAgents;
exports.listCollectives = listCollectives;
exports.resolveAgentIdentifier = resolveAgentIdentifier;
exports.agentExists = agentExists;
exports.loadAgentSpec = loadAgentSpec;
exports.extractFrontMatter = extractFrontMatter;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("./config");
const display_transform_1 = require("./display-transform");
let YAML = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    YAML = require('yaml');
}
catch (_) {
    // yaml module optional
}
const fallbackParseFrontMatter = (raw) => {
    const meta = {};
    raw.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            return;
        const separatorIndex = trimmed.indexOf(':');
        if (separatorIndex === -1)
            return;
        const key = trimmed.slice(0, separatorIndex).trim();
        const value = trimmed.slice(separatorIndex + 1).trim();
        if (!key)
            return;
        meta[key] = value;
    });
    return meta;
};
const COLLECTIVE_MARKER = 'AGENTS.md';
const AGENT_DIRECTORY_NAME = 'agents';
function realpathOrNull(target) {
    try {
        return fs_1.default.realpathSync(target);
    }
    catch {
        return null;
    }
}
function toAgentPathSegments(id) {
    if (!id)
        return null;
    const segments = id
        .split('/')
        .map((segment) => segment.trim())
        .filter(Boolean);
    if (!segments.length)
        return null;
    if (segments.some((segment) => segment === '.' || segment === '..')) {
        return null;
    }
    return segments;
}
function discoverCollectiveDirectories(genieRoot, maxDepth = 1) {
    const discovered = new Map();
    if (!fs_1.default.existsSync(genieRoot) || !fs_1.default.statSync(genieRoot).isDirectory()) {
        return [];
    }
    const queue = [{ dir: genieRoot, depth: 0 }];
    while (queue.length) {
        const { dir, depth } = queue.shift();
        const markerPath = path_1.default.join(dir, COLLECTIVE_MARKER);
        if (fs_1.default.existsSync(markerPath)) {
            const resolvedRoot = realpathOrNull(dir) ?? path_1.default.resolve(dir);
            const relative = path_1.default.relative(genieRoot, resolvedRoot);
            const segments = relative.split(path_1.default.sep).filter(Boolean);
            const collective = segments.length ? segments.join('/') : 'root';
            let agentsDir = null;
            const candidateAgentsDir = path_1.default.join(dir, AGENT_DIRECTORY_NAME);
            if (fs_1.default.existsSync(candidateAgentsDir) && fs_1.default.statSync(candidateAgentsDir).isDirectory()) {
                agentsDir = realpathOrNull(candidateAgentsDir) ?? path_1.default.resolve(candidateAgentsDir);
            }
            if (!discovered.has(resolvedRoot)) {
                discovered.set(resolvedRoot, { collective, root: resolvedRoot, agentsDir });
            }
            // Do not traverse beyond located collectives; they manage their own hierarchy
        }
        if (depth >= maxDepth)
            continue;
        const entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
        entries.forEach((entry) => {
            if (!entry.isDirectory())
                return;
            if (entry.name.startsWith('.'))
                return;
            const nextDir = path_1.default.join(dir, entry.name);
            queue.push({ dir: nextDir, depth: depth + 1 });
        });
    }
    return Array.from(discovered.values());
}
function getLocalCollectives() {
    const dirs = new Map();
    const genieRoot = path_1.default.join(process.cwd(), '.genie');
    discoverCollectiveDirectories(genieRoot, 2).forEach((info) => {
        dirs.set(info.root, info);
    });
    return Array.from(dirs.values());
}
function findAgentFile(id, collectives) {
    const segments = toAgentPathSegments(id);
    if (!segments)
        return null;
    for (const info of collectives) {
        if (!info.agentsDir)
            continue;
        const candidateSegments = [];
        candidateSegments.push(segments);
        if (segments.length > 1 && segments[0] === info.collective) {
            candidateSegments.push(segments.slice(1));
            if (segments[1] === 'agents') {
                candidateSegments.push(segments.slice(2));
            }
        }
        if (segments[0] === 'agents') {
            candidateSegments.push(segments.slice(1));
        }
        const seen = new Set();
        for (const candidate of candidateSegments) {
            if (!candidate.length)
                continue;
            const key = candidate.join('/');
            if (seen.has(key))
                continue;
            seen.add(key);
            const filePath = path_1.default.join(info.agentsDir, ...candidate) + '.md';
            if (fs_1.default.existsSync(filePath) && fs_1.default.statSync(filePath).isFile()) {
                const relativeId = candidate.join('/').replace(/\\/g, '/');
                return { path: filePath, collective: info.collective, relativeId };
            }
        }
    }
    return null;
}
const resolveAgentPath = (id) => {
    const normalized = id.replace(/\\/g, '/');
    const collectives = getLocalCollectives().filter(info => Boolean(info.agentsDir));
    const candidates = new Set([normalized]);
    if (!normalized.includes('/')) {
        collectives
            .map(info => info.collective)
            .filter((name) => Boolean(name) && name !== 'root')
            .forEach((collectiveName) => {
            candidates.add(`${collectiveName}/${normalized}`);
        });
    }
    // Check local collectives first (user project - takes precedence)
    for (const candidate of candidates) {
        const found = findAgentFile(candidate, collectives);
        if (found) {
            const relativeId = found.relativeId;
            return found.collective && found.collective !== 'root'
                ? `${found.collective}/${relativeId}`
                : relativeId;
        }
    }
    return null;
};
// transformDisplayPath imported from ./display-transform (single source of truth)
/**
 * Lists all available agent definitions from both local and npm package locations.
 *
 * Recursively scans for .md files, extracts metadata, and filters out hidden/disabled agents.
 * Checks local collectives (directories with AGENTS.md + agents/) first, then the packaged core agents.
 *
 * @returns {ListedAgent[]} - Array of agent records with id, label, metadata, and folder path
 */
function listAgents() {
    const records = [];
    const seenIds = new Set();
    const visit = (baseDir, relativePath, collective) => {
        if (!fs_1.default.existsSync(baseDir))
            return;
        const entries = fs_1.default.readdirSync(baseDir, { withFileTypes: true });
        entries.forEach((entry) => {
            const entryPath = path_1.default.join(baseDir, entry.name);
            if (entry.isDirectory()) {
                visit(entryPath, relativePath ? path_1.default.join(relativePath, entry.name) : entry.name, collective);
                return;
            }
            if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'README.md')
                return;
            const rawId = relativePath ? path_1.default.join(relativePath, entry.name) : entry.name;
            const relativeId = rawId.replace(/\.md$/i, '').split(path_1.default.sep).join('/');
            const canonicalId = collective && collective !== 'root'
                ? `${collective}/${relativeId}`.replace(/\\/g, '/')
                : relativeId.replace(/\\/g, '/');
            // Skip if already seen (local agents override npm package agents)
            if (seenIds.has(canonicalId))
                return;
            seenIds.add(canonicalId);
            const content = fs_1.default.readFileSync(entryPath, 'utf8');
            const { meta } = extractFrontMatter(content);
            const metaObj = meta || {};
            if (metaObj.hidden === true || metaObj.disabled === true)
                return;
            // Transform display path (strip template/category folders)
            const { displayId, displayFolder } = (0, display_transform_1.transformDisplayPath)(canonicalId);
            const label = (metaObj.name || displayId.split('/').pop() || displayId).trim();
            records.push({
                id: canonicalId,
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
    collectives.forEach((info) => visit(info.agentsDir, null, info.collective));
    return records;
}
function listCollectives() {
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
function resolveAgentIdentifier(input) {
    const trimmed = (input || '').trim();
    if (!trimmed) {
        throw new Error('Agent id is required');
    }
    const normalized = trimmed.replace(/\.md$/i, '');
    const normalizedLower = normalized.toLowerCase();
    const directCandidates = [normalized, normalizedLower];
    for (const candidate of directCandidates) {
        const resolved = resolveAgentPath(candidate);
        if (resolved)
            return resolved.replace(/\\/g, '/');
    }
    const agents = listAgents();
    const byExactId = agents.find((agent) => agent.id.toLowerCase() === normalizedLower);
    if (byExactId)
        return byExactId.id;
    const byLabel = agents.find((agent) => agent.label.toLowerCase() === normalizedLower);
    if (byLabel)
        return byLabel.id;
    const legacy = normalizedLower.replace(/^genie-/, '').replace(/^template-/, '');
    const legacyCandidates = [legacy, `core/${legacy}`];
    for (const candidate of legacyCandidates) {
        if (agentExists(candidate))
            return candidate;
    }
    if (normalizedLower === 'forge-master' && agentExists('forge'))
        return 'forge';
    throw new Error(`❌ Agent '${input}' not found. Try 'genie list agents' to see available ids.`);
}
/**
 * Checks if an agent exists at the given path.
 *
 * @param {string} id - Agent identifier (without .md extension)
 * @returns {boolean} - True if agent file exists
 */
function agentExists(id) {
    if (!id)
        return false;
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
function loadAgentSpec(name) {
    const base = name.endsWith('.md') ? name.slice(0, -3) : name;
    let normalized = base;
    try {
        normalized = resolveAgentIdentifier(base);
    }
    catch (_) {
        if (!agentExists(normalized)) {
            throw new Error(`❌ Agent '${name}' not found`);
        }
    }
    const collectives = getLocalCollectives().filter(info => Boolean(info.agentsDir));
    const fileInfo = findAgentFile(normalized, collectives);
    if (!fileInfo) {
        throw new Error(`❌ Agent '${name}' not found`);
    }
    const content = fs_1.default.readFileSync(fileInfo.path, 'utf8');
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
function extractFrontMatter(source) {
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
        (0, config_1.recordStartupWarning)('[genie] YAML module unavailable; falling back to basic front matter parsing.');
        return { meta: fallbackParseFrontMatter(raw), body };
    }
    try {
        const parsed = YAML.parse(raw) || {};
        return { meta: parsed, body };
    }
    catch {
        return { meta: fallbackParseFrontMatter(raw), body };
    }
}
