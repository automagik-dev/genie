import path from 'path';

export function getPackageRoot(): string {
  return path.resolve(__dirname, '../../../..');
}

export function getTemplateGeniePath(): string {
  // Use templates/base/.genie/ (clean template) NOT .genie/ (framework dev)
  return path.join(getPackageRoot(), 'templates', 'base', '.genie');
}

export function getTemplateClaudePath(): string {
  return path.join(getPackageRoot(), 'templates', 'base', '.claude');
}

export function getTemplateRelativeBlacklist(): Set<string> {
  // Protect user work - these directories should NEVER be overwritten
  return new Set([
    'cli',        // Framework CLI code
    'mcp',        // Framework MCP code
    'backups',    // User backups
    'agents',     // User custom agents (preserve entirely)
    'wishes',     // User wishes (preserve entirely)
    'reports',    // User reports (preserve entirely)
    'state'       // User session state (preserve entirely)
  ]);
}

export function resolveTargetGeniePath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, '.genie');
}

export function resolveTargetStatePath(cwd: string = process.cwd()): string {
  return path.join(resolveTargetGeniePath(cwd), 'state');
}

export function resolveBackupsRoot(cwd: string = process.cwd()): string {
  return path.join(resolveTargetGeniePath(cwd), 'backups');
}

export function resolveWorkspaceProviderPath(cwd: string = process.cwd()): string {
  return path.join(resolveTargetStatePath(cwd), 'provider.json');
}

export function resolveWorkspaceVersionPath(cwd: string = process.cwd()): string {
  return path.join(resolveTargetStatePath(cwd), 'version.json');
}

export function resolveProviderStatusPath(cwd: string = process.cwd()): string {
  return path.join(resolveTargetStatePath(cwd), 'provider-status.json');
}

export function resolveTempBackupsRoot(cwd: string = process.cwd()): string {
  return path.join(cwd, '.genie-backups-temp');
}
