"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runRuns = runRuns;
exports.runList = runList;
exports.emitAgentCatalog = emitAgentCatalog;
const session_store_1 = require("../session-store");
const session_helpers_1 = require("../lib/session-helpers");
const utils_1 = require("../lib/utils");
const runs_1 = require("../views/runs");
const view_helpers_1 = require("../lib/view-helpers");
const help_1 = require("../views/help");
const common_1 = require("../views/common");
const agent_catalog_1 = require("../views/agent-catalog");
const agent_resolver_1 = require("../lib/agent-resolver");
const config_defaults_1 = require("../lib/config-defaults");
async function runRuns(parsed, config, paths) {
    const warnings = [];
    const store = (0, session_store_1.loadSessions)(paths, config, config_defaults_1.DEFAULT_CONFIG, { onWarning: (message) => warnings.push(message) });
    const entries = Object.entries(store.agents || {});
    const rows = entries.map(([agent, entry]) => {
        const iso = entry.lastUsed ? (0, utils_1.safeIsoString)(entry.lastUsed) : entry.created ? (0, utils_1.safeIsoString)(entry.created) : null;
        return {
            agent,
            status: (0, session_helpers_1.resolveDisplayStatus)(entry),
            sessionId: entry.sessionId || null,
            updated: iso ? (0, utils_1.formatRelativeTime)(iso) : 'n/a',
            updatedIso: iso,
            log: entry.logFile ? (0, utils_1.formatPathRelative)(entry.logFile, paths.baseDir || '.') : null
        };
    });
    const isActive = (row) => {
        const normalized = (row.status || '').toLowerCase();
        return normalized.startsWith('running') || normalized.startsWith('pending');
    };
    const sortByUpdated = (a, b) => {
        const aTime = a.updatedIso ? new Date(a.updatedIso).getTime() : 0;
        const bTime = b.updatedIso ? new Date(b.updatedIso).getTime() : 0;
        return bTime - aTime;
    };
    const active = rows.filter(isActive).sort(sortByUpdated);
    const recent = rows.filter((row) => !isActive(row)).sort(sortByUpdated).slice(0, 10);
    const envelope = (0, runs_1.buildRunsOverviewView)({
        active,
        recent,
        warnings: warnings.length ? warnings : undefined
    });
    await (0, view_helpers_1.emitView)(envelope, parsed.options);
}
async function runList(parsed, config, paths) {
    const [targetRaw] = parsed.commandArgs;
    if (!targetRaw) {
        await (0, view_helpers_1.emitView)((0, help_1.buildListHelpView)(), parsed.options);
        return;
    }
    const target = targetRaw.toLowerCase();
    if (target === 'agents') {
        await emitAgentCatalog(parsed);
        return;
    }
    if (target === 'sessions') {
        await runRuns(parsed, config, paths);
        return;
    }
    await (0, view_helpers_1.emitView)((0, common_1.buildErrorView)('Unknown list target', `Unknown list target '${targetRaw}'. Try 'agents' or 'sessions'.`), parsed.options, { stream: process.stderr });
    process.exitCode = 1;
}
async function emitAgentCatalog(parsed) {
    const agents = (0, agent_resolver_1.listAgents)();
    const summarize = (entry) => {
        const description = (entry.meta?.description || entry.meta?.summary || '').replace(/\s+/g, ' ').trim();
        return (0, utils_1.truncateText)(description || '—', 96);
    };
    const grouped = new Map();
    agents.forEach((entry) => {
        const folder = entry.folder ?? '.';
        if (!grouped.has(folder))
            grouped.set(folder, []);
        grouped.get(folder).push(entry);
    });
    const orderedFolders = Array.from(grouped.keys()).sort((a, b) => {
        if (a === '.')
            return -1;
        if (b === '.')
            return 1;
        return a.localeCompare(b);
    });
    const groups = orderedFolders.map((folder) => ({
        label: folder === '.' ? 'root' : folder,
        rows: grouped
            .get(folder)
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((entry) => ({ id: entry.id, summary: summarize(entry) }))
    }));
    const envelope = (0, agent_catalog_1.buildAgentCatalogView)({
        total: agents.length,
        groups
    });
    await (0, view_helpers_1.emitView)(envelope, parsed.options);
}
