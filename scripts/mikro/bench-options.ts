/**
 * argv → the options `bench.ts` runs on.
 *
 * Pure by construction: it reads no file, spawns nothing and starts no run, so a
 * test can assert what a flag does without paying for a provider call. It exists
 * because `bench.ts` executes on import — there is no way to import it and look
 * at what it parsed.
 *
 * Precedence, the one rule worth stating twice: the **registry** (`schemas.ts`)
 * decides the agent NAME and therefore the output schema it is validated
 * against; `--agents-dir` decides only WHERE that agent's `agent.yaml` and
 * `SYSTEM.md` are read from. An agent outside the registry is still refused, and
 * pointing `--agents-dir` at a tree holding a differently-named agent does not
 * register it.
 */
import { join, resolve } from 'node:path';
import { AGENT_NAMES, type AgentName, isAgentName } from './schemas';

export const BENCH_USAGE = `usage: bun scripts/mikro/bench.ts <${AGENT_NAMES.join('|')}> [--reps n] [--concurrency n] [--only a,b] [--tag k=v] [--dir repo] [--agents-dir dir] [--fixtures path] [--timeout-ms n] [--boundary none|bwrap] [--no-phoenix] [--write-evidence]\n`;

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
    fixturesPath: opt('--fixtures') ?? join(dir, 'scripts', 'mikro', 'fixtures', `${agent}.json`),
    ...(timeoutMs === undefined ? {} : { timeoutMs: Number(timeoutMs) }),
    phoenix: !has('--no-phoenix'),
    writeEvidence: has('--write-evidence'),
  };
}
