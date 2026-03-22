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
  });
});
