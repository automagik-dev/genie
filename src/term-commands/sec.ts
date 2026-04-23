import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';

export interface SecScanCommandOptions {
  json?: boolean;
  allHomes?: boolean;
  home?: string[];
  root?: string[];
  noProgress?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  progressJson?: boolean;
  progressInterval?: string;
  eventsFile?: string;
  redact?: boolean;
  persist?: boolean;
  impactSurface?: boolean;
  phaseBudget?: string[];
}

interface SecScanSpawnResult {
  status: number | null;
  error?: Error;
}

export interface SecScanDeps {
  existsSync: (path: string) => boolean;
  realpathSync: (path: string) => string;
  spawnSync: (command: string, args: string[], options: { stdio: 'inherit' }) => SecScanSpawnResult;
  setExitCode: (exitCode: number) => void;
}

const defaultDeps: SecScanDeps = {
  existsSync,
  realpathSync,
  spawnSync,
  setExitCode: (exitCode) => {
    process.exitCode = exitCode;
  },
};

function collectRepeatedOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Resolve genie's package root from either src/ or dist/. */
export function resolveGenieRoot(
  argv1: string | undefined = process.argv[1],
  deps: Pick<SecScanDeps, 'existsSync' | 'realpathSync'> = defaultDeps,
): string {
  try {
    if (argv1) {
      const scriptDir = dirname(deps.realpathSync(argv1));
      const candidates = [resolve(scriptDir, '..'), resolve(scriptDir, '..', '..')];
      for (const candidate of candidates) {
        if (deps.existsSync(join(candidate, 'package.json'))) return candidate;
      }
    }
  } catch {
    /* fall through */
  }

  return resolve(import.meta.dir, '..', '..');
}

export function resolveSecScanScript(
  argv1: string | undefined = process.argv[1],
  deps: Pick<SecScanDeps, 'existsSync' | 'realpathSync'> = defaultDeps,
): string {
  const root = resolveGenieRoot(argv1, deps);
  const scriptPath = join(root, 'scripts', 'sec-scan.cjs');
  if (!deps.existsSync(scriptPath)) {
    throw new Error(`Security scanner payload not found at ${scriptPath}`);
  }
  return scriptPath;
}

const BOOLEAN_FLAG_MAP: Array<[keyof SecScanCommandOptions, string]> = [
  ['json', '--json'],
  ['allHomes', '--all-homes'],
  ['noProgress', '--no-progress'],
  ['quiet', '--quiet'],
  ['verbose', '--verbose'],
  ['progressJson', '--progress-json'],
  ['redact', '--redact'],
  ['impactSurface', '--impact-surface'],
];

const REPEATED_FLAG_MAP: Array<[keyof SecScanCommandOptions, string]> = [
  ['home', '--home'],
  ['root', '--root'],
  ['phaseBudget', '--phase-budget'],
];

const STRING_FLAG_MAP: Array<[keyof SecScanCommandOptions, string]> = [
  ['progressInterval', '--progress-interval'],
  ['eventsFile', '--events-file'],
];

export function buildSecScanArgv(options: SecScanCommandOptions): string[] {
  const args: string[] = [];

  for (const [key, flag] of BOOLEAN_FLAG_MAP) {
    if (options[key]) args.push(flag);
  }

  for (const [key, flag] of REPEATED_FLAG_MAP) {
    const values = (options[key] as string[] | undefined) ?? [];
    for (const value of values) args.push(flag, value);
  }

  for (const [key, flag] of STRING_FLAG_MAP) {
    const value = options[key] as string | undefined;
    if (value) args.push(flag, value);
  }

  if (options.persist === false) args.push('--no-persist');

  return args;
}

export function runSecScan(options: SecScanCommandOptions, deps: SecScanDeps = defaultDeps): number {
  const scriptPath = resolveSecScanScript(process.argv[1], deps);
  const args = [scriptPath, ...buildSecScanArgv(options)];
  const result = deps.spawnSync(process.execPath, args, { stdio: 'inherit' });

  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function applySecScanExitCode(exitCode: number, deps: Pick<SecScanDeps, 'setExitCode'> = defaultDeps): void {
  if (exitCode !== 0) deps.setExitCode(exitCode);
}

export function registerSecCommands(program: Command, deps: SecScanDeps = defaultDeps): void {
  const sec = program.command('sec').description('Security tooling — host compromise triage and IOC hunts');

  sec
    .command('scan', { isDefault: true })
    .description('Scan host for TeamPCP/CanisterWorm-style package compromise indicators')
    .option('--json', 'Output as JSON envelope')
    .option('--all-homes', 'Scan /root, /home/*, /Users/*, and WSL Windows homes when present')
    .option('--home <path>', 'Add a specific home directory to scan', collectRepeatedOption, [])
    .option('--root <path>', 'Add an application root to scan for project evidence', collectRepeatedOption, [])
    .option('--no-progress', 'Suppress progress output on stderr')
    .option('--quiet', 'Suppress progress and banners on stderr')
    .option('--verbose', 'Emit extra diagnostics on stderr')
    .option('--progress-json', 'Emit progress as NDJSON events to stderr')
    .option('--progress-interval <ms>', 'Progress tick interval in milliseconds')
    .option('--events-file <path>', 'Append structured NDJSON events to a 0600-mode file')
    .option('--redact', 'Hash $HOME-prefixed paths; scrub AWS/GitHub/npm/JWT patterns')
    .option('--no-persist', 'Do not persist the report to $GENIE_HOME/sec-scan/')
    .option('--impact-surface', 'Scan for at-risk local material (secrets, wallets, browsers)')
    .option('--phase-budget <name=ms>', 'Budget (ms) for a named phase (repeatable)', collectRepeatedOption, [])
    .action((options: SecScanCommandOptions) => {
      const exitCode = runSecScan(options, deps);
      applySecScanExitCode(exitCode, deps);
    });
}
