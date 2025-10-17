"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runRuns = runRuns;
exports.runList = runList;
exports.emitAgentCatalog = emitAgentCatalog;
const session_store_1 = require("../session-store");
const session_helpers_1 = require("../lib/session-helpers");
const utils_1 = require("../lib/utils");
const markdown_formatter_js_1 = require("../lib/markdown-formatter.js");
const agent_resolver_1 = require("../lib/agent-resolver");
const config_defaults_1 = require("../lib/config-defaults");
async function runRuns(parsed, config, paths) {
    const warnings = [];
    const store = (0, session_store_1.loadSessions)(paths, config, config_defaults_1.DEFAULT_CONFIG, { onWarning: (message) => warnings.push(message) });
    // Cleanup zombie sessions (stuck in "running" for >24h with no live processes)
    const now = Date.now();
    const ZOMBIE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
    let zombieCount = 0;
    for (const [sessionId, entry] of Object.entries(store.sessions || {})) {
        if (entry.status === 'running' && entry.lastUsed) {
            const lastUsedTime = new Date(entry.lastUsed).getTime();
            const age = now - lastUsedTime;
            if (age > ZOMBIE_THRESHOLD_MS) {
                // Check if processes are actually dead
                const status = (0, session_helpers_1.resolveDisplayStatus)(entry);
                if (status !== 'running') {
                    entry.status = 'abandoned';
                    entry.lastUsed = new Date().toISOString();
                    zombieCount++;
                }
            }
        }
    }
    if (zombieCount > 0) {
        (0, session_store_1.saveSessions)(paths, store);
        warnings.push(`Cleaned up ${zombieCount} zombie session(s)`);
    }
    const entries = Object.entries(store.sessions || {});
    const sessions = entries.map(([sessionId, entry]) => ({
        sessionId: entry.sessionId || sessionId,
        agent: entry.agent,
        status: (0, session_helpers_1.resolveDisplayStatus)(entry),
        executor: String(entry.executor || 'unknown'),
        started: entry.created ? (0, utils_1.safeIsoString)(entry.created) ?? undefined : undefined,
        updated: entry.lastUsed ? (0, utils_1.safeIsoString)(entry.lastUsed) ?? undefined : undefined
    }));
    const markdown = (0, markdown_formatter_js_1.formatSessionList)(sessions);
    console.log(markdown);
    if (warnings.length) {
        console.log('\n⚠️  Warnings:');
        warnings.forEach(w => console.log(`  ${w}`));
    }
}
async function runList(parsed, config, paths) {
    const [targetRaw] = parsed.commandArgs;
    if (!targetRaw) {
        console.log('Usage: genie list <agents|sessions>');
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
    console.error(`Error: Unknown list target '${targetRaw}'. Try 'agents' or 'sessions'.`);
    process.exitCode = 1;
}
async function emitAgentCatalog(parsed) {
    const agents = (0, agent_resolver_1.listAgents)();
    console.log(`## Available Agents (${agents.length} total)\n`);
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
    orderedFolders.forEach((folder) => {
        const label = folder === '.' ? 'root' : folder;
        console.log(`### ${label}\n`);
        const folderAgents = grouped.get(folder).sort((a, b) => a.label.localeCompare(b.label));
        folderAgents.forEach((agent) => {
            const description = (agent.meta?.description || agent.meta?.summary || '')
                .replace(/\s+/g, ' ')
                .trim();
            const summary = (0, utils_1.truncateText)(description || '—', 96);
            console.log(`- **${agent.id}**: ${summary}`);
        });
        console.log('');
    });
}
