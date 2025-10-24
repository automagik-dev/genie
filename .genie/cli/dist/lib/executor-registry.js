"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_EXECUTOR_KEY = exports.EXECUTORS = void 0;
// Full executor mapping - matches Forge profile names
// See init.ts mapExecutorToForgeProfile for canonical mapping
const EXECUTOR_LABELS = {
    opencode: 'OpenCode',
    codex: 'ChatGPT',
    claude: 'Claude',
    gemini: 'Gemini',
    cursor: 'Cursor',
    qwen_code: 'Qwen Code',
    amp: 'Amp',
    copilot: 'GitHub Copilot'
};
// Build EXECUTORS dynamically from labels
exports.EXECUTORS = Object.keys(EXECUTOR_LABELS).reduce((acc, key) => {
    acc[key] = { label: EXECUTOR_LABELS[key] };
    return acc;
}, {});
exports.DEFAULT_EXECUTOR_KEY = 'opencode';
