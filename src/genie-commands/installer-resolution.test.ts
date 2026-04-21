/**
 * Unit tests for `classifyInstallerResolution`.
 *
 * The I/O-heavy probes (`probeInstallers`, `probeResolvedBinary`) spawn
 * subprocesses and walk the filesystem — covered by a single smoke test
 * that just asserts the function returns without throwing on whatever
 * this box happens to have installed. The real behavior under test is
 * the classifier, which is pure and covers every status transition.
 */

import { describe, expect, test } from 'bun:test';
import {
  type InstallerEntry,
  type ResolvedBinary,
  classifyInstallerResolution,
  collectInstallerResolution,
  compareVersions,
} from './installer-resolution.js';

function resolved(path: string, realPath = path): ResolvedBinary {
  return { path, realPath };
}

function entry(installer: InstallerEntry['installer'], binPath: string, version: string): InstallerEntry {
  return {
    installer,
    binPath,
    packageJsonPath: `${binPath}/package.json`,
    version,
  };
}

describe('classifyInstallerResolution', () => {
  test('warns when no binary resolves on PATH', () => {
    const rows = classifyInstallerResolution({ resolved: null, installers: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('warn');
    expect(rows[0].name).toBe('Resolved binary');
    expect(rows[0].message).toContain('which genie');
  });

  test('passes when resolver matches the only detected installer', () => {
    // The match is via real-path comparison. Test doubles live under
    // /tmp which has no genie — but we can exercise the no-match branch
    // by pointing both at the same literal string since `safeRealpath`
    // falls through to the input on ENOENT.
    const bin = '/virtual/bin/genie';
    const rows = classifyInstallerResolution({
      resolved: resolved(bin),
      installers: [entry('npm', bin, '4.260421.17')],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pass');
    expect(rows[0].message).toContain('npm');
    expect(rows[0].message).toContain('4.260421.17');
  });

  test('warns when resolver is on PATH but no installer owns it (dev checkout)', () => {
    const rows = classifyInstallerResolution({
      resolved: resolved('/opt/custom/genie'),
      installers: [entry('npm', '/some/npm/bin/genie', '4.260421.17')],
    });
    expect(rows[0].status).toBe('warn');
    expect(rows[0].message).toContain('not owned');
    expect(rows[0].suggestion).toContain('dev checkout');
    // Still lists the detected installer so the user sees the alternative.
    expect(rows[1].status).toBe('warn');
    expect(rows[1].name).toContain('npm');
  });

  test('warns on duplicate installs and labels the older one stale', () => {
    const npmBin = '/virtual/npm/bin/genie';
    const bunBin = '/virtual/bun/bin/genie';
    const rows = classifyInstallerResolution({
      resolved: resolved(npmBin),
      installers: [entry('npm', npmBin, '4.260421.17'), entry('bun', bunBin, '4.260420.5')],
    });
    expect(rows[0].status).toBe('pass'); // resolver is fine
    const alsoBun = rows.find((r) => r.name.includes('bun'));
    expect(alsoBun?.status).toBe('warn');
    expect(alsoBun?.message).toContain('stale');
    expect(alsoBun?.suggestion).toContain('bun remove -g');
  });

  test('warns when resolver is the stale one shadowed by a newer install', () => {
    const bunBin = '/virtual/bun/bin/genie';
    const npmBin = '/virtual/npm/bin/genie';
    const rows = classifyInstallerResolution({
      resolved: resolved(bunBin),
      installers: [entry('bun', bunBin, '4.260420.5'), entry('npm', npmBin, '4.260421.17')],
    });
    // Resolved binary row passes (we found the installer)
    expect(rows[0].status).toBe('pass');
    expect(rows[0].message).toContain('bun');
    // Sibling installer row shows newer version without "stale" label
    const alsoNpm = rows.find((r) => r.name.includes('npm'));
    expect(alsoNpm?.status).toBe('warn');
    expect(alsoNpm?.message).not.toContain('stale');
    // Explicit update-path advisory fires
    const updatePath = rows.find((r) => r.name === 'Update path');
    expect(updatePath?.status).toBe('warn');
    expect(updatePath?.message).toContain('stale');
    expect(updatePath?.message).toContain('shadowed');
  });

  test('passes cleanly with a single bun install (common user setup)', () => {
    const bunBin = '/virtual/bun/bin/genie';
    const rows = classifyInstallerResolution({
      resolved: resolved(bunBin),
      installers: [entry('bun', bunBin, '4.260421.17')],
    });
    expect(rows.every((r) => r.status === 'pass')).toBe(true);
  });

  test('handles pnpm + yarn duplicates (four-installer matrix)', () => {
    const rows = classifyInstallerResolution({
      resolved: resolved('/virtual/npm/bin/genie'),
      installers: [
        entry('npm', '/virtual/npm/bin/genie', '4.260421.17'),
        entry('bun', '/virtual/bun/bin/genie', '4.260420.5'),
        entry('pnpm', '/virtual/pnpm/bin/genie', '4.260419.0'),
        entry('yarn', '/virtual/yarn/bin/genie', '4.260418.2'),
      ],
    });
    // Three sibling advisories, each with the right remove hint
    expect(rows.find((r) => r.name.includes('bun'))?.suggestion).toContain('bun remove -g');
    expect(rows.find((r) => r.name.includes('pnpm'))?.suggestion).toContain('pnpm remove -g');
    expect(rows.find((r) => r.name.includes('yarn'))?.suggestion).toContain('yarn global remove');
  });
});

describe('compareVersions', () => {
  test('orders major.minor.patch correctly', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  test('handles calendar-versioned genie releases', () => {
    expect(compareVersions('4.260421.17', '4.260421.5')).toBeGreaterThan(0);
    expect(compareVersions('4.260420.99', '4.260421.0')).toBeLessThan(0);
  });

  test('treats missing segments as zero', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('2', '1.999.999')).toBeGreaterThan(0);
  });

  test('does not crash on non-numeric segments (naive comparator)', () => {
    // Prerelease labels aren't semver-aware here — genie ships
    // calendar-versioned releases without prereleases. Just assert the
    // comparator yields a finite number without throwing.
    const n = compareVersions('1.0.0-rc.1', '1.0.0');
    expect(Number.isFinite(n)).toBe(true);
  });
});

describe('collectInstallerResolution (smoke)', () => {
  test('returns at least one CheckResult row without throwing', async () => {
    const rows = await collectInstallerResolution();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(typeof row.name).toBe('string');
      expect(['pass', 'warn', 'fail']).toContain(row.status);
    }
  });
});
