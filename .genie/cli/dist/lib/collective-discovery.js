"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.discoverCollectives = discoverCollectives;
exports.getDefaultCollectiveId = getDefaultCollectiveId;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const yaml_1 = __importDefault(require("yaml"));
/**
 * Auto-discover collectives by scanning .genie/ for directories with AGENTS.md
 * Collectives are detected by presence of root AGENTS.md file with frontmatter
 */
async function discoverCollectives(genieRoot) {
    const collectives = [];
    try {
        const entries = await promises_1.default.readdir(genieRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            // Skip known system directories
            const skipDirs = ['agents', 'workflows', 'skills', 'backups', 'cli', 'mcp', 'product',
                'reports', 'scripts', 'specs', 'state', 'teams', 'wishes', 'qa', 'discovery'];
            if (skipDirs.includes(entry.name))
                continue;
            // Check for AGENTS.md
            const agentsPath = path_1.default.join(genieRoot, entry.name, 'AGENTS.md');
            const exists = await promises_1.default.access(agentsPath).then(() => true).catch(() => false);
            if (exists) {
                // Extract metadata from frontmatter
                const content = await promises_1.default.readFile(agentsPath, 'utf8');
                const metadata = extractFrontmatter(content);
                collectives.push({
                    id: entry.name,
                    name: metadata.name || entry.name,
                    description: metadata.description || `${entry.name} collective`,
                    label: metadata.label || formatLabel(metadata.name || entry.name)
                });
            }
        }
        return collectives.sort((a, b) => a.id.localeCompare(b.id));
    }
    catch (error) {
        console.error(`Failed to discover collectives: ${error}`);
        return [];
    }
}
/**
 * Extract frontmatter from markdown file
 */
function extractFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match)
        return {};
    try {
        return yaml_1.default.parse(match[1]) || {};
    }
    catch {
        return {};
    }
}
/**
 * Format collective name into display label with emoji
 */
function formatLabel(name) {
    const emojiMap = {
        code: '💻',
        create: '✍️',
        utilities: '🔧',
        default: '📦'
    };
    const emoji = emojiMap[name.toLowerCase()] || emojiMap.default;
    const displayName = name.charAt(0).toUpperCase() + name.slice(1);
    return `${emoji} ${displayName}`;
}
/**
 * Get default collective ID (fallback when discovery fails)
 */
function getDefaultCollectiveId() {
    return 'code';
}
