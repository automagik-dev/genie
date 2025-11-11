/**
 * Version comparison utilities for semver-style versions
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

/**
 * Parse a semver string (e.g., "2.5.14-rc.1") into components
 */
export function parseSemVer(version: string): SemVer {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) {
    throw new Error(`Invalid semver format: ${version}`);
  }

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4]
  };
}

/**
 * Compare two semver versions (ignoring prerelease suffixes)
 * Returns: -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareSemVer(a: string, b: string): number {
  const verA = parseSemVer(a);
  const verB = parseSemVer(b);

  if (verA.major !== verB.major) {
    return verA.major < verB.major ? -1 : 1;
  }
  if (verA.minor !== verB.minor) {
    return verA.minor < verB.minor ? -1 : 1;
  }
  if (verA.patch !== verB.patch) {
    return verA.patch < verB.patch ? -1 : 1;
  }
  return 0;
}

/**
 * Check if version is >= target (ignoring prerelease suffixes)
 */
export function isVersionGte(version: string, target: string): boolean {
  return compareSemVer(version, target) >= 0;
}
