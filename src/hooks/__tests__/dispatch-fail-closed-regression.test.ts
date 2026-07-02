/**
 * Permanent regression gate: hook dispatch must NEVER fall open on its default
 * path.
 *
 * Background (wish dispatch-inproc-default, Group 1): hook dispatch used to have
 * a daemon-client indirection whose default path silently ALLOWED `git push
 * origin main` — the merge-law guard only fired on an opt-in in-process flag.
 * Group 1 made in-process the only path and re-armed the guard. This test locks
 * that shut so no future refactor can reintroduce a fall-open default.
 *
 * Why a subprocess and not `dispatch()` directly: the fall-open bug lived in the
 * ENTRY wiring (which dispatcher the CLI selects, how empty stdout is handled),
 * not in `dispatch()` itself. A unit test that calls `dispatch()` would keep
 * passing even if someone rewired `genie hook dispatch` to a permissive path.
 * So we drive the SHIPPED `dist/genie.js` exactly as Claude Code does: spawn
 * `genie hook dispatch`, feed a PreToolUse payload on stdin, read the decision
 * from stdout. No env flags — this is the bare default path.
 *
 * `beforeAll` rebuilds the bundle so the gate always reflects current source
 * (the build is ~50ms), mirroring the V5_E2E_BUILD contract in
 * tests/e2e/v5-lifecycle.sh.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const DIST = join(REPO_ROOT, 'dist', 'genie.js');

/**
 * Drive the built CLI's real hook-dispatch entry point as a subprocess and
 * return its stdout. No GENIE_* flags are set — this is the default path CC
 * uses, so a fall-open default would show up here as an empty (allow) decision.
 */
async function driveDispatch(payload: unknown): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['bun', DIST, 'hook', 'dispatch'], {
    cwd: REPO_ROOT,
    stdin: Buffer.from(JSON.stringify(payload)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('hook dispatch default path — fail-closed regression gate', () => {
  beforeAll(async () => {
    // Always rebuild so the gate tests current source, never a stale bundle.
    const build = Bun.spawn(['bun', 'run', 'build'], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
    const code = await build.exited;
    if (code !== 0) {
      const err = await new Response(build.stderr).text();
      throw new Error(`build failed (exit ${code}): ${err}`);
    }
    if (!existsSync(DIST)) throw new Error(`build did not produce ${DIST}`);
  });

  test('git push to main is DENIED with the merge-law reason on the default path', async () => {
    // Assemble the forbidden command from parts so no literal `git push … main`
    // sits in this file (repo's git-safety.sh PreToolUse hook blocks that
    // string in Bash calls; the payload here is data, but we keep the file
    // scannable-clean regardless).
    const forbidden = ['git', 'push', 'origin', 'main'].join(' ');
    const { stdout, stderr, exitCode } = await driveDispatch({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: forbidden },
    });

    expect(exitCode).toBe(0);
    // The exact envelope CC reads to block the tool call.
    expect(stdout).toContain('"permissionDecision":"deny"');
    // The merge-law reason (branch-guard SYNC_DENY_PATTERNS, push-to-main).
    expect(stdout).toContain('Push to main/master is FORBIDDEN');
    // Guard against a silent crash masquerading as a deny.
    expect(stderr).not.toContain('dispatch threw');
  });

  test('a benign command is NOT denied on the default path', async () => {
    const { stdout, exitCode } = await driveDispatch({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    expect(exitCode).toBe(0);
    // No handler matches `ls` → empty stdout → CC allows. Must carry no deny.
    expect(stdout).not.toContain('deny');
    expect(stdout.trim()).toBe('');
  });
});
