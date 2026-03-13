/**
 * Team shortcut routing: resolves `genie [team]` -> `genie _open [team]`
 *
 * UX: `genie` derives window name from cwd, `genie <name>` opens that team.
 * Internally dispatches to hidden `_open` command.
 *
 * Priority:
 * 1. --team flag always routes to _open (for disambiguation)
 * 2. Known subcommands take priority over team names
 * 3. No args -> open session (window name derived from cwd at runtime)
 * 4. Unknown first arg treated as team name (catch-all)
 */

interface ShortcutResult {
  /** The (potentially rewritten) CLI args (without argv[0] and argv[1]) */
  args: string[];
  /** Whether the args were rewritten (team shortcut) */
  isShortcut: boolean;
  /** Warning message if first arg collides with a known subcommand */
  collisionWarning: string | null;
}

/**
 * Resolve team shortcut from raw CLI args.
 *
 * @param rawArgs - process.argv.slice(2) (everything after `node genie`)
 * @param knownCommands - Set of registered subcommand names (+ aliases)
 * @param teamExists - Optional callback to check if a team directory exists (for collision warnings)
 */
export function resolveTeamShortcut(
  rawArgs: string[],
  knownCommands: Set<string>,
  teamExists?: (name: string) => boolean,
): ShortcutResult {
  const firstArg = rawArgs[0];

  // No args -> open session (window name derived from cwd by sessionCommand)
  if (!firstArg) {
    return { args: ['_open'], isShortcut: true, collisionWarning: null };
  }

  // 1. Global --team flag: genie --team <name> [...rest] -> genie _open <name> [...rest]
  if (firstArg === '--team' && rawArgs.length >= 2) {
    const teamName = rawArgs[1];
    return {
      args: ['_open', teamName, ...rawArgs.slice(2)],
      isShortcut: true,
      collisionWarning: null,
    };
  }
  if (firstArg.startsWith('--team=')) {
    const teamName = firstArg.slice('--team='.length);
    if (!teamName) {
      return { args: rawArgs, isShortcut: false, collisionWarning: null };
    }
    return {
      args: ['_open', teamName, ...rawArgs.slice(1)],
      isShortcut: true,
      collisionWarning: null,
    };
  }

  // Skip flags (e.g., --help, --version, -h)
  if (firstArg.startsWith('-')) {
    return { args: rawArgs, isShortcut: false, collisionWarning: null };
  }

  // 2. Known subcommand takes priority
  if (knownCommands.has(firstArg)) {
    let collisionWarning: string | null = null;
    if (teamExists?.(firstArg)) {
      collisionWarning = `Warning: "${firstArg}" is a subcommand. To open team "${firstArg}", use: genie --team ${firstArg}`;
    }
    return { args: rawArgs, isShortcut: false, collisionWarning };
  }

  // 3. Unknown first arg -> treat as team name
  return {
    args: ['_open', ...rawArgs],
    isShortcut: true,
    collisionWarning: null,
  };
}
