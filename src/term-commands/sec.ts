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

export interface SecRemediateCommandOptions {
  json?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  resume?: string;
  scanReport?: string;
  scanId?: string;
  plan?: string;
  quarantineDir?: string;
  unsafeUnverified?: string;
  remediatePartial?: boolean;
  confirmIncompleteScan?: string;
  killPid?: number[];
  autoConfirmFrom?: string;
}

export interface SecQuarantineListOptions {
  json?: boolean;
}

export interface SecQuarantineGcOptions {
  json?: boolean;
  olderThan?: string;
  confirmGc?: string;
}

export interface SecRollbackOptions {
  json?: boolean;
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

function collectKillPid(value: string, previous: number[]): number[] {
  const pid = Number.parseInt(value, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`--kill-pid expects a positive integer, got "${value}"`);
  }
  return [...previous, pid];
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

export function resolveSecRemediateScript(
  argv1: string | undefined = process.argv[1],
  deps: Pick<SecScanDeps, 'existsSync' | 'realpathSync'> = defaultDeps,
): string {
  const root = resolveGenieRoot(argv1, deps);
  const scriptPath = join(root, 'scripts', 'sec-remediate.cjs');
  if (!deps.existsSync(scriptPath)) {
    throw new Error(`Security remediation payload not found at ${scriptPath}`);
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

export function buildSecRemediateArgv(options: SecRemediateCommandOptions): string[] {
  const args: string[] = [];

  if (options.dryRun) args.push('--dry-run');
  if (options.apply) args.push('--apply');
  if (options.resume) args.push('--resume', options.resume);
  if (options.scanReport) args.push('--scan-report', options.scanReport);
  if (options.scanId) args.push('--scan-id', options.scanId);
  if (options.plan) args.push('--plan', options.plan);
  if (options.quarantineDir) args.push('--quarantine-dir', options.quarantineDir);
  if (options.unsafeUnverified) args.push('--unsafe-unverified', options.unsafeUnverified);
  if (options.remediatePartial) args.push('--remediate-partial');
  if (options.confirmIncompleteScan) args.push('--confirm-incomplete-scan', options.confirmIncompleteScan);
  for (const pid of options.killPid ?? []) {
    args.push('--kill-pid', String(pid));
  }
  if (options.autoConfirmFrom) args.push('--auto-confirm-from', options.autoConfirmFrom);
  if (options.json) args.push('--json');

  return args;
}

export function runSecScan(options: SecScanCommandOptions, deps: SecScanDeps = defaultDeps): number {
  const scriptPath = resolveSecScanScript(process.argv[1], deps);
  const args = [scriptPath, ...buildSecScanArgv(options)];
  const result = deps.spawnSync(process.execPath, args, { stdio: 'inherit' });

  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runSecRemediate(options: SecRemediateCommandOptions, deps: SecScanDeps = defaultDeps): number {
  const scriptPath = resolveSecRemediateScript(process.argv[1], deps);
  const args = [scriptPath, ...buildSecRemediateArgv(options)];
  const result = deps.spawnSync(process.execPath, args, { stdio: 'inherit' });

  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runSecRestore(quarantineId: string, deps: SecScanDeps = defaultDeps): number {
  const scriptPath = resolveSecRemediateScript(process.argv[1], deps);
  const args = [scriptPath, '--restore', quarantineId];
  // The current sec-remediate.cjs handles restore via a separate entry: invoke
  // the small CLI shim below by reusing the script and a dedicated flag.
  const result = deps.spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function buildSecRollbackArgv(scanId: string, options: SecRollbackOptions): string[] {
  const args: string[] = ['--rollback', scanId];
  if (options.json) args.push('--json');
  return args;
}

export function buildSecQuarantineListArgv(options: SecQuarantineListOptions): string[] {
  const args: string[] = ['--quarantine-list'];
  if (options.json) args.push('--json');
  return args;
}

export function buildSecQuarantineGcArgv(options: SecQuarantineGcOptions): string[] {
  const args: string[] = ['--quarantine-gc'];
  if (options.olderThan) args.push('--older-than', options.olderThan);
  if (options.confirmGc) args.push('--confirm-gc', options.confirmGc);
  if (options.json) args.push('--json');
  return args;
}

export function runSecRollback(scanId: string, options: SecRollbackOptions, deps: SecScanDeps = defaultDeps): number {
  const scriptPath = resolveSecRemediateScript(process.argv[1], deps);
  const args = [scriptPath, ...buildSecRollbackArgv(scanId, options)];
  const result = deps.spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runSecQuarantineList(options: SecQuarantineListOptions, deps: SecScanDeps = defaultDeps): number {
  const scriptPath = resolveSecRemediateScript(process.argv[1], deps);
  const args = [scriptPath, ...buildSecQuarantineListArgv(options)];
  const result = deps.spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runSecQuarantineGc(options: SecQuarantineGcOptions, deps: SecScanDeps = defaultDeps): number {
  const scriptPath = resolveSecRemediateScript(process.argv[1], deps);
  const args = [scriptPath, ...buildSecQuarantineGcArgv(options)];
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
    .option('--json', 'Output as JSON')
    .option('--all-homes', 'Scan /root, /home/*, /Users/*, and WSL Windows homes when present')
    .option('--home <path>', 'Add a specific home directory to scan', collectRepeatedOption, [])
    .option('--root <path>', 'Add an application root to scan for project evidence', collectRepeatedOption, [])
    .action((options: SecScanCommandOptions) => {
      const exitCode = runSecScan(options, deps);
      applySecScanExitCode(exitCode, deps);
    });

  sec
    .command('remediate')
    .description('Reversibly remediate findings from a sec scan (dry-run by default)')
    .option('--dry-run', 'Generate a plan manifest without mutating anything (default mode)')
    .option('--apply', 'Execute a previously-generated plan (requires --plan)')
    .option('--resume <path>', 'Resume a previously-aborted apply from its resume file')
    .option('--scan-report <path>', 'Path to a scan JSON report (use with --dry-run)')
    .option('--scan-id <ulid>', 'ULID of a persisted scan in $GENIE_HOME/sec-scan/')
    .option('--plan <path>', 'Path to a frozen plan manifest (required with --apply)')
    .option('--quarantine-dir <path>', 'Override quarantine root (must be on same device as targets)')
    .option('--unsafe-unverified <id>', 'Bypass binary signature requirement (logs incident id + ack)')
    .option('--remediate-partial', 'Allow remediation against a coverage-capped scan (requires typed ack)')
    .option('--confirm-incomplete-scan <ack>', 'Typed ack for --remediate-partial')
    .option('--kill-pid <pid>', 'Authorize SIGTERM to a PID matching a plan entry', collectKillPid, [])
    .option('--auto-confirm-from <path>', 'Non-interactive consent map (testing only)')
    .option('--json', 'Emit JSON summary to stdout')
    .action((options: SecRemediateCommandOptions) => {
      const normalized: SecRemediateCommandOptions = { ...options };
      if (!normalized.dryRun && !normalized.apply && !normalized.resume) {
        normalized.dryRun = true;
      }
      const exitCode = runSecRemediate(normalized, deps);
      applySecScanExitCode(exitCode, deps);
    });

  sec
    .command('restore <quarantine-id>')
    .description('Restore every action under a quarantine id (sha256-verified per file)')
    .action((quarantineId: string) => {
      const exitCode = runSecRestore(quarantineId, deps);
      applySecScanExitCode(exitCode, deps);
    });

  sec
    .command('rollback <scan-id>')
    .description('Bulk undo every quarantined action for a scan (walks audit log in reverse)')
    .option('--json', 'Emit JSON summary to stdout')
    .action((scanId: string, options: SecRollbackOptions) => {
      const exitCode = runSecRollback(scanId, options, deps);
      applySecScanExitCode(exitCode, deps);
    });

  const quarantine = sec.command('quarantine').description('Quarantine lifecycle (list, gc)');

  quarantine
    .command('list')
    .description('List quarantines with id, timestamp, size, status, scan_id')
    .option('--json', 'Emit JSON rows to stdout')
    .action((options: SecQuarantineListOptions) => {
      const exitCode = runSecQuarantineList(options, deps);
      applySecScanExitCode(exitCode, deps);
    });

  quarantine
    .command('gc')
    .description('Delete restored/abandoned quarantines older than <duration> (refuses active)')
    .requiredOption('--older-than <duration>', 'Duration threshold, e.g. 30d, 24h, 15m')
    .option('--confirm-gc <token>', 'Typed ack: CONFIRM-GC-<6-hex>')
    .option('--json', 'Emit JSON summary to stdout')
    .action((options: SecQuarantineGcOptions) => {
      const exitCode = runSecQuarantineGc(options, deps);
      applySecScanExitCode(exitCode, deps);
    });
}
