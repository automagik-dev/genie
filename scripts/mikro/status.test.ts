import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyCitations } from './call';
import { IssueTriage } from './schemas';
import { type StatusGate, makeAncestorCheck, statusLedgerRow, verifyStatus } from './status';

/**
 * Real git repositories, never mocks: the whole point of the gate is that git —
 * not the model, and not a stub — decides whether a commit is on this tree.
 */
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir });
  return p.stdout.toString().trim();
}

/** A repo whose HEAD carries `src/fix.ts` (4 lines), plus one commit on a side branch. */
function repo(): { dir: string; head: string; side: string; gate: StatusGate } {
  const dir = mkdtempSync(join(tmpdir(), 'mikro-status-'));
  roots.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'fix.ts'), 'a\nb\nc\nd\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'the fix');
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(dir, 'src', 'other.ts'), 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'not on main');
  const side = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  return {
    dir,
    head,
    side,
    gate: {
      isAncestor: makeAncestorCheck(dir),
      // The SAME check the citation gate applies to every other citation in the answer.
      citationOk: (path, line) =>
        verifyCitations({ cite: `${path}:${line}` }, dir).some((c) => c.ok && c.line === line),
    },
  };
}

const answer = (state: string, evidence: unknown[]) => ({ issue: 1, status: { state, evidence } });
const stateOf = (value: unknown) => (value as { status: { state: string; downgraded?: { reason: string } } }).status;

describe('the fixed-on-tree gate', () => {
  test('an ancestor commit plus a path:line that verifies survives untouched', () => {
    const { head, gate } = repo();
    const input = answer('fixed-on-tree', [{ kind: 'commit', ref: head, path: 'src/fix.ts', line: 3 }]);
    const out = verifyStatus(input, gate);
    expect(stateOf(out).state).toBe('fixed-on-tree');
    expect(stateOf(out).downgraded).toBeUndefined();
    expect(out).toBe(input); // a surviving verdict is not even re-allocated
  });

  test('a short ref works, and the answer may cite the fix from a second evidence row', () => {
    const { head, gate } = repo();
    const out = verifyStatus(
      answer('fixed-on-tree', [
        { kind: 'commit', ref: head.slice(0, 9) },
        { kind: 'pr', ref: '#2921', path: 'src/fix.ts', line: 1 },
      ]),
      gate,
    );
    expect(stateOf(out).state).toBe('fixed-on-tree');
  });

  test('a commit that exists but is NOT an ancestor of HEAD is downgraded', () => {
    const { side, gate } = repo();
    const out = verifyStatus(
      answer('fixed-on-tree', [{ kind: 'commit', ref: side, path: 'src/fix.ts', line: 1 }]),
      gate,
    );
    expect(stateOf(out).state).toBe('unclear');
    expect(stateOf(out).downgraded).toEqual({
      from: 'fixed-on-tree',
      reason: `commit ${side} is not an ancestor of HEAD in the analysed tree`,
    });
  });

  test('every commit must be an ancestor: one good ref does not carry a bad one', () => {
    const { head, side, gate } = repo();
    const out = verifyStatus(
      answer('fixed-on-tree', [
        { kind: 'commit', ref: head, path: 'src/fix.ts', line: 1 },
        { kind: 'commit', ref: side },
      ]),
      gate,
    );
    expect(stateOf(out).state).toBe('unclear');
    expect(stateOf(out).downgraded?.reason).toContain(side);
  });

  test('a sha this tree has never seen is downgraded', () => {
    const { gate } = repo();
    const invented = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const out = verifyStatus(
      answer('fixed-on-tree', [{ kind: 'commit', ref: invented, path: 'src/fix.ts', line: 1 }]),
      gate,
    );
    expect(stateOf(out).state).toBe('unclear');
    expect(stateOf(out).downgraded?.reason).toContain('not an ancestor of HEAD');
  });

  test('a ref that is not an object name at all never reaches git', () => {
    const { gate } = repo();
    for (const ref of ['HEAD', '--help', 'v1.2.3', 'the commit that fixed it']) {
      const out = verifyStatus(answer('fixed-on-tree', [{ kind: 'commit', ref, path: 'src/fix.ts', line: 1 }]), gate);
      expect(stateOf(out).state).toBe('unclear');
    }
  });

  test('no commit evidence is downgraded even when a real path:line is cited', () => {
    const { gate } = repo();
    const out = verifyStatus(
      answer('fixed-on-tree', [{ kind: 'pr', ref: '#2921', path: 'src/fix.ts', line: 2 }]),
      gate,
    );
    expect(stateOf(out).state).toBe('unclear');
    expect(stateOf(out).downgraded?.reason).toContain('must name a commit this tree carries');
  });

  test('a commit with no path:line anywhere is downgraded', () => {
    const { head, gate } = repo();
    const out = verifyStatus(answer('fixed-on-tree', [{ kind: 'commit', ref: head }]), gate);
    expect(stateOf(out).state).toBe('unclear');
    expect(stateOf(out).downgraded?.reason).toContain('names a path and line');
  });

  test('a path:line past end of file is downgraded — the citation gate decides, not the model', () => {
    const { head, gate } = repo();
    const out = verifyStatus(
      answer('fixed-on-tree', [{ kind: 'commit', ref: head, path: 'src/fix.ts', line: 900 }]),
      gate,
    );
    expect(stateOf(out).state).toBe('unclear');
    expect(stateOf(out).downgraded?.reason).toContain('src/fix.ts:900');
  });

  test('a path that is not in the tree is downgraded', () => {
    const { head, gate } = repo();
    const out = verifyStatus(
      answer('fixed-on-tree', [{ kind: 'commit', ref: head, path: 'src/never.ts', line: 1 }]),
      gate,
    );
    expect(stateOf(out).state).toBe('unclear');
    expect(stateOf(out).downgraded?.reason).toContain('src/never.ts:1');
  });

  test('a dir that is not a git checkout proves nothing: fails closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mikro-status-bare-'));
    roots.push(dir);
    writeFileSync(join(dir, 'fix.ts'), 'a\n');
    const gate: StatusGate = {
      isAncestor: makeAncestorCheck(dir),
      citationOk: (path, line) =>
        verifyCitations({ cite: `${path}:${line}` }, dir).some((c) => c.ok && c.line === line),
    };
    const out = verifyStatus(
      answer('fixed-on-tree', [{ kind: 'commit', ref: 'abcdef1234567', path: 'fix.ts', line: 1 }]),
      gate,
    );
    expect(stateOf(out).state).toBe('unclear');
  });
});

