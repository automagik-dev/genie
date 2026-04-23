import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';

export interface SecScanCommandOptions {
  json?: boolean;
  allHomes?: boolean;
  home?: string[];
  root?: string[];
}

interface SecScanSpawnResult {
  status: number | null;
  error?: Error;
}

export interface SecScanDeps {
  existsSync: (path: string) => boolean;
  realpathSync: (path: string) => string;
  spawnSync: (command: string, args: string[], options: { stdio: 'inherit' }) => SecScanSpawnResult;
}

const defaultDeps: SecScanDeps = {
  existsSync,
  realpathSync,
  spawnSync,
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

export function buildSecScanArgv(options: SecScanCommandOptions): string[] {
  const args: string[] = [];

  if (options.json) args.push('--json');
  if (options.allHomes) args.push('--all-homes');

  for (const homePath of options.home ?? []) {
    args.push('--home', homePath);
  }

  for (const rootPath of options.root ?? []) {
    args.push('--root', rootPath);
  }

  return args;
}

export function runSecScan(options: SecScanCommandOptions, deps: SecScanDeps = defaultDeps): number {
  const scriptPath = resolveSecScanScript(process.argv[1], deps);
  const args = [scriptPath, ...buildSecScanArgv(options)];
  const result = deps.spawnSync(process.execPath, args, { stdio: 'inherit' });

  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function registerSecCommands(program: Command, deps: SecScanDeps = defaultDeps): void {
  const sec = program.command('sec').description('Security tooling — host compromise triage and IOC hunts');

  sec
    .command('scan', { isDefault: true })
    .description('Scan host for TeamPCP/CanisterWorm-style package compromise indicators')
    .option('--json', 'Output as JSON')
    .option('--all-homes', 'Scan /root, /home/*, /Users/*, and WSL Windows homes when present')
    .option('--home <path>', 'Add a specific home directory to scan', collectRepeatedOption, [])
    .option('--root <path>', 'Add an application root to scan for project evidence', collectRepeatedOption, [])
    .action((options: SecScanCommandOptions) => {
      const exitCode = runSecScan(options, deps);
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}
