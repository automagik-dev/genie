"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.USER_EXECUTOR_ORDER = exports.DEFAULT_EXECUTOR_KEY = exports.EXECUTORS = void 0;
exports.normalizeExecutorKey = normalizeExecutorKey;
exports.normalizeExecutorKeyOrDefault = normalizeExecutorKeyOrDefault;
exports.getExecutorLabel = getExecutorLabel;
const CANONICAL_EXECUTOR_LABELS = {
    GEMINI: 'Google Gemini',
    CODEX: 'ChatGPT',
    CLAUDE_CODE: 'Claude',
    CURSOR: 'Cursor',
    COPILOT: 'GitHub Copilot',
    OPENCODE: 'OpenCode',
    QWEN_CODE: 'Qwen Code',
    AMP: 'Amp'
};
const FRIENDLY_NAME_MAP = {
    claude: 'CLAUDE_CODE',
    chatgpt: 'CODEX'
};
// Build EXECUTORS dynamically from labels (canonical keys only)
exports.EXECUTORS = Object.keys(CANONICAL_EXECUTOR_LABELS).reduce((acc, key) => {
    acc[key] = { label: CANONICAL_EXECUTOR_LABELS[key] };
    return acc;
}, {});
exports.DEFAULT_EXECUTOR_KEY = 'OPENCODE';
exports.USER_EXECUTOR_ORDER = ['GEMINI', 'CODEX', 'CLAUDE_CODE', 'CURSOR', 'COPILOT'];
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
    const sanitizedUpper = sanitized.toUpperCase();
    if (sanitizedUpper in CANONICAL_EXECUTOR_LABELS) {
        return sanitizedUpper;
    }
    if (sanitized in FRIENDLY_NAME_MAP) {
        return FRIENDLY_NAME_MAP[sanitized];
    }
    const lower = trimmed.toLowerCase();
    if (lower in FRIENDLY_NAME_MAP) {
        return FRIENDLY_NAME_MAP[lower];
    }
    return upper;
}
function normalizeExecutorKeyOrDefault(key, fallback = exports.DEFAULT_EXECUTOR_KEY) {
    return normalizeExecutorKey(key) ?? fallback;
}
function getExecutorLabel(executorKey) {
    return CANONICAL_EXECUTOR_LABELS[executorKey] ?? executorKey;
}
