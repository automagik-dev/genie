import { describe, expect, test } from 'bun:test';
import { parseRef } from './state.js';

describe('parseRef', () => {
  test('parses slug#group format', () => {
    const result = parseRef('auth-bug#2');
    expect(result).toEqual({ slug: 'auth-bug', group: '2' });
  });

  test('parses with complex slug', () => {
    const result = parseRef('feature-add-login#1');
    expect(result).toEqual({ slug: 'feature-add-login', group: '1' });
  });

  test('throws for missing hash separator', () => {
    expect(() => parseRef('no-hash')).toThrow('Invalid reference');
  });

  test('throws for empty slug', () => {
    expect(() => parseRef('#2')).toThrow('Both slug and group are required');
  });

  test('throws for empty group', () => {
    expect(() => parseRef('slug#')).toThrow('Both slug and group are required');
  });

  test('handles group with non-numeric value', () => {
    const result = parseRef('my-wish#alpha');
    expect(result).toEqual({ slug: 'my-wish', group: 'alpha' });
  });
});
