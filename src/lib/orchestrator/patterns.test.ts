import { describe, expect, test } from 'bun:test';
import {
  completionPatterns,
  errorPatterns,
  getFirstMatch,
  hasMatch,
  idlePatterns,
  matchPatterns,
  permissionPatterns,
  questionPatterns,
  stripAnsi,
  toolUsePatterns,
  workingPatterns,
} from './patterns.js';

describe('stripAnsi', () => {
  test('removes ANSI escape codes', () => {
    expect(stripAnsi('\x1B[31mhello\x1B[0m')).toBe('hello');
  });

  test('returns plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  test('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  test('strips multiple escape sequences', () => {
    expect(stripAnsi('\x1B[1m\x1B[34mbold blue\x1B[0m')).toBe('bold blue');
  });
});

describe('matchPatterns', () => {
  test('matches permission patterns', () => {
    const matches = matchPatterns('Allow bash command? [Y/n]', permissionPatterns);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].type).toBe('bash_permission');
  });

  test('returns empty for no matches', () => {
    const matches = matchPatterns('just some text', permissionPatterns);
    expect(matches).toEqual([]);
  });

  test('extracts data from matches', () => {
    const matches = matchPatterns('Error: something broke', errorPatterns);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].extracted?.message).toBe('something broke');
  });

  test('matches global patterns multiple times', () => {
    const content = '❯ 1. Option A\n❯ 2. Option B\n❯ 3. Option C';
    const matches = matchPatterns(content, questionPatterns);
    const numbered = matches.filter((m) => m.type === 'claude_code_numbered_options');
    expect(numbered.length).toBeGreaterThanOrEqual(2);
  });

  test('matches file permission patterns', () => {
    const matches = matchPatterns('Allow Edit file? [Y/n]', permissionPatterns);
    expect(matches.some((m) => m.type === 'file_permission')).toBe(true);
  });

  test('matches MCP permission patterns', () => {
    const matches = matchPatterns('Allow MCP tool? [Y/n]', permissionPatterns);
    expect(matches.some((m) => m.type === 'mcp_permission')).toBe(true);
  });

  test('matches yes/no question patterns', () => {
    const matches = matchPatterns('Continue? [Y/n]', questionPatterns);
    expect(matches.some((m) => m.type === 'yes_no_question')).toBe(true);
  });

  test('matches tool use patterns', () => {
    const matches = matchPatterns('Running command: ls -la', toolUsePatterns);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].extracted?.command).toBe('ls -la');
  });

  test('matches read file tool pattern', () => {
    const matches = matchPatterns('Reading file: /tmp/test.ts', toolUsePatterns);
    expect(matches.some((m) => m.type === 'read_file')).toBe(true);
  });

  test('matches write file tool pattern', () => {
    const matches = matchPatterns('Writing to: /tmp/output.ts', toolUsePatterns);
    expect(matches.some((m) => m.type === 'write_file')).toBe(true);
  });

  test('matches search tool pattern', () => {
    const matches = matchPatterns('Searching: function foo', toolUsePatterns);
    expect(matches.some((m) => m.type === 'search')).toBe(true);
  });

  test('matches non-global patterns only once', () => {
    const content = 'Error: first\nError: second';
    const matches = matchPatterns(content, errorPatterns);
    // Each error pattern should match at most once (non-global)
    const errorTypes = matches.filter((m) => m.type === 'error');
    expect(errorTypes.length).toBe(1);
  });
});

describe('hasMatch', () => {
  test('returns true when pattern matches', () => {
    expect(hasMatch('Thinking...', workingPatterns)).toBe(true);
  });

  test('returns false when no pattern matches', () => {
    expect(hasMatch('hello world', workingPatterns)).toBe(false);
  });

  test('matches completion patterns', () => {
    expect(hasMatch('Successfully completed', completionPatterns)).toBe(true);
  });

  test('matches idle patterns', () => {
    expect(hasMatch('\n>\n', idlePatterns)).toBe(true);
  });

  test('matches working spinner', () => {
    expect(hasMatch('⠋ loading', workingPatterns)).toBe(true);
  });

  test('matches streaming indicator', () => {
    expect(hasMatch('some text▌', workingPatterns)).toBe(true);
  });
});

describe('getFirstMatch', () => {
  test('returns first match', () => {
    const result = getFirstMatch('Error: something failed', errorPatterns);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('error');
  });

  test('returns null when no match', () => {
    const result = getFirstMatch('no errors here', errorPatterns);
    expect(result).toBeNull();
  });

  test('returns permission match with extraction', () => {
    const result = getFirstMatch('Allow bash command? [Y/n]', permissionPatterns);
    expect(result).not.toBeNull();
    expect(result?.extracted?.default).toBe('Y');
  });
});
