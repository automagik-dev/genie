/**
 * Structural test — watchdog source must never import from the parent
 * `@automagik/genie` source tree. Enforcing isolation keeps the dead-man's
 * switch from depending on the thing it is meant to watch.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE_ROOT = new URL('..', import.meta.url).pathname;
const SRC_ROOT = join(PACKAGE_ROOT, 'src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs, acc);
    } else if (abs.endsWith('.ts')) {
      acc.push(abs);
    }
  }
  return acc;
}

describe('watchdog isolation', () => {
  test('no imports from @automagik/genie src', () => {
    const files = walk(SRC_ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (/from ['"]\.\.\/\.\.\/\.\.\/src\//.test(src)) offenders.push(file);
      if (/from ['"]@automagik\/genie['"]/.test(src)) offenders.push(file);
      if (/require\(['"]@automagik\/genie['"]\)/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test('package.json dependencies are minimal', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    // The watchdog is allowed to pin `postgres` and nothing else from the
    // regular npm surface. Additions here should be accompanied by a
    // justification note in the package README.
    expect(deps.sort()).toEqual(['postgres']);
  });
});
