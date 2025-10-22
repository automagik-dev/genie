import { execSync } from 'child_process';
import { resolveWorkspaceProviderPath, resolveWorkspaceVersionPath } from '../lib/paths';
import { pathExists, readJsonFile } from '../lib/fs-utils';
import { getPackageVersion } from '../lib/package';
export async function runStatusline(_parsed, _config, _paths) {
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
async function readProvider(cwd) {
    const providerPath = resolveWorkspaceProviderPath(cwd);
    const state = await readJsonFile(providerPath);
    if (state && state.provider) {
        return state.provider;
    }
    return process.env.GENIE_PROVIDER ?? 'unknown';
}
async function readVersion(cwd) {
    const versionPath = resolveWorkspaceVersionPath(cwd);
    if (await pathExists(versionPath)) {
        const state = await readJsonFile(versionPath);
        if (state && state.version) {
            return state.version;
        }
    }
    return getPackageVersion();
}
function readGitStatus() {
    try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
        const changes = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
        const dirty = changes ? `${changes.split('\n').length} changes` : 'clean';
        return `${branch} (${dirty})`;
    }
    catch {
        return 'no git';
    }
}
