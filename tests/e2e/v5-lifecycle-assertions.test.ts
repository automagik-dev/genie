/**
 * Drift guard for the labels `tests/e2e/v5-lifecycle.sh` prints.
 *
 * The e2e script's only output on a passing run is its `ASSERT <label>` lines,
 * so a label IS the test report. Dogfood 7 W6 found one that lied: the loop
 * greps every machine-local `.genie/` ignore rule by name while the label still
 * said `gitignore-has-three-genie-db-lines` — a count from an older rule set,
 * exactly the counting language the Z11/E2E pass set out to remove.
 *
 * Two claims are pinned here: the rules the script greps are the rules `genie
 * init` actually writes, and the label for that loop carries no cardinal count.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MACHINE_LOCAL_GENIE_PATHS } from '../../src/term-commands/init.js';

const SCRIPT = join(import.meta.dir, 'v5-lifecycle.sh');

describe('v5 lifecycle e2e assertion labels', () => {
  const script = readFileSync(SCRIPT, 'utf8');
  const RULE_LOOP = "for rule in '.genie/genie.db'";

  test('the ignore-rule loop greps exactly the rules genie init writes', () => {
    const line = script.split('\n').find((candidate) => candidate.includes(RULE_LOOP)) as string;
    expect(line).toBeDefined();
    const rules = [...line.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
    expect(rules).toEqual([...MACHINE_LOCAL_GENIE_PATHS]);
  });
});
