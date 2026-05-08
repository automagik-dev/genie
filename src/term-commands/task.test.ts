import { describe, expect, it } from 'bun:test';
import { validateWishSlug, wishFileFromSlug } from './task.js';

describe('validateWishSlug', () => {
  it('accepts a simple lowercase slug', () => {
    expect(validateWishSlug('my-wish')).toBe('my-wish');
  });

  it('accepts a single-character slug', () => {
    expect(validateWishSlug('a')).toBe('a');
  });

  it('accepts digits', () => {
    expect(validateWishSlug('fix-1300')).toBe('fix-1300');
  });

  it('rejects spaces', () => {
    expect(() => validateWishSlug('My Wish')).toThrow(/My Wish/);
  });

  it('rejects uppercase', () => {
    expect(() => validateWishSlug('UPPER')).toThrow(/UPPER/);
  });

  it('rejects leading hyphen', () => {
    expect(() => validateWishSlug('-leading')).toThrow(/-leading/);
  });

  it('rejects path traversal', () => {
    expect(() => validateWishSlug('../oops')).toThrow(/\.\.\/oops/);
  });

  it('rejects absolute path', () => {
    expect(() => validateWishSlug('/abs/path')).toThrow(/\/abs\/path/);
  });

  it('rejects empty string', () => {
    expect(() => validateWishSlug('')).toThrow();
  });

  it('rejects backslash separators', () => {
    expect(() => validateWishSlug('foo\\bar')).toThrow();
  });
});

describe('wishFileFromSlug', () => {
  it('builds the canonical wish file path', () => {
    expect(wishFileFromSlug('my-wish')).toBe('.genie/wishes/my-wish/WISH.md');
  });
});
