"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readSessionIdFromLog = readSessionIdFromLog;
exports.extractSessionIdFromContent = extractSessionIdFromContent;
exports.buildJsonlView = buildJsonlView;
const fs_1 = __importDefault(require("fs"));
const chat_1 = require("../views/chat");
const transcript_utils_1 = require("./transcript-utils");
function readSessionIdFromLog(logFile) {
    if (!logFile)
        return null;
    try {
        const content = fs_1.default.readFileSync(logFile, 'utf8');
        return extractSessionIdFromContent(content);
    }
    catch {
        return null;
    }
}
function extractSessionIdFromContent(content) {
    const lines = Array.isArray(content) ? content : String(content).split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const raw = lines[i];
        if (!raw)
            continue;
        const trimmed = raw.trim();
        if (!trimmed.startsWith('{'))
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (!parsed || typeof parsed !== 'object')
                continue;
            const candidate = parsed.session_id ||
                parsed.sessionId ||
                (parsed.session && (parsed.session.id || parsed.session.session_id || parsed.session.sessionId)) ||
                (parsed.data && (parsed.data.session_id || parsed.data.sessionId));
            if (candidate)
                return candidate;
            if (parsed.type === 'session.created' && parsed.id) {
                return parsed.id;
            }
        }
        catch {
            continue;
        }
    }
    return null;
}
/**
 * Parse Codex JSONL events into ChatMessage[] for conversation view.
 * Extracts all message types: reasoning, tool calls, assistant messages.
 */
function parseConversation(jsonl) {
    const messages = [];
    const responseBuffers = new Map();
    jsonl.forEach((event) => {
        const envelope = event && typeof event === 'object' ? event : {};
        // Handle both wrapped format from genie.ts and raw format
        // Wrapped: { timestamp, type: 'response_item', payload: {...} }
        // Raw: { type, item: {...} }
        const actualEvent = envelope.payload || envelope;
        const explicitType = actualEvent.type;
        const wrapperType = envelope.type;
        // Handle genie.ts wrapped events (agent_message, reasoning, user_message)
        if (wrapperType === 'response_item' || wrapperType === 'agent_message' || wrapperType === 'reasoning' || wrapperType === 'user_message') {
            if (wrapperType === 'agent_message' || (explicitType === 'message' && actualEvent.role === 'assistant')) {
                const content = actualEvent.content;
                if (Array.isArray(content)) {
                    const textParts = [];
                    content.forEach((part) => {
                        if (part.type === 'output_text' && part.text) {
                            textParts.push(part.text);
                        }
                        else if (part.type === 'input_text' && part.text) {
                            textParts.push(part.text);
                        }
                        else if (typeof part.text === 'string') {
                            textParts.push(part.text);
                        }
                    });
                    if (textParts.length > 0) {
                        messages.push({
                            role: 'assistant',
                            title: 'Assistant',
                            body: textParts
                        });
                    }
                }
                return;
            }
            if (wrapperType === 'reasoning') {
                const content = actualEvent.content;
                if (Array.isArray(content)) {
                    const textParts = [];
                    content.forEach((part) => {
                        if (part.type === 'text' && part.text) {
                            textParts.push(part.text);
                        }
                        else if (typeof part.text === 'string') {
                            textParts.push(part.text);
                        }
                    });
                    if (textParts.length > 0) {
                        messages.push({
                            role: 'reasoning',
                            title: 'Reasoning',
                            body: textParts
                        });
                    }
                }
                return;
            }
            if (wrapperType === 'user_message' || (explicitType === 'message' && actualEvent.role === 'user')) {
                const content = actualEvent.content;
                if (Array.isArray(content)) {
                    const textParts = [];
                    content.forEach((part) => {
                        if (part.type === 'input_text' && part.text) {
                            textParts.push(part.text);
                        }
                        else if (typeof part.text === 'string') {
                            textParts.push(part.text);
                        }
                    });
                    if (textParts.length > 0) {
                        messages.push({
                            role: 'action',
                            title: 'User',
                            body: textParts
                        });
                    }
                }
                return;
            }
        }
        // Handle raw item.completed events (Codex format from raw log)
        if (explicitType === 'item.completed') {
            const item = actualEvent.item || {};
            const text = typeof item.text === 'string' ? item.text.trim() : '';
            switch (item.item_type) {
                case 'assistant_message':
                    if (text) {
                        messages.push({
                            role: 'assistant',
                            title: 'Assistant',
                            body: [text]
                        });
                    }
                    break;
                case 'reasoning':
                    if (text) {
                        messages.push({
                            role: 'reasoning',
                            title: 'Reasoning',
                            body: [text]
                        });
                    }
                    break;
                case 'tool_call':
                    if (text || item.id) {
                        messages.push({
                            role: 'tool',
                            title: `Tool Call${item.id ? ` (${item.id})` : ''}`,
                            body: [text || JSON.stringify(item)]
                        });
                    }
                    break;
                case 'tool_result':
                    if (text || item.id) {
                        messages.push({
                            role: 'tool',
                            title: `Tool Result${item.id ? ` (${item.id})` : ''}`,
                            body: [text || JSON.stringify(item)]
                        });
                    }
                    break;
                default:
                    if (text) {
                        messages.push({
                            role: 'reasoning',
                            title: item.item_type || 'Item',
                            body: [text]
                        });
                    }
            }
            return;
        }
        // Handle streaming response events
        const payload = actualEvent.msg || actualEvent;
        const type = payload && payload.type;
        if (type === 'response.output_text.delta') {
            const responseId = actualEvent.response_id || payload.response_id;
            if (responseId) {
                const delta = actualEvent.delta || payload.delta || '';
                const prev = responseBuffers.get(responseId) || '';
                responseBuffers.set(responseId, prev + delta);
            }
        }
        else if (type === 'response.output_text.completed' || type === 'response.completed') {
            const responseId = actualEvent.response_id || payload.response_id;
            if (responseId && responseBuffers.has(responseId)) {
                const text = responseBuffers.get(responseId)?.trim();
                if (text) {
                    messages.push({
                        role: 'assistant',
                        title: 'Assistant',
                        body: [text]
                    });
                }
                responseBuffers.delete(responseId);
            }
        }
    });
    // Flush any remaining buffered responses
    responseBuffers.forEach((text) => {
        const cleaned = text.trim();
        if (cleaned) {
            messages.push({
                role: 'assistant',
                title: 'Assistant',
                body: [cleaned]
            });
        }
    });
    return messages;
}
/**
 * Extract metrics from Codex JSONL events and format for header meta items.
 * Follows Metrics Summarization Specification from wish.
 */
