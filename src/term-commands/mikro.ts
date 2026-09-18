/**
 * genie mikro — the mikro microagent runtime, on PATH.
 *
 *   mikro call <agent> --prompt "<text>" [flags]
 *
 * The runtime itself stays in `scripts/mikro/`: this file is a registration
 * surface over `runCallCli`, so `genie mikro call` and `bun scripts/mikro/call.ts`
 * are one code path. That is why the command declares no options of its own —
 * it hands its argv to the runtime untouched (`allowUnknownOption` +
 * `passThroughOptions`), and a flag added to the runtime needs no edit here.
 *
 * Exit codes are the runtime's: 0 ok, 1 not ok (including a `mikro` that is not
 * on PATH, which answers `ok: false` with an `unavailable:` error), 2 usage.
 */

import type { Command } from 'commander';
import { CALL_USAGE, runCallCli } from '../../scripts/mikro/call';

const MIKRO_GROUP_DESCRIPTION = 'Run genie mikro microagents (call)';

/**
 * The flags are shown as help text rather than declared as Commander options on
 * purpose: a declared option is a CONSUMED option, and this command's contract is
 * that every token after the agent name reaches the runtime exactly as typed.
 */
const CALL_HELP = `
Flags (parsed by the mikro runtime, forwarded untouched):
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

${CALL_USAGE}`;

export function registerMikroCommands(program: Command): void {
  const existing = program.commands.find((c) => c.name() === 'mikro');
  // Positional options on the GROUP, not on the program: it is what `call` needs to
  // pass its own tail through, and it changes the parse of nothing else.
  const mikro = existing ?? program.command('mikro').description(MIKRO_GROUP_DESCRIPTION).enablePositionalOptions();

  mikro
    .command('call')
    .description('Run one mikro microagent and print its validated JSON answer')
    .argument('<agent>', 'Registered agent name (issue-triage, wish-context, review-prep, mikro-coach)')
    .argument('[flags...]', 'Runtime flags, forwarded untouched')
    .allowUnknownOption()
    .passThroughOptions()
    .addHelpText('after', CALL_HELP)
    .action(async (agent: string, flags: string[]) => {
      process.exitCode = await runCallCli([agent, ...flags]);
    });
}
