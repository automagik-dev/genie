/**
 * `genie install` — stub for the zero-daemon era.
 *
 * Through v4 this command registered a `Genie` pm2 service and wired it to a
 * canonical pgserve (PostgreSQL) backbone so a long-lived daemon survived
 * shell exits and reboots. v5 is zero-daemon: task/board state lives in a
 * per-repo SQLite file (`.genie/genie.db`) and there is no background service
 * to supervise, so there is nothing to install.
 *
 * The command is retained (rather than removed) so scripts and muscle memory
 * that call `genie install` still exit 0. A real install flow returns with the
 * Warp-integration wish; until then this prints guidance and succeeds.
 */

/** Options accepted by `genie install`. Reserved for the Warp-integration wish. */
export interface InstallOptions {
  /** Deprecated no-op — v5 has no pgserve to skip. Retained for backward compat. */
  skipPgserve?: boolean;
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/**
 * No-op install for zero-daemon v5. Idempotent, always exits 0.
 */
export async function installCommand(_options: InstallOptions = {}): Promise<void> {
  out('genie v5 is zero-daemon — there is no background service to install.');
  out('Task and board state lives in a per-repo SQLite database (.genie/genie.db),');
  out('created automatically on first use. Run `genie doctor` to verify your setup.');
  out('');
  out('A managed install flow returns with the Warp-integration wish.');
}
