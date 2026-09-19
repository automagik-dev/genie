#!/usr/bin/env bun
/**
 * scripts/mikro/init.ts — seed a repository's own mikro agents.
 *
 *   genie mikro init [--dir repo]
 *   bun scripts/mikro/init.ts [--dir repo]        # the same code, inside this checkout
 *
 * The first step of growing agents in a repository that is not genie: copy the two
 * default agents this release ships (`<GENIE_HOME>/templates/mikro/agents`, where
 * `templates/` converges on every install and update) into `<repo>/.mikro/agents/`,
 * where they become the repository's own to specialize.
 *
 * Three rules, all of them about not destroying work:
 *
 *   - an agent directory that already exists is REFUSED, never overwritten. `genie
 *     mikro init` is idempotent by refusal: the second run writes nothing, and a
 *     specialized prompt is never silently replaced by the shipped one.
 *   - nothing is written outside `<repo>`, and a `.mikro` or `.mikro/agents` that is
 *     a SYMLINK is refused rather than followed — the seed would otherwise land
 *     wherever that link points.
 *   - `.mikro/runs/` joins `.gitignore` (the file is created when absent, the line
 *     never duplicated), because the run ledger, the retained raw answers and the
 *     bench records are machine-local evidence, not repository content.
 *
 * `mikro-coach` is deliberately NOT seeded. It is a tool that reads another agent's
 * prompt and evidence, not a worker a repository specializes; `genie mikro coach`
 * resolves it from the shipped set the same way `call` resolves any agent.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveMikroGenieHome, shippedAgentsRoot } from './call';
import { resolveTrustedRef } from './trusted-source';

/**
 * The agents a repository starts with. A SUBSET of what the release ships
 * (`SHIPPED_AGENTS` in `scripts/build-binary.sh`, which also carries `mikro-coach`):
 * these two are the workers a repository specializes. `scripts/release-docs.test.ts`
 * pins both lists against each other.
 */
export const SEEDED_AGENTS = ['wish-context', 'review-prep'] as const;

/** The two files the runtime reads. `EVIDENCE.md` is a bench record and is never seeded. */
const AGENT_FILES = ['agent.yaml', 'SYSTEM.md'] as const;

/** The line `.mikro/runs/` needs in `.gitignore`, and the spellings that already mean it. */
const RUNS_IGNORE_LINE = '.mikro/runs/';
const RUNS_IGNORE_EQUIVALENTS = ['.mikro/runs', '.mikro/runs/', '/.mikro/runs', '/.mikro/runs/', '.mikro/'];

/** A refusal that leaves the repository exactly as it was found; the CLI prints it and exits 1. */
export class InitError extends Error {}

export type GitignoreAction = 'created' | 'added' | 'present' | 'skipped';

export interface SeedResult {
  /** Paths written, absolute, every one of them inside `<dir>`. */
  written: string[];
  /** Agents that were already there — the reason `init` is safe to re-run. */
  refused: string[];
  /** What happened to `.gitignore`. A superset of the declared shape, so a caller that wants only the two arrays still gets them. */
  gitignore: GitignoreAction;
}

/** True when the path exists and is a symlink — checked with `lstat`, which is the whole point. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True only for a real file at that path: `lstat` again, so a symlink is never mistaken for one. */
function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * `.mikro/runs/` in `.gitignore`, exactly once. A repository that already ignores the
 * directory under any of the spellings that mean the same thing is left alone: a
 * duplicated ignore line is the kind of noise that makes an operator distrust a tool.
 *
 * A `.gitignore` that is a SYMLINK — or anything else that is not a regular file — is
 * not written through, and that is the same rule as `.mikro`/`.mikro/agents` above for
 * the same reason: writing through it appends to a file OUTSIDE `<repo>`, which is
 * exactly what this command promises never to do. It is reported (`skipped`) rather
 * than fatal, because the agents are seeded and one line is something an operator can
 * add by hand.
 */
export function ensureRunsIgnored(dir: string): GitignoreAction {
  const path = join(dir, '.gitignore');
  if (!existsSync(path) && !isSymlink(path)) {
    writeFileSync(path, `${RUNS_IGNORE_LINE}\n`);
    return 'created';
  }
  if (!isRegularFile(path)) return 'skipped';
  const body = readFileSync(path, 'utf8');
  const lines = body.split('\n').map((line) => line.trim());
  if (lines.some((line) => RUNS_IGNORE_EQUIVALENTS.includes(line))) return 'present';
  writeFileSync(path, `${body.endsWith('\n') || body === '' ? body : `${body}\n`}${RUNS_IGNORE_LINE}\n`);
  return 'added';
}

/**
 * Copy the shipped agents into `<dir>/.mikro/agents/`, refusing every agent that is
 * already there, and ignore the run ledger. Returns what it did, so the caller prints
 * it rather than this function guessing at a transcript.
 */
