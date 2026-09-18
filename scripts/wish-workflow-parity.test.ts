import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Single-source guard: the wish delivery workflow lives only in .claude/workflows/wish.js.
// The wish skill is a front door that runs that workflow and must not carry a roster of its own,
// while the enums and clauses it relays must equal the script's, normalized, not merely contained.

const ROOT = join(import.meta.dir, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();

const script = read('.claude/workflows/wish.js');
const skill = read('skills/wish/SKILL.md');

function scriptArray(name: string): string[] {
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(script);
  if (!match) throw new Error(`wish.js: ${name} not found`);
  return [...match[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
}

function scriptPhases(): string[] {
  return [...script.matchAll(/^\s*phase\('([A-Za-z-]+)'\)/gm)].map((m) => m[1]);
}

function metaPhases(): string[] {
  const block = /phases: \[([\s\S]*?)\n {2}\],/.exec(script);
  if (!block) throw new Error('wish.js: meta.phases not found');
  return [...block[1].matchAll(/title: '([A-Za-z-]+)'/g)].map((m) => m[1]);
}

describe('wish skill fronts the wish workflow', () => {
  test('meta.name is wish, the phases the script runs are the phases meta declares', () => {
    expect(/name: 'wish',/.test(script)).toBe(true);
    expect(scriptPhases()).toEqual(metaPhases());
    expect(metaPhases()).toEqual(['Admit', 'Work', 'Gate', 'Review', 'Repair', 'Publish', 'Read-back', 'Render']);
  });

  test('the skill points at the workflow, names no client tool, and carries no roster', () => {
    expect(skill).toContain('.claude/workflows/wish.js');
    expect(skill).toContain('saved name `wish`');
    expect(skill).not.toMatch(/Claude Code|Workflow tool/);
    expect(/^\d+\. \*\*[A-Za-z]+\*\*/m.test(skill)).toBe(false);
  });

  test('every state and every route the script returns is defined in the skill, by equal enums', () => {
    const states = scriptArray('STATES');
    const routes = scriptArray('ROUTES');
    expect(states).toEqual(['merge-ready', 'pr-open', 'refused', 'blocked', 'missed']);
    expect(routes).toEqual(['proceed', 'report', 'brainstorm', 'plan']);
    const relay = skill.slice(skill.indexOf('## Relay'), skill.indexOf('## Contracts it inherits'));
    const defined = [...relay.matchAll(/^- `([a-z-]+)` — /gm)].map((m) => m[1]);
    expect(defined).toEqual(states);
    const admission = skill.slice(skill.indexOf('## Admission'), skill.indexOf('## Relay'));
    for (const route of routes) expect(admission).toContain(`\`${route}\``);
  });

  test('the size band the skill states equals the script constants', () => {
    const constant = (name: string): number => {
      const match = new RegExp(`const ${name} = (\\d+)`).exec(script);
      if (!match) throw new Error(`wish.js: ${name} not found`);
      return Number(match[1]);
    };
    const band = `maximum ${constant('MAX_FILES')} files and ${constant('MAX_INSERTIONS').toLocaleString('en-US')} insertions, the hard maxima; ${constant('MAX_UNITS')} units, advisory; ideal ${constant('IDEAL_FILES')}, ${constant('IDEAL_INSERTIONS')}, ${constant('IDEAL_UNITS')}`;
    expect(normalize(skill)).toContain(band);
    expect(normalize(skill)).toContain(
      `\`repairBudget\` defaults to ${constant('DEFAULT_REPAIR_BUDGET')} and is capped at ${constant('MAX_REPAIR_BUDGET')}`,
    );
  });

  test('the by-hand section lists the same stages in the same order', () => {
    const byHand = normalize(skill.slice(skill.indexOf('## Without a workflow surface')));
    const order = [
      'read-only scout',
      'blind judge',
      'one executor',
      'mechanical gate',
      'reviewer that is not the executor',
      'repair rounds',
      'one publisher',
    ];
    const positions = order.map((phrase) => byHand.indexOf(phrase));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('the three inherited clauses are verbatim in the source skill, the front door and the script', () => {
    const pins: Array<[string, string, RegExp]> = [
      [
        'skills/review/SKILL.md',
        'The reviewer is different from the author and remains read-only.',
        /NOT the agent that wrote this code/,
      ],
      ['skills/fix/SKILL.md', 'default 2 when the key is unset', /const DEFAULT_REPAIR_BUDGET = 2\b/],
      [
        'skills/work/SKILL.md',
        'a worker notification is not delivery evidence by itself.',
        /never an inferred green|checks: 'pending'|'pending'/,
      ],
    ];
    for (const [source, clause, mechanism] of pins) {
      expect(normalize(read(source))).toContain(clause);
      expect(normalize(skill)).toContain(clause);
      expect(mechanism.test(script)).toBe(true);
    }
  });

  test('the script pins no model, reads no clock, and keeps the denylist the skill describes', () => {
    expect(script).not.toMatch(/model: 'opus'|DEFAULT_MODEL/);
    expect(script).not.toMatch(/Date\.now|Math\.random/);
    for (const path of ['.github/', '.husky/', '.claude/hooks/', 'scripts/release-*', 'delivery-evidence-verify.ts']) {
      expect(script).toContain(`'${path}'`);
    }
  });

  test('quick is a one-line deprecation stub pointing at wish, and nothing pins the hour contract', () => {
    const quick = read('skills/quick/SKILL.md');
    const body = quick.slice(quick.indexOf('---', 4) + 3).trim();
    expect(body).toBe(
      'Retired: `quick` is superseded by `wish` (one task delivered); this stub is removed after three measured runs.',
    );
    for (const rel of [
      'skills/quick/SKILL.md',
      'skills/quick/agents/openai.yaml',
      'skills/genie/SKILL.md',
      'skills/genie/reference/lifecycle.md',
      'skills/README.md',
    ]) {
      expect(read(rel)).not.toMatch(/60 minutes|within one hour/);
    }
  });
});

describe('wish.js guards that must not drift', () => {
  const fenceOf = (source: string): string => {
    const match = /const INJECTION_FENCE = `([^`]*)`/.exec(source);
    if (!match) throw new Error('INJECTION_FENCE not found');
    return match[1];
  };
  const requiredList = (name: string): string => {
    const match = new RegExp(`const ${name} = obj\\((\\[[^\\]]*\\])`).exec(script);
    if (!match) throw new Error(`wish.js: ${name} not found`);
    return match[1];
  };

  test('the gate command and the failing-checks read-back mismatch stay pinned', () => {
    expect(script).toContain("const CHECK_COMMAND = 'bun run check'\n");
    expect(script).toContain(
      "if (checks === 'fail') mismatches.push(`the remote checks failed: ${pr.failingChecks.join(', ') || 'no check name was returned'}`)",
    );
  });

  test('exactly nine model spreads, no model literal, and no required/advisory check split', () => {
    expect(script.split('...(MODEL ? { model: MODEL } : {})').length - 1).toBe(9);
    expect(script).not.toMatch(/model: ['"`]/);
    expect(script).not.toContain('--required');
  });

  test('the gate and scout required lists are unchanged', () => {
    expect(requiredList('GATE_SCHEMA')).toBe("['hooksLive', 'exitCode', 'pass', 'problems', 'summaryLine']");
    expect(requiredList('SCOUT_SCHEMA')).toBe("['facts', 'plan', 'estimate', 'injectionAttempts']");
  });

  test('the injection fence equals the research-sweep copy', () => {
    expect(fenceOf(script)).toBe(fenceOf(read('.claude/workflows/research-sweep.js')));
  });

  test('the skill keeps checks pass in merge-ready and does not grow past 95 lines', () => {
    const mergeReady = skill.split('\n').find((line) => line.startsWith('- `merge-ready` — '));
    expect(mergeReady).toContain('checks pass');
    expect(skill.replace(/\n$/, '').split('\n').length).toBeLessThanOrEqual(95);
  });
});

