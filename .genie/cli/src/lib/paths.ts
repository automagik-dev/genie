import path from 'path';

export function getPackageRoot(): string {
  return path.resolve(__dirname, '../../../..');
}

export function getTemplateGeniePath(): string {
  return path.join(getPackageRoot(), '.genie');
}

export function getTemplateClaudePath(): string {
  return path.join(getPackageRoot(), 'templates', '.claude');
}

export function getTemplateRelativeBlacklist(): Set<string> {
  return new Set(['cli', 'mcp', 'state', 'backups']);
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
