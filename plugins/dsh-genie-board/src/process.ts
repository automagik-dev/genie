import { spawn } from 'node:child_process';
import { constants, accessSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const MAX_OUTPUT = 4 * 1024 * 1024;
export const DEADLINE_MS = 10_000;
export interface Budget {
  expires: number;
  bytes: number;
}
export function resolveExecutable(): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
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
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => fail(new Error('Genie deadline exceeded')), remaining);
    const read = (chunk: Buffer, stdout: boolean) => {
      budget.bytes += chunk.length;
      if (budget.bytes > MAX_OUTPUT) return fail(new Error('Genie output limit exceeded'));
      if (stdout) chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => read(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => read(chunk, false));
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Genie exited with code ${code}`));
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