describe('git-safety hook guards the surfaces the wish publisher is forbidden', () => {
  const hook = join(ROOT, '.claude', 'hooks', 'git-safety.sh');
  const probe = (command: string): number => {
    const result = spawnSync('bash', [hook], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' });
    return result.status ?? -1;
  };

  test('blocks merge, API mutations, hook bypasses and direct refspecs to protected branches', () => {
    for (const command of [
      'gh pr merge 1 --squash',
      'gh api -X PUT repos/o/r/pulls/1/merge',
      'gh api --method POST repos/o/r/merges',
      'gh api -X PATCH repos/o/r/git/refs/heads/dev -f sha=abc',
      'HUSKY=0 git push origin wish/x',
      'git -c core.hooksPath=/dev/null push origin wish/x',
      'git config core.hooksPath /dev/null',
      'git push origin wish/x:main',
      'git push --force origin wish/x',
      'git commit --no-verify -m x',
    ]) {
      expect([command, probe(command)]).toEqual([command, 2]);
    }
  });

  /**
   * Every spelling of the same act, because a guard that refuses one spelling and admits another
   * only teaches the next agent which spelling to use. Each of these walked through the guard when
   * PR #2935 was reviewed.
   */
  test('blocks the spellings that used to walk through: flags first, quoted tokens, implicit POST', () => {
    for (const command of [
      'gh  pr   merge 1',
      // A flag before the subcommand is how an agent writes it from outside the repo.
      'gh -R automagik-dev/genie pr merge 1 --squash',
      'gh --repo automagik-dev/genie pr merge 1',
      'gh pr "merge" 1',
      'gh api -XPUT repos/o/r/pulls/1/merge',
      'gh api --method=PUT repos/o/r/pulls/1/merge',
      // A field flag makes gh POST with no -X at all; these merge a branch.
      'gh api repos/o/r/merges -f base=dev -f head=wish/x',
      'gh api repos/o/r/merge-upstream -f branch=main',
      'gh api --method PATCH "repos/o/r/git/refs/heads/main" -f sha=abc',
      'gh api graphql -f query=mutation-mergePullRequest',
      'HUSKY=false git push origin wish/x',
      // git config keys are case-insensitive, and quoting one changes nothing.
      'git -c core.hookspath=/dev/null push origin wish/x',
      'git -c "core.hooksPath=/dev/null" commit -m x',
      'git config "core.hooksPath" /dev/null',
      // An empty value disables the hooks exactly as a wrong path does.
      "git config core.hooksPath ''",
      'git config --unset core.hooksPath',
      'git config --unset-all core.hooksPath',
      // Dashless subcommands work on git 2.50+.
      'git config unset core.hooksPath',
      'git push origin HEAD:refs/heads/main',
      'git push origin +main',
      'git push origin refs/heads/master',
      // `git -C <worktree>` is how the executor drives the worktree it cut.
      'git -C /tmp/wt push --force origin wish/x',
      // Combined short flags are one flag.
      'git push -uf origin wish/x',
      'git commit -n -m x',
      // A quoted command handed to a shell IS the command, whatever the shell is called.
      'bash -c "gh pr merge 1 --squash"',
      '/bin/sh -c "gh pr merge 1"',
      "node -e \"require('child_process').execSync('gh pr merge 1')\"",
      'echo "$(gh pr merge 1 --squash)"',
    ]) {
      expect([command, probe(command)]).toEqual([command, 2]);
    }
  });

  /**
   * What this guard is NOT. It matches text, so a determined spelling always gets past it — a bare
   * `git push origin main`, a branch in a variable, `--all`, `--mirror`, a name split across quotes.
   * Those are the pre-push hook's job: it receives the refs a push updates instead of parsing a
   * command line, and refuses main/master for every spelling. The rules above earn their place by
   * keeping THAT hook alive. This test records the boundary so nobody mistakes one for the other.
   */
  /**
   * The text transforms are themselves an attack surface: a second adversarial pass broke the
   * guard through the two the first pass asked for. A redirect that carries its own target ate the
   * next argument; the read-only exemption admitted tools that execute; a blanked message value
   * still ran its command substitution; and joining lines with a space put a following `grep -n`
   * inside the commit's own segment.
   */
  test('blocks what the redirect, exemption and message transforms let through', () => {
    for (const command of [
      'git commit >&2 --no-verify -m x',
      'git push origin >&2 --force dev',
      'gh pr 2>&1 merge 1',
      'awk \'BEGIN{system("gh pr merge 1")}\'',
      'grep -rn "$(gh pr merge 1)" .',
      'cat "$(gh pr merge 1)"',
      'git commit -m "$(gh pr merge 1)"',
      'gh pr create --body "$(gh pr merge 1)"',
      // Every pinned case above carries ONE substitution, which is how a greedy collapse hid a
      // merge behind a second one: these are those same commands with ` $(date)` appended.
      'git commit -m "$(gh pr merge 1) at $(date)"',
      'gh pr create --body "$(gh pr merge 1) $(date)"',
      'git commit -m "$(gh pr merge $(echo 1))"',
      'git commit -m "`gh pr merge 1` at $(date)"',
      'git commit -m "$(echo a) $(echo b) $(gh pr merge 1) $(echo c)"',
      'export GIT_CONFIG_KEY_0="core.hooksPath"; export GIT_CONFIG_VALUE_0=/tmp/x; git commit -m x',
      // The plumbing twin of push: the pre-push hook never sees it.
      'git send-pack origin main:refs/heads/main',
      // core.hooksPath lives in .git/config; editing the file is the same act as `git config`.
      "sed -i '' 's|.*|hooksPath|' .git/config",
      'perl -i -pe s/hooksPath/x/ .git/config',
      // Redirects the first pass missed: &> and < also separate the tokens a rule needs adjacent.
      'gh pr &> /tmp/x merge 1',
      'gh pr < /dev/null merge 1',
      'git push origin &> /tmp/x --force dev',
      // A redirect target that is itself a substitution is run, so it is never stripped.
      'cat >$(gh pr merge 1)',
      // `send-pack` pushes without the pre-push hook ever seeing the refs.
      'git send-pack origin main',
      'git send-pack --all origin',
      // Inside DOUBLE quotes a backtick is substitution: the shell would run this one.
      'gh pr create --base dev --body "never runs `gh pr merge`"',
    ]) {
      expect([command, probe(command)]).toEqual([command, 2]);
    }
  });

  test('a newline is a separator, so the next line is not judged as the previous command', () => {
    for (const command of [
      'git commit -m "feat: x"\ngrep -n TODO src/app.ts',
      'git add -A\ngit commit -m "feat: x"\nhead -n 20 /tmp/out',
      'git push origin wish/x\nrm -f /tmp/push.log',
      "git commit -m $'fix: keep --no-verify refused'",
      'gh issue list --search "pr merge"',
      'git commit -m "feat: costs $5 more"',
      // Single quotes are inert to the shell, so a backticked rule in a body is prose — which is
      // what this repository's contract text, and the publisher quoting it, actually look like.
      "gh pr create --base dev --title t --body 'never runs `gh pr merge`'",
      'git commit -m "fix: $VAR handling of --no-verify"',
      // Prose about the file, and a copy OUT of it, are not writes to it.
      'gh pr create --base dev --body "never write .git/config with tee"',
      'cp .git/config /tmp/config.backup',
      // The -i veto is aimed at sed/perl, not at grep's case-insensitive flag.
      "grep -i 'gh pr merge' skills/wish/SKILL.md",
      // A substitution computing a title or a head does not make a single-quoted body executable —
      // this is the publisher's own shape, a frozen contract quoting the rule it obeys.
      'gh pr create --base dev --title t --body \'never runs gh pr merge\' --head "$(git rev-parse --abbrev-ref HEAD)"',
      'git commit -m "docs: never run gh pr merge" && echo "$(date)"',
      // Mixed value: the substitution stays visible, the prose around it stops being judged.
      'git commit -m "chore: bump to $(cat VERSION), still no --no-verify"',
      // An escaped backtick is literal — that is how a code span is written inside double quotes.
      'gh pr create --base dev --title t --body "never runs \\`gh pr merge\\`"',
      "grep -rn '`gh pr merge`' skills/",
      'git commit -m "gh pr merge costs $"',
      'gh api repos/o/r/pulls/1/comments -f body="see $(date): never run gh pr merge"',
      'gh api repos/o/r/pulls/1/comments -f body="never run gh pr merge, costs $"',
      'git commit -m "docs: \\`gh pr merge\\` is banned, built $(date)"',
    ]) {
      expect([command, probe(command)]).toEqual([command, 0]);
    }
  });

  test('does not pretend to catch what only the pre-push hook can see', () => {
    for (const command of [
      'git push origin main',
      'git push origin "$BRANCH"',
      'git push --all origin',
      'git push --mirror origin',
    ]) {
      expect([command, probe(command)]).toEqual([command, 0]);
    }
  });

  /**
   * A forbidden form quoted as DATA is text, not an act. Refusing these blocked read-only searches,
   * a commit message that explained the rule, and the publisher's own PR body — which quotes the
   * contract it is obeying.
   */
  test('allows a command that only mentions a forbidden form inside quotes', () => {
    for (const command of [
      "grep -rn 'gh pr merge' skills/",
      'bash -c "grep -rn \'gh pr merge\' skills/"',
      'git commit -m "docs: explain why gh pr merge stays blocked"',
      "gh pr create --base dev --title t --body 'the workflow never runs gh pr merge'",
      'git commit -m "fix: restore --force on the temp worktree cleanup"',
      // A review-thread reply whose body quotes an endpoint is still a reply.
      "gh api repos/o/r/pulls/1/comments -f body='see POST /repos/o/r/merges'",
      'git config --get core.hooksPath && echo ok',
      'git config --get core.hooksPath 2>/dev/null',
      // The unset names another key entirely.
      'git config --get core.hooksPath && git config --unset user.signingkey',
      // Another program's -f on the same line is not a force push.
      'git push origin wish/x && rm -f /tmp/push.log',
      'grep -f /tmp/pats.txt notes.txt && git push origin wish/x',
      // Reading a protected ref is not pushing at it.
      'git show-ref refs/heads/main && git push origin wish/x',
      'git fetch origin main && git push origin wish/x',
      'git push origin mainline',
      'git push origin feature/main-menu',
    ]) {
      expect([command, probe(command)]).toEqual([command, 0]);
    }
  });

  test('allows the publisher allowlist and the read-only hooksPath query', () => {
    for (const command of [
      'git push -u origin wish/x',
      'gh pr create --base dev --head wish/x --title t --body b',
      'gh pr view 1 --json baseRefName,headRefOid,files',
      'gh pr checks 1',
      'gh pr list --head wish/x --json number',
      'git config --get core.hooksPath',
      'git rev-parse --git-path hooks',
      'git ls-remote origin wish/x',
      'gh api -X POST repos/o/r/pulls/1/comments/1/replies -f body=x',
      'git push --force-with-lease origin wish/x',
      'gh api repos/o/r/pulls/1',
      'git push origin HEAD:dev',
    ]) {
      expect([command, probe(command)]).toEqual([command, 0]);
    }
  });
});
