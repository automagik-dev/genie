import fs from 'fs';
import path from 'path';

/**
 * Walks upward from the current working directory to locate the user's workspace root that contains a `.genie` folder.
 * Returns the current working directory when no `.genie` directory is found.
 * @returns {string} Absolute path to the detected workspace root or the current working directory as a fallback.
 * @example
 * ```ts
 * const root = findWorkspaceRoot();
 * console.log(root);
 * ```
 */
export function findWorkspaceRoot(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.genie'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  // Fallback to cwd if .genie not found
  return process.cwd();
}

/**
 * Resolves the root directory of the installed Genie framework package relative to the compiled distribution files.
 * Supports both development and globally installed scenarios.
 * @returns {string} Absolute path to the automagik-genie package root directory.
 * @example
 * ```ts
 * const packageRoot = getPackageRoot();
 * console.log(packageRoot);
 * ```
 */
export function getPackageRoot(): string {
  // __dirname = .genie/cli/dist/lib/
  // ../../../../ = workspace root (dev) or package root (npm)
  return path.resolve(__dirname, '../../../..');
}

export type TemplateType = 'code' | 'create';

/**
 * Builds the absolute path to the framework-provided `.genie` template directory for the requested template type.
 * @param {TemplateType} [template='code'] Template variant to reference, typically `code` or `create`.
 * @returns {string} Absolute path to the template's `.genie` directory within the package root.
 * @example
 * ```ts
 * const genieTemplate = getTemplateGeniePath('create');
 * console.log(genieTemplate);
 * ```
 */
export function getTemplateGeniePath(template: TemplateType = 'code'): string {
  // Copy from framework's .genie/code/ or .genie/create/ directory
  return path.join(getPackageRoot(), '.genie', template);
}

/**
 * Retrieves the path to the framework's `.claude` directory when a Claude template is requested.
 * Currently returns the root `.claude` directory irrespective of the supplied template type.
 * @param {TemplateType} [_template='code'] Template identifier (unused, reserved for future flexibility).
 * @returns {string} Absolute path to the package-level `.claude` resources.
 * @example
 * ```ts
 * const claudeTemplate = getTemplateClaudePath();
 * console.log(claudeTemplate);
 * ```
 */
export function getTemplateClaudePath(_template: TemplateType = 'code'): string {
  // .claude/ not used - Claude Code wraps core agents directly
  return path.join(getPackageRoot(), '.claude');
}

/**
 * Determines the root directory that should be used as the source when copying framework root files into a workspace.
 * @param {TemplateType} [_template='code'] Template identifier (unused, included for API symmetry).
 * @returns {string} Absolute path to the package root for framework root file replication.
 * @example
 * ```ts
 * const rootTemplatePath = getTemplateRootPath();
 * console.log(rootTemplatePath);
 * ```
 */
export function getTemplateRootPath(_template: TemplateType = 'code'): string {
  // Root files (AGENTS.md, CLAUDE.md) copied from framework root
  return getPackageRoot();
}

/**
 * Provides the set of relative paths within the workspace that must never be overwritten by template synchronization.
 * @returns {Set<string>} A set containing relative directory names that are protected from template operations.
 * @example
 * ```ts
 * const blacklist = getTemplateRelativeBlacklist();
 * console.log(blacklist.has('wishes'));
 * ```
 */
export function getTemplateRelativeBlacklist(): Set<string> {
  // Protect user work - these directories should NEVER be overwritten
  return new Set([
    'cli',        // Framework CLI code
    'mcp',        // Framework MCP code
    'backups',    // User backups
    'wishes',     // User wishes (preserve entirely)
    'reports',    // User reports (preserve entirely)
    'state'       // User session state (preserve entirely)
  ]);
}

/**
 * Resolves the absolute path to the workspace's `.genie` directory using the provided working directory.
 * @param {string} [cwd=process.cwd()] Working directory from which the `.genie` directory should be resolved.
 * @returns {string} Absolute path to the `.genie` directory within the target workspace.
 * @example
 * ```ts
 * const targetGenie = resolveTargetGeniePath('/tmp/project');
 * console.log(targetGenie);
 * ```
 */
