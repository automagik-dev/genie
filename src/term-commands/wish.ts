/**
 * genie wish — the wish-document verbs, on PATH.
 *
 *   wish lint [--dir <repo>]     # structural lint over <repo>/.genie/wishes
 *
 * The linter itself stays in `scripts/wishes-lint.ts`: this file is a
 * registration surface over `runWishLintCli`, so `genie wish lint` and
 * `bun run wishes:lint` are one code path, exactly as `genie mikro` fronts the
 * mikro runtime. The script is NOT relocated under `src/` — its formatting and
 * its `validate-wish` neighbour are inherited verbatim from the plugin era, and
 * a move would be a decomposition project rather than a delivery step.
 *
 * The point of the verb is that a repository which is not genie can run the
 * linter its `wish` skill tells it to run. That is why `'wish'` sits in
 * `WORKSPACE_EXEMPT` (`src/lib/interactivity.ts`): without it the v4 workspace
 * gate would prompt for `genie init` in every repository this verb exists for.
 *
 * Exit codes: 0 clean, 1 findings, 2 the runtime refused the root it was handed
 * (a `--dir` that is not a directory, or one carrying no `.genie/wishes`). An
 * unknown FLAG is Commander's own error through genie's global handler and
 * exits 1 — the same path `genie mikro call` with no agent takes.
 */

import type { Command } from 'commander';
import { runWishLintCli } from '../../scripts/wishes-lint';

const WISH_GROUP_DESCRIPTION = 'Work with wish documents (lint)';

const LINT_HELP = `
Reads <repo>/.genie/wishes and reports structure: the canonical wish template
sections, the metadata fields (a Status from the lifecycle vocabulary, a valid
YYYY-MM-DD Date), the Execution Strategy routing columns, and every markdown
link into .genie/brainstorms/ that does not resolve on disk. It writes nothing.

Without --dir the root is the git toplevel of the working directory, falling
back to the working directory itself; a checkout that carries no wishes yet is
not an error and reports 0 files. A --dir you TYPED is verified instead: one
that is not a directory, or that holds no .genie/wishes, is refused rather than
scanned, so a typo can never read as a clean bill of health. A file may opt out
with a leading <!-- wishes-lint:ignore --> marker.

Two further rules ride the same pass but stay REPOSITORY-GATE concerns rather
than a promise this verb makes to every checkout: design-review evidence (a
post-2026-07-11 wish must link a DESIGN.md carrying a current SHIP stamp) and
the cross-wish graph (depends-on/blocks must name slugs that exist in this same
corpus and stay acyclic). They are authored for the genie repository's own
\`bun run wishes:lint\` gate, where the whole corpus is present; a repository
that does not follow that contract should treat them there, not here.

Exit codes: 0 clean, 1 findings, 2 the root was refused. An unknown flag is the
parser's own error and exits 1.`;

export function registerWishCommands(program: Command): void {
  const existing = program.commands.find((c) => c.name() === 'wish');
  const wish = existing ?? program.command('wish').description(WISH_GROUP_DESCRIPTION);

  wish
    .command('lint')
    .description("Lint a repository's wish documents for structure (writes nothing)")
    .option('--dir <repo>', 'Repository whose .genie/wishes is linted (default: the git toplevel of the cwd)')
    .addHelpText('after', LINT_HELP)
    // `!== undefined`, never truthiness: `--dir ""` is a mistake an operator made
    // (an unset shell variable), and a falsy check silently turned it into "lint
    // the working directory instead". The runtime refuses the empty value.
    .action(async (options: { dir?: string }) => {
      process.exitCode = await runWishLintCli(options.dir !== undefined ? ['--dir', options.dir] : []);
    });
}
