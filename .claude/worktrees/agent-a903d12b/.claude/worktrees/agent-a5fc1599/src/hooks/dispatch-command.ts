/**
 * CLI command: genie hook dispatch
 *
 * Reads CC hook payload from stdin, dispatches to handlers,
 * writes result to stdout. Designed for minimal startup time.
 */

import type { Command } from 'commander';
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
}
