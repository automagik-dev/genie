import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The DSH Host range every Genie DSH plugin declares in `engines.dsh` is a promise DSH
 * keeps for it. From dsh-app-boot 0.2.1-alpha.4 an unmet range skips the plugin's bundle
 * at profile load and disables its row in preflight, evaluated with prereleases included
 * (`semver.satisfies(runtime, range, { includePrerelease: true })`; `engines.dsh`, when
 * present, decides alone). So the three plugins refuse an untested Host together, by one
 * ceiling spelling, and each still admits the Host its README says it was verified on.
 */
const PLUGINS = ['dsh-genie-board', 'dsh-workflow-loader', 'genie-dsh'] as const;
const VERIFIED_HOST = '0.2.2-rc.2';
/** `<0.3.0` would admit every 0.3.0 prerelease under the include-prerelease rule; `-0` refuses them. */
const CEILING = '<0.3.0-0';

type Version = { release: [number, number, number]; prerelease: string[] };

function parse(version: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) throw new Error(`not a plain SemVer version: ${version}`);
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** SemVer 2.0 precedence (§11): release triple, then a prerelease sorts below its release. */
function compare(left: string, right: string): number {
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    const delta = (a.release[index] ?? 0) - (b.release[index] ?? 0);
    if (delta) return Math.sign(delta);
  }
  if (!a.prerelease.length || !b.prerelease.length) return Math.sign(b.prerelease.length - a.prerelease.length);
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numeric = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (numeric[0] && numeric[1]) return Math.sign(Number(x) - Number(y));
    if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** A space-separated AND of plain comparators, every version taking part (include-prerelease). */
function admits(range: string, version: string): boolean {
  return range
    .trim()
    .split(/\s+/)
    .every((comparator) => {
      const match = /^(>=|<=|>|<|=)?(.+)$/.exec(comparator);
      if (!match?.[2] || range.includes('||')) throw new Error(`unsupported range: ${range}`);
      const order = compare(version, match[2]);
      switch (match[1] ?? '=') {
        case '>=':
          return order >= 0;
        case '<=':
          return order <= 0;
        case '>':
          return order > 0;
        case '<':
          return order < 0;
        default:
          return order === 0;
      }
    });
}

const read = (plugin: string, file: string) => readFileSync(join(import.meta.dir, plugin, file), 'utf8');
const rangeOf = (plugin: string): string => JSON.parse(read(plugin, 'package.json')).engines?.dsh;

test('the comparator follows the include-prerelease rule DSH evaluates engines.dsh with', () => {
  expect(admits('>=0.1.2-rc.1 <0.3.0-0', '0.2.2-rc.2')).toBe(true);
  expect(admits('>=0.2.1-rc.2 <0.3.0-0', '0.2.1-rc.1')).toBe(false);
  expect(admits('>=0.1.2-rc.1 <0.3.0-0', '0.3.0-rc.1')).toBe(false);
  expect(admits('>=0.1.2-rc.1 <0.3.0', '0.3.0-rc.1')).toBe(true);
  expect(admits('>=0.1.2-rc.1 <0.3.0', '0.3.0')).toBe(false);
  expect(compare('1.0.0-alpha.beta', '1.0.0-alpha.1')).toBe(1);
  expect(compare('1.0.0-rc.11', '1.0.0-rc.2')).toBe(1);
});

describe.each([...PLUGINS])('%s', (plugin) => {
  test(`declares the shared ceiling ${CEILING}`, () => {
    const ceiling = rangeOf(plugin)
      .trim()
      .split(/\s+/)
      .find((comparator) => comparator.startsWith('<'));
    expect(ceiling).toBe(CEILING);
  });

  test(`admits the verified Host ${VERIFIED_HOST}`, () => {
    expect(admits(rangeOf(plugin), VERIFIED_HOST)).toBe(true);
  });

  test(`its README names ${VERIFIED_HOST} as the verified Host`, () => {
    expect(read(plugin, 'README.md')).toContain(`Verified Host: \`@deepseek-ai/dsh@${VERIFIED_HOST}\``);
  });
});
