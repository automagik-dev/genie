/**
 * scripts/mikro/status.ts — the script's own verdict on a triage `status`.
 *
 * "Already fixed on the tree" is the one triage answer that is cheap to assert
 * and expensive to be wrong about: it closes an issue nobody re-reads. So the
 * model's `status.state` is never taken at its word. A `fixed-on-tree` verdict
 * survives ONLY IF
 *   (a) it names at least one `kind: 'commit'` evidence,
 *   (b) EVERY commit ref it names is an ancestor of HEAD in the analysed tree, and
 *   (c) at least one evidence carries `path` + `line` that passes the same check
 *       `verifyCitations` (call.ts) applies to every other citation in the answer.
 * Anything else — an unknown object, a shallow clone, a git that cannot answer, a
 * path that is not there — FAILS CLOSED: the state is rewritten to `unclear` and
 * the answer keeps the receipt in `status.downgraded`.
 *
 * This is a silent post-validation rewrite, the same family as `applyResolutions`,
 * and deliberately NEITHER a validation error NOR a retry: a retry costs money and
 * invites the model to fabricate a ref that passes.
 *
 * `fixed-by-open-pr` is not verified here — there is no `gh` inside the boundary —
 * so it passes through exactly as answered.
 */
import type { TriageState, TriageStatusRecord } from './schemas';
import { gitProbeEnv } from './trusted-source';

/** The two proofs the gate needs, injected so the rule itself stays pure and testable. */
export interface StatusGate {
  /** True only when git proves `ref` is a commit in HEAD's history in the analysed tree. */
  isAncestor: (ref: string) => boolean;
  /** The citation gate's own verdict on one `path:line` in the analysed tree. */
  citationOk: (path: string, line: number) => boolean;
}

/** Exit code 0 from one git read, or false — a git that cannot answer proves nothing. */
export type GitRun = (dir: string, args: string[]) => boolean;

/**
 * The ambient git environment is STRIPPED (`gitProbeEnv`): `GIT_DIR`, `GIT_WORK_TREE`
 * and their siblings make git answer for a repository other than the one `cwd` names,
 * and this probe's whole job is to prove a commit is in HEAD's history *in the analysed
 * tree*. An exported `GIT_DIR` would let an unrelated repository — or a git hook that
 * happened to launch this process — vouch for a sha the analysed tree has never seen.
 */
export const gitExitZero: GitRun = (dir, args) => {
  try {
    return (
      Bun.spawnSync(['git', '--no-pager', ...args], {
        cwd: dir,
        env: gitProbeEnv(),
        stdout: 'pipe',
        stderr: 'pipe',
      }).exitCode === 0
    );
  } catch {
    // no git on PATH, no repository: nothing here can prove an ancestor either.
    return false;
  }
};

/**
 * A hex object name only. `merge-base --is-ancestor` takes a REVISION, so a ref
 * like `--help` or `HEAD` would either reach git's option parser or prove itself
 * trivially; the prompt asks for a sha out of `git log`, and everything else fails
 * closed before a process is spawned.
 */
const COMMIT_REF = /^[0-9a-f]{7,40}$/i;

/** One ancestor probe per ref per run — the answer cannot change under us mid-run. */
export function makeAncestorCheck(dir: string, run: GitRun = gitExitZero): (ref: string) => boolean {
  const cache = new Map<string, boolean>();
  return (ref: string): boolean => {
    const key = ref.trim();
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const result = COMMIT_REF.test(key) && run(dir, ['merge-base', '--is-ancestor', key, 'HEAD']);
    cache.set(key, result);
    return result;
  };
}

type Evidence = TriageStatusRecord['evidence'][number];

const located = (e: Evidence): e is Evidence & { path: string; line: number } =>
  typeof e.path === 'string' && e.path.trim() !== '' && typeof e.line === 'number' && Number.isInteger(e.line);

/**
 * Why a `fixed-on-tree` verdict cannot stand — ONE line, recorded verbatim as
 * `status.downgraded.reason`. `null` means the verdict survives.
 */
export function refuteFixedOnTree(status: TriageStatusRecord, gate: StatusGate): string | null {
  const evidence = Array.isArray(status.evidence) ? status.evidence : [];
  const commits = evidence.filter((e) => e?.kind === 'commit' && typeof e.ref === 'string' && e.ref.trim() !== '');
  if (!commits.length) return 'no commit evidence: a fixed-on-tree verdict must name a commit this tree carries';
  const unproven = commits.find((e) => !gate.isAncestor(e.ref));
  if (unproven) return `commit ${unproven.ref} is not an ancestor of HEAD in the analysed tree`;
  const shown = evidence.filter(located);
  if (!shown.length) return 'no evidence names a path and line in the current tree that shows the fix';
  if (!shown.some((e) => gate.citationOk(e.path, e.line)))
    return `no evidence path:line is verifiable in the current tree (${shown
      .slice(0, 3)
      .map((e) => `${e.path}:${e.line}`)
      .join(', ')})`;
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The answer with an unproven `fixed-on-tree` rewritten to `unclear` + `downgraded`.
 * Every other state — and every answer with no `status` at all — is returned untouched.
 */
export function verifyStatus<T>(answer: T, gate: StatusGate): T {
  const status = isRecord(answer) ? answer.status : undefined;
  if (!isRecord(status) || status.state !== 'fixed-on-tree') return answer;
  const reason = refuteFixedOnTree(status as unknown as TriageStatusRecord, gate);
  if (!reason) return answer;
  return {
    ...(answer as Record<string, unknown>),
    status: { ...status, state: 'unclear', downgraded: { from: 'fixed-on-tree' as TriageState, reason } },
  } as T;
}

/** The additive ledger keys for one answer's verdict; `undefined` for an agent that has no status. */
export function statusLedgerRow(
  answer: unknown,
): { state: TriageState; downgraded?: { from: TriageState; reason: string } } | undefined {
  const status = isRecord(answer) ? answer.status : undefined;
  if (!isRecord(status) || typeof status.state !== 'string') return undefined;
  const downgraded = isRecord(status.downgraded)
    ? { from: status.downgraded.from as TriageState, reason: String(status.downgraded.reason) }
    : undefined;
  return { state: status.state as TriageState, downgraded };
}
