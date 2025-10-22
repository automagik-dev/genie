import fs from 'fs';
/**
 * Generate a friendly session name from agent name and timestamp.
 * Format: "{agent}-{YYMMDDHHmm}"
 * Example: "analyze-2310171530"
 */
export function generateSessionName(agentName) {
    const now = new Date();
    const timestamp = now.toISOString()
        .replace(/[-:T]/g, '')
        .slice(2, 12); // YYMMDDHHmm
    const slug = agentName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'session';
    return `${slug}-${timestamp}`;
}
export function loadSessions(paths = {}, config = {}, defaults = {}, callbacks = {}) {
    const storePath = paths.sessionsFile;
    let store;
    if (storePath && fs.existsSync(storePath)) {
        store = normalizeSessionStore(readJson(storePath, callbacks), callbacks);
    }
    else {
        store = { version: 3, sessions: {} };
    }
    const defaultExecutor = resolveDefaultExecutor(config, defaults);
    return migrateSessionEntries(store, defaultExecutor);
}
export function saveSessions(paths = {}, store) {
    if (!paths.sessionsFile)
        return;
    const payload = JSON.stringify(store, null, 2);
    fs.writeFileSync(paths.sessionsFile, payload);
}
function readJson(filePath, callbacks) {
    const content = fs.readFileSync(filePath, 'utf8');
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
        return { version: 3, sessions: {} };
    }
    const incoming = data;
    // Version 3 format (sessions keyed by name) - current
    if (incoming.version === 3 && incoming.sessions) {
        return {
            version: 3,
            sessions: incoming.sessions
        };
    }
    // Version 2 format (sessions keyed by sessionId) - MIGRATE to v3
    if (incoming.version === 2 && incoming.sessions) {
        callbacks.onWarning?.('Migrating sessions.json from v2 (sessionId-keyed) to v3 (name-keyed)');
        const sessions = {};
        Object.entries(incoming.sessions).forEach(([sessionId, entry]) => {
            if (!entry || typeof entry !== 'object')
                return;
            // Use existing name or generate one from sessionId
            const name = entry.name || `migrated-${sessionId.slice(0, 8)}`;
            sessions[name] = {
                ...entry,
                name
            };
        });
        return {
            version: 3,
            sessions
        };
    }
    // Version 2 without explicit version number
    if (incoming.sessions && !incoming.version) {
        callbacks.onWarning?.('Migrating sessions.json from v2 (sessionId-keyed) to v3 (name-keyed)');
        const sessions = {};
        Object.entries(incoming.sessions).forEach(([sessionId, entry]) => {
            if (!entry || typeof entry !== 'object')
                return;
            const name = entry.name || `migrated-${sessionId.slice(0, 8)}`;
            sessions[name] = {
                ...entry,
                name
            };
        });
        return {
            version: 3,
            sessions
        };
    }
    // Version 1 format (agents keyed by agent name) - MIGRATE to v3
    if (incoming.agents) {
        callbacks.onWarning?.('Migrating sessions.json from v1 (agent-keyed) to v3 (name-keyed)');
        const sessions = {};
        Object.entries(incoming.agents).forEach(([agentName, entry]) => {
            if (typeof entry !== 'object' || entry === null)
                return;
            if (agentName === 'version' || agentName === 'sessions' || agentName === 'executor')
                return;
            if (!entry.agent && !entry.sessionId)
                return;
            const name = entry.name || `migrated-${agentName}`;
            sessions[name] = {
                ...entry,
                agent: entry.agent || agentName,
                name
            };
        });
        return {
            version: 3,
            sessions
        };
    }
    // Empty or malformed
    return {
        version: 3,
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
        'opencode');
}
export const _internals = {
    readJson,
    normalizeSessionStore,
    migrateSessionEntries,
    resolveDefaultExecutor
};
