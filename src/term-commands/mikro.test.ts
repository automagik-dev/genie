/**
 * `genie mikro call` as a user invokes it: the command surface, its exit codes,
 * and the two failure modes that only exist once the runtime ships inside the
 * binary — a host with no `mikro` on PATH, and a bundle that must not execute
 * another module's entry block.
 *
 * Every case spawns the CLI rather than calling the handler, because the exit
 * code and the stream the message lands on are the contract here.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const ENTRY = join(ROOT, 'src', 'genie.ts');
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A GENIE_HOME whose `templates/mikro/agents` carries the agents a release ships. */
function shippedHome(agents: string[]): string {
  const home = tmp('genie-mikro-home-');
  for (const agent of agents) {
    const dir = join(home, 'templates', 'mikro', 'agents', agent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.yaml'), 'model: deepseek-api/deepseek-flash\nsystem: SYSTEM.md\n');
    writeFileSync(join(dir, 'SYSTEM.md'), '# shipped default\n');
  }
  return home;
}

function runCli(argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawnSync([process.execPath, ENTRY, ...argv], {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe('genie mikro call', () => {
  test('--help lists the runtime flags and the agent-source rule', () => {
    const { code, stdout } = runCli(['mikro', 'call', '--help']);
    expect(code).toBe(0);
    for (const flag of [
      '--prompt',
      '--prompt-file',
      '--dir',
      '--agents-dir',
      '--agents-ref',
      '--facts',
      '--boundary',
      '--raw',
    ]) {
      expect(stdout).toContain(flag);
    }
    expect(stdout).toContain('agentSource');
    // The help text is where an operator learns that the agent comes from a ref, not
    // from the tree under review — and what to pass to run with their own working tree.
    expect(stdout).toContain('trusted ref');
    expect(stdout).toContain('repo@<ref>');
  });

  test('an unregistered agent name exits 2 and names the registry, without running anything', () => {
    const { code, stderr, stdout } = runCli(['mikro', 'call', 'not-an-agent', '--prompt', 'x']);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown agent: not-an-agent');
    expect(stderr).toContain('wish-context');
    expect(stdout).toBe('');
  });

  test('a registered agent with no prompt is a usage error, not a billed run', () => {
    const { code, stderr } = runCli(['mikro', 'call', 'wish-context']);
    expect(code).toBe(2);
    expect(stderr).toContain('--prompt or --prompt-file is required');
  });

  /**
   * The tail is forwarded AS TYPED, with one exception this test exists to keep
   * honest: genie's own global options are consumed by the program wherever they
   * appear, including as the VALUE of a runtime flag. `enablePositionalOptions()`
   * on the `mikro` group shields the tail from the group's own options, not from
   * the program's, and moving it to the program would change how every other
   * command parses. Documented by this test rather than by folklore; the escape is
   * to prefix the value with a space (`--prompt " -V"`) or to use --prompt-file —
   * shell quoting alone does not change the argv token the program sees.
   */
  test("genie's three global options win anywhere in the tail, and run no agent", () => {
    for (const spelling of ['-V', '--version']) {
      const { code, stdout, stderr } = runCli(['mikro', 'call', 'wish-context', '--prompt', spelling]);
      expect(code).toBe(0);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/); // the version, not an answer
      expect(stdout).not.toContain('"agent"');
      expect(stderr).toBe('');
    }
    // A trailing --help is Commander's help, not the runtime's usage banner.
    const help = runCli(['mikro', 'call', 'wish-context', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: genie mikro call');
    // --no-interactive is consumed too, so it never reaches the runtime as a value:
    // the prompt is then missing and the runtime refuses rather than running blind.
    const interactive = runCli(['mikro', 'call', 'wish-context', '--prompt', '--no-interactive']);
    expect(interactive.code).toBe(2);
    expect(interactive.stderr).toContain('--prompt or --prompt-file is required');
    // The escape: prefixing the value with a space makes it ONE argv token that is no
    // longer a global option, and it is forwarded. Proven at zero cost — `--dir` carries
    // a `.mikro/TOOLS.md` the trusted ref does not, so the run is refused before any
    // runtime is spawned, and reaching that refusal is itself the proof that the prompt
    // was accepted rather than eaten.
    const other = tmp('genie-mikro-other-');
    mkdirSync(join(other, '.mikro'), { recursive: true });
    writeFileSync(join(other, '.mikro', 'TOOLS.md'), '## injected\n');
    const home = shippedHome(['wish-context']);
    const quoted = runCli(
      ['mikro', 'call', 'wish-context', '--prompt', ' -V', '--dir', other, '--no-phoenix', '--no-ledger'],
      { env: { GENIE_HOME: home } },
    );
    expect(quoted.code).toBe(1);
    expect(quoted.stdout).not.toMatch(/^\d+\.\d+\.\d+/);
    const answer = JSON.parse(quoted.stdout) as { ok: boolean; attempts: { errors: string[] }[] };
    expect(answer.ok).toBe(false);
    expect(answer.attempts[0].errors[0]).toStartWith('config:');
  });

  test('the group is exempt from the v4 workspace gate — any repository may run it', () => {
    // A directory with no `.genie/workspace.json` at all: before the exemption this
    // exited 2 with "No workspace found", in exactly the repositories the command exists for.
    const { stderr } = runCli(['mikro', 'call', 'not-an-agent', '--prompt', 'x'], { cwd: tmp('genie-mikro-cwd-') });
    expect(stderr).not.toContain('No workspace found');
  });

  test('with mikro absent from PATH the answer is ok:false JSON and the exit code is 1', () => {
    const repo = tmp('genie-mikro-repo-');
    Bun.spawnSync(['git', '-C', repo, 'init', '-q']);
    const home = shippedHome(['wish-context']);
    const emptyPath = tmp('genie-mikro-path-');
    const { code, stdout } = runCli(
      ['mikro', 'call', 'wish-context', '--dir', repo, '--prompt', 'Intent: x', '--no-phoenix', '--no-ledger'],
      { cwd: repo, env: { PATH: emptyPath, GENIE_HOME: home, HOME: home } },
    );
    expect(code).toBe(1);
    const answer = JSON.parse(stdout) as {
      ok: boolean;
      agentSource?: string;
      attempts: { errors: string[] }[];
    };
    expect(answer.ok).toBe(false);
    expect(answer.agentSource).toBe('shipped');
    // The classification is by the spawn error's CODE; the wording differs between
    // Bun ("Executable not found in $PATH") and Node ("spawn mikro ENOENT"), so the
    // assertion is on the vocabulary this repository owns.
    const errors = answer.attempts.flatMap((a) => a.errors);
    expect(errors.some((e) => e.startsWith('unavailable:'))).toBe(true);
    // A runtime that is not installed cannot appear between two attempts.
    expect(answer.attempts).toHaveLength(1);
    // Nothing was written into the shipped payload.
    expect(readdirSync(join(home, 'templates', 'mikro', 'agents', 'wish-context')).sort()).toEqual([
      'SYSTEM.md',
      'agent.yaml',
    ]);
    expect(existsSync(join(repo, '.mikro'))).toBe(false);
  });
});

describe('genie mikro bench', () => {
  test('--help lists the flags and says the bench reads the working tree', () => {
    const { code, stdout } = runCli(['mikro', 'bench', '--help']);
    expect(code).toBe(0);
    for (const flag of ['--dir', '--fixtures', '--agents-dir', '--reps', '--only', '--boundary', '--write-evidence']) {
      expect(stdout).toContain(flag);
    }
    expect(stdout).toContain('WORKING TREE');
    expect(stdout).toContain('a tree you trust');
  });

  test('the tail reaches the runtime: a repository with no fixture set is refused with exit 2', () => {
    const repo = tmp('genie-mikro-bench-');
    const { code, stderr, stdout } = runCli(['mikro', 'bench', 'wish-context', '--dir', repo, '--no-phoenix'], {
      cwd: repo,
    });
    expect(code).toBe(2);
    expect(stderr).toContain('no fixture set at');
    expect(stderr).toContain('genie mikro fixtures --from-commits');
    expect(stdout).toBe('');
    // Refused before anything ran: no ledger, no record, no `.mikro/` grown in the repository.
    expect(existsSync(join(repo, '.mikro'))).toBe(false);
  });
});

describe('the built bundle', () => {
  /** `dist/genie.js` when the build already ran, else a throwaway build of the same entry point. */
  function bundle(): string {
    const built = join(ROOT, 'dist', 'genie.js');
    if (existsSync(built)) return built;
    const out = join(tmp('genie-mikro-bundle-'), 'genie.js');
    const build = Bun.spawnSync(
      [process.execPath, 'build', ENTRY, '--target', 'bun', '--external', 'bun', '--outfile', out],
      { cwd: ROOT },
    );
    if (build.exitCode !== 0) throw new Error(`bundling failed: ${build.stderr.toString()}`);
    return out;
  }

  /**
   * `scripts/mikro/*` carry their own `import.meta.main` entry blocks. Inside the
   * bundle they are imported modules, so none of those blocks may fire — the symptom
   * would be one of their usage banners on a command that never asked for them.
   */
  test('no imported module runs its own entry block', () => {
    const js = bundle();
    const version = Bun.spawnSync([process.execPath, js, '--version'], { cwd: ROOT });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString().trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(version.stderr.toString()).toBe('');

    const call = Bun.spawnSync([process.execPath, js, 'mikro', 'call'], { cwd: ROOT });
    const stderr = call.stderr.toString();
    expect(stderr).toContain("missing required argument 'agent'");
    expect(stderr).not.toContain('usage: bun scripts/mikro/');
  });
});
