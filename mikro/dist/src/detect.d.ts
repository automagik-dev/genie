/**
 * Package auto-detection for the Python REPL.
 *
 * Probes for common data-science / utility packages at startup
 * and formats availability info for the system prompt.
 */
/** Packages to probe for auto-detection in `full` tools mode. */
export declare const PROBE_PACKAGES: readonly ["numpy", "pandas", "httpx", "bs4", "sklearn", "matplotlib"];
export interface PackageAvailability {
    [packageName: string]: boolean;
}
export interface PythonVersionInfo {
    version: string;
    valid: boolean;
}
/**
 * Check the installed Python version.
 * Returns version string and whether it meets the 3.10+ requirement.
 * Throws with platform-specific install guidance if python3 is not found.
 */
export declare function checkPythonVersion(pythonPath?: string): Promise<PythonVersionInfo>;
/**
 * Detect which Python packages are installed.
 * Runs a single Python subprocess to check all packages at once.
 */
export declare function detectPackages(pythonPath?: string): Promise<PackageAvailability>;
/**
 * Format detected packages as a system prompt addition.
 * Returns empty string if no packages are available.
 */
export declare function formatPackagePrompt(packages: PackageAvailability): string;
//# sourceMappingURL=detect.d.ts.map