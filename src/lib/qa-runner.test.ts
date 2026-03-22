import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { defaultSpecDir } from './qa-runner.js';

describe('qa-runner', () => {
  describe('defaultSpecDir', () => {
    test('returns {cwd}/.genie/qa/ when no argument given', () => {
      const result = defaultSpecDir();
      expect(result).toBe(join(resolve(process.cwd()), '.genie', 'qa'));
    });

    test('returns {repoPath}/.genie/qa/ for explicit path', () => {
      const result = defaultSpecDir('/abc/def');
      expect(result).toBe(join(resolve('/abc/def'), '.genie', 'qa'));
    });

    test('different CWDs produce different spec dirs', () => {
      const dirA = defaultSpecDir('/tmp/repo-a');
      const dirB = defaultSpecDir('/tmp/repo-b');
      expect(dirA).toBe('/tmp/repo-a/.genie/qa');
      expect(dirB).toBe('/tmp/repo-b/.genie/qa');
      expect(dirA).not.toBe(dirB);
    });
  });
});
