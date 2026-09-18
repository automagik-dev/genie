/**
 * genie mikro — the mikro microagent runtime, on PATH.
 *
 *   mikro call <agent> --prompt "<text>" [flags]
 *   mikro bench <agent> [flags]            # measure one agent over its fixture set
 *   mikro coach <agent> [flags]            # one coaching round over its prompt
 *   mikro fixtures --from-commits <range> --agent <agent>
 *   mikro init [--dir <repo>]              # seed the shipped agents into a repository
 *
 * The runtime itself stays in `scripts/mikro/`: this file is a registration
 * surface over `runCallCli`, `runBenchCli`, `runCoachCli`, `runFixturesCli` and
 * `runInitCli`, so `genie mikro <verb>` and `bun scripts/mikro/<file>.ts` are one
 * code path each. That is why the commands declare no options of their own
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
 * spellings above. Shell quoting alone does not change the argv token the program
 * sees: prefix the value with a space (`--prompt " -V"`) or use `--prompt-file`.
 * `src/term-commands/mikro.test.ts` pins the behaviour so the exception stays
 * documented rather than folklore.
 *
 * Exit codes: 0 ok, 1 not ok (including a `mikro` that is not on PATH, which
 * answers `ok: false` with an `unavailable:` error, and including `mikro call`
 * with NO agent, which is Commander's missing-argument path through genie's
 * global error handler). 2 is the runtime's own usage refusal — an unregistered
 * agent NAME, or a registered one with no prompt.
 */

import type { Command } from 'commander';
import { runBenchCli } from '../../scripts/mikro/bench';
import { BENCH_USAGE } from '../../scripts/mikro/bench-options';
import { CALL_USAGE, runCallCli } from '../../scripts/mikro/call';
import { FIXTURES_USAGE, runFixturesCli } from '../../scripts/mikro/fixtures-from-commits';
import { INIT_USAGE, runInitCli } from '../../scripts/mikro/init';

const MIKRO_GROUP_DESCRIPTION = 'Run and grow genie mikro microagents (call, bench, coach, fixtures, init)';

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
  --agents-ref <ref>         The ref in the INVOKING checkout whose agent files and .mikro/
                             config are trusted (default: the base branch origin/HEAD names)
  --facts auto|<path>        Precompute the mechanical facts and hand them over as MCP context
  --timeout-ms <n>           Wall clock for one attempt (default 600000)
  --retries <n>              Retries after a failed validation (default 1)
  --tag k=v                  Ledger/Phoenix tag; repeatable
  --trace <id>               Trace id shared by the runs of one job
  --boundary none|bwrap      Where the runtime runs (default none)
  --no-phoenix, --no-ledger  Turn off the span or the run ledger
  --raw                      Print each attempt's raw answer instead of the JSON result

Without --agents-dir the agent files come from the INVOKING checkout's
.mikro/agents/<agent>/ as it exists at the trusted ref — never from its working
tree and never from --dir, which is the tree under review — and otherwise from
the shipped defaults under <GENIE_HOME>/templates/mikro/agents/. The answer names
which source won in "agentSource" (flag, repo@<ref>, shipped) and why in
"agentSourceReason". The same ref decides whether --dir's own .mikro/ (and legacy
.rlmx/) configuration is trusted; an uncommitted edit to one of those files is
refused, a checkout that resolves no ref at all refuses them outright, and
--agents-dir is the operator's way to run with a working tree instead.

Genie's own global options win anywhere in the tail: -V/--version, -h/--help and
--no-interactive are consumed before the tail reaches the runtime, so a flag
VALUE that is one of them (--prompt -V) prints the version and runs nothing.
Shell quoting does not change the argv token: prefix the value with a space
(--prompt " -V") or use --prompt-file.

${CALL_USAGE}`;

/**
 * `bench` and `coach` are the measuring tools, and they read the WORKING TREE under
 * `--dir` rather than a git ref — the opposite of `call`, deliberately, because a
 * refinement round exists to measure the prompt the operator just edited. The help
 * says so where an operator will read it: point them at a tree you trust.
 */
const BENCH_HELP = `
Flags (parsed by the mikro runtime, forwarded as typed):
  --dir <repo>               The repository whose agents are measured and whose
                             citations are verified; defaults to the working directory
  --fixtures <path>          The fixture set; default <dir>/.mikro/fixtures/<agent>.json,
                             else <dir>/scripts/mikro/fixtures/<agent>.json
  --agents-dir <dir>         Read agent files from here instead of <dir>/.mikro/agents
  --reps <n>                 Runs per fixture (default 1)
  --concurrency <n>          Fixtures in flight (default 3)
  --only a,b                 Run these fixture ids only
  --tag k=v                  Ledger/Phoenix/evidence tag; repeatable (--tag round=N)
  --timeout-ms <n>           Wall clock for one attempt (default 600000)
  --boundary none|bwrap      Where each run runs (default none)
  --no-phoenix               Turn off the span
  --write-evidence           Append the table to <dir>/.mikro/agents/<agent>/EVIDENCE.md

