import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
const DEFAULT_COLLECT_OPTIONS = {
    extensions: [".md"],
    exclude: ["node_modules", ".git", "dist"],
};
/**
 * Pre-compile exclude patterns into a test function.
 * Glob patterns (containing `*`) are compiled to RegExp once;
 * plain strings use exact match.
 */
function buildExcludeMatcher(patterns) {
    const matchers = patterns.map((pattern) => {
        if (pattern.includes("*")) {
            const regexStr = "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
            const re = new RegExp(regexStr);
            return (name) => re.test(name);
        }
        return (name) => name === pattern;
    });
    return (name) => matchers.some((m) => m(name));
}
/**
 * Recursively collect files matching a pattern from a directory.
 * Accepts a pre-compiled exclude matcher and extension Set to avoid
 * repeated RegExp/array allocations during traversal.
 */
async function collectFiles(dir, baseDir, options, isExcluded, extSet) {
    const excludeFn = isExcluded ?? buildExcludeMatcher(options.exclude);
    const extensions = extSet ?? new Set(options.extensions);
    const items = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        // Resolve symlinks: isDirectory/isFile return false for symlinks
        let isDir;
        let isFile;
        if (entry.isSymbolicLink()) {
            const resolved = await stat(fullPath); // stat follows symlinks
            isDir = resolved.isDirectory();
            isFile = resolved.isFile();
        }
        else {
            isDir = entry.isDirectory();
            isFile = entry.isFile();
        }
        if (isDir) {
            // Always skip hidden directories (starting with .)
            if (entry.name.startsWith("."))
                continue;
            // Skip directories matching exclude patterns
            if (excludeFn(entry.name))
                continue;
            const subItems = await collectFiles(fullPath, baseDir, options, excludeFn, extensions);
            items.push(...subItems);
        }
        else if (isFile) {
            // Skip files matching exclude patterns
            if (excludeFn(entry.name))
                continue;
            // Check if file matches any of the allowed extensions (O(1) Set lookup per extension suffix)
            const dotIdx = entry.name.lastIndexOf(".");
            if (dotIdx !== -1 && extensions.has(entry.name.slice(dotIdx))) {
                const content = await readFile(fullPath, "utf-8");
                items.push({
                    path: relative(baseDir, fullPath),
                    content,
                });
            }
        }
    }
    return items;
}
/**
 * Generate metadata string describing the loaded context.
 */
function generateMetadata(ctx) {
    if (ctx.type === "string") {
        const content = ctx.content;
        const prefix = content.slice(0, 200).replace(/\n/g, " ");
        return `Context is a string with ${content.length} total characters. Preview: "${prefix}..."`;
    }
    if (ctx.type === "list") {
        const items = ctx.content;
        let totalLength = 0;
        const chunkLengths = new Array(items.length);
        for (let i = 0; i < items.length; i++) {
            const len = items[i].content.length;
            totalLength += len;
            chunkLengths[i] = len;
        }
        let chunkStr;
        if (chunkLengths.length > 100) {
            const shown = chunkLengths.slice(0, 100);
            chunkStr = `[${shown.join(", ")}... ${chunkLengths.length - 100} others]`;
        }
        else {
            chunkStr = `[${chunkLengths.join(", ")}]`;
        }
        return `Context is a list of ${items.length} items with ${totalLength} total characters, chunk lengths: ${chunkStr}`;
    }
    // dict type
    const content = ctx.content;
    return `Context is a dict/JSON with ${content.length} total characters.`;
}
/**
 * Load context from a directory path.
 * Recursively reads files matching the configured extensions.
 */
export async function loadContextFromDir(dirPath, options) {
    // Normalize extensions: ensure each has a leading dot ("mdx" → ".mdx")
    const rawExtensions = options?.extensions ?? DEFAULT_COLLECT_OPTIONS.extensions;
    const normalizedExtensions = rawExtensions.map((ext) => ext.startsWith(".") ? ext : `.${ext}`);
    const merged = {
        extensions: normalizedExtensions,
        exclude: options?.exclude ?? DEFAULT_COLLECT_OPTIONS.exclude,
    };
    const items = await collectFiles(dirPath, dirPath, merged);
    items.sort((a, b) => a.path.localeCompare(b.path));
    const ctx = {
        type: "list",
        content: items,
        metadata: "",
    };
    ctx.metadata = generateMetadata(ctx);
    return ctx;
}
/**
 * Load context from a single file.
 */
export async function loadContextFromFile(filePath) {
    const content = await readFile(filePath, "utf-8");
    // JSON files → parse as dict or list
    if (filePath.endsWith(".json")) {
        try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
                const items = parsed.map((item, i) => ({
                    path: `[${i}]`,
                    content: typeof item === "string" ? item : JSON.stringify(item),
                }));
                const ctx = { type: "list", content: items, metadata: "" };
                ctx.metadata = generateMetadata(ctx);
                return ctx;
            }
            const ctx = {
                type: "dict",
                content: JSON.stringify(parsed, null, 2),
                metadata: "",
            };
            ctx.metadata = generateMetadata(ctx);
            return ctx;
        }
        catch {
            // Fall through to string
        }
    }
    const ctx = { type: "string", content, metadata: "" };
    ctx.metadata = generateMetadata(ctx);
    return ctx;
}
/**
 * Load context from stdin (non-blocking check).
 */
export async function loadContextFromStdin() {
    const chunks = [];
    const stdin = process.stdin;
    return new Promise((resolve, reject) => {
        stdin.setEncoding("utf-8");
        stdin.on("data", (chunk) => chunks.push(chunk));
        stdin.on("end", () => {
            const content = chunks.join("");
            const ctx = { type: "string", content, metadata: "" };
            ctx.metadata = generateMetadata(ctx);
            resolve(ctx);
        });
        stdin.on("error", reject);
        stdin.resume();
    });
}
/**
 * Load context from a path (auto-detect file vs directory).
 */
export async function loadContext(contextPath, options) {
    const info = await stat(contextPath);
    if (info.isDirectory()) {
        return loadContextFromDir(contextPath, options);
    }
    return loadContextFromFile(contextPath);
}
//# sourceMappingURL=context.js.map