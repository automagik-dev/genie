import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('isolated database setup fail-closed guard', () => {
  test('does not return no-op cleanup when isolated DB setup fails', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib', `test-${'db'}.ts`), 'utf8');

    expect(source).toContain('Unable to prepare isolated Genie test database');
    expect(source).toContain('Unable to create isolated Genie test database');
    expect(source).not.toContain('return async () => {};');
  });
});
