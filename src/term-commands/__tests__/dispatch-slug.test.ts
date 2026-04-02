import { describe, expect, test } from 'bun:test';
import { validateSlug } from '../dispatch.js';

/**
 * validateSlug calls process.exit(1) on invalid slugs.
 * We test by intercepting process.exit with a throw.
 */
function expectSlugRejected(slug: string): void {
  const originalExit = process.exit;
  let exited = false;
  process.exit = (() => {
    exited = true;
    throw new Error('process.exit called');
  }) as never;
  try {
    validateSlug(slug);
  } catch {
    // Expected
  } finally {
    process.exit = originalExit;
  }
  expect(exited).toBe(true);
}

function expectSlugAccepted(slug: string): void {
  const originalExit = process.exit;
  let exited = false;
  process.exit = (() => {
    exited = true;
    throw new Error('process.exit called');
  }) as never;
  try {
    validateSlug(slug);
  } catch {
    // Unexpected
  } finally {
    process.exit = originalExit;
  }
  expect(exited).toBe(false);
}

describe('validateSlug — path traversal prevention', () => {
  test('rejects path traversal: ../../etc/passwd', () => {
    expectSlugRejected('../../etc/passwd');
  });

  test('rejects path traversal: ../secret', () => {
    expectSlugRejected('../secret');
  });

  test('rejects forward slash: foo/bar', () => {
    expectSlugRejected('foo/bar');
  });

  test('rejects backslash: foo\\bar', () => {
    expectSlugRejected('foo\\bar');
  });

  test('rejects empty string', () => {
    expectSlugRejected('');
  });

  test('rejects spaces: foo bar', () => {
    expectSlugRejected('foo bar');
  });

  test('accepts valid slug: my-wish', () => {
    expectSlugAccepted('my-wish');
  });

  test('accepts valid slug with dots: v4.hook-cli', () => {
    expectSlugAccepted('v4.hook-cli');
  });

  test('accepts valid slug with underscore: my_wish_v2', () => {
    expectSlugAccepted('my_wish_v2');
  });

  test('accepts alphanumeric: abc123', () => {
    expectSlugAccepted('abc123');
  });

  test('accepts single char: a', () => {
    expectSlugAccepted('a');
  });
});
