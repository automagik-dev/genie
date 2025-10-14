"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const stream_1 = require("stream");
const logViewer = __importStar(require("./claude-log-viewer"));
const defaults = {
    binary: 'claude',
    packageSpec: undefined,
    sessionsDir: undefined,
    exec: {
        model: 'sonnet',
        permissionMode: 'default',
        outputFormat: 'stream-json',
        allowedTools: [],
        disallowedTools: []
    },
    resume: {
        outputFormat: 'stream-json'
    },
    sessionExtractionDelayMs: 1000
};
function buildRunCommand({ config = {}, instructions, agentPath, prompt }) {
    const execConfig = mergeExecConfig(config);
    const command = config.binary || defaults.binary;
    const args = ['-p', '--verbose', '--output-format', 'stream-json'];
    // Debug: log exec config
    console.error(`[DEBUG] execConfig.permissionMode = ${execConfig.permissionMode}`);
    if (execConfig.model) {
        args.push('--model', String(execConfig.model));
    }
    if (execConfig.permissionMode) {
        args.push('--permission-mode', String(execConfig.permissionMode));
        console.error(`[DEBUG] Added --permission-mode ${execConfig.permissionMode}`);
    }
    else {
        console.error(`[DEBUG] permissionMode is falsy, not adding flag`);
    }
    if (Array.isArray(execConfig.allowedTools) && execConfig.allowedTools.length > 0) {
        args.push('--allowed-tools', execConfig.allowedTools.join(','));
    }
    if (Array.isArray(execConfig.disallowedTools) && execConfig.disallowedTools.length > 0) {
        args.push('--disallowed-tools', execConfig.disallowedTools.join(','));
    }
    // Prefer instructions (already loaded) over agentPath (requires file read)
    if (instructions) {
        args.push('--append-system-prompt', instructions);
    }
    else if (agentPath) {
        const instructionsFile = path_1.default.isAbsolute(agentPath) ? agentPath : path_1.default.resolve(agentPath);
        try {
            const content = fs_1.default.readFileSync(instructionsFile, 'utf-8');
            args.push('--append-system-prompt', content);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[genie] Failed to read agent file at ${instructionsFile}: ${message}`);
        }
    }
    if (prompt) {
        args.push(prompt);
    }
    return { command, args };
}
function buildResumeCommand({ config = {}, sessionId, prompt }) {
    const resumeConfig = mergeResumeConfig(config.resume);
    const command = config.binary || defaults.binary;
    const args = ['-p', '--verbose', '--output-format', 'stream-json'];
    if (sessionId) {
        args.push('--resume', sessionId);
    }
    if (prompt) {
        args.push(prompt);
    }
    return { command, args };
}
function resolvePaths({ config = {}, baseDir, resolvePath }) {
    return {};
}
function extractSessionId({ startTime, paths = {} }) {
    return null;
}
function getSessionExtractionDelay({ config = {}, defaultDelay }) {
    if (typeof config.sessionExtractionDelayMs === 'number') {
        return config.sessionExtractionDelayMs;
    }
    if (typeof defaults.sessionExtractionDelayMs === 'number') {
        return defaults.sessionExtractionDelayMs;
    }
    return defaultDelay;
}
function mergeExecConfig(execConfig = {}) {
    return {
        ...defaults.exec,
        ...execConfig,
        allowedTools: Array.isArray(execConfig.allowedTools)
            ? execConfig.allowedTools.slice()
            : defaults.exec.allowedTools.slice(),
        disallowedTools: Array.isArray(execConfig.disallowedTools)
            ? execConfig.disallowedTools.slice()
            : defaults.exec.disallowedTools.slice()
    };
}
function mergeResumeConfig(resume = {}) {
    return {
        ...defaults.resume,
        ...resume
    };
}
function createOutputFilter(destination) {
    return new stream_1.Transform({
        transform(chunk, _encoding, callback) {
            const text = chunk.toString('utf8');
            const lines = text.split('\n');
            const output = [];
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('{')) {
                    output.push(line);
                    continue;
                }
                try {
                    const event = JSON.parse(trimmed);
                    const type = event.type;
                    if (type === 'system' && event.subtype === 'init') {
                        const minimal = JSON.stringify({
                            type: 'system',
                            subtype: 'init',
                            session_id: event.session_id,
                            model: event.model
                        });
                        output.push(minimal);
                    }
                    else if (type === 'assistant' && event.message?.content) {
                        const content = event.message.content;
                        if (Array.isArray(content)) {
                            for (const block of content) {
                                if (block.type === 'text' && block.text?.trim()) {
                                    output.push(`\n[assistant] ${block.text}`);
                                }
                                else if (block.type === 'tool_use') {
                                    output.push(`[tool] ${block.name}`);
                                }
                            }
                        }
                    }
                    else if (type === 'user' && event.message?.content) {
                        // Tool results
                        const content = event.message.content;
                        if (Array.isArray(content)) {
                            for (const block of content) {
                                if (block.type === 'tool_result') {
                                    const resultText = typeof block.content === 'string'
                                        ? block.content.slice(0, 100)
                                        : JSON.stringify(block.content).slice(0, 100);
                                    output.push(`[tool_result] ${resultText}...`);
                                }
                            }
                        }
                    }
                    else if (type === 'result' && event.subtype === 'success') {
                        const summary = JSON.stringify({
                            type: 'result',
                            success: true,
                            duration_ms: event.duration_ms,
                            session_id: event.session_id,
                            tokens: {
                                input: event.usage?.input_tokens || 0,
                                output: event.usage?.output_tokens || 0
                            },
                            cost_usd: event.total_cost_usd
                        });
                        output.push(summary);
                    }
                }
                catch {
                    output.push(line);
                }
            }
            const filtered = output.join('\n') + '\n';
            this.push(filtered);
            destination.write(filtered);
            callback();
        }
    });
}
const claudeExecutor = {
    defaults,
    buildRunCommand,
    buildResumeCommand,
    resolvePaths,
    extractSessionId,
    getSessionExtractionDelay,
    createOutputFilter,
    logViewer
};
exports.default = claudeExecutor;
