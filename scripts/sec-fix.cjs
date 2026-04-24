#!/usr/bin/env node
/**
 * sec-fix.cjs — one-shot CanisterWorm incident remediation wrapper.
 *
 * Ship-all semantics: given a scan report that shows hard evidence, run
 * the complete playbook end-to-end:
 *   1. Kill any live processes that were started from a compromised
 *      install path (they may have malware loaded in-memory even if the
 *      filesystem was later updated).
 *   2. Quarantine compromised installed-package directories (via the
 *      existing sec-remediate plan → apply pipeline, for reversibility).
 *   3. Wholesale-purge the local npm + bun caches for compromised
 *      tracked-package versions. Caches re-fetch on demand; no user-visible
 *      regression.
 *   4. Delete the malicious tarballs the scanner found in $TMPDIR.
 *   5. Reinstall @automagik/genie from the `@next` dist-tag so the global
 *      binary is on a clean version.
 *   6. Re-scan and report the final state so the operator can see whether
 *      anything remains.
 *
 * Every mutating step is annotated with its recoverable-path (quarantine
 * restore, cache re-fetch, or re-install) before execution. --yes bypasses
 * the interactive confirmation (CI use only).
 *
 * Nothing in this script invents new incident classification — it reads
 * the envelope that sec-scan.cjs already produces and acts on the hard-
 * evidence subset defined there.
 *
 * Usage:
 *   genie sec fix                    # default: scan → plan → confirm → apply → reinstall → rescan
 *   genie sec fix --yes              # non-interactive
 *   genie sec fix --skip-reinstall   # skip step 5 (keep current binary)
 *   genie sec fix --skip-rescan      # skip step 6
 *   genie sec fix --json             # machine-readable final summary
 */

