import { describe, expect, test } from 'bun:test';
import { validateRepoPath } from './dir.js';

describe('validateRepoPath', () => {
  test('accepts absolute paths', () => {
    expect(() => validateRepoPath('/home/user/project')).not.toThrow();
    expect(() => validateRepoPath('/tmp/repo')).not.toThrow();
  });

  test('accepts home-relative paths', () => {
    expect(() => validateRepoPath('~/projects/app')).not.toThrow();
    expect(() => validateRepoPath('~/repo')).not.toThrow();
  });

  test('accepts dot-relative paths', () => {
    expect(() => validateRepoPath('./local-repo')).not.toThrow();
    expect(() => validateRepoPath('../sibling-repo')).not.toThrow();
  });

  test('rejects bare words', () => {
    expect(() => validateRepoPath('genie')).toThrow(/Invalid --repo value/);
    expect(() => validateRepoPath('my-project')).toThrow(/Invalid --repo value/);
  });

  test('rejects URLs', () => {
    expect(() => validateRepoPath('https://github.com/org/repo')).toThrow(/Invalid --repo value/);
  });

  test('rejects git SSH URLs', () => {
    expect(() => validateRepoPath('git@github.com:org/repo.git')).toThrow(/Invalid --repo value/);
  });
});
