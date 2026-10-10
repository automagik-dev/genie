/**
 * Scaffold a .mikro/ directory with template files.
 * Returns list of files that were created.
 */
export declare function scaffold(dir: string, template?: string): Promise<string[]>;
/**
 * Check if config needs scaffolding (no .mikro/mikro.yaml).
 */
export declare function needsScaffold(dir: string): Promise<boolean>;
//# sourceMappingURL=scaffold.d.ts.map