export function resolveTargetGeniePath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, '.genie');
}

/**
 * Builds the absolute path to the workspace state directory inside `.genie` based on the provided working directory.
 * @param {string} [cwd=process.cwd()] Working directory of the target workspace.
 * @returns {string} Absolute path to the `.genie/state` directory.
 * @example
 * ```ts
 * const stateDir = resolveTargetStatePath('/tmp/project');
 * console.log(stateDir);
 * ```
 */
export function resolveTargetStatePath(cwd: string = process.cwd()): string {
  return path.join(resolveTargetGeniePath(cwd), 'state');
}

/**
 * Generates the absolute path to the root backups directory inside a workspace's `.genie` folder.
 * @param {string} [cwd=process.cwd()] Working directory used to resolve the target workspace.
 * @returns {string} Absolute path to `.genie/backups` for the workspace.
 * @example
 * ```ts
 * const backupsDir = resolveBackupsRoot('/tmp/project');
 * console.log(backupsDir);
 * ```
 */
export function resolveBackupsRoot(cwd: string = process.cwd()): string {
  return path.join(resolveTargetGeniePath(cwd), 'backups');
}

/**
 * Resolves the path to the `provider.json` file that stores workspace provider metadata.
 * @param {string} [cwd=process.cwd()] Working directory indicating the workspace base.
 * @returns {string} Absolute path to `.genie/state/provider.json`.
 * @example
 * ```ts
 * const providerPath = resolveWorkspaceProviderPath('/tmp/project');
 * console.log(providerPath);
 * ```
 */
export function resolveWorkspaceProviderPath(cwd: string = process.cwd()): string {
  return path.join(resolveTargetStatePath(cwd), 'provider.json');
}

/**
 * Resolves the path to the `version.json` file that tracks the workspace's framework version information.
 * @param {string} [cwd=process.cwd()] Working directory indicating the workspace base.
 * @returns {string} Absolute path to `.genie/state/version.json`.
 * @example
 * ```ts
 * const versionPath = resolveWorkspaceVersionPath('/tmp/project');
 * console.log(versionPath);
 * ```
 */
export function resolveWorkspaceVersionPath(cwd: string = process.cwd()): string {
  return path.join(resolveTargetStatePath(cwd), 'version.json');
}

/**
 * Computes the absolute path to the `.genie/package.json` file within the workspace.
 * @param {string} [cwd=process.cwd()] Working directory indicating the workspace base.
 * @returns {string} Absolute path to the framework-managed `package.json` file.
 * @example
 * ```ts
 * const packageJsonPath = resolveWorkspacePackageJson('/tmp/project');
 * console.log(packageJsonPath);
 * ```
 */
export function resolveWorkspacePackageJson(cwd: string = process.cwd()): string {
  return path.join(resolveTargetGeniePath(cwd), 'package.json');
}

/**
 * Resolves the path to the `provider-status.json` file inside the workspace state directory.
 * @param {string} [cwd=process.cwd()] Working directory indicating the workspace base.
 * @returns {string} Absolute path to `.genie/state/provider-status.json`.
 * @example
 * ```ts
 * const statusPath = resolveProviderStatusPath('/tmp/project');
 * console.log(statusPath);
 * ```
 */
export function resolveProviderStatusPath(cwd: string = process.cwd()): string {
  return path.join(resolveTargetStatePath(cwd), 'provider-status.json');
}

/**
 * Builds the absolute path to the temporary backups directory used during workspace synchronization operations.
 * @param {string} [cwd=process.cwd()] Working directory indicating the workspace base.
 * @returns {string} Absolute path to the `.genie-backups-temp` directory alongside the workspace root.
 * @example
 * ```ts
 * const tempBackups = resolveTempBackupsRoot('/tmp/project');
 * console.log(tempBackups);
 * ```
 */
export function resolveTempBackupsRoot(cwd: string = process.cwd()): string {
  return path.join(cwd, '.genie-backups-temp');
}