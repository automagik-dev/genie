"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAgents = listAgents;
exports.resolveAgentIdentifier = resolveAgentIdentifier;
exports.agentExists = agentExists;
exports.loadAgentSpec = loadAgentSpec;
exports.extractFrontMatter = extractFrontMatter;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("./config");
let YAML = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    YAML = require('yaml');
}
catch (_) {
    // yaml module optional
}
/**
 * Lists all available agent definitions from .genie/agents directory.
 *
 * Recursively scans for .md files, extracts metadata, and filters out hidden/disabled agents.
 *
 * @returns {ListedAgent[]} - Array of agent records with id, label, metadata, and folder path
 */
function listAgents() {
    const baseDir = '.genie/agents';
    const records = [];
    if (!fs_1.default.existsSync(baseDir))
        return records;
    const visit = (dirPath, relativePath) => {
        const entries = fs_1.default.readdirSync(dirPath, { withFileTypes: true });
        entries.forEach((entry) => {
            const entryPath = path_1.default.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                visit(entryPath, relativePath ? path_1.default.join(relativePath, entry.name) : entry.name);
                return;
            }
            if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'README.md')
                return;
            const rawId = relativePath ? path_1.default.join(relativePath, entry.name) : entry.name;
            const normalizedId = rawId.replace(/\.md$/i, '').split(path_1.default.sep).join('/');
            const content = fs_1.default.readFileSync(entryPath, 'utf8');
            const { meta } = extractFrontMatter(content);
            const metaObj = meta || {};
            if (metaObj.hidden === true || metaObj.disabled === true)
                return;
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
 * @param {string} input - Agent identifier (e.g., "plan", "utilities/twin", "forge-master")
 * @returns {string} - Canonical agent ID (path without .md extension)
 * @throws {Error} - If agent cannot be found
 *
 * @example
 * resolveAgentIdentifier('plan') // Returns: 'plan'
 * resolveAgentIdentifier('twin') // Returns: 'utilities/twin'
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
        if (agentExists(candidate))
            return candidate.replace(/\\/g, '/');
    }
    const agents = listAgents();
    const byExactId = agents.find((agent) => agent.id.toLowerCase() === normalizedLower);
    if (byExactId)
        return byExactId.id;
    const byLabel = agents.find((agent) => agent.label.toLowerCase() === normalizedLower);
    if (byLabel)
        return byLabel.id;
    const legacy = normalizedLower.replace(/^genie-/, '').replace(/^template-/, '');
    const legacyCandidates = [legacy, `core/${legacy}`, `specialized/${legacy}`];
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
    const normalized = id.replace(/\\/g, '/');
    const file = path_1.default.join('.genie', 'agents', `${normalized}.md`);
    return fs_1.default.existsSync(file);
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
function loadAgentSpec(name) {
    const base = name.endsWith('.md') ? name.slice(0, -3) : name;
    const agentPath = path_1.default.join('.genie', 'agents', `${base}.md`);
    if (!fs_1.default.existsSync(agentPath)) {
        throw new Error(`❌ Agent '${name}' not found in .genie/agents`);
    }
    const content = fs_1.default.readFileSync(agentPath, 'utf8');
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
        (0, config_1.recordStartupWarning)('[genie] YAML module unavailable; front matter metadata ignored.');
        return { meta: {}, body };
    }
    try {
        const parsed = YAML.parse(raw) || {};
        return { meta: parsed, body };
    }
    catch {
        return { meta: {}, body };
    }
}
