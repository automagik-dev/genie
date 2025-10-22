import { execSync } from 'child_process';
import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { resolveWorkspaceProviderPath, resolveWorkspaceVersionPath } from '../lib/paths';
import { pathExists, readJsonFile } from '../lib/fs-utils';
import { getPackageVersion } from '../lib/package';

interface ProviderState {
  provider?: string;
}

interface VersionState {
  version?: string;
}

export async function runStatusline(
  _parsed: ParsedCommand,
  _config: GenieConfig,
  _paths: Required<ConfigPaths>
): Promise<void> {
  const cwd = process.cwd();
  const provider = await readProvider(cwd);
  const version = await readVersion(cwd);
  const gitInfo = readGitStatus();

  const parts = [
    '🧞 Genie',
    `provider: ${provider}`,
    gitInfo,
    `version: v${version}`
  ].filter(Boolean);

  process.stdout.write(parts.join(' | ') + '\n');
  process.stderr.write('⚠️  `statusline` is deprecated. Refer to the migration guide for updated integrations.\n');
}

async function readProvider(cwd: string): Promise<string> {
  const providerPath = resolveWorkspaceProviderPath(cwd);
  const state = await readJsonFile<ProviderState>(providerPath);
  if (state && state.provider) {
    return state.provider;
  }
  return process.env.GENIE_PROVIDER ?? 'unknown';
}

async function readVersion(cwd: string): Promise<string> {
  const versionPath = resolveWorkspaceVersionPath(cwd);
  if (await pathExists(versionPath)) {
    const state = await readJsonFile<VersionState>(versionPath);
    if (state && state.version) {
      return state.version;
    }
  }
  return getPackageVersion();
}

function readGitStatus(): string {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const changes = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const dirty = changes ? `${changes.split('\n').length} changes` : 'clean';
    return `${branch} (${dirty})`;
  } catch {
    return 'no git';
  }
}
