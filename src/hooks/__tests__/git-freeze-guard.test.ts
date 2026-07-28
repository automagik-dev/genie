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
  '/other2': '/other2',
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
  // Separators decide whether a cd moves the shell the git call runs in
  // =========================================================================

  // Regression: PR #2722 review (CodeRabbit 3662114937, Codex 3661572682).
  // The walk applied every `cd` to every later statement whatever operators
  // sat around it. A `cd` beside `|` or `&` is its own process and moves
  // nothing; a `cd` before `||` only takes effect when it succeeded, in which
  // case the else-branch never runs at all. Reading either as effective let a
  // frozen call through while bash ran it in the shared checkout.
  describe('cd propagates only across separators that keep the parent shell', () => {
    const blocked = [
      'cd /other | git switch dev',
      'cd /other & git reset --hard HEAD~1',
      'cd /missing || git rebase origin/dev',
      'foo | cd /other && git switch dev',
    ];

    for (const cmd of blocked) {
      test(`denies: ${cmd}`, async () => {
        expect((await run(subagent(cmd)))?.decision).toBe('deny');
      });
    }

    // The counterweight: `cd <worktree> || exit 1` is the ordinary way to make
    // a lane script abort on a bad path, and the git call after it genuinely
    // runs in the worktree. A blanket "`||` never propagates" rule would deny it.
    test('allows the guarded-cd idiom into an owned worktree', async () => {
      expect(await run(subagent(`cd ${LANE} || exit 1; git switch dev`))).toBeUndefined();
    });
  });

  // =========================================================================
  // A cd can fail, so every directory it could leave the shell in is checked
  // =========================================================================

  // Regression: PR #2726 review (CodeRabbit 3667949005). Tracking only the
  // `cd` target assumed the `cd` worked. When it doesn't, the shell stays put
  // and the git call lands in the shared checkout — the exact case the freeze
  // exists for. Verified against bash: `cd /nonexistent || true && pwd` prints
  // the *original* directory, because `||` consumes the failure and `&&` then
  // proceeds. So the walk keeps every reachable directory and denies if any of
  // them is the shared root.
  describe('denies when the shared checkout is still reachable after a cd', () => {
    const blocked = [
      // The reported bypass: `||` swallows the failure, `&&` carries on.
      'cd /definitely-missing || true && git reset --hard',
      // Neither branch of the `||` rules the shared checkout out.
      'cd /other || cd /other2; git switch dev',
      // `;` does not depend on the cd at all, so a failed cd reaches the git.
      'cd /definitely-missing; git switch dev',
      // `&&` suspends the failure branch; the later `;` resumes it.
      `cd ${LANE} && echo ok ; git switch dev`,
    ];

    for (const cmd of blocked) {
      test(`denies: ${cmd}`, async () => {
        expect((await run(subagent(cmd)))?.decision).toBe('deny');
      });
    }

    // The counterweights. `&&` genuinely rules the shared checkout out — the
    // git call cannot run unless the cd succeeded — and a terminator ends the
    // failure branch outright. Both must stay allowed or the guard is unusable.
    const allowed = [
      `cd ${LANE} && git switch dev`,
      `cd ${LANE} || exit 1; git switch dev`,
      `cd ${LANE} || return 1; git switch dev`,
    ];

    for (const cmd of allowed) {
      test(`allows: ${cmd}`, async () => {
        expect(await run(subagent(cmd))).toBeUndefined();
      });
    }
  });

  // =========================================================================
  // Subshells — `(…)` scopes a cd, and its parens are not part of the command
  // =========================================================================

  describe('subshell grouping', () => {
    test('allows a subshell that cd s into another repo before the frozen call', async () => {
      expect(await run(subagent('(cd /other && git switch main)'))).toBeUndefined();
    });

    test('allows the same subshell written with the parens as their own tokens', async () => {
      expect(await run(subagent('( cd /other && git switch main )'))).toBeUndefined();
    });

    test('allows a nested subshell', async () => {
      expect(await run(subagent('((cd /other && git switch main))'))).toBeUndefined();
    });

    test('allows a subshell cd into an owned worktree', async () => {
      expect(await run(subagent(`(cd ${LANE} && git switch -c feat/x)`))).toBeUndefined();
    });

    test('denies once the subshell closes, because its cd does not leak', async () => {
      expect((await run(subagent(`(cd ${LANE} && git status) && git switch dev`)))?.decision).toBe('deny');
    });

    test('denies a frozen call that follows a closed subshell', async () => {
      expect((await run(subagent('(cd /other && git switch main) ; git switch dev')))?.decision).toBe('deny');
    });

    test('a command substitution inside a subshell does not close it early', async () => {
      expect(await run(subagent(`(cd ${LANE} && echo $(pwd) && git switch dev)`))).toBeUndefined();
    });

    test('still denies after a command substitution in an earlier statement', async () => {
      expect((await run(subagent('echo $(date) && git switch dev')))?.decision).toBe('deny');
      expect((await run(subagent('echo `date` && git switch dev')))?.decision).toBe('deny');
    });

    test('allows a git -C whose target is a command substitution', async () => {
      expect(await run(subagent('git -C $(pwd) switch dev'))).toBeUndefined();
    });
  });

  // =========================================================================
  // Every frozen invocation is evaluated, not just the first
  // =========================================================================

  describe('multiple frozen invocations in one command', () => {
    test('denies a shared-checkout call hidden behind a legitimate git -C', async () => {
      expect((await run(subagent('git -C /other switch main && git switch dev')))?.decision).toBe('deny');
    });

    test('denies a shared-checkout call hidden behind a legitimate worktree call', async () => {
      expect((await run(subagent(`cd ${LANE} && git switch x && cd ${SHARED} && git switch dev`)))?.decision).toBe(
        'deny',
      );
    });

    test('allows when every frozen invocation lands outside the shared checkout', async () => {
      expect(await run(subagent(`git -C ${LANE} switch x && git -C /other switch y`))).toBeUndefined();
    });

    test('the deny names the invocation that targets the shared checkout', async () => {
      const result = await run(subagent('git -C /other switch main && git reset --hard HEAD~1'));
      expect(result?.decision).toBe('deny');
      expect(result?.reason ?? '').toContain('`git reset`');
    });

    test('resolves each distinct directory at most once', async () => {
      const mock = mockDeps();
      expect(await gitFreezeGuard(subagent('cd /other && git switch a && git switch b'), mock.deps)).toBeUndefined();
      expect(mock.calls).toEqual([SHARED, '/other']);
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

  // Regression: PR #2722 review (CodeRabbit 3662114937, Codex 3661572682).
  // The masker read an *unquoted* `\"` as a quote opener, and the closing `\"`
  // was then swallowed by the double-quoted `\X` rule — so the phantom region
  // masked to end of string and everything after the message vanished. bash
  // runs the whole line; the guard only ever saw its head.
  describe('shell-escaped quotes do not hide the rest of the command', () => {
    const blocked = ['git commit -m \\"fix\\" && git checkout main', 'echo \\" ; git switch dev'];

    for (const cmd of blocked) {
      test(`denies: ${cmd}`, async () => {
        expect((await run(subagent(cmd)))?.decision).toBe('deny');
      });
    }

    test('but an escaped-quote message with nothing frozen after it still passes', async () => {
      expect(await run(subagent('git commit -m \\"fix\\" && git status'))).toBeUndefined();
    });
  });

  // Regression: PR #2726 review (CodeRabbit 3667949010). Escaping a character
  // is how a shell author says "this is not syntax", so an escaped `;`/`|`/`&`
  // is an argument, not a separator. The walk split on them anyway and denied
  // single commands: bash runs `echo \; git switch dev` as one `echo` that
  // prints `; git switch dev` — verified — and no git at all.
  describe('escaped structural characters are literals, not separators', () => {
    const allowed = [
      'echo \\; git switch dev',
      'echo \\| git switch dev',
      'echo \\& git switch dev',
      // One `git commit` whose arguments happen to read like a second command.
      'git commit -m x \\; git switch dev',
    ];

    for (const cmd of allowed) {
      test(`allows: ${cmd}`, async () => {
        expect(await run(subagent(cmd))).toBeUndefined();
      });
    }

    // The other direction: masking an escape must not hide real structure.
    test('an unescaped separator still denies', async () => {
      expect((await run(subagent('echo hi ; git switch dev')))?.decision).toBe('deny');
    });

    // An escaped backtick is not a command substitution, so it must not mask
    // the rest of the line the way a real one does — bash runs the tail.
    test('an escaped backtick does not swallow the command after it', async () => {
      expect((await run(subagent('echo \\` && git switch dev')))?.decision).toBe('deny');
    });

    // `\` + newline is a line continuation: bash removes both and runs one
    // command. Splitting on that newline used to hide the subcommand.
    test('a line continuation joins the statement rather than splitting it', async () => {
      expect((await run(subagent('git \\\n switch dev')))?.decision).toBe('deny');
    });
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

    test('allows a frozen call nested inside a substitution — the documented boundary', async () => {
      // The guard masks a substitution's interior instead of walking it, so a
      // frozen call in there is not seen. Pinned deliberately: see the module
      // header. The freeze targets the accidental `git switch dev`, and this is
      // not a form anyone reaches for by accident.
      expect(await run(subagent('$(cd /repo && git switch dev)'))).toBeUndefined();
      expect(await run(subagent('`git switch dev`'))).toBeUndefined();
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
