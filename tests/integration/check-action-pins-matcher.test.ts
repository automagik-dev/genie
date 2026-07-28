/**
 * Matcher contract for scripts/check-action-pins.sh (#2669).
 *
 * The `Action Pin Resolvability` CI job runs the script against the live repo,
 * which proves the 10 real pins resolve but never exercises the spellings the
 * repo happens not to use. These tests drive the script's offline `--extract`
 * mode with fixture YAML lines, so the two regressions the scanner was blind to
 * stay closed:
 *   - single-/double-quoted `uses:` scalars were skipped entirely;
 *   - a 40-hex run followed by trailing garbage (`@<sha>oops`) was accepted as
 *     a pin, because the SHA was not anchored to the end of the scalar;
 *   - an unanchored match let a quoted pin inside a trailing comment shadow the
 *     real bare pin on the same line;
 *   - a flow-mapping step (`- { uses: owner/repo@<sha>, name: X }`) was skipped
 *     because the comma stayed glued to the scalar;
 *   - a literal `uses:` inside an earlier quoted value shadowed the real key, so
 *     the pin on that line was silently never validated (fail-open).
 *
 * No network, no gh auth: `--extract` only runs the regex layer.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-action-pins.sh');
const SHA = '93cb6efe18208431cddfb8368fd83d5badbf9bfd';
/** A different well-formed SHA, used to prove which scalar the matcher picked. */
const OTHER_SHA = '11b0e1c8d3d0f8f8d3ce4cd7d0d0a1b2c3d4e5f6';

/** Feed raw YAML lines through the script's matcher; returns the pins it emitted. */
function extract(...lines: string[]): string[] {
  const result = spawnSync('bash', [SCRIPT, '--extract'], {
    input: `${lines.join('\n')}\n`,
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout.split('\n').filter((entry) => entry.length > 0);
}

describe('check-action-pins matcher — accepted scalars', () => {
  test('bare scalar, with and without a trailing version comment', () => {
    expect(extract(`      - uses: actions/checkout@${SHA}`)).toEqual([`actions/checkout@${SHA}`]);
    expect(extract(`      - uses: actions/checkout@${SHA} # v5`)).toEqual([`actions/checkout@${SHA}`]);
  });

  test('double-quoted scalar', () => {
    expect(extract(`      - uses: "actions/checkout@${SHA}"`)).toEqual([`actions/checkout@${SHA}`]);
    expect(extract(`      - uses: "actions/checkout@${SHA}" # v5`)).toEqual([`actions/checkout@${SHA}`]);
  });

  test('single-quoted scalar', () => {
    expect(extract(`      - uses: 'actions/checkout@${SHA}'`)).toEqual([`actions/checkout@${SHA}`]);
    expect(extract(`        uses: 'actions/checkout@${SHA}' # v5`)).toEqual([`actions/checkout@${SHA}`]);
  });

  test('subpath action resolves against its parent repository', () => {
    expect(extract(`      - uses: owner/repo/sub/path@${SHA}`)).toEqual([`owner/repo@${SHA}`]);
    expect(extract(`      - uses: "owner/repo/sub/path@${SHA}"`)).toEqual([`owner/repo@${SHA}`]);
  });

  test('CRLF line endings and extra spacing after the key', () => {
    expect(extract(`      - uses:    actions/checkout@${SHA}\r`)).toEqual([`actions/checkout@${SHA}`]);
    expect(extract(`      - uses: "actions/checkout@${SHA}"\r`)).toEqual([`actions/checkout@${SHA}`]);
  });

  test('a quoted pin in a trailing comment never shadows the real scalar', () => {
    expect(extract(`      - uses: actions/checkout@${SHA} # was uses: "actions/checkout@${OTHER_SHA}"`)).toEqual([
      `actions/checkout@${SHA}`,
    ]);
    expect(extract(`      - uses: actions/checkout@${SHA} # was uses: 'actions/checkout@${OTHER_SHA}'`)).toEqual([
      `actions/checkout@${SHA}`,
    ]);
  });

  test('flow mapping scalar ends at the comma or closing brace', () => {
    expect(extract(`      - { uses: owner/repo@${SHA}, name: Build }`)).toEqual([`owner/repo@${SHA}`]);
    expect(extract(`      - { uses: owner/repo@${SHA} }`)).toEqual([`owner/repo@${SHA}`]);
    expect(extract(`      - { uses: "owner/repo@${SHA}", name: Build }`)).toEqual([`owner/repo@${SHA}`]);
  });

  test('a literal uses: inside an earlier quoted value never shadows the real key', () => {
    expect(extract(`      - { name: "literal uses: x", uses: owner/repo@${SHA} }`)).toEqual([`owner/repo@${SHA}`]);
    expect(extract(`      - { name: 'literal uses: x', uses: owner/repo@${SHA} }`)).toEqual([`owner/repo@${SHA}`]);
    expect(extract(`      - { name: "literal uses: x", uses: "owner/repo@${SHA}" }`)).toEqual([`owner/repo@${SHA}`]);
  });
});

describe('check-action-pins matcher — rejected scalars', () => {
  test('trailing garbage after the 40-hex SHA is not a pin (#2669)', () => {
    expect(extract(`      - uses: actions/checkout@${SHA}deadbeef`)).toEqual([]);
    expect(extract(`      - uses: "actions/checkout@${SHA}oops"`)).toEqual([]);
    expect(extract(`      - uses: 'actions/checkout@${SHA}oops'`)).toEqual([]);
    expect(extract(`      - uses: actions/checkout@${SHA}0`)).toEqual([]);
  });

  test('short SHA, tag and branch refs are not 40-hex pins', () => {
    expect(extract(`      - uses: actions/checkout@${SHA.slice(0, 39)}`)).toEqual([]);
    expect(extract('      - uses: actions/checkout@v5')).toEqual([]);
    expect(extract('      - uses: actions/checkout@main')).toEqual([]);
  });

  test('local and docker references carry no commit to resolve', () => {
    expect(extract('      - uses: ./.github/actions/ggshield')).toEqual([]);
    expect(extract('      - uses: docker://alpine:3.19')).toEqual([]);
  });
});

describe('check-action-pins matcher — real workflows', () => {
  const workflowDir = join(REPO_ROOT, '.github', 'workflows');

  test('every SHA-pinned uses: line in .github/workflows still extracts', () => {
    const lines = readdirSync(workflowDir)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .flatMap((name) => readFileSync(join(workflowDir, name), 'utf8').split('\n'))
      .filter((line) => /uses:/.test(line) && /@[0-9a-f]{40}/.test(line));

    expect(lines.length).toBeGreaterThan(0);
    const pins = extract(...lines);
    expect(pins.length).toBe(lines.length);
    for (const pin of pins) {
      expect(pin).toMatch(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@[0-9a-f]{40}$/);
    }
  });
});
