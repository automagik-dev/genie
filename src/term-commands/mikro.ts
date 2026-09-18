/**
 * genie mikro — the mikro microagent runtime, on PATH.
 *
 *   mikro call <agent> --prompt "<text>" [flags]
 *
 * The runtime itself stays in `scripts/mikro/`: this file is a registration
 * surface over `runCallCli`, so `genie mikro call` and `bun scripts/mikro/call.ts`
 * are one code path. That is why the command declares no options of its own
 * (`allowUnknownOption` + `passThroughOptions`): a flag added to the runtime
 * needs no edit here.
 *
 * ONE exception, and it is not cosmetic: genie's own GLOBAL options still win
 * anywhere in the tail. `-V`/`--version`, `-h`/`--help` and `--no-interactive`
 * are consumed by the program before the tail is assembled, so
 * `mikro call wish-context --prompt -V` prints the version and runs no agent.
 * `enablePositionalOptions()` on this group shields the tail from the group's own
 * options, not from the program's, and turning it on for the PROGRAM would change
 * how every other command parses — a much larger blast radius than the three
 * spellings above. Quote or rename such a value (`--prompt " -V"`), or use
 * `--prompt-file`. `src/term-commands/mikro.test.ts` pins the behaviour so the
 * exception stays documented rather than folklore.
 *
 * Exit codes: 0 ok, 1 not ok (including a `mikro` that is not on PATH, which
 * answers `ok: false` with an `unavailable:` error, and including `mikro call`
 * with NO agent, which is Commander's missing-argument path through genie's
 * global error handler). 2 is the runtime's own usage refusal — an unregistered
 * agent NAME, or a registered one with no prompt.
 */

import type { Command } from 'commander';
import { CALL_USAGE, runCallCli } from '../../scripts/mikro/call';

const MIKRO_GROUP_DESCRIPTION = 'Run genie mikro microagents (call)';

/**
 * The flags are shown as help text rather than declared as Commander options on
 * purpose: a declared option is a CONSUMED option, and this command's contract is
 * that every token after the agent name reaches the runtime exactly as typed —
 * except genie's three global options, which the program consumes first (see the
 * file header).
 */
const CALL_HELP = `
Flags (parsed by the mikro runtime, forwarded as typed):
  --prompt <text>            The one instruction for the agent (or --prompt-file <path>)
  --prompt-file <path>       Read the prompt from a file
  --dir <repo>               The tree the agent reads; defaults to the working directory
  --agents-dir <dir>         Read agent files from here (operator trust: it sets the trusted root too)
  --facts auto|<path>        Precompute the mechanical facts and hand them over as MCP context
  --timeout-ms <n>           Wall clock for one attempt (default 600000)
  --retries <n>              Retries after a failed validation (default 1)
  --tag k=v                  Ledger/Phoenix tag; repeatable
  --trace <id>               Trace id shared by the runs of one job
  --boundary none|bwrap      Where the runtime runs (default none)
  --no-phoenix, --no-ledger  Turn off the span or the run ledger
  --raw                      Print each attempt's raw answer instead of the JSON result

Without --agents-dir the agent files come from the invoking checkout's
.mikro/agents/<agent>/, and otherwise from the shipped defaults under
<GENIE_HOME>/templates/mikro/agents/. The answer names which source won in
"agentSource".

Genie's own global options win anywhere in the tail: -V/--version, -h/--help and
--no-interactive are consumed before the tail reaches the runtime, so a flag
VALUE that is one of them (--prompt -V) prints the version and runs nothing.
Quote it (--prompt " -V") or use --prompt-file.

${CALL_USAGE}`;

export function registerMikroCommands(program: Command): void {
  const existing = program.commands.find((c) => c.name() === 'mikro');
  // Positional options on the GROUP, not on the program: it is what `call` needs to
  // pass its tail through, and it changes the parse of nothing else. It does NOT
  // shield the tail from the PROGRAM's global options — see the file header.
  const mikro = existing ?? program.command('mikro').description(MIKRO_GROUP_DESCRIPTION).enablePositionalOptions();

  mikro
    .command('call')
    .description('Run one mikro microagent and print its validated JSON answer')
    .argument('<agent>', 'Registered agent name (issue-triage, wish-context, review-prep, mikro-coach)')
    .argument('[flags...]', 'Runtime flags, forwarded as typed (genie global options excepted)')
    .allowUnknownOption()
    .passThroughOptions()
    .addHelpText('after', CALL_HELP)
    .action(async (agent: string, flags: string[]) => {
      process.exitCode = await runCallCli([agent, ...flags]);
    });
}
