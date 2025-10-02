"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports._internals = void 0;
exports.loadSessions = loadSessions;
exports.saveSessions = saveSessions;
const fs_1 = __importDefault(require("fs"));
function loadSessions(paths = {}, config = {}, defaults = {}, callbacks = {}) {
    const storePath = paths.sessionsFile;
    let store;
    if (storePath && fs_1.default.existsSync(storePath)) {
        store = normalizeSessionStore(readJson(storePath, callbacks));
    }
    else {
        store = { version: 1, agents: {} };
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
function normalizeSessionStore(data) {
    if (!data || typeof data !== 'object') {
        return { version: 1, agents: {} };
    }
    const incoming = data;
    if (incoming.agents) {
        return {
            version: incoming.version ?? 1,
            agents: incoming.agents
        };
    }
    return {
        version: 1,
        agents: incoming
    };
}
function migrateSessionEntries(store, defaultExecutor) {
    const result = {
        version: store.version ?? 1,
        agents: { ...store.agents }
    };
    Object.entries(result.agents || {}).forEach(([agent, entry]) => {
        if (!entry || typeof entry !== 'object')
            return;
        if (!entry.mode && entry.preset)
            result.agents[agent].mode = entry.preset;
        if (!entry.preset && entry.mode)
            result.agents[agent].preset = entry.mode;
        if (!entry.executor)
            result.agents[agent].executor = defaultExecutor;
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
