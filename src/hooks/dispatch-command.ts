/**
 * CLI command: genie hook dispatch
 *
 * Reads CC hook payload from stdin, dispatches to handlers,
 * writes result to stdout. Designed for minimal startup time.
 *
 * **Hot-path strategy** (issue #1574):
 *
 * The bun-fork hot path used to dispatch in-process — every hook event opened
 * its own PG connection (max: 50 client-side pool) and `process.exit(0)`'d
 * without `shutdown()`, leaking server-side backends until pgserve hit
 * `max_connections=1000`. Operators saw "FATAL: sorry, too many clients
 * already" at steady state.
 *
 * Now: bun fork connects to `~/.genie/hook.sock` (the daemon's UDS) FIRST.
 * The daemon owns the PG pool; the fork stays stateless and never opens a
 * connection of its own. Only when the socket is missing/refused/timed-out
 * does the fork fall back to in-process dispatch (which still opens a pool;
 * acceptable as a degraded mode because the daemon is supposed to be up).
 *
 * This is a strict perf improvement on the existing path AND a fix for the
 * #1574 PG leak — every "happy path" hook now does a 4-byte UDS roundtrip
 * with zero PG state in the fork.
 */

import type { Command } from 'commander';
import { registerHookTrustCommand } from '../term-commands/hook/trust.js';
import { runDispatchClient } from './dispatch-client.js';
import { dispatch } from './index.js';

async function readStdin(): Promise<string> {
  // Bun-native stdin read
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function dispatchAction(): Promise<void> {
  // Mac-CPU fix C — short-circuit DB boot for hook dispatch forks. Only the
  // legacy in-process fallback below pays the cost; the default daemon path
  // never opens PG in this fork at all.
  process.env.GENIE_SKIP_DB_BOOT = '1';

  // Issue #1574 fix — default path: hand off to the daemon socket via
  // runDispatchClient(). On socket miss the client emits the F1 fallback
  // (empty stdout, allow-by-default, audit log entry) and returns 0 itself.
  // Either way the fork stays stateless, no PG connection, no shutdown leak.
  //
  // Set GENIE_HOOK_FORCE_INPROC=1 to bypass the daemon and run handlers
  // in-process (legacy behavior, kept for tests/debugging — DOES open a
  // PG pool that won't be cleanly shut down on process.exit, so don't
  // enable in production).
  if (process.env.GENIE_HOOK_FORCE_INPROC !== '1') {
    const code = await runDispatchClient();
    process.exit(code);
  }

  // Legacy in-process path — opt-in only. Reads stdin, dispatches against
  // the local handler registry, writes stdout. Same code that ran before
  // PR-#XXXX shipped the daemon-first hot path.
  const stdin = await readStdin();
  if (!stdin.trim()) {
    process.exit(0);
  }

  const result = await dispatch(stdin);
  if (result) {
    process.stdout.write(result);
  }
}

export function registerHookNamespace(program: Command): void {
  const hook = program.command('hook').description('Hook middleware for Claude Code integration');

  hook
    .command('dispatch')
    .description('Dispatch a CC hook event (reads JSON from stdin, writes decision to stdout)')
    .action(dispatchAction);

  // Group 1 of hookify-third-party-absorption: trust subcommand. Subsequent
  // groups extend this namespace with `list`, `scaffold`, `test`, `reload`,
  // `quarantine`, `import`, `prune`. Registered synchronously so commander's
  // parse pass sees it; the trust handler itself only runs when the user
  // invokes `genie hook trust` so the dispatch hot path doesn't pay for it.
  registerHookTrustCommand(hook);
}
