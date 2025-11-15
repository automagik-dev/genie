"use strict";
/**
 * Server helper utilities
 * Extracted from server.ts per Amendment 10 (file size discipline)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findWorkspaceRoot = findWorkspaceRoot;
exports.listAgents = listAgents;
exports.loadForgeExecutor = loadForgeExecutor;
exports.listSessions = listSessions;
exports.getGenieVersion = getGenieVersion;
exports.getVersionHeader = getVersionHeader;
exports.syncAgentProfilesToForge = syncAgentProfilesToForge;
exports.loadOAuth2Config = loadOAuth2Config;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const display_transform_js_1 = require("./display-transform.js");
// Find actual workspace root by searching upward for .genie/ directory
function findWorkspaceRoot() {
    let dir = process.cwd();
    while (dir !== path_1.default.dirname(dir)) {
        if (fs_1.default.existsSync(path_1.default.join(dir, '.genie'))) {
            return dir;
        }
        dir = path_1.default.dirname(dir);
    }
    // Fallback to process.cwd() if .genie not found
    return process.cwd();
}
// Helper: List available agents from all collectives
function listAgents() {
    const workspaceRoot = findWorkspaceRoot();
    const agents = [];
    // ONLY scan specific agents/ directories (not workflows/ or spells/)
    const searchDirs = [
        path_1.default.join(workspaceRoot, '.genie/code/agents'),
        path_1.default.join(workspaceRoot, '.genie/create/agents')
    ];
    const visit = (dirPath, relativePath) => {
        const entries = fs_1.default.readdirSync(dirPath, { withFileTypes: true });
        entries.forEach((entry) => {
            const entryPath = path_1.default.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                // Recurse into subdirectories (for sub-agents like git/workflows/, wish/)
                visit(entryPath, relativePath ? path_1.default.join(relativePath, entry.name) : entry.name);
                return;
            }
            if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'README.md') {
                return;
            }
            const rawId = relativePath ? path_1.default.join(relativePath, entry.name) : entry.name;
            const normalizedId = rawId.replace(/\.md$/i, '').split(path_1.default.sep).join('/');
            // Extract frontmatter to get name and description
            const content = fs_1.default.readFileSync(entryPath, 'utf8');
            const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
            let name = normalizedId;
            let description;
            if (frontmatterMatch) {
                const frontmatter = frontmatterMatch[1];
                const nameMatch = frontmatter.match(/name:\s*(.+)/);
                const descMatch = frontmatter.match(/description:\s*(.+)/);
                if (nameMatch)
                    name = nameMatch[1].trim();
                if (descMatch)
                    description = descMatch[1].trim();
            }
            // Transform display path (strip template/category folders)
            const { displayId, displayFolder } = (0, display_transform_js_1.transformDisplayPath)(normalizedId);
            agents.push({ id: normalizedId, displayId, name, description, folder: displayFolder || undefined });
        });
    };
    // Visit all search directories
    searchDirs.forEach(baseDir => {
        if (fs_1.default.existsSync(baseDir)) {
            visit(baseDir, null);
        }
    });
    return agents;
}
// Helper: Safely load Forge executor from dist (package) or src (repo)
function loadForgeExecutor() {
    // Prefer compiled dist (works in published package)
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('../../cli/lib/forge-executor');
    }
    catch (_distErr) {
        // Fallback to TypeScript sources for local dev (within repo)
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            return require('../../../src/cli/lib/forge-executor');
        }
        catch (_srcErr) {
            return null;
        }
    }
}
// Helper: List recent sessions (uses Forge API)
async function listSessions() {
    const workspaceRoot = findWorkspaceRoot();
    try {
        // ALWAYS use Forge API for session listing (complete executor replacement)
        const mod = loadForgeExecutor();
        if (!mod || typeof mod.createForgeExecutor !== 'function') {
            throw new Error('Forge executor unavailable (did you build the CLI?)');
        }
        const forgeExecutor = mod.createForgeExecutor();
        const forgeSessions = await forgeExecutor.listSessions();
        const sessions = forgeSessions.map((entry) => ({
            id: entry.id || entry.taskId || 'unknown',
            name: entry.name || entry.taskId || 'unknown',
            agent: entry.agent || 'unknown',
            status: entry.status || 'unknown',
            created: entry.created || 'unknown',
            lastUsed: entry.lastUsed || entry.created || 'unknown'
        }));
        // Filter: Show running sessions + recent completed (last 10)
        // Fix Bug #5: Filter out stale sessions (>24 hours old with no recent activity)
        const now = Date.now();
        const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
        const running = sessions.filter((s) => {
            const status = s.status === 'running' || s.status === 'starting';
            if (!status)
                return false;
            // Check if session is stale (created >24h ago, no recent activity)
            if (s.lastUsed !== 'unknown') {
                const lastUsedTime = new Date(s.lastUsed).getTime();
                const age = now - lastUsedTime;
                if (age > STALE_THRESHOLD_MS) {
                    // Mark as stale but keep for manual cleanup
                    return false;
                }
            }
            return true;
        });
        const completed = sessions
            .filter((s) => s.status === 'completed')
            .sort((a, b) => {
            if (a.lastUsed === 'unknown')
                return 1;
            if (b.lastUsed === 'unknown')
                return -1;
            return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
        })
            .slice(0, 10);
        // Combine and sort by lastUsed descending
        return [...running, ...completed].sort((a, b) => {
            if (a.lastUsed === 'unknown')
                return 1;
            if (b.lastUsed === 'unknown')
                return -1;
            return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
        });
    }
    catch (error) {
        // Fallback to local sessions.json if Forge API fails
        console.warn('Failed to fetch Forge sessions, falling back to local store');
        const sessionsFile = path_1.default.join(workspaceRoot, '.genie/state/agents/sessions.json');
        if (!fs_1.default.existsSync(sessionsFile)) {
            return [];
        }
        try {
            const content = fs_1.default.readFileSync(sessionsFile, 'utf8');
            const store = JSON.parse(content);
            const sessions = Object.entries(store.sessions || {}).map(([key, entry]) => ({
                id: entry.taskId || key,
                name: entry.name || key,
                agent: entry.agent || key,
                status: entry.status || 'unknown',
                created: entry.created || 'unknown',
                lastUsed: entry.lastUsed || entry.created || 'unknown'
            }));
            // Apply same stale filter as Forge path (Fix Bug #5)
            const now = Date.now();
            const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
            const running = sessions.filter(s => {
                const status = s.status === 'running' || s.status === 'starting';
                if (!status)
                    return false;
                // Filter out stale sessions
                if (s.lastUsed !== 'unknown') {
                    const lastUsedTime = new Date(s.lastUsed).getTime();
                    const age = now - lastUsedTime;
                    if (age > STALE_THRESHOLD_MS) {
                        return false;
                    }
                }
                return true;
            });
            const completed = sessions
                .filter(s => s.status === 'completed')
                .sort((a, b) => {
                if (a.lastUsed === 'unknown')
                    return 1;
                if (b.lastUsed === 'unknown')
                    return -1;
                return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
            })
                .slice(0, 10);
            return [...running, ...completed].sort((a, b) => {
                if (a.lastUsed === 'unknown')
                    return 1;
                if (b.lastUsed === 'unknown')
                    return -1;
                return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
            });
        }
        catch (error) {
            return [];
        }
    }
}
// Helper: Get Genie version from package.json
function getGenieVersion() {
    try {
        // From dist/mcp/lib/server-helpers.js → root package.json (3 levels up)
        const packageJsonPath = path_1.default.join(__dirname, '../../..', 'package.json');
        const packageJson = JSON.parse(fs_1.default.readFileSync(packageJsonPath, 'utf8'));
        return packageJson.version || '0.0.0';
    }
    catch (error) {
        return '0.0.0';
    }
}
// Helper: Get version header for MCP outputs
function getVersionHeader() {
    return `Genie MCP v${getGenieVersion()}\n\n`;
}
// NOTE: Agent profile sync removed - Forge discovers .genie folders natively
async function syncAgentProfilesToForge() {
    // No-op: Forge discovers .genie folders natively, sync no longer needed
}
// Load OAuth2 configuration (if available)
function loadOAuth2Config() {
    const workspaceRoot = findWorkspaceRoot();
    // Try multiple locations for config-manager.js
    const searchPaths = [
        // 1. User workspace (for dev mode)
        path_1.default.join(workspaceRoot, 'dist', 'cli', 'lib', 'config-manager.js'),
        // 2. Global install (resolved relative to this MCP server file)
        // MCP server at: node_modules/automagik-genie/dist/mcp/lib/server-helpers.js
        // CLI at:        node_modules/automagik-genie/dist/cli/lib/config-manager.js
        path_1.default.join(__dirname, '../../cli/lib/config-manager.js'),
    ];
    for (const configModPath of searchPaths) {
        try {
            if (fs_1.default.existsSync(configModPath)) {
                const { loadOAuth2Config } = require(configModPath);
                return loadOAuth2Config();
            }
        }
        catch (error) {
            // Try next path
            continue;
        }
    }
    // Config not available (expected for stdio transport)
    return null;
}
