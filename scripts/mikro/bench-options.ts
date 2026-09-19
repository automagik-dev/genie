/**
 * argv → the options `bench.ts` runs on.
 *
 * Spawns nothing and starts no run, so a test can assert what a flag does without
 * paying for a provider call; the one thing it touches on disk is the single
 * `existsSync` fixture resolution below, which takes an injectable prober for
 * exactly that reason. It exists because `runBenchCli` is one long workflow —
 * there is no other way to look at what a round parsed.
 *
 * Precedence, the one rule worth stating twice: the **registry** (`schemas.ts`)
 * decides the agent NAME and therefore the output schema it is validated
 * against; `--agents-dir` decides only WHERE that agent's `agent.yaml` and
 * `SYSTEM.md` are read from. An agent outside the registry is still refused, and
 * pointing `--agents-dir` at a tree holding a differently-named agent does not
 * register it.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AGENT_NAMES, type AgentName, isAgentName } from './schemas';

export const BENCH_USAGE = `usage: genie mikro bench <${AGENT_NAMES.join('|')}> [--reps n] [--concurrency n] [--only a,b] [--tag k=v] [--dir repo] [--agents-dir dir] [--fixtures path] [--timeout-ms n] [--boundary none|bwrap] [--no-phoenix] [--write-evidence]
       (inside this checkout the same code runs as: bun scripts/mikro/bench.ts <agent> …)
`;

/** Thrown for an argv the bench cannot run; the CLI prints `message` and exits 2. */
export class BenchUsageError extends Error {}

export interface BenchOptions {
  /** A registered agent name — the schema its answers are validated against. */
  agent: AgentName;
  /** The repository the agent reads and citations are verified against. */
  dir: string;
  /**
   * Where the `<agent>/agent.yaml` + `SYSTEM.md` folders live, absolute.
   * `undefined` — the no-flag default — leaves `runAgent` to use this checkout's
   * `.mikro/agents`, which is what every round before this flag measured.
   */
  agentsDir?: string;
  reps: number;
  concurrency: number;
  only?: string[];
  tags: Record<string, string>;
  fixturesPath: string;
  timeoutMs?: number;
  phoenix: boolean;
  writeEvidence: boolean;
}

/**
 * The agents dir the bench hands `runAgent`: the flag when the operator typed one, else
 * the WORKING TREE under `--dir`.
 *
 * This is deliberate, and it is the one place the trust boundary is taken the other way
 * round (Decision 8). `genie mikro call` reviews untrusted content, so it reads its agent
 * from a git ref; the bench and the coach are operator tools over the operator's own
 * working tree, and the whole point of a refinement round is to measure the `SYSTEM.md`
 * the operator just edited. Passing it explicitly also keeps the coach honest: its BEFORE
 * bench then measures the same working-tree prompt its printed diff is computed from,
 * while AFTER keeps measuring the patched copy.
 *
 * Two consequences, stated rather than hidden: the run resolves through the flag path, so
 * the synthesized trusted root equals `--dir` and the `.mikro/` configuration comparison is
 * skipped by the same-directory exemption — so `bench` and `coach` may only be pointed at a
 * tree the operator trusts, never at a PR checkout or an unaudited clone. And the value is
 * NOT recorded: with no `--agents-dir` the bench record stays byte-identical to every round
 * before the flag existed.
 */
export function benchAgentsDir(options: { dir: string; agentsDir?: string }): string {
  return options.agentsDir ?? join(options.dir, '.mikro', 'agents');
}

/**
 * Where one agent's fixture set lives (Decision 12), in order:
 *
 *   `--fixtures <path>` → `<dir>/.mikro/fixtures/<agent>.json` → `<dir>/scripts/mikro/fixtures/<agent>.json`
 *
 * The last entry is genie's own legacy location and is deliberately unchanged, so a
 * no-flag round inside this checkout resolves exactly what it always did. The middle
 * one is what a repository that is not genie gets: `genie mikro fixtures
 * --from-commits` writes there by default, and `genie mikro init` seeds beside it.
 *
 * The prober is injectable because this is the one place the parser touches disk.
 */
export function resolveFixturesPath(
  args: { dir: string; agent: string; explicit?: string },
  exists: (path: string) => boolean = existsSync,
): string {
  if (args.explicit !== undefined) return resolve(args.explicit);
  const repoLocal = join(args.dir, '.mikro', 'fixtures', `${args.agent}.json`);
  if (exists(repoLocal)) return repoLocal;
  return join(args.dir, 'scripts', 'mikro', 'fixtures', `${args.agent}.json`);
}

export function parseBenchOptions(argv: string[], cwd: string): BenchOptions {
  const agent = argv[0];
  if (!agent || !isAgentName(agent)) throw new BenchUsageError(BENCH_USAGE);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string) => argv.includes(name);
  const dir = resolve(opt('--dir') ?? cwd);
  const tags: Record<string, string> = {};
  argv.forEach((a, i) => {
    if (a === '--tag' && argv[i + 1]?.includes('=')) {
      const [k, ...v] = argv[i + 1].split('=');
      tags[k] = v.join('=');
    }
  });
  const agentsDir = opt('--agents-dir');
  const timeoutMs = opt('--timeout-ms');
  return {
    agent,
    dir,
    ...(agentsDir === undefined ? {} : { agentsDir: resolve(agentsDir) }),
    reps: Number(opt('--reps') ?? 1),
    concurrency: Number(opt('--concurrency') ?? 3),
    only: opt('--only')?.split(',').filter(Boolean),
    tags,
    fixturesPath: resolveFixturesPath({ dir, agent, explicit: opt('--fixtures') }),
    ...(timeoutMs === undefined ? {} : { timeoutMs: Number(timeoutMs) }),
    phoenix: !has('--no-phoenix'),
    writeEvidence: has('--write-evidence'),
  };
}
