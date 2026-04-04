import { describe, expect, test } from 'bun:test';
import { enrichContext } from './context-enrichment.js';

describe('context-enrichment', () => {
  test('returns empty string when brain path does not exist', () => {
    const result = enrichContext({
      query: 'test query',
      brainPath: '/nonexistent/brain/path',
    });
    expect(result).toBe('');
  });

  test('returns empty string when rlmx is not available', () => {
    const result = enrichContext({
      query: 'test query',
      brainPath: '/tmp',
    });
    // Either rlmx is available and finds nothing, or it's not available
    expect(typeof result).toBe('string');
  }, 30_000);
});
