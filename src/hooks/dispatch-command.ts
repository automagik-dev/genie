/**
 * CLI command: genie hook dispatch
 *
 * Reads CC hook payload from stdin, dispatches to handlers,
 * writes result to stdout. Designed for minimal startup time.
 */

import type { Command } from 'commander';
import { registerHookTrustCommand } from '../term-commands/hook/trust.js';
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
  // Mac-CPU fix C — short-circuit DB boot for hook dispatch forks.
  //
  // The long-lived `genie serve` daemon owns migrations + seed (it ran
  // them at startup). Each `genie hook dispatch` fork (hundreds/min on a
  // busy Mac dev machine) is short-lived; making each fork re-run
  // `runMigrations` + `needsSeed` (which loops all 92 ~/.claude/teams
  // entries on every call) is the second-largest contributor to the
  // .18 100%-CPU regression on Mac.
  //
  // Setting this env BEFORE `dispatch(stdin)` ensures the first
  // `getConnection()` inside any handler skips migrations + seed.
  // Handlers that need DB still get a working connection — they just
  // skip the boot-time setup that the daemon already handled.
  //
  // Set unconditionally for the dispatch entrypoint; daemon and CLI
  // code paths never enter this function.
  process.env.GENIE_SKIP_DB_BOOT = '1';

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