function extractMetrics(jsonl) {
    const metrics = [];
    const byCall = new Map();
    const execs = [];
    const mcp = [];
    const patches = { add: 0, update: 0, move: 0, delete: 0 };
    let tokenInfo = null;
    let rateLimits = null;
    jsonl.forEach((event) => {
        const envelope = event && typeof event === 'object' ? event : {};
        // Handle both wrapped format from genie.ts and raw format
        const actualEvent = envelope.payload || envelope;
        const payload = actualEvent.msg || actualEvent;
        const type = payload && payload.type;
        const rate = actualEvent.rate_limits || payload.rate_limits;
        switch (type) {
            case 'exec_command_begin':
                byCall.set(payload.call_id, { cmd: (payload.command || []).join(' ') });
                break;
            case 'exec_command_end': {
                execs.push({ exit: payload.exit_code });
                break;
            }
            case 'mcp_tool_call_begin':
                byCall.set(payload.call_id, { mcp: { server: payload.invocation?.server, tool: payload.invocation?.tool } });
                break;
            case 'mcp_tool_call_end': {
                const rec = byCall.get(payload.call_id) || { mcp: {} };
                mcp.push({ server: rec.mcp?.server || '?', tool: rec.mcp?.tool || '?' });
                break;
            }
            case 'patch_apply_begin': {
                const changes = payload.changes || {};
                Object.values(changes).forEach((chg) => {
                    if (chg.add)
                        patches.add += 1;
                    if (chg.update) {
                        patches.update += 1;
                        if (chg.update.move_path)
                            patches.move += 1;
                    }
                    if (chg.delete)
                        patches.delete += 1;
                });
                break;
            }
            case 'token_count': {
                const info = envelope.info || payload.info;
                if (info?.total_token_usage)
                    tokenInfo = info.total_token_usage;
                if (rate)
                    rateLimits = rate;
                break;
            }
            case 'token.usage': {
                if (payload.input_tokens || payload.output_tokens || payload.total_tokens) {
                    tokenInfo = {
                        input_tokens: payload.input_tokens,
                        output_tokens: payload.output_tokens,
                        total_tokens: payload.total_tokens || ((payload.input_tokens || 0) + (payload.output_tokens || 0))
                    };
                }
                break;
            }
            case 'response.usage': {
                const usage = envelope.usage || payload.usage || payload;
                if (usage) {
                    tokenInfo = {
                        input_tokens: usage.input_tokens || usage.prompt_tokens || 0,
                        output_tokens: usage.output_tokens || usage.completion_tokens || 0,
                        total_tokens: usage.total_tokens || usage.usage || ((usage.input_tokens || 0) + (usage.output_tokens || 0))
                    };
                }
                break;
            }
        }
    });
    // Tokens metric
    if (tokenInfo) {
        const info = tokenInfo;
        const inp = info.input_tokens ?? 0;
        const out = info.output_tokens ?? 0;
        const total = info.total_tokens ?? (inp + out);
        metrics.push({ label: 'Tokens', value: `in:${inp} out:${out} total:${total}` });
    }
    // MCP Calls metric (aggregate, top 2 servers)
    if (mcp.length > 0) {
        const serverCounts = new Map();
        mcp.forEach((call) => {
            serverCounts.set(call.server, (serverCounts.get(call.server) || 0) + 1);
        });
        const topServers = Array.from(serverCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2);
        const topServerStr = topServers.map(([srv, cnt]) => `${srv}:${cnt}`).join(' ');
        const moreCount = serverCounts.size > 2 ? ` +${serverCounts.size - 2} more` : '';
        metrics.push({ label: 'MCP Calls', value: `${mcp.length} calls (${topServerStr}${moreCount})` });
    }
    // Patches metric
    if (patches.add || patches.update || patches.move || patches.delete) {
        metrics.push({
            label: 'Patches',
            value: `add:${patches.add} update:${patches.update} move:${patches.move} delete:${patches.delete}`
        });
    }
    // Exec Commands metric
    if (execs.length > 0) {
        const okCount = execs.filter((e) => e.exit === 0).length;
        const errCount = execs.filter((e) => e.exit !== 0 && e.exit != null).length;
        metrics.push({
            label: 'Execs',
            value: `${execs.length} commands (${okCount} ok, ${errCount} err)`,
            tone: errCount > 0 ? 'warning' : undefined
        });
    }
    // Rate Limits metric
    if (rateLimits?.primary) {
        const usedPercent = rateLimits.primary.used_percent || 0;
        const resetSecs = rateLimits.primary.resets_in_seconds || 0;
        metrics.push({
            label: 'Rate Limit',
            value: `${usedPercent}% used, resets in ${resetSecs}s`,
            tone: usedPercent > 80 ? 'warning' : undefined
        });
    }
    return metrics;
}
function buildJsonlView(ctx) {
    const { render, parsed, paths, store, save } = ctx;
    const { entry, jsonl } = render;
    // Extract session ID from events if needed
    let sessionIdFromEvents = null;
    jsonl.forEach((event) => {
        const envelope = event && typeof event === 'object' ? event : {};
        // Handle both wrapped format from genie.ts and raw format
        const actualEvent = envelope.payload || envelope;
        const payload = actualEvent.msg || actualEvent;
        const type = payload && payload.type;
        if (type === 'session.created') {
            const found = payload.session_id || payload.sessionId || (payload.session && (payload.session.id || payload.session.session_id || payload.session.sessionId));
            if (found)
                sessionIdFromEvents = sessionIdFromEvents || found;
        }
    });
    if (sessionIdFromEvents && !entry.sessionId) {
        entry.sessionId = sessionIdFromEvents;
        save(paths, store);
    }
    // Parse conversation from JSONL events
    let allMessages = parseConversation(jsonl);
    // Determine slicing based on mode
    let messages;
    let showFull = false;
    if (parsed.options.full) {
        // Full mode: show all messages
        messages = allMessages;
        showFull = true;
    }
    else if (parsed.options.live) {
        // Live mode: show latest assistant message (+ optional preceding reasoning)
        messages = (0, transcript_utils_1.sliceForLatest)(allMessages);
    }
    else {
        // Default mode: show last 5 messages
        messages = allMessages.slice(-5);
    }
    // Extract metrics for header
    const metrics = extractMetrics(jsonl);
    // Build and return conversation view
    return (0, chat_1.buildChatView)({
        agent: entry.agent,
        sessionId: entry.sessionId || null,
        status: null,
        messages,
        meta: metrics,
        showFull
    });
}
exports.default = {
    readSessionIdFromLog,
    extractSessionIdFromContent,
    buildJsonlView
};