describe('everything else passes through', () => {
  test('real, unclear and fixed-by-open-pr are never rewritten', () => {
    const { side, gate } = repo();
    for (const state of ['real', 'unclear', 'fixed-by-open-pr']) {
      // Deliberately unprovable evidence: only `fixed-on-tree` is the script's business.
      const input = answer(state, [{ kind: 'commit', ref: side }]);
      const out = verifyStatus(input, gate);
      expect(out).toBe(input);
      expect(stateOf(out).state).toBe(state);
    }
  });

  test('an answer with no status at all is returned as it came', () => {
    const { gate } = repo();
    const input = { issue: 1, title: 't' };
    expect(verifyStatus(input, gate)).toBe(input);
    expect(statusLedgerRow(input)).toBeUndefined();
  });
});

describe('the schema', () => {
  const minimal = {
    issue: 1,
    title: 't',
    type: 'bug',
    area: ['a'],
    summary: 's',
    repro: { present: false },
    candidate_files: [{ path: 'src/x.ts', why: 'w' }],
    lane: 'patch',
    first_question: null,
  };

  test('an answer that omits status parses to the unclear default', () => {
    const parsed = IssueTriage.safeParse(minimal);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.status).toEqual({ state: 'unclear', evidence: [] });
  });

  test('a status the agent answered is kept, and an unknown state is a schema failure', () => {
    const ok = IssueTriage.safeParse({
      ...minimal,
      status: { state: 'fixed-on-tree', evidence: [{ kind: 'commit', ref: 'abc1234', path: 'src/x.ts', line: 2 }] },
    });
    expect(ok.success && ok.data.status.state).toBe('fixed-on-tree');
    expect(IssueTriage.safeParse({ ...minimal, status: { state: 'shipped' } }).success).toBe(false);
  });
});

describe('the ledger row', () => {
  test('carries the final state and the downgrade receipt when there is one', () => {
    const { side, gate } = repo();
    const out = verifyStatus(answer('fixed-on-tree', [{ kind: 'commit', ref: side }]), gate);
    expect(statusLedgerRow(out)).toEqual({
      state: 'unclear',
      downgraded: { from: 'fixed-on-tree', reason: `commit ${side} is not an ancestor of HEAD in the analysed tree` },
    });
    expect(statusLedgerRow(answer('real', []))).toEqual({ state: 'real', downgraded: undefined });
  });
});
