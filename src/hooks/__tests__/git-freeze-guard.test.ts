import { describe, expect, test } from 'bun:test';
import { type GitFreezeGuardDeps, gitFreezeGuard } from '../handlers/git-freeze-guard.js';
import type { HookPayload } from '../types.js';

/** The shared checkout every dispatched subagent starts in. */
const SHARED = '/repo';
/** A linked worktree an agent owns — its own HEAD, so the freeze does not apply. */
const LANE = '/wt/lane-a';

/**
 * Working-tree topology the mock resolves against. Mirrors what
 * `git rev-parse --show-toplevel` returns for each directory; anything absent
 * is "not a git working tree" (the mock returns `null`, and the guard allows).
 */
const TOPOLOGY: Record<string, string> = {
  [SHARED]: SHARED,
  [`${SHARED}/src`]: SHARED,
  [`${SHARED}/src/hooks`]: SHARED,
  [LANE]: LANE,
  [`${LANE}/src`]: LANE,
  '/other': '/other',
};

interface CallLog {
  deps: GitFreezeGuardDeps;
  calls: string[];
}

function mockDeps(topology: Record<string, string> = TOPOLOGY): CallLog {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      resolveWorktreeRoot: (dir) => {
        calls.push(dir);
        return topology[dir] ?? null;
      },
    },
  };
}

/** A Bash call issued by a dispatched subagent (Claude Code fills `agent_id`). */
function subagent(command: string, cwd: string = SHARED): HookPayload {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd,
    agent_id: 'a59efa9aa4e5c4138',
    agent_type: 'general-purpose',
    tool_input: { command },
  };
}

/** The same Bash call issued by the orchestrator (main thread: no `agent_id`). */
function orchestrator(command: string, cwd: string = SHARED): HookPayload {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd,
    agent_id: null,
    agent_type: null,
    tool_input: { command },
  };
}

async function run(payload: HookPayload, topology?: Record<string, string>) {
  return gitFreezeGuard(payload, mockDeps(topology).deps);
}

