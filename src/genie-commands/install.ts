/**
 * Genie Install Command — TypeScript-side finishing step of the curl|bash bootstrap.
 *
 * install.sh downloads, verifies, extracts, links and PATH-wires the binary in
 * bash, then hands off to `genie install` on the freshly linked binary for the
 * finishing steps that belong in TypeScript. v5 keeps this deliberately thin;
 * today the only finisher is the v4 legacy cleanup (see legacy-v4.ts).
 *
 * Opt out with `--skip-v4-cleanup` — install.sh forwards its CLI args, so
 * `curl ... | bash -s -- --skip-v4-cleanup` reaches this flag.
 */

import { cleanupV4 } from './legacy-v4.js';

export interface InstallOptions {
  /** Set by --skip-v4-cleanup: leave v4-era artifacts in place. */
  skipV4Cleanup?: boolean;
}

type V4CleanupRunner = typeof cleanupV4;

/**
 * Run the post-install finishers. `runV4Cleanup` is an injection seam for
 * tests — production callers pass options only.
 */
export function installCommand(options: InstallOptions = {}, runV4Cleanup: V4CleanupRunner = cleanupV4): void {
  if (options.skipV4Cleanup) {
    console.log('\x1b[2mSkipping v4 legacy cleanup (--skip-v4-cleanup).\x1b[0m');
    return;
  }
  runV4Cleanup();
}
