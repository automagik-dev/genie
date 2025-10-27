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
exports.deepClone = deepClone;
exports.mergeDeep = mergeDeep;
const path_1 = __importDefault(require("path"));
/**
 * Formats an ISO timestamp as human-readable relative time.
 *
 * Converts timestamps to friendly formats like "5m ago", "3h ago", or "2d ago".
 * For times older than 5 weeks, returns a localized date string.
 *
 * @param {string} value - ISO 8601 timestamp string (e.g., '2025-09-30T10:00:00Z')
 * @returns {string} Relative time string ('just now', '5m ago', '2h ago', '3d ago', '2w ago')
 *                   or localized date string for older timestamps. Returns 'n/a' for invalid dates.
 *
 * @example
 * // Current time: 2025-09-30T10:05:00Z
 * formatRelativeTime('2025-09-30T10:00:00Z')
 * // Returns: '5m ago'
 *
 * @example
 * // Invalid date handling
 * formatRelativeTime('invalid-date')
 * // Returns: 'n/a'
 *
 * @example
 * // Future dates
 * formatRelativeTime('2025-12-31T00:00:00Z')
 * // Returns: 'just now'
 *
 * @performance O(1) - Simple arithmetic operations
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
 * Formats an absolute file system path as relative to a base directory.
 *
 * Calculates the relative path from baseDir to targetPath. Useful for
 * displaying cleaner paths in logs or UI by removing common prefixes.
 *
 * @param {string} targetPath - Absolute file system path to format (e.g., '/home/user/project/src/file.ts')
 * @param {string} baseDir - Base directory for relative path calculation (e.g., '/home/user/project')
 * @returns {string} Relative path from baseDir to targetPath (e.g., 'src/file.ts').
 *                   Returns original targetPath if calculation fails or targetPath is falsy.
 *                   Returns 'n/a' if targetPath is empty or undefined.
 *
 * @example
 * formatPathRelative('/home/user/project/src/file.ts', '/home/user/project')
 * // Returns: 'src/file.ts'
 *
 * @example
 * // Same directory
 * formatPathRelative('/home/user/project', '/home/user/project')
 * // Returns: '/home/user/project'
 *
 * @example
 * // Error handling
 * formatPathRelative('', '/home/user')
 * // Returns: 'n/a'
 *
 * @performance O(n) where n is the length of the path strings
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
 * Truncates text to a maximum length, adding ellipsis if truncated.
 *
 * Ensures text doesn't exceed maxLength by slicing and appending '...'.
 * Trims whitespace before adding ellipsis for cleaner output.
 *
 * @param {string} text - Text string to truncate
 * @param {number} [maxLength=64] - Maximum character length including ellipsis (must be >= 3 for meaningful truncation)
 * @returns {string} Original text if length <= maxLength, otherwise truncated text with '...' suffix.
 *                   Returns empty string if text is falsy.
 *
 * @example
 * truncateText('This is a very long sentence that needs truncation', 20)
 * // Returns: 'This is a very lo...'
 *
 * @example
 * // Short text remains unchanged
 * truncateText('Short text', 20)
 * // Returns: 'Short text'
 *
 * @example
 * // Empty or falsy input
 * truncateText('', 10)
 * // Returns: ''
 *
 * @example
 * // Edge case: maxLength shorter than ellipsis
 * truncateText('Hello World', 2)
 * // Returns: '...' (sliceLength becomes 0, trimmed)
 *
 * @performance O(n) where n is maxLength
 * @warning If maxLength < 3, result may be just '...' or shorter
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
 * Sanitizes an agent name to create a safe filename for logging.
 *
 * Performs multiple transformations to ensure the name is filesystem-safe:
 * - Replaces path separators (/ \) with dashes
 * - Removes special characters (keeps only alphanumeric, dots, dashes, underscores)
 * - Collapses consecutive separators into single characters
 * - Trims leading/trailing separators and dots
 *
 * @param {string} agentName - Agent identifier to sanitize (e.g., 'core/implementor', 'my-agent@@!!')
 * @returns {string} Sanitized filename containing only [a-z0-9._-] characters.
 *                   Returns 'agent' as fallback if input is invalid or results in empty string.
 *
 * @example
 * sanitizeLogFilename('core/implementor')
 * // Returns: 'core-implementor'
 *
 * @example
 * sanitizeLogFilename('my-agent@@!!')
 * // Returns: 'my-agent'
 *
 * @example
 * sanitizeLogFilename('//bad...name--')
 * // Returns: 'bad.name'
 *
 * @example
 * // Invalid input fallback
 * sanitizeLogFilename('')
 * // Returns: 'agent'
 *
 * @example
 * sanitizeLogFilename(null as any)
 * // Returns: 'agent'
 *
 * @performance O(n) where n is the length of agentName
 * @warning Does not check for reserved filesystem names (e.g., 'CON', 'PRN' on Windows)
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
 * Converts a timestamp string to ISO 8601 format with validation.
 *
 * Parses any valid date string and returns standardized ISO format.
 * Useful for normalizing dates from various sources.
 *
 * @param {string} value - Timestamp string in any format parseable by Date constructor
 *                        (e.g., '2025-09-30', 'Sep 30, 2025', '1727692800000')
 * @returns {string | null} ISO 8601 formatted string (e.g., '2025-09-30T10:00:00.000Z')
 *                          or null if the input cannot be parsed into a valid date.
 *
 * @example
 * safeIsoString('2025-09-30T10:00:00Z')
 * // Returns: '2025-09-30T10:00:00.000Z'
 *
 * @example
 * safeIsoString('Sep 30, 2025')
 * // Returns: '2025-09-30T00:00:00.000Z' (depending on timezone)
 *
 * @example
 * // Invalid date handling
 * safeIsoString('not-a-date')
 * // Returns: null
 *
 * @example
 * safeIsoString('Invalid Date')
 * // Returns: null
 *
 * @performance O(1) - Simple date parsing and formatting
 */
