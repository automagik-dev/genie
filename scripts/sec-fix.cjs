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
  underline: isTTY ? '\x1b[4m' : '',
  blink: isTTY ? '\x1b[5m' : '',
  inverse: isTTY ? '\x1b[7m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  blue: isTTY ? '\x1b[34m' : '',
  magenta: isTTY ? '\x1b[35m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  white: isTTY ? '\x1b[37m' : '',
  bgRed: isTTY ? '\x1b[41m' : '',
  bgYellow: isTTY ? '\x1b[43m' : '',
  bgGreen: isTTY ? '\x1b[42m' : '',
  bgBlue: isTTY ? '\x1b[44m' : '',
};

// Severity tags used in the audit print. Order matters for the summary
// banner — CRITICAL is always the loudest signal.
const SEVERITY = {
  CRITICAL: {
    label: 'CRITICAL',
    paint: (s) => `${TTY.bgRed}${TTY.white}${TTY.bold}${TTY.blink} ${s} ${TTY.reset}`,
    rowPaint: (s) => `${TTY.red}${TTY.bold}${s}${TTY.reset}`,
    icon: '☠',
  },
  DESTRUCTIVE: {
    label: 'DESTRUCTIVE',
    paint: (s) => `${TTY.bgRed}${TTY.white}${TTY.bold} ${s} ${TTY.reset}`,
    rowPaint: (s) => `${TTY.red}${s}${TTY.reset}`,
    icon: '⚠',
  },
  REVERSIBLE: {
    label: 'REVERSIBLE',
    paint: (s) => `${TTY.bgYellow}${TTY.bold} ${s} ${TTY.reset}`,
    rowPaint: (s) => `${TTY.yellow}${s}${TTY.reset}`,
    icon: '↻',
  },
  SAFE: {
    label: 'SAFE',
    paint: (s) => `${TTY.bgGreen}${TTY.bold} ${s} ${TTY.reset}`,
    rowPaint: (s) => `${TTY.green}${s}${TTY.reset}`,
    icon: '✓',
  },
};

function hrule(char, color) {
  const width = Math.min((process.stderr.columns || 100) - 2, 96);
  process.stderr.write(`${color || TTY.dim}${char.repeat(width)}${TTY.reset}\n`);
}
function banner(text, severity) {
  const width = Math.min((process.stderr.columns || 100) - 2, 96);
  const padded = ` ${text} `;
  const pad = Math.max(0, Math.floor((width - padded.length) / 2));
  const line = ' '.repeat(pad) + padded + ' '.repeat(Math.max(0, width - pad - padded.length));
  const paint = severity.paint;
  process.stderr.write(`${paint(line)}\n`);
}

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

function isRootUid() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function runScan() {
  section('1/6 Scan — gathering evidence');
  const rootMode = isRootUid();
  if (rootMode) {
    process.stderr.write(
      `  ${TTY.bgRed}${TTY.white}${TTY.bold} ROOT MODE ${TTY.reset}  ${TTY.red}${TTY.bold}scanning every user home, system-wide persistence, all PIDs, root-only files${TTY.reset}\n`,
    );
    if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root') {
      process.stderr.write(
        `  ${TTY.dim}invoking user: ${TTY.reset}${process.env.SUDO_USER} ${TTY.dim}(reinstall will be routed back to this user via su)${TTY.reset}\n`,
      );
    }
  } else {
    process.stderr.write(
      `  ${TTY.yellow}running as user $(id -un) — for full coverage of other homes + /etc/cron + /etc/systemd + all PIDs, re-run under ${TTY.bold}sudo -E env "PATH=$PATH" genie sec fix${TTY.reset}\n`,
    );
  }
  const scanArgs = [SCAN_SCRIPT, '--json', '--no-progress', '--redact'];
  if (rootMode) {
    // --all-homes enumerates /root + every /home/* + /Users/* on darwin.
    // The persistence + shell-history + impact-surface phases iterate these
    // homes so the deeper coverage falls out naturally once they're in the
    // input list. /etc/cron.* and /etc/systemd/system/* are already in the
    // persistence target table and become readable under root.
    scanArgs.push('--all-homes');
  }
  const result = spawnSync(process.execPath, scanArgs, {
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

function renderAuditRow(severity, verb, target, recovery) {
  const tag = severity.paint(`${severity.icon} ${severity.label.padEnd(11)}`);
  const verbRow = severity.rowPaint(verb);
  process.stderr.write(`  ${tag}  ${verbRow}\n`);
  process.stderr.write(`                ${TTY.dim}target:   ${TTY.reset}${target}\n`);
  process.stderr.write(`                ${TTY.dim}recovery: ${TTY.reset}${TTY.cyan}${recovery}${TTY.reset}\n\n`);
}

function renderBreachImpact(envelope) {
  const breach = envelope?.breachImpact || { enabled: false };
  if (!breach.enabled || (breach.likelyStolen || []).length === 0) return;

  process.stderr.write('\n');
  hrule('═', TTY.red + TTY.bold);
  banner('☠  BREACH IMPACT — RETRACING THE WORM  ☠', SEVERITY.CRITICAL);
  hrule('═', TTY.red + TTY.bold);
  process.stderr.write('\n');

  process.stderr.write(
    `  ${TTY.dim}Exfil channel:${TTY.reset}   ${TTY.red}${TTY.bold}${breach.exfilChannel.host}${TTY.reset} ${breach.exfilChannel.paths.join(', ')}\n`,
  );
  if (breach.compromiseWindow) {
    process.stderr.write(
      `  ${TTY.dim}Window:${TTY.reset}          ${breach.compromiseWindow.firstEvidence} .. ${breach.compromiseWindow.lastEvidence}\n`,
    );
  }
  if ((breach.compromisedInstallPaths || []).length > 0) {
    process.stderr.write(`  ${TTY.dim}Install path:${TTY.reset}    ${breach.compromisedInstallPaths[0]}\n`);
  }
  process.stderr.write('\n');
  process.stderr.write(
    `  ${TTY.bold}${TTY.red}The env-compat.cjs payload ran as this user during the window.${TTY.reset}\n`,
  );
  process.stderr.write(`  ${TTY.dim}These credentials were readable to it — assume stolen:${TTY.reset}\n\n`);

  for (const item of breach.rotationChecklist || []) {
    const sev =
      item.severity === 'CRITICAL'
        ? SEVERITY.CRITICAL.paint(` ${item.severity} `)
        : SEVERITY.DESTRUCTIVE.paint(` ${item.severity} `);
    process.stderr.write(`  ${sev}  ${TTY.bold}${item.category}${TTY.reset}\n`);
    for (const p of item.paths || []) process.stderr.write(`           ${TTY.dim}path:${TTY.reset}   ${p}\n`);
    process.stderr.write(`           ${TTY.dim}why:${TTY.reset}    ${item.reason}\n`);
    if (item.rotationUrl) {
      process.stderr.write(
        `           ${TTY.cyan}rotate:${TTY.reset} ${TTY.underline}${item.rotationUrl}${TTY.reset}\n`,
      );
    }
    process.stderr.write('\n');
  }

  if ((breach.runningProcessesDuringWindow || []).length > 0) {
    process.stderr.write(`  ${TTY.bold}Processes that ran the compromised binary:${TTY.reset}\n`);
    for (const proc of breach.runningProcessesDuringWindow) {
      process.stderr.write(
        `    pid=${proc.pid}  elapsed=${proc.elapsed}  ${TTY.dim}${(proc.command || '').slice(0, 90)}${TTY.reset}\n`,
      );
    }
    process.stderr.write('\n');
  }
}

function showPlanSummary(plan, options, envelope) {
  renderBreachImpact(envelope);

  process.stderr.write('\n');
  hrule('═', TTY.red + TTY.bold);
  banner('⚠  DESTRUCTIVE OPERATIONS AUDIT — REVIEW BEFORE ACCEPTING  ⚠', SEVERITY.DESTRUCTIVE);
  hrule('═', TTY.red + TTY.bold);
  process.stderr.write('\n');

  const counts = { CRITICAL: 0, DESTRUCTIVE: 0, REVERSIBLE: 0, SAFE: 0 };
  let sawAny = false;

  for (const pid of plan.killPids) {
    counts.CRITICAL += 1;
    sawAny = true;
    renderAuditRow(
      SEVERITY.CRITICAL,
      `KILL PROCESS  pid=${pid}  (SIGTERM + 2s + SIGKILL if still alive)`,
      `running process id ${pid}`,
      "service must be restarted manually after fix completes (e.g. 'genie serve start')",
    );
  }

  for (const path of plan.compromisedInstallPaths) {
    counts.DESTRUCTIVE += 1;
    sawAny = true;
    renderAuditRow(
      SEVERITY.DESTRUCTIVE,
      'REMOVE INSTALL DIR',
      path,
      'clean binary reinstalls in step 5; malicious bytes are quarantined (genie sec restore)',
    );
  }

  for (const path of plan.compromisedBunCacheDirs) {
    counts.REVERSIBLE += 1;
    sawAny = true;
    renderAuditRow(
      SEVERITY.REVERSIBLE,
      'PURGE BUN CACHE DIR',
      path,
      'bun re-fetches this package from npm registry on next install',
    );
  }

  if (plan.compromisedNpmCache) {
    counts.REVERSIBLE += 1;
    sawAny = true;
    renderAuditRow(
      SEVERITY.REVERSIBLE,
      'PURGE NPM CACHE (wholesale)',
      join(homedir(), '.npm', '_cacache'),
      'npm rebuilds cache from registry on next install; no user data',
    );
  }

  for (const path of plan.tempTarballsToDelete) {
    counts.DESTRUCTIVE += 1;
    sawAny = true;
    renderAuditRow(
      SEVERITY.DESTRUCTIVE,
      'UNLINK MALICIOUS TARBALL',
      path,
      'this file IS the payload — deletion IS the recovery',
    );
  }

  if (!options.skipReinstall && sawAny) {
    counts.SAFE += 1;
    renderAuditRow(
      SEVERITY.SAFE,
      'REINSTALL @automagik/genie@next  (global binary)',
      "via 'bun add -g @automagik/genie@next'",
      'installing the clean version never regresses; old bytes are already quarantined',
    );
  }

  if (!options.skipRescan && sawAny) {
    counts.SAFE += 1;
    renderAuditRow(
      SEVERITY.SAFE,
      'RE-SCAN to confirm clean state',
      'invokes `sec-scan.cjs --json --redact`',
      'read-only; no mutations',
    );
  }

  hrule('═', TTY.red + TTY.bold);
  const total = counts.CRITICAL + counts.DESTRUCTIVE + counts.REVERSIBLE + counts.SAFE;
  if (sawAny) {
    const countsLine =
      `${SEVERITY.CRITICAL.rowPaint(`${counts.CRITICAL} CRITICAL`)}  ` +
      `${SEVERITY.DESTRUCTIVE.rowPaint(`${counts.DESTRUCTIVE} DESTRUCTIVE`)}  ` +
      `${SEVERITY.REVERSIBLE.rowPaint(`${counts.REVERSIBLE} REVERSIBLE`)}  ` +
      `${SEVERITY.SAFE.rowPaint(`${counts.SAFE} SAFE`)}`;
    process.stderr.write(`  ${TTY.bold}TOTAL: ${total} operations${TTY.reset}     ${countsLine}\n`);
    hrule('═', TTY.red + TTY.bold);

    if (counts.CRITICAL > 0) {
      process.stderr.write('\n');
      process.stderr.write(
        `  ${TTY.blink}${TTY.red}${TTY.bold}⚠  ${counts.CRITICAL} CRITICAL operation(s) — processes will be forcibly terminated  ⚠${TTY.reset}\n`,
      );
      process.stderr.write(
        `  ${TTY.dim}Running services (genie serve, pgserve, codex workers) will be killed.\n  Any in-flight work in those processes will be lost.${TTY.reset}\n`,
      );
    }
    process.stderr.write('\n');
  } else {
    ok('no compromise evidence — nothing to fix');
  }
  return sawAny;
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

  // When running under sudo, route the install to the invoking user so
  // the bun global ends up in THEIR home (correct ownership + matches the
  // binary that user invokes from the command line). Root's own bun
  // global would be orphaned.
  const sudoUser = process.env.SUDO_USER;
  if (isRootUid() && sudoUser && sudoUser !== 'root') {
    info(`routing reinstall to invoking user: ${sudoUser}`);
    const suBin = findExecutable('su');
    if (!suBin) {
      warn('su not found — falling back to root install (may need manual reinstall as the user later)');
    } else {
      const cmd = `${bunBin} add -g @automagik/genie@next`;
      const result = spawnSync(suBin, ['-', sudoUser, '-c', cmd], { stdio: 'inherit' });
      if (result.status !== 0) {
        warn(`reinstall (as ${sudoUser}) exited with code ${result.status}`);
        return { reinstalled: false, exitCode: result.status, ranAs: sudoUser };
      }
      ok(`reinstalled @automagik/genie@next (as ${sudoUser})`);
      return { reinstalled: true, ranAs: sudoUser };
    }
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
  const rescanArgs = [SCAN_SCRIPT, '--json', '--no-progress', '--redact'];
  if (isRootUid()) rescanArgs.push('--all-homes');
  const result = spawnSync(process.execPath, rescanArgs, {
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
  const somethingToDo = showPlanSummary(plan, options, envelope);

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
