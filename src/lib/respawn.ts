/**
 * Re-spawn invocation resolver — produces the correct `{ command, args }` to
 * launch genie from inside an already-running genie process.
 *
 * Why this exists: in a Bun-compiled single-file standalone (the distribution
 * shape since the G1 cutover), `process.argv[1]` is a virtual path inside the
 * embedded bunfs (e.g. `/$bunfs/root/genie`) that has no host-filesystem
 * meaning. The legacy pattern of `spawn(process.execPath, [process.argv[1],
 * ...args])` therefore passes a bogus literal to the new process, and the
 * shell variant emitted to `tui-launch.sh` is even worse: `$bunfs` expands to
 * the empty string, so the launch script becomes
 *   exec /path/to/genie //root/genie
 * which makes genie treat `//root/genie` as its subcommand and exit silently
 * — the symptom users on the new installer report as "genie does nothing".
 *
 * Detection: a bunfs argv[1] always starts with `/$bunfs/`. When detected,
 * we re-spawn `process.execPath` alone — the compiled binary is self-hosting,
 * so no entry path is needed.
 *
 * In dev (`bun src/genie.ts`) and the older dist mode (`bun dist/genie.js`),
 * we keep the previous behavior: `bunPath argv[1] ...args`.
 */

const BUNFS_PREFIX = '/$bunfs/';

/** True when the current process is a Bun-compiled standalone binary. */
export function isCompiledBunStandalone(argv1: string | undefined = process.argv[1]): boolean {
  return typeof argv1 === 'string' && argv1.startsWith(BUNFS_PREFIX);
}

export interface RespawnDeps {
  execPath?: string;
  argv1?: string;
}

/**
 * Returns the spawn command + args to re-launch genie with the given
 * subcommand args. Use with `child_process.spawn` or anywhere structured
 * argv is expected.
 *
 * When `deps` is omitted, values come from `process.execPath` / `process.argv[1]`.
 * When `deps` is provided, its fields win — including explicit `undefined`,
 * which lets tests model the missing-argv1 edge case without leaking the
 * test runner's argv into the result.
 */
export function respawnInvocation(
  extraArgs: readonly string[] = [],
  deps?: RespawnDeps,
): { command: string; args: string[] } {
  const execPath = deps ? (deps.execPath ?? 'bun') : (process.execPath ?? 'bun');
  const argv1 = deps ? deps.argv1 : process.argv[1];

  if (isCompiledBunStandalone(argv1)) {
    return { command: execPath, args: [...extraArgs] };
  }

  if (!argv1 || argv1 === 'genie') {
    // Last-resort fallback: rely on PATH lookup of the `genie` shim. Matches
    // the pre-helper behavior in TUI components that defaulted to plain
    // `'genie'` when argv[1] was missing.
    return { command: 'genie', args: [...extraArgs] };
  }

  return { command: execPath, args: [argv1, ...extraArgs] };
}

/**
 * Returns a fully shell-escaped one-liner that re-launches genie. Use this
 * when generating shell scripts (e.g. `~/.genie/tui-launch.sh`) or systemd
 * unit `ExecStart=` lines, where structured argv is not available.
 */
export function respawnShellCommand(extraArgs: readonly string[] = [], deps?: RespawnDeps): string {
  const { command, args } = respawnInvocation(extraArgs, deps);
  return [command, ...args].map(shellEscape).join(' ');
}

/**
 * POSIX shell-escape: single-quote unless the value is a "safe" identifier.
 * Embedded single quotes are emitted as `'"'"'` which is the standard
 * portable trick that does not require shell-specific extensions.
 */
function shellEscape(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_\-./:@=+]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
