import { describe, expect, test } from 'bun:test';
import { type BranchGuardDeps, branchGuard } from '../handlers/branch-guard.js';
import type { HookPayload } from '../types.js';

function makePayload(command: string): HookPayload {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  };
}

/**
 * Build a mock `BranchGuardDeps` that returns the supplied value from
 * `resolvePrBase`. Pass `null` to simulate a generic lookup failure; pass
 * a string to simulate a successful base-branch resolution.
 */
function mockDeps(base: string | null): BranchGuardDeps {
  return {
    resolvePrBase: async () => (base === null ? { reason: 'mock-null-failure' } : { base }),
  };
}

/**
 * Build a mock that fails `resolvePrBase` with a specific diagnostic
 * reason — lets us assert that the diagnostic surfaces in the deny message.
 */
function mockDepsWithReason(reason: string): BranchGuardDeps {
  return {
    resolvePrBase: async () => ({ reason }),
  };
}

describe('branch-guard', () => {
  // =========================================================================
  // SHOULD BLOCK
  // =========================================================================

  describe('blocks push to main/master', () => {
    const blocked = [
      'git push origin main',
      'git push origin master',
      'git push -u origin main',
      'git push --set-upstream origin master',
      'git push origin main --tags',
      'git push origin HEAD:main',
      'git push origin feat/x:master',
    ];

    for (const cmd of blocked) {
      test(`blocks: ${cmd}`, async () => {
        const result = await branchGuard(makePayload(cmd));
        expect(result).toBeDefined();
        expect(result!.decision).toBe('deny');
      });
    }
  });

  describe('blocks gh pr create without --base', () => {
    const blocked = ['gh pr create --title "test" --body "test"', 'gh pr create --title "no base"', 'gh pr create'];

    for (const cmd of blocked) {
      test(`blocks: ${cmd}`, async () => {
        const result = await branchGuard(makePayload(cmd));
        expect(result).toBeDefined();
        expect(result!.decision).toBe('deny');
        expect(result!.reason).toContain('--base');
      });
    }
  });

  describe('blocks gh pr merge without explicit PR number', () => {
    const blocked = ['gh pr merge', 'gh pr merge --auto', 'gh pr merge --squash'];

    for (const cmd of blocked) {
      test(`blocks: ${cmd}`, async () => {
        const result = await branchGuard(makePayload(cmd), mockDeps('dev'));
        expect(result).toBeDefined();
        expect(result!.decision).toBe('deny');
        expect(result!.reason).toContain('explicit PR number');
      });
    }
  });

  describe('blocks gh pr merge when PR targets main/master', () => {
    const cases: Array<{ cmd: string; base: string }> = [
      { cmd: 'gh pr merge 123', base: 'main' },
      { cmd: 'gh pr merge 42 --squash', base: 'master' },
      { cmd: 'gh pr merge 99 --auto', base: 'main' },
      { cmd: 'gh pr merge 7 --merge', base: 'master' },
    ];

    for (const { cmd, base } of cases) {
      test(`blocks "${cmd}" (base=${base})`, async () => {
        const result = await branchGuard(makePayload(cmd), mockDeps(base));
        expect(result).toBeDefined();
        expect(result!.decision).toBe('deny');
        expect(result!.reason).toContain(base);
        expect(result!.reason).toContain('§19');
      });
    }
  });

  describe('blocks gh pr merge when base cannot be resolved', () => {
    test('blocks when resolvePrBase returns null (generic failure)', async () => {
      const result = await branchGuard(makePayload('gh pr merge 123'), mockDeps(null));
      expect(result).toBeDefined();
      expect(result!.decision).toBe('deny');
      expect(result!.reason).toContain('could not resolve');
    });

    // Regression: Task #26 — the previous `execSync` with `stdio: ['ignore',
    // 'pipe', 'ignore']` collapsed every failure mode into one opaque deny
    // message ("gh view failed or returned empty"), making production
    // fall-closed incidents undiagnosable. The new `spawnSync` + explicit
    // `{ reason }` channel surfaces the subprocess diagnostic verbatim.
    test('surfaces subprocess exit-code diagnostic in deny reason', async () => {
      const result = await branchGuard(
        makePayload('gh pr merge 1262'),
        mockDepsWithReason('gh pr view exited 1: could not find pull request #1262'),
      );
      expect(result).toBeDefined();
      expect(result!.decision).toBe('deny');
      expect(result!.reason).toContain('#1262');
      expect(result!.reason).toContain('gh pr view exited 1');
      expect(result!.reason).toContain('could not find pull request');
      expect(result!.reason).toContain('§19');
    });

    test('surfaces empty-stdout diagnostic when subprocess succeeded but produced nothing', async () => {
      const result = await branchGuard(
        makePayload('gh pr merge 1262'),
        mockDepsWithReason('gh pr view exited 0 with empty stdout (stderr: none)'),
      );
      expect(result).toBeDefined();
      expect(result!.decision).toBe('deny');
      expect(result!.reason).toContain('exited 0 with empty stdout');
    });

    test('surfaces spawn exception diagnostic in deny reason', async () => {
      const result = await branchGuard(
        makePayload('gh pr merge 1262'),
        mockDepsWithReason('spawnSync threw: ENOENT: no such file or directory, gh'),
      );
      expect(result).toBeDefined();
      expect(result!.decision).toBe('deny');
      expect(result!.reason).toContain('spawnSync threw');
      expect(result!.reason).toContain('ENOENT');
    });
  });

  describe('blocks checkout main with chained mutation', () => {
    const blocked = [
      'git checkout main && git commit -m "test"',
      'git checkout master; git push origin master',
      'git checkout main && git add . && git commit -m "x"',
      'git checkout master && git merge feat/x',
      'git checkout main && git cherry-pick abc123',
      'git checkout main && git rebase feat/x',
    ];

    for (const cmd of blocked) {
      test(`blocks: ${cmd}`, async () => {
        const result = await branchGuard(makePayload(cmd));
        expect(result).toBeDefined();
        expect(result!.decision).toBe('deny');
      });
    }
  });

  // =========================================================================
  // SHOULD ALLOW
  // =========================================================================

  describe('allows gh pr merge when PR targets dev', () => {
    const allowed = [
      'gh pr merge 123',
      'gh pr merge 42 --squash',
      'gh pr merge 99 --auto',
      'gh pr merge 7 --merge',
      'gh pr merge 1246 --squash --delete-branch',
    ];

    for (const cmd of allowed) {
      test(`allows: ${cmd}`, async () => {
        const result = await branchGuard(makePayload(cmd), mockDeps('dev'));
        expect(result).toBeUndefined();
      });
    }
  });

  // Regression: multi-repo workstation — the hook's `gh pr view` subprocess
  // inherits a cwd whose git remote points at a different fork/clone than
  // the PR being merged, so default gh resolution lands on the wrong repo
  // and GraphQL returns "no such PR". Fix: forward `--repo OWNER/NAME` (or
  // `-R OWNER/NAME`, with or without `=`) from the agent command to the
  // lookup subprocess so both sides target the same repo.
  describe('forwards --repo flag from gh pr merge to resolvePrBase', () => {
    type ResolveCall = { prNum: string; repo: string | undefined };
    function spyDeps(base: string): { deps: BranchGuardDeps; calls: ResolveCall[] } {
      const calls: ResolveCall[] = [];
      return {
        calls,
        deps: {
          resolvePrBase: async (prNum, repo) => {
            calls.push({ prNum, repo });
            return { base };
          },
        },
      };
    }

    const variants: Array<[string, string]> = [
      ['long flag, space-separated', 'gh pr merge 1270 --squash --repo automagik-dev/genie'],
      ['long flag, equals-separated', 'gh pr merge 1270 --repo=automagik-dev/genie --squash'],
      ['short flag, space-separated', 'gh pr merge 1270 --squash -R automagik-dev/genie'],
      ['short flag, equals-separated', 'gh pr merge 1270 -R=automagik-dev/genie'],
      ['repo before pr num still parsed', 'gh pr merge 1270 --repo automagik-dev/genie --auto --delete-branch'],
      ['slug with dots and hyphens', 'gh pr merge 42 --repo my-org/my.repo-name'],
      ['slug with underscores', 'gh pr merge 7 --repo owner_x/name_y'],
    ];
    for (const [label, cmd] of variants) {
      test(`${label}: "${cmd}"`, async () => {
        const { deps, calls } = spyDeps('dev');
        const result = await branchGuard(makePayload(cmd), deps);
        expect(result).toBeUndefined();
        expect(calls).toHaveLength(1);
        expect(calls[0].prNum).toBe(cmd.match(/gh\s+pr\s+merge\s+(\d+)/)![1]);
        // The repo slug must round-trip verbatim so subprocess targets the
        // same repo the merge will hit.
        expect(calls[0].repo).toBe(cmd.match(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/)![0]);
      });
    }

    test('absent --repo leaves repo param undefined (backward compat — fall back to cwd resolution)', async () => {
      const { deps, calls } = spyDeps('dev');
      const result = await branchGuard(makePayload('gh pr merge 1270 --squash'), deps);
      expect(result).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0].repo).toBeUndefined();
    });

    test('malformed repo arg (no slash) is ignored — repo stays undefined', async () => {
      const { deps, calls } = spyDeps('dev');
      await branchGuard(makePayload('gh pr merge 1270 --repo justowner'), deps);
      expect(calls[0].repo).toBeUndefined();
    });

    test('--repo inside a quoted body is stripped before extraction (no accidental forwarding)', async () => {
      const { deps, calls } = spyDeps('dev');
      // The body text describes `--repo X/Y`; the actual merge command has
      // no real --repo flag. The hook must NOT pull the slug out of the body.
      await branchGuard(
        makePayload('gh pr merge 1270 --squash --body "see --repo namastexlabs/genie for context"'),
        deps,
      );
      expect(calls[0].repo).toBeUndefined();
    });

    test('still denies when --repo is present but PR targets main', async () => {
      const { deps } = spyDeps('main');
      const result = await branchGuard(makePayload('gh pr merge 1270 --repo automagik-dev/genie'), deps);
      expect(result).toBeDefined();
      expect(result!.decision).toBe('deny');
      expect(result!.reason).toContain('main');
    });
  });

  describe('allows legitimate commands', () => {
    const allowed = [
      // Push to feature branches
      'git push origin feat/my-feature',
      'git push origin fix/bug-123',
      'git push -u origin feat/new-thing',
      'git push origin dev',
      'git push',

      // PR targeting dev
      'gh pr create --base dev --title "test" --body "test"',
      'gh pr create -B dev --title "test"',
      'gh pr create --base dev',

      // PR targeting main/master (creating PRs is proposing, not merging)
      'gh pr create --base main --title "test"',
      'gh pr create --base master --title "test"',
      'gh pr create -B main --title "test"',
      'gh pr create -B master --title "test"',

      // Read-only git commands mentioning main
      'git diff main...HEAD',
      'git log main..HEAD',
      'git log --oneline main',
      'git merge-base main HEAD',
      'git branch -a',
      'git fetch origin main',

      // Non-git commands
      'ls -la',
      'bun run build',
      'echo "hello"',
      'npm test',

      // Branch named main-something (word boundary)
      'git push origin feat/main-feature',
      'git checkout main-feature',

      // PR view/list (not merge or create)
      'gh pr list',
      'gh pr view 42',
      'gh pr checks 42',
    ];

    for (const cmd of allowed) {
      test(`allows: ${cmd}`, async () => {
        const result = await branchGuard(makePayload(cmd));
        expect(result).toBeUndefined();
      });
    }
  });

  // =========================================================================
  // REGEX OVER-MATCH DEFENSE — quoted body content must not trigger patterns
  // =========================================================================

  // Regression: Task #30 — a blocked command substring appearing inside a
  // `--body` / `--message` / `-m` argument triggered a false-positive deny.
  // Live repro: opening PR #1264 (branch-guard subprocess-diagnostics fix)
  // was blocked twice because the PR body described the very commands the
  // hook denies. The fix masks quoted regions before regex matching so the
  // body text becomes invisible to the pattern tests while word-boundaries
  // on the unmasked portion stay intact.
  describe('masks quoted regions so body text does not over-match', () => {
    const allowed: Array<[string, string]> = [
      [
        'allows gh pr create --base dev with `gh pr merge` inside body',
        'gh pr create --base dev --title "test" --body "see gh pr merge 1262 for context"',
      ],
      [
        'allows gh pr create --base dev with `git push origin main` inside body',
        'gh pr create --base dev --title "test" --body "fix: git push origin main was denied"',
      ],
      [
        'allows gh pr create --base dev with `git checkout main && git commit` inside body',
        'gh pr create --base dev --body "repros git checkout main && git commit -m x"',
      ],
      [
        'allows git commit -m with blocked phrase inside the message',
        'git commit -m "docs: explain why git push origin main is blocked"',
      ],
      [
        'allows single-quoted body containing blocked phrases',
        "gh pr create --base dev --body 'git push origin main example'",
      ],
      [
        'allows double-quoted body with escaped quote inside',
        'gh pr create --base dev --body "contains \\"git push origin main\\" escaped"',
      ],
      [
        'allows gh pr merge inside a --body of pr create (the live repro)',
        'gh pr create --base dev --title "fix" --body "blocked by gh pr merge regex"',
      ],
    ];
    for (const [label, cmd] of allowed) {
      test(label, async () => {
        const result = await branchGuard(makePayload(cmd));
        expect(result).toBeUndefined();
      });
    }

    // Negative control: the fix must NOT weaken the real policy. These remain
    // blocked even though they share structure with the allowed cases above.
    test('still blocks real push to main (no quotes)', async () => {
      const result = await branchGuard(makePayload('git push origin main'));
      expect(result).toBeDefined();
      expect(result!.decision).toBe('deny');
    });

    test('still blocks gh pr create lacking --base even if body mentions --base', async () => {
      const result = await branchGuard(makePayload('gh pr create --title "needs --base dev added" --body "test"'));
      expect(result).toBeDefined();
      expect(result!.decision).toBe('deny');
      expect(result!.reason).toContain('--base');
    });

    test('still blocks real gh pr merge targeting main (quoted args do not shield the actual command)', async () => {
      const result = await branchGuard(makePayload('gh pr merge 123 --squash --body "some note"'), mockDeps('main'));
      expect(result).toBeDefined();
      expect(result!.decision).toBe('deny');
      expect(result!.reason).toContain('main');
    });
  });

  // =========================================================================
  // EDGE CASES
  // =========================================================================

  describe('edge cases', () => {
    test('handles empty command', async () => {
      const result = await branchGuard({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: '' },
      });
      expect(result).toBeUndefined();
    });

    test('handles missing tool_input', async () => {
      const result = await branchGuard({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
      });
      expect(result).toBeUndefined();
    });

    test('handles missing command in tool_input', async () => {
      const result = await branchGuard({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {},
      });
      expect(result).toBeUndefined();
    });
  });
});
