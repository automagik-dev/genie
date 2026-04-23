/**
 * Tests for spawn-invocation helper — ensures the TUI preview string and the
 * executor argv never drift. Run with: bun test src/lib/spawn-invocation.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { type SpawnIntent, buildSpawnInvocation } from './spawn-invocation.js';
import { shellQuote } from './team-lead-command.js';

describe('buildSpawnInvocation', () => {
  describe('spawn-agent variant', () => {
    test('minimal intent produces [spawn, name]', () => {
      const { argv } = buildSpawnInvocation({ kind: 'spawn-agent', name: 'reviewer' });
      expect(argv).toEqual(['spawn', 'reviewer']);
    });

    test('full intent includes all flags in canonical order', () => {
      const { argv } = buildSpawnInvocation({
        kind: 'spawn-agent',
        name: 'engineer',
        team: 'my-team',
        session: 'sess-1',
        window: 'win-0',
        newWindow: true,
        prompt: 'do the thing',
      });
      expect(argv).toEqual([
        'spawn',
        'engineer',
        '--team',
        'my-team',
        '--session',
        'sess-1',
        '--window',
        'win-0',
        '--new-window',
        '--prompt',
        'do the thing',
      ]);
    });

    test('newWindow=false omits the --new-window flag', () => {
      const { argv } = buildSpawnInvocation({
        kind: 'spawn-agent',
        name: 'engineer',
        newWindow: false,
      });
      expect(argv).toEqual(['spawn', 'engineer']);
    });

    test('empty optional strings are omitted from argv', () => {
      const { argv } = buildSpawnInvocation({
        kind: 'spawn-agent',
        name: 'engineer',
        team: '',
        session: '',
        window: '',
        prompt: '',
      });
      expect(argv).toEqual(['spawn', 'engineer']);
    });
  });

  describe('create-team variant', () => {
    test('minimal intent produces [team, create, name]', () => {
      const { argv } = buildSpawnInvocation({ kind: 'create-team', name: 'alpha' });
      expect(argv).toEqual(['team', 'create', 'alpha']);
    });

    test('with repo and baseBranch', () => {
      const { argv } = buildSpawnInvocation({
        kind: 'create-team',
        name: 'alpha',
        repo: '/home/genie/repos/foo',
        baseBranch: 'main',
      });
      expect(argv).toEqual(['team', 'create', 'alpha', '--repo', '/home/genie/repos/foo', '--base', 'main']);
    });

    test('members are NOT wired into argv (follow-up hire sequence handles that)', () => {
      const { argv } = buildSpawnInvocation({
        kind: 'create-team',
        name: 'alpha',
        members: ['engineer', 'reviewer'],
      });
      expect(argv).toEqual(['team', 'create', 'alpha']);
    });

    test('empty optional strings are omitted from argv', () => {
      const { argv } = buildSpawnInvocation({
        kind: 'create-team',
        name: 'alpha',
        repo: '',
        baseBranch: '',
      });
      expect(argv).toEqual(['team', 'create', 'alpha']);
    });
  });

  describe('round-trip invariant', () => {
    const cases: Array<{ label: string; intent: SpawnIntent }> = [
      {
        label: 'spawn-agent minimal',
        intent: { kind: 'spawn-agent', name: 'reviewer' },
      },
      {
        label: 'spawn-agent with all flags',
        intent: {
          kind: 'spawn-agent',
          name: 'engineer',
          team: 'my-team',
          session: 'sess-1',
          window: 'win-0',
          newWindow: true,
          prompt: 'do the thing',
        },
      },
      {
        label: 'spawn-agent prompt with single quotes',
        intent: { kind: 'spawn-agent', name: 'engineer', prompt: "it's tricky" },
      },
      {
        label: 'spawn-agent prompt with double quotes',
        intent: { kind: 'spawn-agent', name: 'engineer', prompt: 'say "hi"' },
      },
      {
        label: 'spawn-agent prompt with dollar signs',
        intent: { kind: 'spawn-agent', name: 'engineer', prompt: 'echo $HOME && $(whoami)' },
      },
      {
        label: 'spawn-agent name with spaces',
        // spawn-agent does not enforce branch-safety on name; spaces are
        // allowed so long as they round-trip through shellQuote.
        intent: { kind: 'spawn-agent', name: 'spaces here' },
      },
      {
        label: 'spawn-agent team with spaces',
        intent: { kind: 'spawn-agent', name: 'engineer', team: 'team with spaces' },
      },
      {
        label: 'create-team minimal',
        intent: { kind: 'create-team', name: 'alpha' },
      },
      {
        label: 'create-team with repo containing spaces',
        intent: { kind: 'create-team', name: 'alpha', repo: '/home/user/my repos/foo' },
      },
    ];

    for (const { label, intent } of cases) {
      test(`${label}: argv.map(shellQuote).join(' ') === cli`, () => {
        const { cli, argv } = buildSpawnInvocation(intent);
        expect(argv.map(shellQuote).join(' ')).toBe(cli);
      });
    }

    test('cli preview for a prompt with single quotes quotes correctly', () => {
      const { cli } = buildSpawnInvocation({ kind: 'spawn-agent', name: 'engineer', prompt: "it's tricky" });
      // POSIX single-quote escape: close, escape, reopen.
      expect(cli).toBe("'spawn' 'engineer' '--prompt' 'it'\\''s tricky'");
    });
  });

  describe('negative cases', () => {
    test('spawn-agent with empty name throws naming the field', () => {
      expect(() => buildSpawnInvocation({ kind: 'spawn-agent', name: '' })).toThrow(/"name"/);
    });

    test('create-team with empty name throws naming the field', () => {
      expect(() => buildSpawnInvocation({ kind: 'create-team', name: '' })).toThrow(/"name"/);
    });

    test('create-team with unsafe branch name (spaces) throws naming the field', () => {
      expect(() => buildSpawnInvocation({ kind: 'create-team', name: 'spaces here' })).toThrow(
        /"name".*unsafe characters/,
      );
    });

    test('create-team with unsafe branch name (shell metachar) throws', () => {
      expect(() => buildSpawnInvocation({ kind: 'create-team', name: 'bad;name' })).toThrow(/unsafe characters/);
    });

    test('unknown kind throws', () => {
      const bogus = { kind: 'nuke-planet', name: 'earth' } as unknown as SpawnIntent;
      expect(() => buildSpawnInvocation(bogus)).toThrow(/unknown intent "kind"/);
    });
  });
});
