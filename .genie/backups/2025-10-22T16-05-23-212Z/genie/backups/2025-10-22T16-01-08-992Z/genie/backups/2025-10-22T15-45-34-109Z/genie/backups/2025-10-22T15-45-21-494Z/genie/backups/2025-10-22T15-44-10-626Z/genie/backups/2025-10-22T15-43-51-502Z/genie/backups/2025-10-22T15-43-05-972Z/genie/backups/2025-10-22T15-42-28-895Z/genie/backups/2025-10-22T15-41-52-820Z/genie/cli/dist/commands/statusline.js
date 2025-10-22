"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runStatusline = runStatusline;
const child_process_1 = require("child_process");
const paths_1 = require("../lib/paths");
const fs_utils_1 = require("../lib/fs-utils");
const package_1 = require("../lib/package");
async function runStatusline(_parsed, _config, _paths) {
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
    const providerPath = (0, paths_1.resolveWorkspaceProviderPath)(cwd);
    const state = await (0, fs_utils_1.readJsonFile)(providerPath);
    if (state && state.provider) {
        return state.provider;
    }
    return process.env.GENIE_PROVIDER ?? 'unknown';
}
async function readVersion(cwd) {
    const versionPath = (0, paths_1.resolveWorkspaceVersionPath)(cwd);
    if (await (0, fs_utils_1.pathExists)(versionPath)) {
        const state = await (0, fs_utils_1.readJsonFile)(versionPath);
        if (state && state.version) {
            return state.version;
        }
    }
    return (0, package_1.getPackageVersion)();
}
function readGitStatus() {
    try {
        const branch = (0, child_process_1.execSync)('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
        const changes = (0, child_process_1.execSync)('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
        const dirty = changes ? `${changes.split('\n').length} changes` : 'clean';
        return `${branch} (${dirty})`;
    }
    catch {
        return 'no git';
    }
}