export function seedAgents(options: { dir: string; genieHome: string }): SeedResult {
  const dir = resolve(options.dir);
  const shipped = shippedAgentsRoot(options.genieHome);
  const missing = SEEDED_AGENTS.filter((agent) => AGENT_FILES.some((file) => !existsSync(join(shipped, agent, file))));
  if (missing.length)
    throw new InitError(
      `this release ships no ${missing.join(' or ')} under ${shipped} — run genie update to converge <GENIE_HOME>/templates, or pass --agents-dir to a checkout that carries them`,
    );

  const mikroDir = join(dir, '.mikro');
  const agentsDir = join(mikroDir, 'agents');
  for (const path of [mikroDir, agentsDir])
    if (isSymlink(path))
      throw new InitError(
        `${path} is a symlink: refusing to seed through it, because the files would not land in ${dir}`,
      );

  const written: string[] = [];
  const refused: string[] = [];
  for (const agent of SEEDED_AGENTS) {
    const target = join(agentsDir, agent);
    if (existsSync(target) || isSymlink(target)) {
      refused.push(agent);
      continue;
    }
    mkdirSync(target, { recursive: true });
    for (const file of AGENT_FILES) {
      copyFileSync(join(shipped, agent, file), join(target, file));
      written.push(join(target, file));
    }
  }
  return { written, refused, gitignore: ensureRunsIgnored(dir) };
}

/**
 * Which of Decision 8's two rules this repository will be read under when `genie mikro
 * call` runs inside it — probed rather than guessed, because the answer decides whether
 * the operator must PUSH the commit they are about to make.
 */
export function nextStepForCommit(dir: string): string {
  const trusted = resolveTrustedRef(resolve(dir));
  if (!trusted.ref)
    return `  2. give this checkout a base branch — ${trusted.reason}
     git -C ${dir} remote set-head origin -a          # or pass --agents-ref <ref> to every call
     Until then the shipped default agent is used and your seeded one is ignored.`;
  if (trusted.ref.startsWith('refs/heads/'))
    return `  2. no push needed yet: the trusted ref is ${trusted.reason}, so a committed-but-unpushed
     agent on that branch IS the one this repository's runs will use (Decision 8's local-base
     rule). Push it anyway before anyone else clones the repository:
     git -C ${dir} push`;
  return `  2. PUSH it — the trusted ref here is ${trusted.reason}, so an agent that is committed but
     not pushed is invisible to every run:
     git -C ${dir} push`;
}

export const INIT_USAGE = `usage: genie mikro init [--dir repo]
       (inside this checkout the same code runs as: bun scripts/mikro/init.ts [--dir repo])
`;

/** Seed one repository and print the sequence that turns the seed into a measured agent. */
export function runInitCli(argv: string[]): number {
  const i = argv.indexOf('--dir');
  const dirArg = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && (dirArg === undefined || dirArg.startsWith('--'))) {
    process.stderr.write(`--dir needs a path\n${INIT_USAGE}`);
    return 2;
  }
  const dir = resolve(dirArg ?? process.cwd());
  if (!existsSync(dir)) {
    process.stderr.write(`${dir} does not exist\n`);
    return 2;
  }
  let seeded: SeedResult;
  try {
    seeded = seedAgents({ dir, genieHome: resolveMikroGenieHome() });
  } catch (error) {
    process.stderr.write(`${error instanceof InitError ? error.message : String(error)}\n`);
    return 1;
  }
  for (const path of seeded.written) process.stdout.write(`seeded ${path}\n`);
  for (const agent of seeded.refused)
    process.stdout.write(`kept ${join(dir, '.mikro', 'agents', agent)} — it already exists, nothing was overwritten\n`);
  if (seeded.gitignore === 'present') process.stdout.write(`.gitignore already ignores ${RUNS_IGNORE_LINE}\n`);
  else if (seeded.gitignore === 'skipped')
    process.stdout.write(
      `left ${join(dir, '.gitignore')} alone — it is not a regular file (a symlink?), and writing through it would write outside ${dir}\n` +
        `  add this line to the file it points at, by hand: ${RUNS_IGNORE_LINE}\n`,
    );
  else process.stdout.write(`${seeded.gitignore} ${join(dir, '.gitignore')} with ${RUNS_IGNORE_LINE}\n`);
  process.stdout.write(`
next, in order:

  1. commit the agents on your base branch — an agent that is not committed is not used:
     git -C ${dir} add .mikro/agents .gitignore
     git -C ${dir} commit -m "chore(mikro): seed the wish-context and review-prep agents"

${nextStepForCommit(dir)}

  3. build a fixture set from this repository's own history (no pull requests needed):
     genie mikro fixtures --from-commits HEAD~20..HEAD --agent wish-context --dir ${dir}

  4. measure the agent you now own, and keep the number:
     genie mikro bench wish-context --dir ${dir} --reps 1 --write-evidence

  5. edit .mikro/agents/wish-context/SYSTEM.md, re-bench with --tag round=N, and keep the
     change only if the bars still pass. "genie mikro coach wish-context --dir ${dir}"
     proposes one bounded patch and measures it before/after; it never writes to a
     tracked file.

on this host, mikro itself is the one prerequisite genie does not ship:

  - mikro >= 1.260909.1 on PATH (mikro --version)
  - ~/.mikro/settings.json declaring a "deepseek-api" provider with the "deepseek-flash"
    model, so a --dir outside the genie checkout still resolves the shipped agents' model
  - DEEPSEEK_API_KEY in the environment

without them every run answers ok:false with one "unavailable:" error and exits 1 —
nothing is written and nothing is billed.
`);
  return 0;
}

// No top-level `await`: this module is imported by the genie CLI, where
// `import.meta.main` is false and nothing below must run.
if (import.meta.main) {
  process.exit(runInitCli(process.argv.slice(2)));
}
