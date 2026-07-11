export interface CommandCheck {
  exists: boolean;
  version?: string;
  path?: string;
  timedOut?: boolean;
  error?: string;
}

export interface CommandProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface CommandCheckOptions {
  timeoutMs?: number;
  which?: (name: string) => string | null;
  run?: (path: string, args: string[], timeoutMs: number) => CommandProbeResult;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 3_000;

function defaultRun(path: string, args: string[], timeoutMs: number): CommandProbeResult {
  const result = Bun.spawnSync([path, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    timedOut: result.exitedDueToTimeout === true,
  };
}

function parseVersion(raw: string): string | undefined {
  const firstLine = raw.split('\n')[0]?.trim();
  if (!firstLine) return undefined;
  const versionMatch = firstLine.match(/(\d+\.[\d.]+[a-z0-9-]*)/i);
  return versionMatch ? versionMatch[1] : firstLine.slice(0, 50);
}

/** Resolve a command and bound every version probe with an explicit deadline. */
export async function checkCommand(cmd: string, options: CommandCheckOptions = {}): Promise<CommandCheck> {
  const path = (options.which ?? ((name: string) => Bun.which(name)))(cmd);
  if (!path) return { exists: false };

  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const run = options.run ?? defaultRun;
  for (const args of [['--version'], ['-v']]) {
    const result = run(path, args, timeoutMs);
    if (result.timedOut) {
      return {
        exists: true,
        path,
        timedOut: true,
        error: `${cmd} ${args[0]} timed out after ${timeoutMs}ms`,
      };
    }
    if (result.exitCode === 0) return { exists: true, path, version: parseVersion(result.stdout) };
  }
  return { exists: true, path, error: `${cmd} did not return a version from --version or -v` };
}