describe('git-freeze-guard', () => {
  // =========================================================================
  // DENIES — subagent moving the shared checkout's git state
  // =========================================================================

  describe('denies frozen subcommands from a subagent in the shared workspace', () => {
    const blocked = [
      'git checkout dev',
      'git checkout -b feat/thing',
      'git checkout -- src/foo.ts',
      'git switch dev',
      'git switch -c feat/thing',
      'git reset --hard HEAD~1',
      'git reset --soft HEAD~1',
      'git stash',
      'git stash push -m wip',
      'git stash pop',
      'git rebase origin/dev',
      'git rebase --abort',
      'git rebase -i HEAD~3',
    ];

    for (const cmd of blocked) {
      test(`denies: ${cmd}`, async () => {
        const result = await run(subagent(cmd));
        expect(result?.decision).toBe('deny');
      });
    }
  });

  test('deny reason cites the AGENTS.md freeze and both escape hatches', async () => {
    const result = await run(subagent('git checkout dev'));
    const reason = result?.reason ?? '';
    expect(reason).toContain('AGENTS.md');
    expect(reason).toContain('only the orchestrator moves HEAD');
    expect(reason).toContain('genie launch');
    expect(reason).toContain('git worktree add');
    expect(reason).toContain('sequence the work');
    expect(reason).toContain(SHARED);
  });

  // =========================================================================
  // ALLOWS — the orchestrator owns HEAD
  // =========================================================================

  describe('never fires for the orchestrator', () => {
    for (const cmd of ['git checkout dev', 'git reset --hard HEAD~1', 'git rebase origin/dev']) {
      test(`allows from main thread: ${cmd}`, async () => {
        expect(await run(orchestrator(cmd))).toBeUndefined();
      });
    }

    test('allows when agent_type is explicitly main', async () => {
      const payload = subagent('git switch dev');
      payload.agent_type = 'main';
      expect(await run(payload)).toBeUndefined();
    });

    test('allows when the runtime supplies no agent_id at all (Codex, older clients)', async () => {
      const payload = subagent('git switch dev');
      payload.agent_id = undefined;
      payload.agent_type = undefined;
      expect(await run(payload)).toBeUndefined();
    });
  });

  // =========================================================================
  // ALLOWS — read-only and worktree plumbing
  // =========================================================================

  describe('allows non-frozen git usage from a subagent', () => {
    const allowed = [
      'git status',
      'git log --oneline -10',
      'git diff --stat',
      'git show HEAD',
      'git add -A',
      'git commit -m wip',
      'git fetch origin',
      'git worktree add /wt/lane-b -b feat/x origin/dev',
      'git worktree remove /wt/lane-b',
      'git worktree prune',
      'git worktree list',
      'git stash list',
      'git stash show -p',
      'git branch --show-current',
    ];

    for (const cmd of allowed) {
      test(`allows: ${cmd}`, async () => {
        expect(await run(subagent(cmd))).toBeUndefined();
      });
    }
  });

  // =========================================================================
  // `git -C <path>` — the worktree an agent owns
  // =========================================================================

  describe('git -C targeting', () => {
    test('allows git -C into a worktree the agent owns', async () => {
      expect(await run(subagent(`git -C ${LANE} checkout -b feat/x`))).toBeUndefined();
    });

    test('denies git -C pointed back at the shared checkout', async () => {
      expect((await run(subagent(`git -C ${SHARED} switch dev`)))?.decision).toBe('deny');
    });

    test('denies git -C . in the shared checkout', async () => {
      expect((await run(subagent('git -C . reset --hard HEAD~1')))?.decision).toBe('deny');
    });

    test('denies git -C on a subdirectory of the shared checkout', async () => {
      expect((await run(subagent('git -C src/hooks checkout dev')))?.decision).toBe('deny');
    });

    test('allows git -C to an unrelated repo outside the shared checkout', async () => {
      expect(await run(subagent('git -C ../other checkout dev'))).toBeUndefined();
    });

    test('allows a non-literal git -C target rather than guessing', async () => {
      expect(await run(subagent('git -C "$WT" checkout -b feat/x'))).toBeUndefined();
    });
  });

  // =========================================================================
  // Compound commands — the documented false-positive trap
  // =========================================================================

  describe('compound commands', () => {
    test('allows cd into an owned worktree before checkout', async () => {
      expect(await run(subagent(`cd ${LANE} && git checkout -b feat/x`))).toBeUndefined();
    });

    test('denies when a later cd lands back in the shared checkout', async () => {
      expect((await run(subagent(`cd ${LANE} && cd ${SHARED} && git switch dev`)))?.decision).toBe('deny');
    });

    test('denies a relative cd that stays inside the shared checkout', async () => {
      expect((await run(subagent('cd src && git switch dev')))?.decision).toBe('deny');
    });

    test('denies a frozen command that follows an unrelated command', async () => {
      expect((await run(subagent('bun test && git checkout dev')))?.decision).toBe('deny');
    });

    test('denies across a semicolon separator', async () => {
      expect((await run(subagent('echo hi; git rebase origin/dev')))?.decision).toBe('deny');
    });

    test('denies across a pipe separator', async () => {
      expect((await run(subagent('git checkout dev | tee /dev/null')))?.decision).toBe('deny');
    });

    test('allows when the cd target is a variable (unresolvable, so not guessed)', async () => {
      expect(await run(subagent('cd "$WORKTREE" && git checkout -b feat/x'))).toBeUndefined();
    });

    test('allows when the cd target is tilde-expanded (unresolvable)', async () => {
      expect(await run(subagent('cd ~/work/lane && git checkout -b feat/x'))).toBeUndefined();
    });

    test('allows after popd discards the known directory', async () => {
      expect(await run(subagent(`pushd ${LANE} && popd && git checkout dev`))).toBeUndefined();
    });
  });

  // =========================================================================
  // Quoting — a frozen command named inside an argument is not a command
  // =========================================================================

  describe('quoted arguments never trigger a deny', () => {
    const allowed = [
      'git commit -m "git checkout main to reproduce"',
      "gh pr create --base dev --body 'the fix removes a stray git rebase origin/dev'",
      'gh issue comment 2705 --body "shared-workspace subagents never run git reset --hard"',
      'echo "cd /repo && git switch dev"',
    ];

    for (const cmd of allowed) {
      test(`allows: ${cmd}`, async () => {
        expect(await run(subagent(cmd))).toBeUndefined();
      });
    }
  });

  // =========================================================================
  // Fail-open boundaries
  // =========================================================================

  describe('fails open on anything it cannot resolve', () => {
    test('allows repo-redirecting global flags rather than re-deriving git discovery', async () => {
      expect(await run(subagent('git --git-dir=/repo/.git checkout dev'))).toBeUndefined();
      expect(await run(subagent('git --work-tree /repo checkout dev'))).toBeUndefined();
    });

    test('allows when the payload carries no cwd', async () => {
      const payload = subagent('git checkout dev');
      payload.cwd = undefined;
      expect(await run(payload)).toBeUndefined();
    });

    test('allows when the shared cwd is not a git working tree', async () => {
      expect(await run(subagent('git checkout dev', '/not/a/repo'))).toBeUndefined();
    });

    test('allows when tool_input has no command', async () => {
      const payload = subagent('git checkout dev');
      payload.tool_input = {};
      expect(await run(payload)).toBeUndefined();
    });

    test('does not shell out to git for commands that never mention git', async () => {
      const mock = mockDeps();
      expect(await gitFreezeGuard(subagent('bun run check:fast'), mock.deps)).toBeUndefined();
      expect(mock.calls).toEqual([]);
    });

    test('does not shell out to git for read-only git commands', async () => {
      const mock = mockDeps();
      expect(await gitFreezeGuard(subagent('git status --short'), mock.deps)).toBeUndefined();
      expect(mock.calls).toEqual([]);
    });
  });

  // =========================================================================
  // Worktree-scoped sessions
  // =========================================================================

  describe('worktree-scoped sessions', () => {
    test('a subagent may not move the HEAD of the worktree it shares with its orchestrator', async () => {
      expect((await run(subagent('git checkout dev', LANE)))?.decision).toBe('deny');
    });

    test('but may move a different worktree it addresses explicitly', async () => {
      expect(await run(subagent(`git -C ${SHARED} checkout dev`, LANE))).toBeUndefined();
    });
  });
});
