/**
 * genie agent recover <name> — One-shot operator command that runs the manual
 * surgery sequence required to recover a master agent post-outage. Idempotent.
 *
 * Background: master agents (`dir:<name>` rows — email, genie, felipe,
 * genie-pgserve) lose their persistent claude session UUIDs every time a
 * team-lead "hires" them, because the team-spawn path used to skip the
 * `shouldResume` chokepoint when no live worker row existed yet — generating
 * fresh `--session-id <new>` instead of `--resume <uuid>`. Group 1 of the
 * master-aware-spawn wish patched the chokepoint to fall back to `dir:<name>`;
 * this verb encodes the operator-facing recovery sequence Felipe ran by hand
 * during the 2026-04-25 power outage on top of that patch.
 */

import type { Command } from 'commander';
import { RecoverAgentNotFoundError, handleWorkerRecover } from '../agents.js';

export function registerAgentRecover(parent: Command): void {
  parent
    .command('recover <name>')
    .description(
      'Recover a master agent post-outage: flip auto_resume, terminate stale spawning executors, anchor session UUID, resume.',
    )
    .option('-y, --yes', 'Skip the interactive confirmation (unattended use)')
    .addHelpText(
      'after',
      `
Examples:
  genie agent recover email           # interactive — prompts for confirmation
  genie agent recover email --yes     # unattended — skip the prompt

Behavior (idempotent):
  1. Flip auto_resume = true.
  2. Terminate stale 'spawning' executors with close_reason='recovery_anchor'.
  3. Locate session UUID via chokepoint (DB → strict-jsonl → relaxed-jsonl scan).
  4. Invoke 'genie agent resume <name>' internally.

Exit codes:
  0  recovery succeeded (or agent already healed — second run is a no-op)
  1  resume failed; PG surgery state is preserved for retry
  2  agent not found by id, dir:<name>, custom_name, or role`,
    )
    .action(async (name: string, options: { yes?: boolean }) => {
      try {
        await handleWorkerRecover(name, options);
      } catch (error) {
        if (error instanceof RecoverAgentNotFoundError) {
          console.error(`Error: ${error.message}`);
          process.exit(2);
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