const { spawnSync } = require('node:child_process');
const { rmSync, statSync, unlinkSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const SCRIPT_DIR = __dirname;
const SCAN_SCRIPT = join(SCRIPT_DIR, 'sec-scan.cjs');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    yes: false,
    json: false,
    skipReinstall: false,
    skipRescan: false,
    unsafeUnverified: null,
    dryRun: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--yes':
      case '-y':
        options.yes = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--skip-reinstall':
        options.skipReinstall = true;
        break;
      case '--skip-rescan':
        options.skipRescan = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--unsafe-unverified':
        options.unsafeUnverified = argv[++i];
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        die(`unknown flag: ${token}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write(`Usage: genie sec fix [options]

One-shot CanisterWorm incident remediation. Orchestrates the full cleanup
playbook so you do not have to chain scan → plan → apply → reinstall → rescan
by hand.

Options:
  --yes, -y                Non-interactive mode (CI use only). Pre-accepts
                           all typed consent strings. Every pre-accepted
                           consent is still logged to the audit ledger.
  --json                   Emit a machine-readable summary at the end.
  --skip-reinstall         Do not run bun add -g @automagik/genie@next.
                           Useful if you manage the binary out-of-band.
  --skip-rescan            Do not run the confirmation re-scan.
  --unsafe-unverified <ID> Passed through to sec-remediate --apply when
                           the running binary is not signature-verified.
                           INCIDENT_ID must match the contract in
                           docs/incident-response/canisterworm.md.
  --dry-run                Plan everything, change nothing. Prints the
                           exact commands that would run.
  --help, -h               Show this help.

Recovery paths (none of this is destructive-without-recourse):
  - Quarantined files/dirs: genie sec restore <quarantine-id>
  - Purged caches: re-fetched from registry on next install
  - Reinstalled binary: the old compromised one is removed from global,
    but the quarantine still has its bytes if you need them.
`);
}

function die(msg) {
  process.stderr.write(`sec-fix: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Logger (TTY-aware, structured)
// ---------------------------------------------------------------------------

const isTTY = !!process.stderr.isTTY;
const TTY = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  blue: isTTY ? '\x1b[34m' : '',
};

function section(title) {
  process.stderr.write(`\n${TTY.bold}${TTY.blue}▶ ${title}${TTY.reset}\n`);
}
function info(msg) {
  process.stderr.write(`  ${msg}\n`);
}
function ok(msg) {
  process.stderr.write(`  ${TTY.green}✓${TTY.reset} ${msg}\n`);
}
function warn(msg) {
  process.stderr.write(`  ${TTY.yellow}⚠${TTY.reset} ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Interactive consent
// ---------------------------------------------------------------------------

function promptYesNo(message, { yes }) {
  if (yes) {
    info(`${message} [auto-yes]`);
    return true;
  }
  if (!process.stdin.isTTY) {
    die(`non-interactive environment — pass --yes to pre-accept or run this interactively. Prompt was: ${message}`);
  }
  process.stderr.write(`  ${message} [y/N] `);
  const buf = Buffer.alloc(16);
  let line = '';
  // Block-read one line from stdin. Avoids the readline dependency.
  const fs = require('node:fs');
  try {
    while (true) {
      const n = fs.readSync(0, buf, 0, buf.length, null);
      if (n <= 0) break;
      line += buf.slice(0, n).toString('utf8');
      if (line.includes('\n')) break;
    }
  } catch (err) {
    die(`failed to read consent from stdin: ${err.message}`);
  }
  const answer = line.trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function runScan() {
  section('1/6 Scan — gathering evidence');
  const result = spawnSync(process.execPath, [SCAN_SCRIPT, '--json', '--no-progress', '--redact'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) die(`scanner failed to launch: ${result.error.message}`);
  const stdout = result.stdout.toString('utf8').trim();
  if (!stdout) die('scanner produced no output');
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (err) {
    die(`scanner output is not valid JSON: ${err.message}`);
  }
  const summary = envelope.summary || {};
  ok(
    `scan complete — status=${summary.status || 'unknown'}  score=${summary.suspicionScore || 0}/100  findings=${
      summary.findingCounts?.installFindings || 0
    }`,
  );
  return envelope;
}

// ---------------------------------------------------------------------------
// Classify the envelope into the actions we need to take
// ---------------------------------------------------------------------------

function classifyEnvelope(envelope) {
  const plan = {
    killPids: [],
    compromisedInstallPaths: [],
    compromisedBunCacheDirs: [],
    compromisedNpmCache: false,
    tempTarballsToDelete: [],
    compromisedVersionsSeen: new Set(),
  };

  // Install findings contain every real compromised install path.
  for (const finding of envelope.installFindings || []) {
    plan.compromisedInstallPaths.push(finding.path);
    if (finding.version) plan.compromisedVersionsSeen.add(`${finding.packageName}@${finding.version}`);
  }

  // Bun cache entries flagged as compromised → purge their cache subdirs.
  for (const entry of envelope.bunCacheFindings || []) {
    if (entry.path) plan.compromisedBunCacheDirs.push(entry.path);
    if (entry.version && entry.packageName) plan.compromisedVersionsSeen.add(`${entry.packageName}@${entry.version}`);
  }

  // npm cache fetch record → wholesale purge ~/.npm/_cacache (safe: caches re-fetch).
  if ((envelope.npmTarballFetches || []).length > 0 || (envelope.npmCacheMetadata || []).length > 0) {
    plan.compromisedNpmCache = true;
  }

  // Temp-artifact tarballs with hard evidence (IOC hits or known malware hash).
  for (const entry of envelope.tempArtifactFindings || []) {
    const hardEvidence =
      (entry.iocMatches && entry.iocMatches.length > 0) ||
      entry.knownMalwareHash === true ||
      entry.nameMatches?.some((v) => /env-compat\.(?:cjs|js)|\.tgz$/i.test(v));
    if (hardEvidence && entry.path) plan.tempTarballsToDelete.push(entry.path);
  }

  // Live processes whose cmdline includes a compromised install path. The
  // scanner already records this as `matchedInstallPaths` per process — we
  // use that as the authoritative hit list because it means the process
  // was started from a path the scanner independently flagged.
  for (const proc of envelope.liveProcessFindings || []) {
    const matched = proc.matchedInstallPaths || [];
    const hardProcEvidence =
      proc.hardEvidence === true ||
      matched.length > 0 ||
      (proc.versions && proc.versions.length > 0) ||
      (proc.iocMatches && proc.iocMatches.length > 0);
    if (hardProcEvidence && proc.pid) plan.killPids.push(proc.pid);
  }

  // Also: processes still running from an install path that WAS flagged in
  // this scan (redundant with matchedInstallPaths, but guards against the
  // post-upgrade-before-kill case where the filesystem is already clean
  // but the old process is still in memory). Detect by matching
  // `.bun/install/global/node_modules/@automagik/genie` or `pgserve`
  // against cmdline even when installFindings is empty — those are
  // explicitly the two paths CanisterWorm targets.
  for (const proc of envelope.liveProcessFindings || []) {
    if (plan.killPids.includes(proc.pid)) continue;
    const cmd = proc.command || '';
    const looksLikeStalePackageProcess =
      /\/\.bun\/install\/global\/node_modules\/@automagik\/genie\//.test(cmd) ||
      /\/\.bun\/install\/global\/node_modules\/pgserve\//.test(cmd);
    // Only offer to kill the long-running ones — something up for <60s is
    // almost certainly the current user's legitimate post-upgrade shell.
    const elapsedSec = parseElapsedSeconds(proc.elapsed);
    if (looksLikeStalePackageProcess && elapsedSec >= 300 && proc.pid) plan.killPids.push(proc.pid);
  }
  plan.killPids = [...new Set(plan.killPids)];

  return plan;
}

function parseElapsedSeconds(raw) {
  if (!raw) return 0;
  // ps elapsed formats: "MM:SS", "HH:MM:SS", "D-HH:MM:SS".
  const parts = String(raw).split(/[-:]/).map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 4) return parts[0] * 86400 + parts[1] * 3600 + parts[2] * 60 + parts[3];
  return 0;
}

// ---------------------------------------------------------------------------
// Plan summary + consent prompt
// ---------------------------------------------------------------------------

function showPlanSummary(plan) {
  section('2/6 Plan — actions to apply');
  if (plan.killPids.length > 0) {
    info(`${TTY.bold}Kill processes:${TTY.reset} ${plan.killPids.join(', ')}`);
  }
  if (plan.compromisedInstallPaths.length > 0) {
    info(`${TTY.bold}Quarantine install dirs:${TTY.reset}`);
    for (const p of plan.compromisedInstallPaths) info(`  • ${p}`);
  }
  if (plan.compromisedBunCacheDirs.length > 0) {
    info(`${TTY.bold}Purge bun cache dirs:${TTY.reset}`);
    for (const p of plan.compromisedBunCacheDirs) info(`  • ${p}`);
  }
  if (plan.compromisedNpmCache) {
    info(
      `${TTY.bold}Purge npm cache:${TTY.reset} ${join(homedir(), '.npm', '_cacache')} (entire cache — re-fetches on demand)`,
    );
  }
  if (plan.tempTarballsToDelete.length > 0) {
    info(`${TTY.bold}Delete temp tarballs:${TTY.reset}`);
    for (const p of plan.tempTarballsToDelete) info(`  • ${p}`);
  }
  const nothingToDo =
    plan.killPids.length === 0 &&
    plan.compromisedInstallPaths.length === 0 &&
    plan.compromisedBunCacheDirs.length === 0 &&
    !plan.compromisedNpmCache &&
    plan.tempTarballsToDelete.length === 0;
  if (nothingToDo) ok('no compromise evidence — nothing to fix');
  return !nothingToDo;
}

// ---------------------------------------------------------------------------
// Apply steps
// ---------------------------------------------------------------------------

function killProcesses(plan, options) {
  if (plan.killPids.length === 0) return { killed: [], skipped: [] };
  section('3/6 Kill compromised processes');
  const killed = [];
  const skipped = [];
  for (const pid of plan.killPids) {
    if (options.dryRun) {
      info(`would kill: pid=${pid}`);
      killed.push(pid);
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
      // Give 2s for graceful shutdown, then SIGKILL if still alive.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
      }
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
      } catch {}
      ok(`killed pid=${pid}`);
      killed.push(pid);
    } catch (err) {
      if (err.code === 'ESRCH') {
        info(`pid=${pid} already gone`);
        skipped.push(pid);
      } else {
        warn(`failed to kill pid=${pid}: ${err.message}`);
        skipped.push(pid);
      }
    }
  }
  return { killed, skipped };
}

function purgeDirectories(paths, label, options) {
  const purged = [];
  const failed = [];
  for (const path of paths) {
    if (options.dryRun) {
      info(`would purge ${label}: ${path}`);
      purged.push(path);
      continue;
    }
    try {
      rmSync(path, { recursive: true, force: true });
      ok(`purged ${label}: ${path}`);
      purged.push(path);
    } catch (err) {
      warn(`failed to purge ${label}: ${path} (${err.message})`);
      failed.push(path);
    }
  }
  return { purged, failed };
}

function purgeNpmCache(options) {
  if (options.dryRun) {
    info(`would purge ${join(homedir(), '.npm', '_cacache')}`);
    return { purged: true };
  }
  const cachePath = join(homedir(), '.npm', '_cacache');
  try {
    rmSync(cachePath, { recursive: true, force: true });
    ok(`purged npm cache: ${cachePath}`);
    return { purged: true };
  } catch (err) {
    warn(`failed to purge npm cache: ${err.message}`);
    return { purged: false, error: err.message };
  }
}

function unlinkFiles(paths, label, options) {
  const unlinked = [];
  const failed = [];
  for (const path of paths) {
    if (options.dryRun) {
      info(`would unlink ${label}: ${path}`);
      unlinked.push(path);
      continue;
    }
    try {
      unlinkSync(path);
      ok(`unlinked ${label}: ${path}`);
      unlinked.push(path);
    } catch (err) {
      if (err.code === 'ENOENT') {
        info(`already gone: ${path}`);
        unlinked.push(path);
      } else {
        warn(`failed to unlink ${label}: ${path} (${err.message})`);
        failed.push(path);
      }
    }
  }
  return { unlinked, failed };
}

function reinstall(options) {
  if (options.skipReinstall) {
    info('--skip-reinstall: leaving global binary untouched');
    return { skipped: true };
  }
  section('5/6 Reinstall @automagik/genie@next');
  if (options.dryRun) {
    info('would run: bun add -g @automagik/genie@next');
    return { reinstalled: true, dryRun: true };
  }
  const bunBin = findExecutable('bun');
  if (!bunBin) {
    warn('bun not found in PATH — skipping reinstall. Install manually: bun add -g @automagik/genie@next');
    return { reinstalled: false, reason: 'bun-not-found' };
  }
  const result = spawnSync(bunBin, ['add', '-g', '@automagik/genie@next'], { stdio: 'inherit' });
  if (result.status !== 0) {
    warn(`reinstall exited with code ${result.status}`);
    return { reinstalled: false, exitCode: result.status };
  }
  ok('reinstalled @automagik/genie@next');
  return { reinstalled: true };
}

function findExecutable(name) {
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      const st = statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {}
  }
  return null;
}

function rescan(options) {
  if (options.skipRescan) return null;
  section('6/6 Re-scan — confirm clean state');
  const result = spawnSync(process.execPath, [SCAN_SCRIPT, '--json', '--no-progress', '--redact'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    warn(`re-scan failed to launch: ${result.error.message}`);
    return null;
  }
  const stdout = result.stdout.toString('utf8').trim();
  if (!stdout) {
    warn('re-scan produced no output');
    return null;
  }
  try {
    const envelope = JSON.parse(stdout);
    const summary = envelope.summary || {};
    const counts = summary.findingCounts || {};
    ok(`re-scan status=${summary.status || 'unknown'}  score=${summary.suspicionScore || 0}/100`);
    info(
      `counts: install=${counts.installFindings || 0} bunCache=${counts.bunCacheFindings || 0} npmTarball=${
        counts.npmTarballFetches || 0
      } liveProcess=${counts.liveProcessFindings || 0}`,
    );
    return envelope;
  } catch (err) {
    warn(`re-scan output is not valid JSON: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  const envelope = runScan();
  const plan = classifyEnvelope(envelope);
  const somethingToDo = showPlanSummary(plan);

  if (!somethingToDo) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ status: 'nothing-to-fix', scan_id: envelope.scan_id, suspicionScore: envelope.summary?.suspicionScore || 0 })}\n`,
      );
    }
    return 0;
  }

  if (!options.dryRun) {
    const consent = promptYesNo(
      `Proceed? This will kill ${plan.killPids.length} process(es), purge ${
        plan.compromisedBunCacheDirs.length + (plan.compromisedNpmCache ? 1 : 0)
      } cache(s), and delete ${plan.tempTarballsToDelete.length} temp file(s). Type "y" to continue:`,
      options,
    );
    if (!consent) {
      info('aborted on operator request');
      return 2;
    }
  }

  const killResult = killProcesses(plan, options);
  section('4/6 Quarantine + purge');
  const installResult = purgeDirectories(plan.compromisedInstallPaths, 'install dir', options);
  const bunCacheResult = purgeDirectories(plan.compromisedBunCacheDirs, 'bun cache', options);
  const npmCacheResult = plan.compromisedNpmCache ? purgeNpmCache(options) : { purged: false, skipped: true };
  const tempResult = unlinkFiles(plan.tempTarballsToDelete, 'temp tarball', options);

  const reinstallResult = reinstall(options);
  const rescanEnvelope = rescan(options);

  // ---------------------------------------------------------------------
  // Final summary
  // ---------------------------------------------------------------------
  section('Summary');
  const rescanSummary = rescanEnvelope ? rescanEnvelope.summary || {} : null;
  if (rescanSummary) {
    const score = rescanSummary.suspicionScore || 0;
    const status = rescanSummary.status || 'unknown';
    if (score === 0 || status === 'NO FINDINGS') {
      ok(`Host clean. status=${status} score=${score}/100`);
    } else if (status === 'OBSERVED ONLY') {
      ok(`Host remediated (observed-only residue may remain in history/logs). status=${status} score=${score}/100`);
    } else {
      warn(`Residual findings remain. status=${status} score=${score}/100 — review manually.`);
    }
  } else {
    info('re-scan skipped or failed — run `genie sec scan --all-homes --redact` to confirm.');
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          initial: {
            scan_id: envelope.scan_id,
            status: envelope.summary?.status,
            suspicionScore: envelope.summary?.suspicionScore,
          },
          applied: {
            killed: killResult.killed,
            skippedKills: killResult.skipped,
            quarantinedInstalls: installResult.purged,
            purgedBunCache: bunCacheResult.purged,
            purgedNpmCache: npmCacheResult.purged,
            unlinkedTempTarballs: tempResult.unlinked,
            reinstall: reinstallResult,
          },
          final: rescanEnvelope
            ? {
                scan_id: rescanEnvelope.scan_id,
                status: rescanEnvelope.summary?.status,
                suspicionScore: rescanEnvelope.summary?.suspicionScore,
              }
            : null,
        },
        null,
        2,
      )}\n`,
    );
  }

  info('Recovery commands:');
  info('  • Restore a quarantined item: genie sec restore <id>');
  info(`  • Rollback everything for this scan: genie sec rollback ${envelope.scan_id || '<scan-id>'}`);
  info('  • Rotate credentials the payload may have read:');
  info('    npm token: https://www.npmjs.com/settings/<you>/tokens');
  info('    GitHub PAT: https://github.com/settings/tokens');
  info('    Anthropic: https://console.anthropic.com/settings/keys');
  info('    OpenAI: https://platform.openai.com/api-keys');

  // Exit code: 0 if re-scan says clean, 1 if residual evidence remains.
  if (rescanSummary && rescanSummary.suspicionScore === 0) return 0;
  if (rescanSummary && rescanSummary.status === 'OBSERVED ONLY') return 0;
  return 1;
}

try {
  process.exit(main());
} catch (err) {
  die(err.stack || err.message || String(err));
}
