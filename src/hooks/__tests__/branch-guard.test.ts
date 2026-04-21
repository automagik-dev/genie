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
 * `resolvePrBase`. Pass `null` to simulate a lookup failure.
 */
function mockDeps(base: string | null): BranchGuardDeps {
  return {
    resolvePrBase: async () => base,
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
    test('blocks when resolvePrBase returns null', async () => {
      const result = await branchGuard(makePayload('gh pr merge 123'), mockDeps(null));
      expect(result).toBeDefined();
      expect(result!.decision).toBe('deny');
      expect(result!.reason).toContain('could not resolve');
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
