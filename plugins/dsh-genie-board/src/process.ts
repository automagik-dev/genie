import { spawn } from 'node:child_process';
import { constants, accessSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export const MAX_OUTPUT = 4 * 1024 * 1024;
export const DEADLINE_MS = 10_000;
/** How much of a failing command's stderr the Host keeps for its message. */
export const MAX_STDERR_KEPT = 8 * 1024;
/**
 * What a human sees when a command outruns {@link MAX_OUTPUT}. Genie bounds the
 * board aggregate below this budget itself (it degrades each card's embedded
 * history, and refuses an unfittable board with its own named `Error:` line), so
 * reaching this limit means the workspace is emitting more than this Host can
 * read — which is a board size problem, not an opaque overflow.
 */
export const OUTPUT_LIMIT_MESSAGE =
  'This board is too large for one response (over 4 MiB). Scope it to a wish, or split the board.';
export interface Budget {
  expires: number;
  bytes: number;
  /** Shared output ceiling for this request; {@link MAX_OUTPUT} when unset. */
  limit?: number;
}
/**
 * A Genie command that ran and refused: it exited non-zero on its own, so it
 * changed nothing. The Host distinguishes this from a killed or unstartable
 * child (deadline, output overflow, spawn error), whose effect is unknown.
 */
export class GenieCommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = 'GenieCommandError';
  }
}
/** Every directory the Host will look in, in order: PATH, then the installers'. */
function candidateDirectories(): string[] {
  const path = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const home = process.env.HOME ?? homedir();
  const fallbacks = [
    process.env.GENIE_HOME ? join(process.env.GENIE_HOME, 'bin') : undefined,
    home ? join(home, '.genie', 'bin') : undefined,
    home ? join(home, '.local', 'bin') : undefined,
  ].filter((directory): directory is string => directory !== undefined);
  return [...path, ...fallbacks];
}
/**
 * Resolve the one Genie executable this Host will run, once at startup. PATH
 * comes first; when DSH is launched from a desktop session that never sourced a
 * shell profile, PATH can miss the installer's directory, so the documented
 * install locations are tried next (P3). `/health` names the winner.
 */
export function resolveExecutable(): string {
  for (const directory of candidateDirectories()) {
    try {
      const path = realpathSync(join(directory, 'genie'));
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* Continue the one startup-only lookup. */
    }
  }
  throw new Error('Genie executable is unavailable');
}
export function hostEnvironment(identity: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1', GENIE_AGENT_NAME: identity, GENIE_AGENT_KIND: 'dsh' };
  for (const key of ['PATH', 'HOME', 'GENIE_HOME']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
/**
 * The message for a non-zero exit. Genie prints every typed refusal as a single
 * `Error: <reason>` line, so that line is the message a human needs; anything
 * else falls back to the last stderr line, and only a silent failure keeps the
 * bare exit code (F7).
 */
export function describeExit(stderr: string, code: number | null): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const detail = lines.find((line) => line.startsWith('Error:')) ?? lines.at(-1);
  return detail ? detail.slice(0, 500) : `Genie exited with code ${code}`;
}
export function execute(
  binary: string,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  budget: Budget,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const remaining = budget.expires - Date.now();
    if (remaining <= 0) return reject(new Error('Genie deadline exceeded'));
    const child = spawn(binary, ['--no-interactive', ...argv], {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    // Bounded stderr tail: it still counts against the shared byte budget, and
    // only the most recent MAX_STDERR_KEPT bytes are retained for the message.
    let errors = '';
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => fail(new Error('Genie deadline exceeded')), remaining);
    const read = (chunk: Buffer, stdout: boolean) => {
      budget.bytes += chunk.length;
      if (budget.bytes > (budget.limit ?? MAX_OUTPUT)) return fail(new Error(OUTPUT_LIMIT_MESSAGE));
      if (stdout) chunks.push(chunk);
      else errors = (errors + chunk.toString('utf8')).slice(-MAX_STDERR_KEPT);
    };
    child.stdout.on('data', (chunk: Buffer) => read(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => read(chunk, false));
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new GenieCommandError(describeExit(errors, code), code));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
export function compatible(actual: string, minimum: string): boolean {
  const parse = (value: string) =>
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  const a = parse(actual.trim());
  const b = parse(minimum);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) > BigInt(b[i]);
  }
  if (a[4] === b[4]) return true;
  if (!a[4]) return true;
  if (!b[4]) return false;
  const ap = a[4].split('.');
  const bp = b[4].split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === bp[i]) continue;
    if (ap[i] === undefined) return false;
    if (bp[i] === undefined) return true;
    const an = /^\d+$/.test(ap[i]);
    const bn = /^\d+$/.test(bp[i]);
    return an && bn ? BigInt(ap[i]) > BigInt(bp[i]) : an !== bn ? !an : ap[i] > bp[i];
  }
  return true;
}
