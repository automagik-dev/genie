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
    for (const line of lines) {
        if (!line)
            continue;
        const trimmed = line.trim();
        if (!trimmed.startsWith('{'))
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (!parsed || typeof parsed !== 'object')
                continue;
            if (parsed.type === 'system' && parsed.session_id) {
                return parsed.session_id;
            }
            if (parsed.session_id) {
                return parsed.session_id;
            }
        }
        catch {
            continue;
        }
    }
    return null;
}
/**
 * Parse Claude JSONL events into ChatMessage[] for conversation view.
 * Extracts all message types: assistant, user, reasoning, tool calls/results.
 */
function parseConversation(jsonl) {
    const messages = [];
    jsonl.forEach((event) => {
        if (!event || typeof event !== 'object')
            return;
        if (event.type === 'assistant' && event.message?.content) {
            const content = event.message.content;
            if (!Array.isArray(content))
                return;
            const textParts = [];
            const toolCalls = [];
            content.forEach((item) => {
                if (item.type === 'text' && item.text) {
                    textParts.push(item.text.trim());
                }
                else if (item.type === 'tool_use') {
                    const toolName = item.name || 'unknown';
                    const toolInput = JSON.stringify(item.input || {}, null, 2);
                    const toolId = item.id ? ` (${item.id})` : '';
                    toolCalls.push(`${toolName}${toolId}\n${toolInput}`);
                }
            });
            if (textParts.length > 0) {
                messages.push({
                    role: 'assistant',
                    title: 'Assistant',
                    body: textParts
                });
            }
            if (toolCalls.length > 0) {
                messages.push({
                    role: 'tool',
                    title: `Tool Call${toolCalls.length > 1 ? 's' : ''}`,
                    body: toolCalls
                });
            }
            return;
        }
        if (event.type === 'user' && event.message?.content) {
            const content = event.message.content;
            if (!Array.isArray(content))
                return;
            const textParts = [];
            const toolResults = [];
            content.forEach((item) => {
                if (item.type === 'text' && item.text) {
                    textParts.push(item.text.trim());
                }
                else if (item.type === 'tool_result') {
                    const toolId = item.tool_use_id ? ` [${item.tool_use_id}]` : '';
                    const resultContent = typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2);
                    toolResults.push(`${toolId}\n${resultContent}`);
                }
            });
            if (textParts.length > 0) {
                messages.push({
                    role: 'action',
                    title: 'User',
                    body: textParts
                });
            }
            if (toolResults.length > 0) {
                messages.push({
                    role: 'tool',
                    title: `Tool Result${toolResults.length > 1 ? 's' : ''}`,
                    body: toolResults
                });
            }
            return;
        }
        if (event.type === 'result' && event.result) {
            const resultText = typeof event.result === 'string' ? event.result : JSON.stringify(event.result, null, 2);
            messages.push({
                role: 'assistant',
                title: 'Final Result',
                body: [resultText]
            });
            return;
        }
    });
    return messages;
}
/**
 * Extract metrics from Claude JSONL events and format for header meta items.
 * Follows Metrics Summarization Specification from wish.
 */
function extractMetrics(jsonl) {
    const metrics = [];
    let tokenInfo = null;
    let model = null;
    const toolCallCounts = new Map();
    jsonl.forEach((event) => {
        if (!event || typeof event !== 'object')
            return;
        if (event.type === 'system' && event.model) {
            model = event.model;
            return;
        }
        if (event.type === 'assistant' && event.message?.content) {
            const content = event.message.content;
            if (Array.isArray(content)) {
                content.forEach((item) => {
                    if (item.type === 'tool_use' && item.name) {
                        const toolName = item.name;
                        toolCallCounts.set(toolName, (toolCallCounts.get(toolName) || 0) + 1);
                    }
                });
            }
            return;
        }
        if (event.type === 'result' && event.usage) {
            tokenInfo = {
                input_tokens: event.usage.input_tokens || 0,
                output_tokens: event.usage.output_tokens || 0,
                total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0)
            };
            return;
        }
    });
    if (tokenInfo) {
        const info = tokenInfo;
        const inp = info.input_tokens ?? 0;
        const out = info.output_tokens ?? 0;
        const total = info.total_tokens ?? (inp + out);
        metrics.push({ label: 'Tokens', value: `in:${inp} out:${out} total:${total}` });
    }
    if (toolCallCounts.size > 0) {
        const totalCalls = Array.from(toolCallCounts.values()).reduce((sum, count) => sum + count, 0);
        const topTools = Array.from(toolCallCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2);
        const topToolsStr = topTools.map(([tool, count]) => `${tool}:${count}`).join(' ');
        const moreCount = toolCallCounts.size > 2 ? ` +${toolCallCounts.size - 2} more` : '';
        metrics.push({ label: 'Tool Calls', value: `${totalCalls} calls (${topToolsStr}${moreCount})` });
    }
    if (model) {
        metrics.push({ label: 'Model', value: model });
    }
    return metrics;
}
function buildJsonlView(ctx) {
    const { render, parsed, paths, store, save } = ctx;
    const { entry, jsonl } = render;
    let sessionIdFromEvents = null;
    jsonl.forEach((event) => {
        if (!event || typeof event !== 'object')
            return;
        if (event.type === 'system' && event.session_id) {
            sessionIdFromEvents = sessionIdFromEvents || event.session_id;
        }
    });
    if (sessionIdFromEvents && !entry.sessionId) {
        entry.sessionId = sessionIdFromEvents;
        save(paths, store);
    }
    let allMessages = parseConversation(jsonl);
    let messages;
    let showFull = false;
    if (parsed.options.full) {
        messages = allMessages;
        showFull = true;
    }
    else if (parsed.options.live) {
        messages = (0, transcript_utils_1.sliceForLatest)(allMessages);
    }
    else {
        messages = allMessages.slice(-5);
    }
    const metrics = extractMetrics(jsonl);
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
