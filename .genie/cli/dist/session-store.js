"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports._internals = void 0;
exports.generateSessionName = generateSessionName;
exports.loadSessions = loadSessions;
exports.saveSessions = saveSessions;
const fs_1 = __importDefault(require("fs"));
/**
 * Generate a friendly session name from agent name and timestamp.
 * Format: "{agent}-{YYMMDDHHmm}"
 * Example: "analyze-2310171530"
 */
function generateSessionName(agentName) {
    const now = new Date();
    const timestamp = now.toISOString()
        .replace(/[-:T]/g, '')
        .slice(2, 12); // YYMMDDHHmm
    return `${agentName}-${timestamp}`;
}
function loadSessions(paths = {}, config = {}, defaults = {}, callbacks = {}) {
    const storePath = paths.sessionsFile;
    let store;
    if (storePath && fs_1.default.existsSync(storePath)) {
        store = normalizeSessionStore(readJson(storePath, callbacks), callbacks);
    }
    else {
        store = { version: 2, sessions: {} };
    }
    const defaultExecutor = resolveDefaultExecutor(config, defaults);
    return migrateSessionEntries(store, defaultExecutor);
}
function saveSessions(paths = {}, store) {
    if (!paths.sessionsFile)
        return;
    const payload = JSON.stringify(store, null, 2);
    fs_1.default.writeFileSync(paths.sessionsFile, payload);
}
function readJson(filePath, callbacks) {
    const content = fs_1.default.readFileSync(filePath, 'utf8');
    if (!content.trim().length)
        return {};
    try {
        return JSON.parse(content);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        callbacks.onWarning?.(`Could not parse JSON from ${filePath}: ${message}`);
        return {};
    }
}
function normalizeSessionStore(data, callbacks = {}) {
    if (!data || typeof data !== 'object') {
        return { version: 2, sessions: {} };
    }
    const incoming = data;
    // Version 2 format (sessions keyed by sessionId)
    if (incoming.sessions) {
        return {
            version: 2,
            sessions: incoming.sessions
        };
    }
    // Version 1 format (agents keyed by agent name) - MIGRATE
    if (incoming.agents) {
        callbacks.onWarning?.('Migrating sessions.json from v1 (agent-keyed) to v2 (sessionId-keyed)');
        const sessions = {};
        Object.entries(incoming.agents).forEach(([agentName, entry]) => {
            // Generate sessionId if missing (fallback to agent name for old entries)
            const sessionId = entry.sessionId || `legacy-${agentName}-${Date.now()}`;
            sessions[sessionId] = {
                ...entry,
                agent: agentName,
                sessionId
            };
        });
        return {
            version: 2,
            sessions
        };
    }
    // Empty or malformed
    return {
        version: 2,
        sessions: {}
    };
}
function migrateSessionEntries(store, defaultExecutor) {
    const result = {
        version: store.version ?? 2,
        sessions: { ...store.sessions }
    };
    // Migrate session entries (apply defaults)
    Object.entries(result.sessions || {}).forEach(([sessionId, entry]) => {
        if (!entry || typeof entry !== 'object')
            return;
        if (!entry.mode && entry.preset)
            result.sessions[sessionId].mode = entry.preset;
        if (!entry.preset && entry.mode)
            result.sessions[sessionId].preset = entry.mode;
        if (!entry.executor)
            result.sessions[sessionId].executor = defaultExecutor;
    });
    return result;
}
function resolveDefaultExecutor(config = {}, defaults = {}) {
    return (config.defaults?.executor ||
        defaults.defaults?.executor ||
        'codex');
}
exports._internals = {
    readJson,
    normalizeSessionStore,
    migrateSessionEntries,
    resolveDefaultExecutor
};