function safeIsoString(value) {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp))
        return null;
    return new Date(timestamp).toISOString();
}
/**
 * Creates a deep clone of an object using JSON serialization.
 *
 * Produces a completely independent copy of the input object by serializing
 * to JSON and deserializing. All nested objects and arrays are cloned.
 *
 * @template T - Type of the object to clone
 * @param {T} input - Object, array, or primitive value to clone
 * @returns {T} Deep copy of the input with no shared references to the original
 *
 * @throws {TypeError} If input contains circular references (JSON.stringify will throw)
 * @throws {TypeError} If input contains values that cannot be serialized to JSON
 *
 * @example
 * const original = { a: { b: 1 }, c: [2, 3] };
 * const clone = deepClone(original);
 * clone.a.b = 99;
 * console.log(original.a.b); // Still 1
 *
 * @example
 * // Arrays are also cloned
 * const arr = [{ id: 1 }, { id: 2 }];
 * const clonedArr = deepClone(arr);
 * clonedArr[0].id = 99;
 * console.log(arr[0].id); // Still 1
 *
 * @example
 * // Primitives are returned as-is
 * deepClone(42) // Returns: 42
 * deepClone('hello') // Returns: 'hello'
 *
 * @performance O(n) where n is the total number of properties/elements in the object tree.
 *              Memory usage is 2x the input size during cloning.
 *
 * @warning Does not handle:
 * - Circular references (will throw TypeError)
 * - Functions (will be omitted)
 * - undefined values (will be omitted or converted to null)
 * - Symbols (will be omitted)
 * - Non-enumerable properties (will be omitted)
 * - Class instances (will lose prototype chain, become plain objects)
 * - Date objects (will become strings)
 * - RegExp, Map, Set, etc. (will become empty objects or strings)
 */
function deepClone(input) {
    return JSON.parse(JSON.stringify(input));
}
/**
 * Recursively merges a source object into a target object.
 *
 * Creates a new object by deeply merging properties from source into target.
 * Arrays in source completely replace arrays in target (no element merging).
 * Null/undefined source values are ignored, preserving target values.
 *
 * @param {any} target - Base object to merge into (will not be modified)
 * @param {any} source - Object whose properties will be merged into target
 * @returns {any} New object with merged properties. If target is not a plain object,
 *                returns source value. If source is null/undefined, returns target.
 *
 * @example
 * const target = { a: 1, b: { c: 2, d: 3 } };
 * const source = { b: { c: 99 }, e: 5 };
 * const result = mergeDeep(target, source);
 * // Returns: { a: 1, b: { c: 99, d: 3 }, e: 5 }
 *
 * @example
 * // Arrays are replaced, not merged
 * const target = { items: [1, 2, 3] };
 * const source = { items: [4, 5] };
 * const result = mergeDeep(target, source);
 * // Returns: { items: [4, 5] }
 *
 * @example
 * // Null source preserves target
 * mergeDeep({ a: 1 }, null)
 * // Returns: { a: 1 }
 *
 * @example
 * // Primitives replace objects
 * mergeDeep({ a: { b: 1 } }, { a: 'string' })
 * // Returns: { a: 'string' }
 *
 * @example
 * // Non-object target is replaced
 * mergeDeep('string', { a: 1 })
 * // Returns: { a: 1 }
 *
 * @performance O(n) where n is the total number of properties in both objects.
 *              Memory usage is proportional to the depth and size of the object tree.
 *
 * @warning
 * - Arrays are shallow-copied and replace target arrays entirely
 * - Does not handle circular references (may cause stack overflow)
 * - Properties with undefined values in source will overwrite target properties
 * - Does not preserve property descriptors or getters/setters
 * - Non-plain objects (class instances) are treated as plain objects
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