Unlike "call", the bench measures the WORKING TREE: <dir>/.mikro/agents/<agent>/,
or the tree --agents-dir names. It therefore skips the .mikro/ configuration
comparison that "call" makes, so point it only at a tree you trust — never at a PR
checkout or an unaudited clone. A missing fixture set or a missing
<agent>/agent.yaml refuses the round upfront, at zero cost, naming the remedy
("genie mikro init", "genie mikro fixtures --from-commits").

Exit codes: 0 every bar passed, 1 a bar failed, 2 the round was refused before any
run.

${BENCH_USAGE}`;

/**
 * The builder a repository with no pull requests needs: its own commits already carry
 * an intent and the file set an agent should have named. Every rule is mechanical, so
 * the help states them rather than describing them.
 */
const FIXTURES_HELP = `
Flags (parsed by the mikro runtime, forwarded as typed):
  --from-commits <range>     The commit range, e.g. HEAD~20..HEAD or v1.2.0..HEAD
  --agent <name>             wish-context or review-prep
  --dir <repo>               The repository whose history is read; defaults to the
                             working directory
  --out <path>               Where to write; default <dir>/.mikro/fixtures/<agent>.json
  --max <n>                  Stop after n fixtures (oldest first)
  --force                    Replace an existing file (refused without it)

Ground truth is mechanical: files = "git show --name-only" of the commit (a rename
contributes the NEW path), prompt = "Intent: <subject>" for wish-context and
"Prepare the review of commit <sha> against <sha>^" for review-prep, id = the first
12 characters of the sha. A merge commit, a root commit (review-prep), a commit with
no files, and a commit any of whose files no longer exists at HEAD are skipped with
the reason printed — the verifier scores the TREE, not the commit. The output is
byte-stable across runs of the same argv.

Exit codes: 0 a set was written, 1 the range stated no fixture (nothing written), 2
the command was refused.

${FIXTURES_USAGE}`;

/**
 * The first step in a repository that is not genie, and the only command here that
 * writes to a repository at all — which is why the help says exactly what it writes.
 */
const INIT_HELP = `
Flags (parsed by the mikro runtime, forwarded as typed):
  --dir <repo>               The repository to seed; defaults to the working directory

Copies this release's default wish-context and review-prep agents from
<GENIE_HOME>/templates/mikro/agents into <repo>/.mikro/agents/, adds ".mikro/runs/"
to .gitignore, and writes nothing else and nothing outside <repo>. An agent
directory that already exists is REFUSED, never overwritten, so a second run changes
nothing. A symlinked .mikro or .mikro/agents is refused rather than followed.

It then prints the sequence: commit the agents on your base branch, push them (or,
when the local-base rule applies, why you need not yet), build a fixture set from
your own commits, bench, refine. mikro-coach is not seeded: it is a tool, resolved
from the shipped set like any other agent.

Exit codes: 0 seeded (or nothing left to seed), 1 the shipped agents are missing (run
genie update), 2 the command was refused.

${INIT_USAGE}`;

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

  mikro
    .command('bench')
    .description('Measure one microagent over its fixture set and score it mechanically')
    .argument('<agent>', 'Registered agent name (issue-triage, wish-context, review-prep, mikro-coach)')
    .argument('[flags...]', 'Runtime flags, forwarded as typed (genie global options excepted)')
    .allowUnknownOption()
    .passThroughOptions()
    .addHelpText('after', BENCH_HELP)
    .action(async (agent: string, flags: string[]) => {
      process.exitCode = await runBenchCli([agent, ...flags]);
    });

  mikro
    .command('fixtures')
    .description("Build a fixture set from a repository's own commits (no PRs needed)")
    .argument('[flags...]', 'Runtime flags, forwarded as typed (genie global options excepted)')
    .allowUnknownOption()
    .passThroughOptions()
    .addHelpText('after', FIXTURES_HELP)
    .action((flags: string[]) => {
      process.exitCode = runFixturesCli(flags);
    });

  mikro
    .command('init')
    .description("Seed this release's default agents into a repository and print the next steps")
    .argument('[flags...]', 'Runtime flags, forwarded as typed (genie global options excepted)')
    .allowUnknownOption()
    .passThroughOptions()
    .addHelpText('after', INIT_HELP)
    .action((flags: string[]) => {
      process.exitCode = runInitCli(flags);
    });
}
