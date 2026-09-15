import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SKILL_CATEGORIES, SKILL_MUTATES_LEVELS } from './taxonomy';

/**
 * The plugin mirrors the repository's frontmatter taxonomy instead of importing
 * it: this module is bundled for the browser too, and importing
 * `scripts/skills-inventory-parity.ts` would drag `node:fs` in behind a
 * constant (and its Node-only lib assumptions into this package's tsconfig).
 *
 * The mirror is only safe while it is checked. A category added to the contract
 * but not here would be silently dropped from the Skills panel instead of shown
 * under its header, so this reads the canonical declarations as text and
 * compares them — order included, because order is the rendering order.
 */
const CANONICAL = join(import.meta.dir, '../../../scripts/skills-inventory-parity.ts');

async function declaredList(name: string): Promise<string[]> {
  const source = await readFile(CANONICAL, 'utf8');
  const block = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(source)?.[1];
  if (block === undefined) throw new Error(`${name} is no longer declared as an inline array in ${CANONICAL}`);
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

test('the plugin taxonomy mirrors the repository contract exactly, order included', async () => {
  expect(SKILL_CATEGORIES as readonly string[]).toEqual(await declaredList('SKILL_CATEGORIES'));
  expect(SKILL_MUTATES_LEVELS as readonly string[]).toEqual(await declaredList('SKILL_MUTATES_LEVELS'));
});
