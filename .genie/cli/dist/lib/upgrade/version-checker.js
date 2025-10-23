"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkForUpdates = checkForUpdates;
const child_process_1 = require("child_process");
/**
 * Check if updates are available by comparing installed version with npm registry
 */
async function checkForUpdates(installedVersion, installedCommit) {
    try {
        // Get latest version from npm registry
        const latestVersion = (0, child_process_1.execSync)('npm view automagik-genie@next version', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        // Get git commit from npm package (if available)
        let latestCommit;
        try {
            latestCommit = (0, child_process_1.execSync)('npm view automagik-genie@next gitCommit', {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            }).trim();
        }
        catch {
            // gitCommit field not yet in package.json, use version comparison only
            latestCommit = 'unknown';
        }
        // Compare versions
        const available = compareVersions(installedVersion, latestVersion) < 0;
        // Get changelog (placeholder for now)
        const changes = available
            ? [
                `+ New features and improvements`,
                `~ Bug fixes and enhancements`,
                `📚 Run 'git log ${installedCommit}..${latestCommit}' for details`
            ]
            : [];
        return {
            available,
            latestVersion,
            latestCommit,
            changes
        };
    }
    catch (error) {
        throw new Error(`Failed to check for updates: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Compare semantic versions (v2.5.0-rc.15 vs v2.5.0-rc.16)
 * Returns: -1 if a < b, 0 if a === b, 1 if a > b
 */
function compareVersions(a, b) {
    const parseVersion = (v) => {
        // Remove leading 'v' if present
        const clean = v.startsWith('v') ? v.slice(1) : v;
        // Split into parts: "2.5.0-rc.15" → ["2", "5", "0", "rc", "15"]
        const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/);
        if (!match) {
            throw new Error(`Invalid version format: ${v}`);
        }
        const [, major, minor, patch, prerelease, prereleaseNum] = match;
        return {
            major: parseInt(major, 10),
            minor: parseInt(minor, 10),
            patch: parseInt(patch, 10),
            prerelease: prerelease || null,
            prereleaseNum: prereleaseNum ? parseInt(prereleaseNum, 10) : null
        };
    };
    const versionA = parseVersion(a);
    const versionB = parseVersion(b);
    // Compare major.minor.patch
    if (versionA.major !== versionB.major)
        return versionA.major < versionB.major ? -1 : 1;
    if (versionA.minor !== versionB.minor)
        return versionA.minor < versionB.minor ? -1 : 1;
    if (versionA.patch !== versionB.patch)
        return versionA.patch < versionB.patch ? -1 : 1;
    // Both stable versions (no prerelease)
    if (!versionA.prerelease && !versionB.prerelease)
        return 0;
    // Stable > prerelease
    if (!versionA.prerelease)
        return 1; // a is stable, b is prerelease
    if (!versionB.prerelease)
        return -1; // a is prerelease, b is stable
    // Both prereleases, compare prerelease numbers
    if (versionA.prereleaseNum === null || versionB.prereleaseNum === null) {
        throw new Error(`Invalid prerelease version format`);
    }
    if (versionA.prereleaseNum < versionB.prereleaseNum)
        return -1;
    if (versionA.prereleaseNum > versionB.prereleaseNum)
        return 1;
    return 0;
}
