export interface ContextItem {
    path: string;
    content: string;
}
export interface LoadedContext {
    type: "string" | "list" | "dict";
    content: string | ContextItem[];
    metadata: string;
}
export interface CollectOptions {
    extensions: string[];
    exclude: string[];
}
/**
 * Load context from a directory path.
 * Recursively reads files matching the configured extensions.
 */
export declare function loadContextFromDir(dirPath: string, options?: Partial<CollectOptions>): Promise<LoadedContext>;
/**
 * Load context from a single file.
 */
export declare function loadContextFromFile(filePath: string): Promise<LoadedContext>;
/**
 * Load context from stdin (non-blocking check).
 */
export declare function loadContextFromStdin(): Promise<LoadedContext>;
/**
 * Load context from a path (auto-detect file vs directory).
 */
export declare function loadContext(contextPath: string, options?: Partial<CollectOptions>): Promise<LoadedContext>;
//# sourceMappingURL=context.d.ts.map