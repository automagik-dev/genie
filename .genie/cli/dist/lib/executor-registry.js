"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_EXECUTOR_KEY = exports.EXECUTORS = void 0;
exports.normalizeExecutorKey = normalizeExecutorKey;
exports.normalizeExecutorKeyOrDefault = normalizeExecutorKeyOrDefault;
exports.getExecutorLabel = getExecutorLabel;
const CANONICAL_EXECUTOR_LABELS = {
    CLAUDE_CODE: 'Claude',
    CODEX: 'ChatGPT',
    OPENCODE: 'OpenCode',
    GEMINI: 'Gemini',
    CURSOR: 'Cursor',
    QWEN_CODE: 'Qwen Code',
    AMP: 'Amp',
    COPILOT: 'GitHub Copilot'
};
const EXECUTOR_ALIAS_MAP = {
    claude: 'CLAUDE_CODE',
    'claude-code': 'CLAUDE_CODE',
    'claude_code': 'CLAUDE_CODE',
    claudecode: 'CLAUDE_CODE',
    code: 'CLAUDE_CODE',
    codex: 'CODEX',
    opencode: 'OPENCODE',
    open_code: 'OPENCODE',
    gemini: 'GEMINI',
    cursor: 'CURSOR',
    qwen: 'QWEN_CODE',
    'qwen-code': 'QWEN_CODE',
    'qwen_code': 'QWEN_CODE',
    amp: 'AMP',
    copilot: 'COPILOT',
    'co-pilot': 'COPILOT'
};
// Build EXECUTORS dynamically from labels (canonical keys only)
exports.EXECUTORS = Object.keys(CANONICAL_EXECUTOR_LABELS).reduce((acc, key) => {
    acc[key] = { label: CANONICAL_EXECUTOR_LABELS[key] };
    return acc;
}, {});
exports.DEFAULT_EXECUTOR_KEY = 'OPENCODE';
/**
 * Normalize user-provided executor keys (CLI flags, env vars, config) to Forge canonical names.
 * Returns undefined when the input is empty/undefined.
 */
function normalizeExecutorKey(key) {
    if (key == null)
        return undefined;
    const trimmed = key.trim();
    if (!trimmed.length)
        return undefined;
    const upper = trimmed.toUpperCase();
    if (upper in CANONICAL_EXECUTOR_LABELS) {
        return upper;
    }
    const sanitized = trimmed.toLowerCase().replace(/\s+/g, '').replace(/-/g, '_');
    if (sanitized in EXECUTOR_ALIAS_MAP) {
        return EXECUTOR_ALIAS_MAP[sanitized];
    }
    const lower = trimmed.toLowerCase();
    if (lower in EXECUTOR_ALIAS_MAP) {
        return EXECUTOR_ALIAS_MAP[lower];
    }
    return upper;
}
function normalizeExecutorKeyOrDefault(key, fallback = exports.DEFAULT_EXECUTOR_KEY) {
    return normalizeExecutorKey(key) ?? fallback;
}
function getExecutorLabel(executorKey) {
    return CANONICAL_EXECUTOR_LABELS[executorKey] ?? executorKey;
}
