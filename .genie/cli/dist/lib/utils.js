"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatRelativeTime = formatRelativeTime;
exports.formatPathRelative = formatPathRelative;
exports.truncateText = truncateText;
exports.sanitizeLogFilename = sanitizeLogFilename;
exports.safeIsoString = safeIsoString;
exports.deriveStartTime = deriveStartTime;
exports.deriveLogFile = deriveLogFile;
exports.deepClone = deepClone;
exports.mergeDeep = mergeDeep;
const path_1 = __importDefault(require("path"));
const background_manager_1 = require("../background-manager");
/**
 * Formats ISO timestamp as human-readable relative time.
 *
 * @param {string} value - ISO timestamp string
 * @returns {string} - Relative time (e.g., '3m ago', '2h ago', '5d ago') or date string
 *
 * @example
 * formatRelativeTime('2025-09-30T10:00:00Z')
 * // Returns: '5m ago' (if current time is 10:05:00)
 */
function formatRelativeTime(value) {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp))
        return 'n/a';
    const diffMs = Date.now() - timestamp;
    if (diffMs < 0)
        return 'just now';
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 5)
        return 'just now';
    if (seconds < 60)
        return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7)
        return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5)
        return `${weeks}w ago`;
    return new Date(value).toLocaleDateString();
}
/**
 * Formats absolute path as relative to base directory.
 *
 * @param {string} targetPath - Absolute path to format
 * @param {string} baseDir - Base directory for relative calculation
 * @returns {string} - Relative path or original path if calculation fails
 */
function formatPathRelative(targetPath, baseDir) {
    if (!targetPath)
        return 'n/a';
    try {
        return path_1.default.relative(baseDir, targetPath) || targetPath;
    }
    catch {
        return targetPath;
    }
}
/**
 * Truncates text to maximum length with ellipsis.
 *
 * @param {string} text - Text to truncate
 * @param {number} [maxLength=64] - Maximum length (default: 64)
 * @returns {string} - Truncated text with '...' suffix if needed
 */
function truncateText(text, maxLength = 64) {
    if (!text)
        return '';
    if (text.length <= maxLength)
        return text;
    const sliceLength = Math.max(0, maxLength - 3);
    return text.slice(0, sliceLength).trimEnd() + '...';
}
/**
 * Sanitizes agent name for safe use as log filename.
 *
 * Replaces path separators with dashes, removes special characters,
 * collapses consecutive separators, and trims edge characters.
 *
 * @param {string} agentName - Agent name to sanitize
 * @returns {string} - Safe filename (alphanumeric, dashes, dots, underscores only)
 *
 * @example
 * sanitizeLogFilename('utilities/twin')  // Returns: 'utilities-twin'
 * sanitizeLogFilename('my-agent@@!!')    // Returns: 'my-agent'
 */
function sanitizeLogFilename(agentName) {
    const fallback = 'agent';
    if (!agentName || typeof agentName !== 'string')
        return fallback;
    const normalized = agentName
        .trim()
        .replace(/[\\/]+/g, '-')
        .replace(/[^a-z0-9._-]+/gi, '-')
        .replace(/-+/g, '-')
        .replace(/\.+/g, '.')
        .replace(/^-+|-+$/g, '')
        .replace(/^\.+|\.+$/g, '');
    return normalized.length ? normalized : fallback;
}
/**
 * Converts timestamp string to ISO string with validation.
 *
 * @param {string} value - Timestamp string (any format Date can parse)
 * @returns {string | null} - ISO string or null if invalid timestamp
 */
function safeIsoString(value) {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp))
        return null;
    return new Date(timestamp).toISOString();
}
/**
 * Derives session start time from environment or current time.
 *
 * Used by background processes to maintain consistent timestamps.
 *
 * @returns {number} - Unix timestamp in milliseconds
 */
function deriveStartTime(isBackgroundRunner = false) {
    if (!isBackgroundRunner)
        return Date.now();
    const fromEnv = process.env[background_manager_1.INTERNAL_START_TIME_ENV];
    if (!fromEnv)
        return Date.now();
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed))
        return parsed;
    return Date.now();
}
/**
 * Derives log file path from agent name and start time.
 *
 * Checks environment for override path, otherwise constructs standard log filename.
 *
 * @param {string} agentName - Agent name for sanitized filename component
 * @param {number} startTime - Unix timestamp for filename uniqueness
 * @param {Required<ConfigPaths>} paths - Configuration paths with logs directory
 * @returns {string} - Absolute path to log file
 *
 * @example
 * deriveLogFile('plan', 1630000000000, paths)
 * // Returns: '.genie/state/agents/logs/plan-1630000000000.log'
 */
function deriveLogFile(agentName, startTime, paths, isBackgroundRunner = false) {
    const envPath = isBackgroundRunner ? process.env[background_manager_1.INTERNAL_LOG_PATH_ENV] : undefined;
    if (envPath)
        return envPath;
    const filename = `${sanitizeLogFilename(agentName)}-${startTime}.log`;
    return path_1.default.join(paths.logsDir || '.genie/state/agents/logs', filename);
}
/**
 * Deep clone an object using JSON serialization
 */
function deepClone(input) {
    return JSON.parse(JSON.stringify(input));
}
/**
 * Deep merge source into target recursively
 */
function mergeDeep(target, source) {
    if (source === null || source === undefined)
        return target;
    if (Array.isArray(source)) {
        return source.slice();
    }
    if (typeof source !== 'object') {
        return source;
    }
    const base = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
    Object.entries(source).forEach(([key, value]) => {
        base[key] = mergeDeep(base[key], value);
    });
    return base;
}
