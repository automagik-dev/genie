#!/usr/bin/env node
/**
 * sec-scan.cjs
 *
 * Read-only compromise triage scanner for the CanisterWorm / TeamPCP-style
 * Namastex ecosystem compromise. It covers the known malicious
 * @automagik/genie publish window plus sibling packages and malware-family
 * indicators reported in public research.
 *
 * It checks:
 * - npm cache metadata snapshots that observed compromised versions
 * - npm cache tarball fetch records for compromised versions
 * - bun install cache directories for compromised versions
 * - global and local node_modules installs for affected packages
 * - lockfiles and npm logs that reference compromised versions
 * - shell histories for install / execution evidence
 * - shell startup files for persistence or IOC references
 * - launchd / systemd / cron / autostart persistence locations
 * - Python .pth injection paths used for propagation
 * - temp and cache directories for dropped artifacts and IOC strings
 * - live process listings for suspicious execution evidence
 *
 * Usage:
 *   node scripts/sec-scan.cjs
 *   node scripts/sec-scan.cjs --json
 *   node scripts/sec-scan.cjs --all-homes --root /srv --root /opt
 *   genie sec scan
 *   genie sec scan --json --all-homes
 *
 * Exit codes:
 *   0 = no findings
 *   1 = observed-only findings (metadata / logs / lockfiles)
 *   2 = likely affected or likely compromised
 */

const { gunzipSync } = require('node:zlib');
const { existsSync, readFileSync, readdirSync, realpathSync, statSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { homedir, hostname, release, userInfo } = require('node:os');
const { join, resolve, basename } = require('node:path');
const { spawnSync } = require('node:child_process');

const PACKAGE_NAME = '@automagik/genie';

const COMPROMISED_VERSIONS = [
  '4.260421.33',
  '4.260421.34',
  '4.260421.35',
  '4.260421.36',
  '4.260421.37',
  '4.260421.38',
  '4.260421.39',
  '4.260421.40',
];

const COMPROMISE_WINDOW = {
  start: '2026-04-21T21:28:20.690Z',
  end: '2026-04-22T03:34:42.780Z',
};

const COMPROMISED_VERSION_SET = new Set(COMPROMISED_VERSIONS);

const TRACKED_PACKAGES = [
  { name: PACKAGE_NAME, versions: COMPROMISED_VERSIONS },
  { name: 'pgserve', versions: ['1.1.11', '1.1.12', '1.1.13'] },
  { name: '@fairwords/websocket', versions: ['1.0.38', '1.0.39'] },
  { name: '@fairwords/loopback-connector-es', versions: ['1.4.3', '1.4.4'] },
  { name: '@openwebconcept/design-tokens', versions: ['1.0.3'] },
  { name: '@openwebconcept/theme-owc', versions: ['1.0.3'] },
];

const TRACKED_PACKAGE_NAME_SET = new Set(TRACKED_PACKAGES.map((entry) => entry.name));
const TRACKED_VERSION_SET = new Set(uniq(TRACKED_PACKAGES.flatMap((entry) => entry.versions)));
const TRACKED_PACKAGE_VERSION_SET = new Set(
  TRACKED_PACKAGES.flatMap((entry) => entry.versions.map((version) => `${entry.name}@${version}`)),
);

const IOC_FILE_SUFFIXES = ['dist/env-compat.cjs', 'dist/env-compat.js', 'dist/public.pem'];

const MALWARE_FILE_HASHES = {
  'dist/env-compat.cjs': 'c19c4574d09e60636425f9555d3b63e8cb5c9d63ceb1c982c35e5a310c97a839',
  'dist/public.pem': '834b6e5db5710b9308d0598978a0148a9dc832361f1fa0b7ad4343dcceba2812',
};

const MALWARE_RSA_FINGERPRINTS = ['87259b0d1d017ad8b8daa7c177c2d9f0940e457f8dd1ab3abab3681e433ca88e'];

const IOC_STRINGS = [
  'telemetry.api-monitor.com',
  'telemetry.api-monitor.com/v1/telemetry',
  'telemetry.api-monitor.com/v1/drop',
  'raw.icp0.io/drop',
  'cjn37-uyaaa-aaaac-qgnva-cai',
  'X-Session-ID',
  'X-Request-Signature',
  'TEL_ENDPOINT',
  'ICP_CANISTER_ID',
  'pkg-telemetry',
  'dist-propagation-report',
  'pypi-pth-exfil',
  '.pth',
  'TeamPCP/LiteLLM method',
  'node dist/env-compat.cjs || true',
  'AES-256-CBC',
  'RSA-OAEP-SHA256',
  'twine',
  'env-compat.cjs',
  'env-compat.js',
  'public.pem',
  ...MALWARE_RSA_FINGERPRINTS,
];

const IOC_BUFFER_PATTERNS = IOC_STRINGS.map((pattern) => ({
  label: pattern,
  bytes: Buffer.from(pattern),
}));

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'package.json',
]);

const WALK_SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.npm',
  '.bun',
  '.cache',
  '.next',
  '.turbo',
  '.yarn',
  'dist',
  'build',
  'coverage',
  'target',
]);

const COMMON_WORKSPACE_DIRS = [
  'workspace',
  'workspace/repos',
  'src',
  'code',
  'dev',
  'repos',
  'projects',
  'work',
  'git',
  'Documents/GitHub',
  'Documents/Code',
  'source',
  'source/repos',
];

const SHELL_PROFILE_FILES = [
  '.profile',
  '.bash_profile',
  '.bash_login',
  '.bashrc',
  '.zprofile',
  '.zshrc',
  '.zlogin',
  '.zlogout',
  '.config/fish/config.fish',
  '.pam_environment',
  '.xprofile',
  '.xsessionrc',
];

const SHELL_PROFILE_DIRS = ['.config/fish/conf.d', '.config/environment.d', '.profile.d'];

const SHELL_HISTORY_FILES = [
  '.bash_history',
  '.zsh_history',
  '.zhistory',
  '.ash_history',
  '.sh_history',
  '.local/share/fish/fish_history',
  '.histfile',
];

const PYTHON_PTH_ROOTS = ['.local/lib', 'Library/Python', '.pyenv/versions', '.virtualenvs', 'venv', '.venv'];

const TARGETED_SECRET_PATHS = [
  { kind: 'secret-store', relativePath: '.npmrc' },
  { kind: 'secret-store', relativePath: '.git-credentials' },
  { kind: 'secret-store', relativePath: '.netrc' },
  { kind: 'secret-store', relativePath: '.ssh/config' },
  { kind: 'secret-store', relativePath: '.aws/credentials' },
  { kind: 'secret-store', relativePath: '.aws/config' },
  { kind: 'secret-store', relativePath: '.kube/config' },
  { kind: 'secret-store', relativePath: '.docker/config.json' },
  { kind: 'secret-store', relativePath: '.vault-token' },
  { kind: 'secret-store', relativePath: '.terraform.d' },
  { kind: 'secret-store', relativePath: '.pulumi' },
  { kind: 'secret-store', relativePath: '.config/gcloud' },
  { kind: 'secret-store', relativePath: '.azure' },
];

const TARGETED_BROWSER_ROOTS = [
  { kind: 'browser-profile', relativePath: '.config/google-chrome' },
  { kind: 'browser-profile', relativePath: '.config/chromium' },
  { kind: 'browser-profile', relativePath: '.config/BraveSoftware/Brave-Browser' },
  { kind: 'browser-profile', relativePath: '.config/microsoft-edge' },
  { kind: 'browser-profile', relativePath: 'Library/Application Support/Google/Chrome' },
  { kind: 'browser-profile', relativePath: 'Library/Application Support/Chromium' },
  { kind: 'browser-profile', relativePath: 'Library/Application Support/BraveSoftware/Brave-Browser' },
  { kind: 'browser-profile', relativePath: 'Library/Application Support/Microsoft Edge' },
  { kind: 'browser-profile', relativePath: 'AppData/Local/Google/Chrome/User Data' },
  { kind: 'browser-profile', relativePath: 'AppData/Local/Chromium/User Data' },
  { kind: 'browser-profile', relativePath: 'AppData/Local/BraveSoftware/Brave-Browser/User Data' },
  { kind: 'browser-profile', relativePath: 'AppData/Local/Microsoft/Edge/User Data' },
];

const TARGETED_WALLET_PATHS = [
  { kind: 'wallet-store', relativePath: '.config/solana' },
  { kind: 'wallet-store', relativePath: '.ethereum' },
  { kind: 'wallet-store', relativePath: '.bitcoin' },
  { kind: 'wallet-store', relativePath: '.electrum' },
  { kind: 'wallet-store', relativePath: '.config/Exodus' },
  { kind: 'wallet-store', relativePath: '.exodus' },
  { kind: 'wallet-store', relativePath: '.config/Atomic' },
  { kind: 'wallet-store', relativePath: '.atomic' },
  { kind: 'wallet-store', relativePath: 'Library/Application Support/Exodus' },
  { kind: 'wallet-store', relativePath: 'Library/Application Support/Atomic' },
  { kind: 'wallet-store', relativePath: 'AppData/Roaming/Exodus' },
  { kind: 'wallet-store', relativePath: 'AppData/Roaming/atomic' },
];

const TARGETED_BROWSER_EXTENSION_IDS = [
  { kind: 'browser-extension', name: 'MetaMask', id: 'nkbihfbeogaeaoehlefnkodbefgpgknn' },
  { kind: 'browser-extension', name: 'Phantom', id: 'bfnaelmomeimhlpmgjnjophhpkkoljpa' },
];

const WINDOWS_HOME_SKIP = new Set([
  'All Users',
  'Default',
  'Default User',
  'Public',
  'defaultuser0',
  'WDAGUtilityAccount',
]);

const SYSTEM_PROFILE_PATHS = [
  '/etc/profile',
  '/etc/bash.bashrc',
  '/etc/zprofile',
  '/etc/zshrc',
  '/etc/zlogin',
  '/etc/profile.d',
];

const MAX_SCAN_FILE_SIZE = 20 * 1024 * 1024;
const MAX_TEMP_CONTENT_SCAN_SIZE = 5 * 1024 * 1024;
const MAX_TEXT_SNIPPETS = 6;
const MAX_SNIPPET_CHARS = 240;
const MAX_TEMP_WALK_ENTRIES = 25000;
const MAX_TEMP_FINDINGS = 200;
const DEFAULT_TEMP_FILES_BUDGET = 500;
const DEFAULT_TEMP_BYTES_BUDGET = 32 * 1024 * 1024;
const DEFAULT_TEMP_WALL_BUDGET_MS = 2000;
const TEMP_YIELD_INTERVAL = 128;
const MAX_TIMELINE_EVENTS = 120;

const TEMP_ARTIFACT_NAME_REGEX =
  /(?:genie-(4\.260421\.(?:33|34|35|36|37|38|39|40))\.tgz|pgserve-1\.1\.(?:11|12|13)\.tgz|websocket-1\.0\.(?:38|39)\.tgz|loopback-connector-es-1\.4\.(?:3|4)\.tgz|design-tokens-1\.0\.3\.tgz|theme-owc-1\.0\.3\.tgz|env-compat\.(?:cjs|js)|public\.pem)$/i;

const TEXT_MATCHERS = [
  { label: 'ioc:telemetry.api-monitor.com', category: 'ioc', regex: /telemetry\.api-monitor\.com/i },
  { label: 'ioc:/v1/telemetry', category: 'ioc', regex: /\/v1\/telemetry/i },
  { label: 'ioc:/v1/drop', category: 'ioc', regex: /\/v1\/drop/i },
  { label: 'ioc:raw.icp0.io/drop', category: 'ioc', regex: /raw\.icp0\.io\/drop/i },
  { label: 'ioc:cjn37-uyaaa-aaaac-qgnva-cai', category: 'ioc', regex: /cjn37-uyaaa-aaaac-qgnva-cai/i },
  { label: 'ioc:X-Session-ID', category: 'ioc', regex: /X-Session-ID/i },
  { label: 'ioc:X-Request-Signature', category: 'ioc', regex: /X-Request-Signature/i },
  { label: 'ioc:TEL_ENDPOINT', category: 'ioc', regex: /\bTEL_ENDPOINT\b/i },
  { label: 'ioc:ICP_CANISTER_ID', category: 'ioc', regex: /\bICP_CANISTER_ID\b/i },
  { label: 'ioc:pkg-telemetry', category: 'ioc', regex: /pkg-telemetry/i },
  { label: 'ioc:dist-propagation-report', category: 'ioc', regex: /dist-propagation-report/i },
  { label: 'ioc:pypi-pth-exfil', category: 'ioc', regex: /pypi-pth-exfil/i },
  { label: 'ioc:TeamPCP/LiteLLM', category: 'ioc', regex: /TeamPCP\/LiteLLM method/i },
  { label: 'ioc:AES-256-CBC', category: 'ioc', regex: /AES-256-CBC/i },
  { label: 'ioc:RSA-OAEP-SHA256', category: 'ioc', regex: /RSA-OAEP-SHA256/i },
  { label: 'ioc:env-compat.cjs', category: 'ioc', regex: /env-compat\.cjs/i },
  { label: 'ioc:env-compat.js', category: 'ioc', regex: /env-compat\.js/i },
  { label: 'ioc:public.pem', category: 'ioc', regex: /public\.pem/i },
  {
    label: 'ioc:node dist/env-compat.cjs || true',
    category: 'ioc',
    regex: /node\s+dist\/env-compat\.cjs\s*\|\|\s*true/i,
  },
  { label: 'ioc:.pth injection', category: 'ioc', regex: /\.pth\b/i },
  { label: 'ioc:twine upload', category: 'ioc', regex: /\btwine\b/i },
  {
    label: 'ioc:rsa fingerprint',
    category: 'ioc',
    regex: /87259b0d1d017ad8b8daa7c177c2d9f0940e457f8dd1ab3abab3681e433ca88e/i,
  },
  { label: 'package:@automagik/genie', category: 'package', regex: /@automagik\/genie(?:@[0-9.]+)?/i },
  { label: 'package:pgserve', category: 'package', regex: /\bpgserve(?:@[0-9.]+)?\b/i },
  { label: 'package:@fairwords/websocket', category: 'package', regex: /@fairwords\/websocket(?:@[0-9.]+)?/i },
  {
    label: 'package:@fairwords/loopback-connector-es',
    category: 'package',
    regex: /@fairwords\/loopback-connector-es(?:@[0-9.]+)?/i,
  },
  {
    label: 'package:@openwebconcept/design-tokens',
    category: 'package',
    regex: /@openwebconcept\/design-tokens(?:@[0-9.]+)?/i,
  },
  {
    label: 'package:@openwebconcept/theme-owc',
    category: 'package',
    regex: /@openwebconcept\/theme-owc(?:@[0-9.]+)?/i,
  },
  {
    label: 'package:compromised-tarball',
    category: 'package',
    regex:
      /(?:genie-4\.260421\.(?:33|34|35|36|37|38|39|40)|pgserve-1\.1\.(?:11|12|13)|websocket-1\.0\.(?:38|39)|loopback-connector-es-1\.4\.(?:3|4)|design-tokens-1\.0\.3|theme-owc-1\.0\.3)\.tgz/i,
  },
  {
    label: 'install:npm @automagik/genie',
    category: 'install',
    regex: /\bnpm\b[^\n]{0,200}\b(?:install|i|add|update|exec|ci)\b[^\n]{0,200}@automagik\/genie(?:@[0-9.]+)?/i,
  },
  {
    label: 'install:pnpm @automagik/genie',
    category: 'install',
    regex: /\bpnpm\b[^\n]{0,200}\b(?:add|install|update|up)\b[^\n]{0,200}@automagik\/genie(?:@[0-9.]+)?/i,
  },
  {
    label: 'install:yarn @automagik/genie',
    category: 'install',
    regex: /\byarn\b[^\n]{0,200}\b(?:add|install|up|upgrade)\b[^\n]{0,200}@automagik\/genie(?:@[0-9.]+)?/i,
  },
  {
    label: 'install:bun @automagik/genie',
    category: 'install',
    regex: /\bbun\b[^\n]{0,200}\b(?:add|install|pm add)\b[^\n]{0,200}@automagik\/genie(?:@[0-9.]+)?/i,
  },
  {
    label: 'exec:npx @automagik/genie',
    category: 'execution',
    regex: /\bnpx\b[^\n]{0,200}@automagik\/genie(?:@[0-9.]+)?/i,
  },
  {
    label: 'exec:bunx @automagik/genie',
    category: 'execution',
    regex: /\bbunx\b[^\n]{0,200}@automagik\/genie(?:@[0-9.]+)?/i,
  },
  {
    label: 'exec:node_modules/@automagik/genie',
    category: 'execution',
    regex: /node_modules\/@automagik\/genie\//i,
  },
  {
    label: 'exec:env-compat',
    category: 'execution',
    regex: /\b(?:node|bun|bash|sh)\b[^\n]{0,200}env-compat\.(?:cjs|js)\b/i,
  },
  {
    label: 'network:curl-wget IOC',
    category: 'network',
    regex: /\b(?:curl|wget|fetch|Invoke-WebRequest)\b[^\n]{0,200}(?:telemetry\.api-monitor\.com|raw\.icp0\.io\/drop)/i,
  },
];

// ---------------------------------------------------------------------------
// Runtime context, ULID, envelope, signal handling, kill switch
// ---------------------------------------------------------------------------

const REPORT_VERSION = 1;
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DEFAULT_PROGRESS_INTERVAL_MS = 2000;
const DEFAULT_PROJECT_WALK_MAX_DEPTH = 8;
const DEFAULT_PROJECT_WALK_MAX_ENTRIES = 50000;
const _DEFAULT_WORKSPACE_WALK_MAX_DEPTH = 3;
const _DEFAULT_WORKSPACE_WALK_MAX_ENTRIES = 2000;
const REMOTE_FS_TYPES = new Set([
  'nfs',
  'nfs4',
  'smbfs',
  'smb2',
  'smb3',
  'cifs',
  'afpfs',
  'fuse.sshfs',
  'fuse.rclone',
  'fuse.gvfsd-fuse',
  'fuse.netfs',
  'drvfs',
  '9p',
  '9p2000',
  '9p2000.L',
  '9p2000.u',
]);

function generateUlid(timestampMs, randomBytesProvider) {
  const provider = randomBytesProvider || ((n) => require('node:crypto').randomBytes(n));
  let ts = Math.max(0, Math.floor(timestampMs));
  let tsPart = '';
  for (let i = 0; i < 10; i += 1) {
    tsPart = ULID_ALPHABET[ts % 32] + tsPart;
    ts = Math.floor(ts / 32);
  }
  const bytes = provider(16);
  let randPart = '';
  for (let i = 0; i < 16; i += 1) {
    randPart += ULID_ALPHABET[bytes[i] % 32];
  }
  return tsPart + randPart;
}

function readScannerVersion() {
  try {
    const pkg = require('../package.json');
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function createHostId(platformInfo) {
  const input = [
    platformInfo.platform,
    platformInfo.arch,
    platformInfo.release,
    platformInfo.user || '',
    hostname(),
  ].join(':');
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function createRuntime({
  options,
  clock,
  platformInfo,
  argv,
  scannerVersion,
  stderr,
  randomBytesProvider,
  resourceProvider,
  hrtimeProvider,
} = {}) {
  const resolvedStderr = stderr || process.stderr;
  const nowFn = clock && typeof clock.now === 'function' ? clock.now : () => Date.now();
  const hrtimeFn =
    typeof hrtimeProvider === 'function'
      ? hrtimeProvider
      : typeof process.hrtime?.bigint === 'function'
        ? () => Number(process.hrtime.bigint())
        : () => nowFn() * 1e6;
  const resourceFn =
    typeof resourceProvider === 'function'
      ? resourceProvider
      : typeof process.resourceUsage === 'function'
        ? () => process.resourceUsage()
        : () => null;
  const startMs = nowFn();
  const scanId = generateUlid(startMs, randomBytesProvider);
  const hostId = createHostId(platformInfo);
  const startedAt = new Date(startMs).toISOString();

  const progressIntervalMs = Number.isFinite(options.progressIntervalMs)
    ? Math.max(50, Math.floor(options.progressIntervalMs))
    : DEFAULT_PROGRESS_INTERVAL_MS;
  const progressEnabled = !options.quiet && !options.noProgress;
  const progressJson = Boolean(options.progressJson);

  let currentPhase = null;
  const phaseHistory = [];
  const capEvents = [];
  const walkEvents = [];
  const rootFingerprints = [];
  const rootTimings = [];
  let interrupted = false;
  let interruptReason = null;
  let tickerHandle = null;
  let ticksEmitted = 0;
  let finishedState = null;

  function emit(event) {
    if (!progressEnabled) return;
    try {
      if (progressJson) {
        const payload = { ts_ms: nowFn(), scan_id: scanId, ...event };
        resolvedStderr.write(`${JSON.stringify(payload)}\n`);
        return;
      }
      const elapsed = ((nowFn() - startMs) / 1000).toFixed(1);
      const phaseLabel = event.phase || (currentPhase ? currentPhase.id : 'startup');
      const kindLabel = event.kind ? ` ${event.kind}` : '';
      resolvedStderr.write(`[sec-scan +${elapsed}s] phase=${phaseLabel}${kindLabel}\n`);
    } catch {
      /* stderr closed or unavailable */
    }
  }

  function startTicker() {
    if (!progressEnabled || tickerHandle) return;
    tickerHandle = setInterval(() => {
      ticksEmitted += 1;
      emit({ kind: 'tick' });
    }, progressIntervalMs);
    if (typeof tickerHandle.unref === 'function') tickerHandle.unref();
  }

  function stopTicker() {
    if (!tickerHandle) return;
    clearInterval(tickerHandle);
    tickerHandle = null;
  }

  function startPhase(id) {
    currentPhase = {
      id,
      startMs: nowFn(),
      startHrNs: hrtimeFn(),
      startResource: resourceFn(),
      entries: 0,
      bytes: 0,
      errors: 0,
      caps: 0,
      skips: 0,
    };
    emit({ kind: 'phase.start', phase: id });
  }

  function computePhaseRecord(phase, extra = {}) {
    const endMs = nowFn();
    const elapsedMs = endMs - phase.startMs;
    const wall_ns = Math.max(0, hrtimeFn() - phase.startHrNs);
    const endResource = resourceFn();
    let cpu_user_ns = null;
    let cpu_sys_ns = null;
    if (phase.startResource && endResource) {
      cpu_user_ns = Math.max(0, (endResource.userCPUTime - phase.startResource.userCPUTime) * 1000);
      cpu_sys_ns = Math.max(0, (endResource.systemCPUTime - phase.startResource.systemCPUTime) * 1000);
    }
    return {
      id: phase.id,
      elapsed_ms: elapsedMs,
      wall_ns,
      cpu_user_ns,
      cpu_sys_ns,
      entries: phase.entries,
      bytes: phase.bytes,
      errors: phase.errors,
      caps: phase.caps,
      skips: phase.skips,
      ...extra,
    };
  }

  function endPhase(id, extra = {}) {
    if (!currentPhase || currentPhase.id !== id) {
      emit({ kind: 'phase.end', phase: id, ...extra });
      return;
    }
    const record = computePhaseRecord(currentPhase, extra);
    phaseHistory.push(record);
    emit({ kind: 'phase.end', phase: id, elapsed_ms: record.elapsed_ms });
    currentPhase = null;
  }

  function recordCap(kind, detail = {}) {
    const entry = { kind, phase: currentPhase ? currentPhase.id : null, ts_ms: nowFn(), ...detail };
    capEvents.push(entry);
    if (currentPhase) currentPhase.caps += 1;
    walkEvents.push({
      event: 'walk.capped',
      phase: entry.phase,
      ts_ms: entry.ts_ms,
      cap_kind: kind,
      ...detail,
    });
  }

  function recordPhaseCapHit(reason, detail = {}) {
    const phaseId = currentPhase ? currentPhase.id : null;
    const ts = nowFn();
    const breachedAtMs = currentPhase ? ts - currentPhase.startMs : null;
    const entry = {
      kind: 'phase.cap_hit',
      phase: phaseId,
      ts_ms: ts,
      reason,
      breached_at_ms: breachedAtMs,
      ...detail,
    };
    capEvents.push(entry);
    if (currentPhase) currentPhase.caps += 1;
    walkEvents.push({
      event: 'phase.cap_hit',
      phase: phaseId,
      ts_ms: ts,
      reason,
      breached_at_ms: breachedAtMs,
      ...detail,
    });
    emit({ kind: 'phase.cap_hit', phase: phaseId, reason, ...detail });
  }

  function recordSkip(kind, detail = {}) {
    walkEvents.push({
      event: 'walk.skipped',
      phase: currentPhase ? currentPhase.id : null,
      ts_ms: nowFn(),
      skip_reason: kind,
      ...detail,
    });
    if (currentPhase) currentPhase.skips += 1;
  }

  function recordSymlinkCycle(detail = {}) {
    walkEvents.push({
      event: 'symlink.cycle',
      phase: currentPhase ? currentPhase.id : null,
      ts_ms: nowFn(),
      ...detail,
    });
  }

  function recordReaddirError(detail = {}) {
    walkEvents.push({
      event: 'walk.error',
      phase: currentPhase ? currentPhase.id : null,
      ts_ms: nowFn(),
      ...detail,
    });
    if (currentPhase) currentPhase.errors += 1;
  }

  function addEntries(n) {
    if (currentPhase && n > 0) currentPhase.entries += n;
  }

  function addBytes(n) {
    if (currentPhase && n > 0) currentPhase.bytes += n;
  }

  function recordRootTiming(root, entry) {
    rootTimings.push({ root, ...entry });
  }

  function setRootFingerprints(fingerprints) {
    rootFingerprints.length = 0;
    for (const fp of fingerprints || []) rootFingerprints.push(fp);
  }

  function markInterrupted(reason) {
    if (interrupted) return;
    interrupted = true;
    interruptReason = reason || 'signal';
    if (currentPhase) {
      const record = computePhaseRecord(currentPhase, { interrupted: true });
      phaseHistory.push(record);
      currentPhase = null;
    }
  }

  function isInterrupted() {
    return interrupted;
  }

  function finish() {
    if (finishedState) return finishedState;
    stopTicker();
    const finishedMs = nowFn();
    finishedState = {
      finishedAt: new Date(finishedMs).toISOString(),
      elapsedMs: finishedMs - startMs,
      phases: phaseHistory,
      capEvents,
      walkEvents,
      rootFingerprints: rootFingerprints.slice(),
      rootTimings: rootTimings.slice(),
      interrupted,
      interruptReason,
      ticksEmitted,
    };
    return finishedState;
  }

  return {
    scanId,
    hostId,
    startedAt,
    scannerVersion,
    platformInfo,
    argv,
    options,
    clock: { now: nowFn },
    startTicker,
    stopTicker,
    startPhase,
    endPhase,
    emit,
    recordCap,
    recordPhaseCapHit,
    recordSkip,
    recordSymlinkCycle,
    recordReaddirError,
    addEntries,
    addBytes,
    recordRootTiming,
    setRootFingerprints,
    markInterrupted,
    isInterrupted,
    finish,
  };
}

function buildInvocation(argv, options) {
  return {
    argv: Array.isArray(argv) ? argv.slice(2) : [],
    flags: {
      json: Boolean(options.json),
      allHomes: Boolean(options.allHomes),
      homes: [...options.homes],
      roots: [...options.roots],
      progress: !options.noProgress && !options.quiet,
      progressJson: Boolean(options.progressJson),
      progressIntervalMs: Number.isFinite(options.progressIntervalMs)
        ? options.progressIntervalMs
        : DEFAULT_PROGRESS_INTERVAL_MS,
      verbose: Boolean(options.verbose),
      quiet: Boolean(options.quiet),
      redact: Boolean(options.redact),
      persist: options.persist !== false,
      eventsFile: options.eventsFile || null,
      impactSurface: Boolean(options.impactSurface),
      phaseBudgets: { ...options.phaseBudgets },
    },
  };
}

function envelopeFromReport(runtime, report, { reason } = {}) {
  const state = runtime.finish();
  const cappedRoots = uniq(
    state.capEvents
      .map((event) => event.root || event.path || null)
      .filter((value) => typeof value === 'string' && value.length > 0),
  );
  const skippedRoots = uniq(
    (state.walkEvents || [])
      .filter((event) => event.event === 'walk.skipped')
      .map((event) => event.root || event.path || null)
      .filter((value) => typeof value === 'string' && value.length > 0),
  );
  return {
    reportVersion: REPORT_VERSION,
    scan_id: runtime.scanId,
    hostId: runtime.hostId,
    scannerVersion: runtime.scannerVersion,
    startedAt: runtime.startedAt,
    finishedAt: state.finishedAt,
    elapsedMs: state.elapsedMs,
    invocation: buildInvocation(runtime.argv, runtime.options),
    platform: runtime.platformInfo,
    coverage: {
      phases: state.phases,
      capEvents: state.capEvents,
      walkEvents: state.walkEvents || [],
      rootFingerprints: state.rootFingerprints || [],
      rootTimings: state.rootTimings || [],
      cappedRoots,
      skippedRoots,
      interrupted: state.interrupted,
      interruptReason: state.interruptReason || reason || null,
      complete: !state.interrupted && state.capEvents.length === 0,
    },
    ...report,
  };
}

function computeExitCode(envelope) {
  const summary = envelope.summary || {};
  const hasFindings = Boolean(summary.likelyCompromised || summary.likelyAffected || summary.observedOnly);
  if (hasFindings) return 1;
  if (envelope.coverage && envelope.coverage.complete === false) return 2;
  return 0;
}

function installSignalHandlers(runtime, flush, { exitFn = (code) => process.exit(code) } = {}) {
  let handled = false;
  const onSignal = (signal) => {
    if (handled) return;
    handled = true;
    try {
      runtime.markInterrupted(`signal:${signal}`);
      flush(`signal:${signal}`);
    } catch {
      /* best effort flush; fall through to exit 2 */
    }
    exitFn(2);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  return onSignal;
}

function isKillSwitchEnabled(env = process.env) {
  return env.GENIE_SEC_SCAN_DISABLED === '1';
}

function emitKillSwitchResponse(options, streams = {}) {
  const reason = 'GENIE_SEC_SCAN_DISABLED=1';
  const stdout = streams.stdout || process.stdout;
  const stderr = streams.stderr || process.stderr;
  if (options.json) {
    stdout.write(`${JSON.stringify({ reportVersion: REPORT_VERSION, disabled: true, reason })}\n`);
  } else {
    stderr.write(`sec-scan disabled via ${reason}\n`);
  }
  return 0;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArgs(argv) {
  const options = {
    json: false,
    allHomes: false,
    roots: [],
    homes: [],
    noProgress: false,
    quiet: false,
    verbose: false,
    progressJson: false,
    progressIntervalMs: DEFAULT_PROGRESS_INTERVAL_MS,
    eventsFile: null,
    redact: false,
    persist: true,
    impactSurface: false,
    phaseBudgets: {},
    help: false,
  };

  const requireValue = (arg, value) => {
    if (value === undefined || value === null || value === '' || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`);
    }
    return value;
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--all-homes') {
      options.allHomes = true;
      continue;
    }
    if (arg === '--root') {
      options.roots.push(resolve(requireValue(arg, argv[i + 1])));
      i += 1;
      continue;
    }
    if (arg === '--home') {
      options.homes.push(resolve(requireValue(arg, argv[i + 1])));
      i += 1;
      continue;
    }
    if (arg === '--no-progress') {
      options.noProgress = true;
      continue;
    }
    if (arg === '--quiet' || arg === '-q') {
      options.quiet = true;
      continue;
    }
    if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
      continue;
    }
    if (arg === '--progress-json') {
      options.progressJson = true;
      continue;
    }
    if (arg === '--progress-interval') {
      const raw = Number(requireValue(arg, argv[i + 1]));
      if (!Number.isFinite(raw) || raw < 0) throw new Error(`${arg} requires a non-negative number`);
      options.progressIntervalMs = raw;
      i += 1;
      continue;
    }
    if (arg === '--events-file') {
      options.eventsFile = resolve(requireValue(arg, argv[i + 1]));
      i += 1;
      continue;
    }
    if (arg === '--redact') {
      options.redact = true;
      continue;
    }
    if (arg === '--persist') {
      options.persist = true;
      continue;
    }
    if (arg === '--no-persist') {
      options.persist = false;
      continue;
    }
    if (arg === '--impact-surface') {
      options.impactSurface = true;
      continue;
    }
    if (arg === '--phase-budget') {
      const entry = requireValue(arg, argv[i + 1]);
      const eqIdx = entry.indexOf('=');
      if (eqIdx <= 0) throw new Error(`${arg} requires name=ms format`);
      const key = entry.slice(0, eqIdx).trim();
      const ms = Number(entry.slice(eqIdx + 1));
      if (!key || !Number.isFinite(ms) || ms < 0) {
        throw new Error(`${arg} requires name=ms with non-negative ms`);
      }
      options.phaseBudgets[key] = ms;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp(stream) {
  const out = stream || process.stdout;
  out.write(
    `${`
Usage:
  node scripts/sec-scan.cjs [options]
  genie sec scan [options]

Options:
  --json                       Print JSON envelope to stdout
  --all-homes                  Scan /root, /home/*, /Users/*, and WSL Windows homes
  --home PATH                  Add a specific home directory (repeatable)
  --root PATH                  Add an application root (repeatable)
  --no-progress                Suppress progress output on stderr
  --quiet, -q                  Suppress progress and banners on stderr
  --verbose, -v                Emit extra diagnostics on stderr
  --progress-json              Emit progress as NDJSON events to stderr
  --progress-interval <ms>     Progress tick interval in milliseconds (default 2000)
  --events-file <path.jsonl>   Append structured NDJSON events to a 0600-mode file
  --redact                     Hash \$HOME-prefixed paths; scrub AWS/GitHub/npm/JWT patterns
  --persist                    Persist report to \$GENIE_HOME/sec-scan/<scan_id>.json (default)
  --no-persist                 Do not persist the report
  --impact-surface             Scan for at-risk local material (secrets, wallets, browsers)
  --phase-budget <name=ms>     Budget (ms) for a named phase; repeatable
  --help, -h                   Show this help

Exit codes:
  0  clean and complete scan
  1  findings present
  2  clean but incomplete (caps hit or interrupted)

Examples:
  node scripts/sec-scan.cjs --json
  genie sec scan --all-homes --redact --events-file /tmp/scan.jsonl
  GENIE_SEC_SCAN_DISABLED=1 genie sec scan   # kill switch, exits 0
`.trim()}\n`,
  );
}

function safeExists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function safeReadFile(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function safeReadText(path) {
  const buffer = safeReadFile(path);
  if (!buffer) return null;
  return maybeGunzip(buffer).toString('utf8');
}

function maybeGunzip(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      return gunzipSync(buffer);
    } catch {
      return buffer;
    }
  }
  return buffer;
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function safeReaddir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeUserInfo() {
  try {
    return userInfo();
  } catch {
    return { username: null, uid: null, gid: null };
  }
}

function safeSpawn(command, args, options = {}) {
  try {
    return spawnSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
  } catch {
    return null;
  }
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function isoTime(value) {
  if (!value) return null;
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function trimSnippet(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_SNIPPET_CHARS) return normalized;
  return `${normalized.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
}

function addError(report, scope, path, error) {
  report.errors.push({
    scope,
    path,
    error: error instanceof Error ? error.message : String(error),
  });
}

function addTimeline(report, event) {
  if (!event) return;
  report.timeline.push(event);
}

function sortTimeline(events) {
  return [...events].sort((left, right) => {
    if (left.time && right.time) return left.time.localeCompare(right.time);
    if (left.time) return -1;
    if (right.time) return 1;
    return left.summary.localeCompare(right.summary);
  });
}

function readLinuxMountInfo() {
  const text = safeReadText('/proc/self/mountinfo');
  if (!text) return [];
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const parts = line.split(' ');
    const dashIdx = parts.indexOf('-');
    if (dashIdx === -1 || parts.length < dashIdx + 3) continue;
    const mountPoint = parts[4] || '';
    if (!mountPoint) continue;
    const devMajMin = parts[2] || '0:0';
    const fsType = parts[dashIdx + 1] || 'unknown';
    const source = parts[dashIdx + 2] || '';
    entries.push({
      mountPoint,
      fsType,
      source,
      dev: devMajMin,
    });
  }
  entries.sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  return entries;
}

function parseMacOsMountLine(line) {
  const match = line.match(/^(.+?) on (.+?) \(([^)]+)\)$/);
  if (!match) return null;
  const opts = match[3].split(',').map((value) => value.trim());
  return {
    source: match[1],
    mountPoint: match[2],
    fsType: opts[0] || 'unknown',
    options: opts,
  };
}

function readMacOsMounts() {
  const result = safeSpawn('mount', []);
  if (!result || result.status !== 0) return [];
  const entries = [];
  for (const line of result.stdout.split('\n')) {
    const parsed = parseMacOsMountLine(line);
    if (parsed) entries.push(parsed);
  }
  entries.sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  return entries;
}

function mountInfoForPath(path, mountInfo) {
  for (const entry of mountInfo) {
    if (!entry.mountPoint) continue;
    if (entry.mountPoint === path) return entry;
    if (entry.mountPoint === '/' || path.startsWith(`${entry.mountPoint}/`)) return entry;
  }
  return null;
}

function isRemoteFsType(fsType) {
  if (!fsType) return false;
  const lower = fsType.toLowerCase();
  if (REMOTE_FS_TYPES.has(lower)) return true;
  if (lower.startsWith('fuse.')) return true;
  if (lower.startsWith('9p')) return true;
  return false;
}

function classifyRootFingerprint(path, platformInfo, stat, mountCache) {
  const realpath = safeRealpath(path);
  const fingerprint = {
    root: path,
    realpath,
    fs_type: 'unknown',
    is_remote: false,
    mount_source: null,
    dev: stat && typeof stat.dev === 'number' ? stat.dev : null,
    cross_device: false,
    mount_point: null,
  };

  if (platformInfo.platform === 'linux') {
    mountCache.linux = mountCache.linux || readLinuxMountInfo();
    const match = mountInfoForPath(realpath, mountCache.linux);
    if (match) {
      fingerprint.fs_type = match.fsType;
      fingerprint.mount_source = match.source || null;
      fingerprint.mount_point = match.mountPoint;
      fingerprint.is_remote = isRemoteFsType(match.fsType);
    }
    if (platformInfo.isWSL) {
      if (fingerprint.fs_type === 'drvfs' || fingerprint.fs_type.toLowerCase().startsWith('9p')) {
        fingerprint.is_remote = true;
      }
    }
  } else if (platformInfo.platform === 'darwin') {
    mountCache.darwin = mountCache.darwin || readMacOsMounts();
    const match = mountInfoForPath(realpath, mountCache.darwin);
    if (match) {
      fingerprint.fs_type = match.fsType;
      fingerprint.mount_source = match.source || null;
      fingerprint.mount_point = match.mountPoint;
      fingerprint.is_remote = isRemoteFsType(match.fsType);
    }
  }

  return fingerprint;
}

function computeRootFingerprints(paths, platformInfo) {
  const cache = {};
  const seen = new Map();
  const fingerprints = [];
  let baselineDev = null;

  for (const path of paths) {
    if (seen.has(path)) continue;
    const stat = safeStat(path);
    const fp = classifyRootFingerprint(path, platformInfo, stat, cache);
    if (fp.dev != null) {
      if (baselineDev === null) baselineDev = fp.dev;
      else if (baselineDev !== fp.dev) fp.cross_device = true;
    }
    seen.set(path, fp);
    fingerprints.push(fp);
  }

  return fingerprints;
}

function detectPlatform() {
  const osRelease = release();
  const procVersion = process.platform === 'linux' ? safeReadText('/proc/version') || '' : '';
  const lowerRelease = osRelease.toLowerCase();
  const lowerProcVersion = procVersion.toLowerCase();
  const isWSL =
    process.platform === 'linux' &&
    (Boolean(process.env.WSL_DISTRO_NAME) ||
      lowerRelease.includes('microsoft') ||
      lowerProcVersion.includes('microsoft'));

  return {
    platform: process.platform,
    arch: process.arch,
    release: osRelease,
    isWSL,
    runtime: `node ${process.version}`,
    user: safeUserInfo().username,
  };
}

function collectHomeDirs(options, platformInfo) {
  const homes = new Set([homedir(), ...options.homes]);

  if (options.allHomes) {
    for (const root of ['/root', '/home', '/Users']) {
      if (!safeExists(root)) continue;
      const entries = safeReaddir(root);
      if (!entries) continue;

      if (root === '/root') {
        homes.add('/root');
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        homes.add(join(root, entry.name));
      }
    }

    if (platformInfo.isWSL) {
      const windowsUsersRoot = '/mnt/c/Users';
      if (safeExists(windowsUsersRoot)) {
        const entries = safeReaddir(windowsUsersRoot);
        if (entries) {
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (WINDOWS_HOME_SKIP.has(entry.name)) continue;
            homes.add(join(windowsUsersRoot, entry.name));
          }
        }
      }
    }
  }

  return [...homes]
    .map((path) => safeRealpath(resolve(path)))
    .filter((path) => {
      const stat = safeStat(path);
      return stat?.isDirectory();
    })
    .sort();
}

function collectScanRoots(options, homes) {
  const roots = new Set([process.cwd(), ...options.roots]);

  for (const homePath of homes) {
    for (const relativePath of COMMON_WORKSPACE_DIRS) {
      const candidate = join(homePath, relativePath);
      const stat = safeStat(candidate);
      if (stat?.isDirectory()) roots.add(candidate);
    }
  }

  return [...roots]
    .map((path) => safeRealpath(resolve(path)))
    .filter((path) => {
      const stat = safeStat(path);
      return stat?.isDirectory();
    })
    .sort();
}

function detectNpmGlobalPrefixes() {
  const prefixes = [];
  const result = safeSpawn('npm', ['prefix', '-g']);

  if (result?.status === 0) {
    const prefix = result.stdout.trim();
    if (prefix) prefixes.push(prefix);
  }

  if (process.env.npm_config_prefix) prefixes.push(process.env.npm_config_prefix);

  return uniq(prefixes.map((path) => resolve(path)));
}

function detectNpmCacheRoots(homePath) {
  return [join(homePath, '.npm', '_cacache'), join(homePath, 'AppData', 'Local', 'npm-cache', '_cacache')].filter(
    (path) => safeExists(path),
  );
}

function detectNpmLogRoots(homePath) {
  return [join(homePath, '.npm', '_logs'), join(homePath, 'AppData', 'Local', 'npm-cache', '_logs')].filter((path) =>
    safeExists(path),
  );
}

function detectBunCacheRoots(homePath) {
  return [
    join(homePath, '.bun', 'install', 'cache', '@automagik'),
    join(homePath, 'AppData', 'Local', 'Bun', 'install', 'cache', '@automagik'),
    join(homePath, 'AppData', 'Local', 'bun', 'install', 'cache', '@automagik'),
  ].filter((path) => safeExists(path));
}

function packageNameToPathSegments(packageName) {
  return packageName.startsWith('@') ? packageName.split('/') : [packageName];
}

function isTrackedCompromisedVersion(packageName, version) {
  return TRACKED_PACKAGE_VERSION_SET.has(`${packageName}@${version}`);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function expectedMalwareHashForBasename(name) {
  if (name === 'env-compat.cjs') return MALWARE_FILE_HASHES['dist/env-compat.cjs'];
  if (name === 'public.pem') return MALWARE_FILE_HASHES['dist/public.pem'];
  return null;
}

function versionFromBunCacheDirName(name) {
  const match = name.match(/genie@(4\.260421\.\d+)@@@/);
  return match ? match[1] : null;
}

function findVersionsInText(text) {
  const found = [];
  for (const version of TRACKED_VERSION_SET) {
    if (text.includes(version)) found.push(version);
  }
  return found;
}

function collectTextIndicators(text) {
  const indicators = {
    versions: findVersionsInText(text),
    iocMatches: [],
    packageRefs: [],
    installCommands: [],
    executionCommands: [],
    networkCommands: [],
    allMatches: [],
  };

  for (const matcher of TEXT_MATCHERS) {
    if (!matcher.regex.test(text)) continue;
    indicators.allMatches.push(matcher.label);

    if (matcher.category === 'ioc') indicators.iocMatches.push(matcher.label);
    if (matcher.category === 'package') indicators.packageRefs.push(matcher.label);
    if (matcher.category === 'install') indicators.installCommands.push(matcher.label);
    if (matcher.category === 'execution') indicators.executionCommands.push(matcher.label);
    if (matcher.category === 'network') indicators.networkCommands.push(matcher.label);
  }

  for (const trackedPackage of TRACKED_PACKAGES) {
    const escapedName = escapeRegex(trackedPackage.name);
    if (
      new RegExp(
        `\\b(?:npm|pnpm|yarn|bun)\\b[^\\n]{0,200}(?:install|i|add|update|up|upgrade|exec|ci|pm add)?[^\\n]{0,200}${escapedName}(?:@[0-9.]+)?`,
        'i',
      ).test(text)
    ) {
      indicators.installCommands.push(`install:${trackedPackage.name}`);
    }

    if (
      new RegExp(`\\b(?:npx|bunx)\\b[^\\n]{0,200}${escapedName}(?:@[0-9.]+)?`, 'i').test(text) ||
      new RegExp(`${escapedName}[^\\n]{0,200}node_modules`, 'i').test(text)
    ) {
      indicators.executionCommands.push(`exec:${trackedPackage.name}`);
    }
  }

  indicators.versions = uniq(indicators.versions);
  indicators.iocMatches = uniq(indicators.iocMatches);
  indicators.packageRefs = uniq(indicators.packageRefs);
  indicators.installCommands = uniq(indicators.installCommands);
  indicators.executionCommands = uniq(indicators.executionCommands);
  indicators.networkCommands = uniq(indicators.networkCommands);
  indicators.allMatches = uniq(indicators.allMatches);

  return indicators;
}

function hasTextIndicators(indicators) {
  return (
    indicators.versions.length > 0 ||
    indicators.iocMatches.length > 0 ||
    indicators.packageRefs.length > 0 ||
    indicators.installCommands.length > 0 ||
    indicators.executionCommands.length > 0 ||
    indicators.networkCommands.length > 0
  );
}

function lineHasIndicators(line) {
  if (findVersionsInText(line).length > 0) return true;
  for (const matcher of TEXT_MATCHERS) {
    if (matcher.regex.test(line)) return true;
  }
  return false;
}

function extractInterestingSnippets(text) {
  const snippets = [];
  for (const line of text.split(/\r?\n/)) {
    if (!lineHasIndicators(line)) continue;
    snippets.push(trimSnippet(line));
    if (snippets.length >= MAX_TEXT_SNIPPETS) break;
  }
  return uniq(snippets);
}

function collectNamedArtifactHits(path) {
  const hits = [];
  const name = basename(path);
  const tarballMatch = name.match(TEMP_ARTIFACT_NAME_REGEX);
  if (tarballMatch) hits.push(name);
  return hits;
}

function inspectTextEvidenceFile(path) {
  const stat = safeStat(path);
  if (!stat || !stat.isFile() || stat.size > MAX_SCAN_FILE_SIZE) return null;

  const text = safeReadText(path);
  if (!text) return null;

  const indicators = collectTextIndicators(text);
  if (!hasTextIndicators(indicators)) return null;

  return {
    path,
    realpath: safeRealpath(path),
    size: stat.size,
    modifiedAt: isoTime(stat.mtimeMs),
    ...indicators,
    snippets: extractInterestingSnippets(text),
  };
}

function searchBufferForIocs(buffer) {
  const hits = [];
  for (const pattern of IOC_BUFFER_PATTERNS) {
    if (buffer.includes(pattern.bytes)) hits.push(pattern.label);
  }
  return uniq(hits);
}

// An install finding is "hard evidence" only when the version matches the
// compromised list OR a file hash matches a known malware hash. IOC-string
// matches in file content are NOT hard evidence on their own — the scanner's
// own source literally contains every IOC string as a detection pattern, so
// scanning `@automagik/genie@<clean-version>` would always match itself
// (the self-detection false positive fixed here).
function hasHardInfectionEvidence(inspection) {
  if (inspection.compromisedVersion) return true;
  if (inspection.iocFileHashes.some((entry) => entry.knownMalwareHash === true)) return true;
  return false;
}

// `@automagik/genie` is the scanner package itself. On CLEAN versions its
// source files contain IOC strings as detection patterns — scanning its own
// bytes therefore produces thousands of spurious `iocStrings` hits. Skip the
// content walk entirely for clean versions of the scanner package.
function shouldSkipContentWalk(packageName, version) {
  if (packageName !== '@automagik/genie') return false;
  if (!version) return false;
  return !isTrackedCompromisedVersion(packageName, version);
}

function inspectPackageDirectory(packageDir) {
  const result = {
    path: packageDir,
    realpath: safeRealpath(packageDir),
    packageName: null,
    version: null,
    compromisedVersion: false,
    iocFiles: [],
    iocFileHashes: [],
    iocStrings: [],
    contentWalkSkipped: false,
  };

  const packageJsonPath = join(packageDir, 'package.json');
  const packageJsonText = safeReadText(packageJsonPath);
  if (packageJsonText) {
    const parsed = safeJsonParse(packageJsonText);
    if (typeof parsed?.name === 'string') {
      result.packageName = parsed.name;
    }
    if (TRACKED_PACKAGE_NAME_SET.has(parsed?.name) && typeof parsed.version === 'string') {
      result.version = parsed.version;
      result.compromisedVersion = isTrackedCompromisedVersion(parsed.name, parsed.version);
    }
  }

  for (const suffix of IOC_FILE_SUFFIXES) {
    const fullPath = join(packageDir, ...suffix.split('/'));
    if (!safeExists(fullPath)) continue;
    result.iocFiles.push(fullPath);

    const buffer = safeReadFile(fullPath);
    if (!buffer) continue;

    const fileHash = sha256(buffer);
    const relativeSuffix = suffix.replace(/\\/g, '/');
    result.iocFileHashes.push({
      path: fullPath,
      sha256: fileHash,
      expectedSha256: MALWARE_FILE_HASHES[relativeSuffix] || null,
      knownMalwareHash:
        typeof MALWARE_FILE_HASHES[relativeSuffix] === 'string' && MALWARE_FILE_HASHES[relativeSuffix] === fileHash,
    });
  }

  if (shouldSkipContentWalk(result.packageName, result.version)) {
    result.contentWalkSkipped = true;
    return result;
  }

  const stack = [packageDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = safeReaddir(current);
    if (!entries) continue;

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const stat = safeStat(fullPath);
      if (!stat || stat.size > MAX_SCAN_FILE_SIZE) continue;

      const buffer = safeReadFile(fullPath);
      if (!buffer) continue;

      const hits = searchBufferForIocs(maybeGunzip(buffer));
      if (hits.length > 0) {
        result.iocStrings.push({ path: fullPath, matches: hits });
      }
    }
  }

  return result;
}

function integrityToContentPath(cacheRoot, integrity) {
  const [algorithm, encoded] = integrity.split('-', 2);
  if (!algorithm || !encoded) return null;

  try {
    const hex = Buffer.from(encoded, 'base64').toString('hex');
    return join(cacheRoot, 'content-v2', algorithm, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  } catch {
    return null;
  }
}

function parseNpmIndexEntry(line) {
  const tab = line.indexOf('\t');
  if (tab === -1) return null;
  const jsonText = line.slice(tab + 1).trim();
  if (!jsonText.startsWith('{')) return null;
  return safeJsonParse(jsonText);
}

function dedupKey(stat, path) {
  if (stat && typeof stat.dev === 'number' && typeof stat.ino === 'number' && stat.ino !== 0) {
    return `inode:${stat.dev}:${stat.ino}`;
  }
  return `path:${path}`;
}

function walkTreeFiles(roots, options, onFile) {
  const runtime = options.runtime || null;
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
  const skipDirs = options.skipDirs;
  const scope = options.scope || null;

  const seenInodes = new Set();
  let totalVisited = 0;
  let capped = false;

  for (const rootPath of roots) {
    if (capped) break;
    if (!safeExists(rootPath)) continue;
    const rootStat = safeStat(rootPath);
    if (!rootStat || !rootStat.isDirectory()) continue;
    const rootKey = dedupKey(rootStat, rootPath);
    if (seenInodes.has(rootKey)) {
      if (runtime) {
        runtime.recordSymlinkCycle({
          root: rootPath,
          path: rootPath,
          dedup_key: rootKey,
          reason: 'duplicate-root',
          scope,
        });
      }
      continue;
    }
    seenInodes.add(rootKey);

    const rootStartMs = runtime ? runtime.clock.now() : 0;
    let rootEntries = 0;
    let rootReaddirErrors = 0;
    const stack = [{ path: rootPath, depth: 0, root: rootPath }];

    outer: while (stack.length > 0) {
      const current = stack.pop();
      const entries = safeReaddir(current.path);
      if (!entries) {
        rootReaddirErrors += 1;
        if (runtime) {
          runtime.recordReaddirError({
            root: current.root,
            path: current.path,
            depth: current.depth,
            error_class: 'readdir',
            scope,
          });
        }
        continue;
      }

      for (const entry of entries) {
        if (totalVisited >= maxEntries) {
          if (runtime) {
            runtime.recordCap('walk.max-entries', {
              scope,
              root: current.root,
              path: current.path,
              entries: totalVisited,
              limit: maxEntries,
            });
          }
          capped = true;
          break outer;
        }
        totalVisited += 1;
        rootEntries += 1;
        if (runtime) runtime.addEntries(1);

        const fullPath = join(current.path, entry.name);

        if (entry.isDirectory()) {
          if (current.depth >= maxDepth) {
            if (runtime) {
              runtime.recordSkip('max-depth', {
                root: current.root,
                path: fullPath,
                depth: current.depth,
                scope,
              });
            }
            continue;
          }
          if (skipDirs?.has(entry.name)) {
            if (runtime) {
              runtime.recordSkip('skip-dir', {
                root: current.root,
                path: fullPath,
                name: entry.name,
                scope,
              });
            }
            continue;
          }
          const childStat = safeStat(fullPath);
          if (!childStat || !childStat.isDirectory()) {
            if (!childStat && runtime) {
              runtime.recordReaddirError({
                root: current.root,
                path: fullPath,
                error_class: 'stat',
                scope,
              });
            }
            continue;
          }
          const key = dedupKey(childStat, fullPath);
          if (seenInodes.has(key)) {
            if (runtime) {
              runtime.recordSymlinkCycle({
                root: current.root,
                path: fullPath,
                dedup_key: key,
                fs_device: childStat.dev,
                scope,
              });
            }
            continue;
          }
          seenInodes.add(key);
          stack.push({ path: fullPath, depth: current.depth + 1, root: current.root });
          continue;
        }

        if (entry.isFile()) {
          onFile(fullPath, entry, current.depth + 1);
        }
      }
    }

    if (runtime) {
      const elapsed = runtime.clock.now() - rootStartMs;
      runtime.recordRootTiming(rootPath, {
        elapsed_ms: elapsed,
        scope,
        entries: rootEntries,
        readdir_errors: rootReaddirErrors,
      });
    }
  }

  return { visitedEntries: totalVisited, capped };
}

function findTrackedPackageDirs(nodeModulesPath) {
  const packageDirs = [];

  for (const pkg of TRACKED_PACKAGES) {
    const candidate = join(nodeModulesPath, ...packageNameToPathSegments(pkg.name));
    if (safeExists(candidate)) packageDirs.push(candidate);
  }

  return packageDirs;
}

function scanNpmCache(homePath, report) {
  for (const cacheRoot of detectNpmCacheRoots(homePath)) {
    const indexRoot = join(cacheRoot, 'index-v5');
    if (!safeExists(indexRoot)) continue;

    const metadataEntries = [];
    const tarballEntries = [];
    const stack = [indexRoot];

    while (stack.length > 0) {
      const current = stack.pop();
      const entries = safeReaddir(current);
      if (!entries) continue;

      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;

        const text = safeReadText(fullPath);
        if (!text) continue;

        for (const line of text.split('\n')) {
          const parsed = parseNpmIndexEntry(line);
          if (!parsed?.key) continue;

          const key = parsed.key;
          if (
            TRACKED_PACKAGES.some(({ name }) => {
              const encodedName = encodeURIComponent(name).replace(/%2F/g, '%2f');
              return (
                key === `make-fetch-happen:request-cache:https://registry.npmjs.org/${encodedName}` ||
                key.startsWith(`make-fetch-happen:request-cache:https://registry.npmjs.org/${encodedName}?`)
              );
            })
          ) {
            metadataEntries.push(parsed);
            continue;
          }

          for (const trackedPackage of TRACKED_PACKAGES) {
            const tarballBase = trackedPackage.name.split('/').pop();
            const versionAlternation = trackedPackage.versions.map((version) => escapeRegex(version)).join('|');
            const match = key.match(new RegExp(`${escapeRegex(tarballBase)}-(${versionAlternation})\\.tgz`));
            if (!match) continue;

            tarballEntries.push({
              home: homePath,
              cacheRoot,
              packageName: trackedPackage.name,
              version: match[1],
              key,
              integrity: parsed.integrity || null,
              time: isoTime(parsed.metadata?.time || parsed.time),
              cacheRecordTime: isoTime(parsed.time),
              size: parsed.size ?? null,
              url: parsed.metadata?.url || null,
            });
          }
        }
      }
    }

    for (const entry of metadataEntries) {
      const metadata = {
        home: homePath,
        cacheRoot,
        key: entry.key,
        observedAt: isoTime(entry.metadata?.time || entry.time),
        cacheRecordTime: isoTime(entry.time),
        distTags: null,
        observedVersions: [],
      };

      const contentPath = entry.integrity ? integrityToContentPath(cacheRoot, entry.integrity) : null;
      if (contentPath && safeExists(contentPath)) {
        const contentStat = safeStat(contentPath);
        if (!contentStat || !contentStat.isFile() || contentStat.size > MAX_SCAN_FILE_SIZE) continue;
        const content = safeReadText(contentPath);
        if (content) {
          const parsed = safeJsonParse(content);
          if (parsed && typeof parsed === 'object') {
            metadata.distTags = parsed['dist-tags'] || null;
            const observed = [];
            const timeMap = parsed.time || {};
            for (const version of TRACKED_VERSION_SET) {
              if (version in timeMap || version in (parsed.versions || {})) observed.push(version);
            }
            metadata.observedVersions = observed;
          } else {
            metadata.observedVersions = findVersionsInText(content);
          }
        }
      }

      if (metadata.observedVersions.length > 0) {
        report.npmCacheMetadata.push(metadata);
        addTimeline(report, {
          time: metadata.observedAt || metadata.cacheRecordTime,
          category: 'npm-cache-metadata',
          severity: 'observed',
          summary: `npm cache metadata recorded compromised versions ${metadata.observedVersions.join(', ')}`,
          path: cacheRoot,
        });
      }
    }

    for (const entry of tarballEntries) {
      const finding = { ...entry, iocHits: [] };
      if (entry.integrity) {
        const contentPath = integrityToContentPath(cacheRoot, entry.integrity);
        if (contentPath && safeExists(contentPath)) {
          const buffer = safeReadFile(contentPath);
          if (buffer) {
            const expanded = maybeGunzip(buffer);
            finding.iocHits = searchBufferForIocs(expanded);
          }
        }
      }
      report.npmTarballFetches.push(finding);
      addTimeline(report, {
        time: finding.time || finding.cacheRecordTime,
        category: 'npm-tarball-fetch',
        severity: 'affected',
        summary: `npm cache fetched ${finding.packageName || PACKAGE_NAME}@${finding.version}`,
        path: cacheRoot,
      });
    }
  }

  for (const logsRoot of detectNpmLogRoots(homePath)) {
    const logEntries = safeReaddir(logsRoot);
    if (!logEntries) continue;

    for (const entry of logEntries) {
      if (!entry.isFile()) continue;
      const fullPath = join(logsRoot, entry.name);
      const stat = safeStat(fullPath);
      if (!stat || stat.size > MAX_SCAN_FILE_SIZE) continue;
      const text = safeReadText(fullPath);
      if (!text || !TRACKED_PACKAGES.some(({ name }) => text.includes(name))) continue;

      const versions = findVersionsInText(text);
      const indicators = collectTextIndicators(text);
      // Hard evidence in an npm log: an actual compromised version string
      // or IOC network pattern. Name-only install/exec entries happen every
      // time anyone runs `npx @automagik/genie ...` and are NOT evidence of
      // compromise — they just record that the package was interacted with.
      const hardEvidence = versions.length > 0 || indicators.iocMatches.length > 0;
      if (!hardEvidence) continue;

      report.npmLogHits.push({
        home: homePath,
        path: fullPath,
        modifiedAt: isoTime(safeStat(fullPath)?.mtimeMs),
        versions,
        installCommands: indicators.installCommands,
        executionCommands: indicators.executionCommands,
        iocMatches: indicators.iocMatches,
        snippets: extractInterestingSnippets(text),
      });
    }
  }
}

function scanBunCache(homePath, report) {
  for (const bunCacheRoot of detectBunCacheRoots(homePath)) {
    const entries = safeReaddir(bunCacheRoot);
    if (entries) {
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const version = versionFromBunCacheDirName(entry.name);
        if (!version || !COMPROMISED_VERSION_SET.has(version)) continue;

        const fullPath = join(bunCacheRoot, entry.name);
        const stat = safeStat(fullPath);
        const inspection = inspectPackageDirectory(fullPath);
        const finding = {
          home: homePath,
          cacheRoot: bunCacheRoot,
          path: fullPath,
          version,
          modifiedAt: isoTime(stat?.mtimeMs),
          iocFiles: inspection.iocFiles,
          iocStrings: inspection.iocStrings,
        };
        report.bunCacheFindings.push(finding);
        addTimeline(report, {
          time: finding.modifiedAt,
          category: 'bun-cache',
          severity: 'affected',
          summary: `bun cache retained ${PACKAGE_NAME}@${version}`,
          path: fullPath,
        });
      }
    }
  }

  const bunGlobalCandidates = [
    join(homePath, '.bun', 'install', 'global', 'node_modules', '@automagik', 'genie'),
    join(homePath, 'AppData', 'Local', 'Bun', 'install', 'global', 'node_modules', '@automagik', 'genie'),
    join(homePath, 'AppData', 'Local', 'bun', 'install', 'global', 'node_modules', '@automagik', 'genie'),
  ];

  for (const bunGlobal of bunGlobalCandidates) {
    if (!safeExists(bunGlobal)) continue;

    const inspection = inspectPackageDirectory(bunGlobal);
    if (hasHardInfectionEvidence(inspection)) {
      const finding = {
        kind: 'bun-global',
        home: homePath,
        path: bunGlobal,
        realpath: inspection.realpath,
        packageName: inspection.packageName,
        version: inspection.version,
        compromisedVersion: inspection.compromisedVersion,
        iocFiles: inspection.iocFiles,
        iocFileHashes: inspection.iocFileHashes,
        iocStrings: inspection.iocStrings,
      };
      report.installFindings.push(finding);
      addTimeline(report, {
        time: isoTime(safeStat(bunGlobal)?.mtimeMs),
        category: 'install',
        severity: 'affected',
        summary: `bun global install contains suspicious ${inspection.packageName || PACKAGE_NAME} bytes`,
        path: bunGlobal,
      });
    }
  }
}

function scanGlobalInstallCandidates(homes, report) {
  const candidates = new Set();

  for (const homePath of homes) {
    candidates.add(join(homePath, '.local', 'lib', 'node_modules'));
    candidates.add(join(homePath, '.bun', 'install', 'global', 'node_modules'));
    candidates.add(join(homePath, 'AppData', 'Roaming', 'npm', 'node_modules'));
    candidates.add(join(homePath, 'AppData', 'Local', 'Bun', 'install', 'global', 'node_modules'));
  }

  for (const prefix of detectNpmGlobalPrefixes()) {
    candidates.add(join(prefix, 'lib', 'node_modules'));
    candidates.add(join(prefix, 'node_modules'));
  }

  for (const systemPath of ['/usr/local/lib/node_modules', '/usr/lib/node_modules', '/opt/homebrew/lib/node_modules']) {
    candidates.add(systemPath);
  }

  for (const nodeModulesPath of candidates) {
    if (!safeExists(nodeModulesPath)) continue;

    for (const candidate of findTrackedPackageDirs(nodeModulesPath)) {
      const inspection = inspectPackageDirectory(candidate);
      if (!hasHardInfectionEvidence(inspection)) continue;

      const finding = {
        kind: 'global-install',
        path: candidate,
        realpath: inspection.realpath,
        packageName: inspection.packageName,
        version: inspection.version,
        compromisedVersion: inspection.compromisedVersion,
        iocFiles: inspection.iocFiles,
        iocFileHashes: inspection.iocFileHashes,
        iocStrings: inspection.iocStrings,
      };
      report.installFindings.push(finding);
      addTimeline(report, {
        time: isoTime(safeStat(candidate)?.mtimeMs),
        category: 'install',
        severity: 'affected',
        summary: `global install contains suspicious ${inspection.packageName || PACKAGE_NAME} bytes`,
        path: candidate,
      });
    }
  }
}

function walkProjectRoots(roots, options, onNodeModules, onLockfile) {
  const runtime = options?.runtime || null;
  const maxDepth = options?.maxDepth ?? DEFAULT_PROJECT_WALK_MAX_DEPTH;
  const maxEntries = options?.maxEntries ?? DEFAULT_PROJECT_WALK_MAX_ENTRIES;
  const scope = 'project-roots';

  const seenInodes = new Set();
  let totalVisited = 0;
  let capped = false;

  for (const rootPath of roots) {
    if (capped) break;
    const rootStat = safeStat(rootPath);
    if (!rootStat || !rootStat.isDirectory()) continue;
    const rootKey = dedupKey(rootStat, rootPath);
    if (seenInodes.has(rootKey)) {
      if (runtime) {
        runtime.recordSymlinkCycle({
          root: rootPath,
          path: rootPath,
          dedup_key: rootKey,
          reason: 'duplicate-root',
          scope,
        });
      }
      continue;
    }
    seenInodes.add(rootKey);

    const rootStartMs = runtime ? runtime.clock.now() : 0;
    let rootEntries = 0;
    const stack = [{ path: rootPath, depth: 0, root: rootPath }];

    outer: while (stack.length > 0) {
      const current = stack.pop();
      const entries = safeReaddir(current.path);
      if (!entries) {
        if (runtime) {
          runtime.recordReaddirError({
            root: current.root,
            path: current.path,
            depth: current.depth,
            error_class: 'readdir',
            scope,
          });
        }
        continue;
      }

      for (const entry of entries) {
        if (totalVisited >= maxEntries) {
          if (runtime) {
            runtime.recordCap('walk.max-entries', {
              scope,
              root: current.root,
              path: current.path,
              entries: totalVisited,
              limit: maxEntries,
            });
          }
          capped = true;
          break outer;
        }
        totalVisited += 1;
        rootEntries += 1;
        if (runtime) runtime.addEntries(1);

        const fullPath = join(current.path, entry.name);

        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') {
            onNodeModules(fullPath);
            continue;
          }
          if (WALK_SKIP_DIRS.has(entry.name)) {
            if (runtime) {
              runtime.recordSkip('skip-dir', { root: current.root, path: fullPath, name: entry.name, scope });
            }
            continue;
          }
          if (current.depth >= maxDepth) {
            if (runtime) {
              runtime.recordSkip('max-depth', { root: current.root, path: fullPath, depth: current.depth, scope });
            }
            continue;
          }
          const childStat = safeStat(fullPath);
          if (!childStat || !childStat.isDirectory()) {
            if (!childStat && runtime) {
              runtime.recordReaddirError({ root: current.root, path: fullPath, error_class: 'stat', scope });
            }
            continue;
          }
          const key = dedupKey(childStat, fullPath);
          if (seenInodes.has(key)) {
            if (runtime) {
              runtime.recordSymlinkCycle({
                root: current.root,
                path: fullPath,
                dedup_key: key,
                fs_device: childStat.dev,
                scope,
              });
            }
            continue;
          }
          seenInodes.add(key);
          stack.push({ path: fullPath, depth: current.depth + 1, root: current.root });
          continue;
        }

        if (!entry.isFile()) continue;
        if (!LOCKFILE_NAMES.has(entry.name)) continue;
        onLockfile(fullPath);
      }
    }

    if (runtime) {
      runtime.recordRootTiming(rootPath, {
        elapsed_ms: runtime.clock.now() - rootStartMs,
        scope,
        entries: rootEntries,
      });
    }
  }
}

function scanProjectRoots(roots, report, runtime) {
  walkProjectRoots(
    roots,
    { runtime, maxDepth: DEFAULT_PROJECT_WALK_MAX_DEPTH, maxEntries: DEFAULT_PROJECT_WALK_MAX_ENTRIES },
    (nodeModulesPath) => {
      for (const packageDir of findTrackedPackageDirs(nodeModulesPath)) {
        const inspection = inspectPackageDirectory(packageDir);
        if (!hasHardInfectionEvidence(inspection)) continue;

        const finding = {
          kind: 'local-install',
          path: packageDir,
          realpath: inspection.realpath,
          packageName: inspection.packageName,
          version: inspection.version,
          compromisedVersion: inspection.compromisedVersion,
          iocFiles: inspection.iocFiles,
          iocFileHashes: inspection.iocFileHashes,
          iocStrings: inspection.iocStrings,
        };
        report.installFindings.push(finding);
        addTimeline(report, {
          time: isoTime(safeStat(packageDir)?.mtimeMs),
          category: 'install',
          severity: 'affected',
          summary: `project node_modules contains suspicious ${inspection.packageName || PACKAGE_NAME} bytes`,
          path: packageDir,
        });
      }
    },
    (lockfilePath) => {
      const stat = safeStat(lockfilePath);
      if (!stat || stat.size > MAX_SCAN_FILE_SIZE) return;

      const text = safeReadText(lockfilePath);
      if (!text) return;
      if (!TRACKED_PACKAGES.some(({ name }) => text.includes(name))) return;

      const versions = findVersionsInText(text);
      if (versions.length === 0) return;

      report.lockfileFindings.push({
        path: lockfilePath,
        modifiedAt: isoTime(stat.mtimeMs),
        versions,
      });
      addTimeline(report, {
        time: isoTime(stat.mtimeMs),
        category: 'lockfile',
        severity: 'observed',
        summary: `lockfile references compromised versions ${versions.join(', ')}`,
        path: lockfilePath,
      });
    },
  );
}

function scanShellProfiles(homes, report, runtime) {
  const directPaths = [];
  const directoryRoots = [];

  for (const homePath of homes) {
    for (const relativePath of SHELL_PROFILE_FILES) {
      directPaths.push({ kind: 'shell-profile', home: homePath, path: join(homePath, relativePath) });
    }
    for (const relativePath of SHELL_PROFILE_DIRS) {
      directoryRoots.push({ kind: 'shell-profile-dir', home: homePath, path: join(homePath, relativePath) });
    }
  }

  for (const path of SYSTEM_PROFILE_PATHS) {
    const stat = safeStat(path);
    if (!stat) continue;
    if (stat.isFile()) {
      directPaths.push({ kind: 'system-profile', home: null, path });
    } else if (stat.isDirectory()) {
      directoryRoots.push({ kind: 'system-profile-dir', home: null, path });
    }
  }

  for (const candidate of directPaths) {
    if (!safeExists(candidate.path)) continue;
    const finding = inspectTextEvidenceFile(candidate.path);
    if (!finding) continue;

    report.shellProfileFindings.push({
      kind: candidate.kind,
      home: candidate.home,
      ...finding,
    });

    addTimeline(report, {
      time: finding.modifiedAt,
      category: 'shell-profile',
      severity: 'compromised',
      summary: 'shell startup file references suspicious package execution or IOC data',
      path: finding.path,
    });
  }

  for (const candidate of directoryRoots) {
    if (!safeExists(candidate.path)) continue;
    walkTreeFiles(
      [candidate.path],
      { maxDepth: 2, maxEntries: 1000, skipDirs: WALK_SKIP_DIRS, runtime, scope: 'shell-profiles' },
      (fullPath) => {
        const finding = inspectTextEvidenceFile(fullPath);
        if (!finding) return;

        report.shellProfileFindings.push({
          kind: candidate.kind,
          home: candidate.home,
          ...finding,
        });

        addTimeline(report, {
          time: finding.modifiedAt,
          category: 'shell-profile',
          severity: 'compromised',
          summary: 'shell profile drop-in references suspicious package execution or IOC data',
          path: finding.path,
        });
      },
    );
  }
}

function scanShellHistories(homes, report) {
  for (const homePath of homes) {
    for (const relativePath of SHELL_HISTORY_FILES) {
      const fullPath = join(homePath, relativePath);
      if (!safeExists(fullPath)) continue;

      const finding = inspectTextEvidenceFile(fullPath);
      if (!finding) continue;

      // Hard evidence: network-IOC pattern (curl/wget to exfil host),
      // raw IOC string match, or explicit compromised-version string in
      // history. Pure `executionCommands`/`installCommands` name-match is
      // ambient noise (triggered every time the user runs the scanner).
      const hasHardEvidence =
        finding.networkCommands.length > 0 || finding.iocMatches.length > 0 || finding.versions.length > 0;

      const exposure = hasHardEvidence ? 'execution' : 'reference';

      report.shellHistoryFindings.push({
        kind: 'shell-history',
        home: homePath,
        exposure,
        hardEvidence: hasHardEvidence,
        ...finding,
      });

      addTimeline(report, {
        time: finding.modifiedAt,
        category: 'shell-history',
        severity: hasHardEvidence ? 'compromised' : 'observed',
        summary: hasHardEvidence
          ? 'shell history shows execution evidence for suspicious package activity'
          : 'shell history references tracked package name (clean or unversioned) — informational',
        path: finding.path,
      });
    }
  }
}

function buildPersistenceTargets(platformInfo, homes) {
  const targets = [];

  if (platformInfo.platform === 'darwin') {
    for (const homePath of homes) {
      targets.push({ kind: 'launchd-user', home: homePath, path: join(homePath, 'Library', 'LaunchAgents') });
    }

    for (const path of [
      '/Library/LaunchAgents',
      '/Library/LaunchDaemons',
      '/System/Library/LaunchAgents',
      '/System/Library/LaunchDaemons',
      '/etc/periodic/daily',
      '/etc/periodic/weekly',
      '/etc/periodic/monthly',
      '/etc/launchd.conf',
    ]) {
      targets.push({ kind: 'launchd-system', home: null, path });
    }
  } else {
    for (const homePath of homes) {
      targets.push({ kind: 'systemd-user', home: homePath, path: join(homePath, '.config', 'systemd', 'user') });
      targets.push({
        kind: 'systemd-user',
        home: homePath,
        path: join(homePath, '.local', 'share', 'systemd', 'user'),
      });
      targets.push({ kind: 'autostart-user', home: homePath, path: join(homePath, '.config', 'autostart') });
      targets.push({ kind: 'cron-user', home: homePath, path: join(homePath, '.config', 'cron') });
      targets.push({ kind: 'cron-user', home: homePath, path: join(homePath, '.crontab') });
    }

    for (const path of [
      '/etc/crontab',
      '/etc/cron.d',
      '/etc/cron.daily',
      '/etc/cron.hourly',
      '/etc/cron.weekly',
      '/etc/cron.monthly',
      '/etc/systemd/system',
      '/usr/local/lib/systemd/system',
      '/usr/lib/systemd/system',
      '/lib/systemd/system',
      '/etc/init.d',
      '/etc/rc.local',
      '/etc/profile.d',
      '/etc/xdg/autostart',
    ]) {
      targets.push({ kind: 'linux-persistence', home: null, path });
    }
  }

  return targets;
}

function scanPersistenceLocations(platformInfo, homes, report, runtime) {
  const targets = buildPersistenceTargets(platformInfo, homes);

  for (const target of targets) {
    const stat = safeStat(target.path);
    if (!stat) continue;

    if (stat.isFile()) {
      const finding = inspectTextEvidenceFile(target.path);
      if (!finding) continue;

      report.persistenceFindings.push({
        kind: target.kind,
        home: target.home,
        ...finding,
      });

      addTimeline(report, {
        time: finding.modifiedAt,
        category: 'persistence',
        severity: 'compromised',
        summary: `${target.kind} contains suspicious persistence or IOC data`,
        path: finding.path,
      });
      continue;
    }

    walkTreeFiles(
      [target.path],
      { maxDepth: 3, maxEntries: 4000, skipDirs: WALK_SKIP_DIRS, runtime, scope: 'persistence' },
      (fullPath) => {
        const finding = inspectTextEvidenceFile(fullPath);
        if (!finding) return;

        report.persistenceFindings.push({
          kind: target.kind,
          home: target.home,
          ...finding,
        });

        addTimeline(report, {
          time: finding.modifiedAt,
          category: 'persistence',
          severity: 'compromised',
          summary: `${target.kind} contains suspicious persistence or IOC data`,
          path: finding.path,
        });
      },
    );
  }
}

function collectPythonPthScanRoots(homes, roots) {
  const pthRoots = new Set(['/usr/local/lib', '/usr/lib', '/Library/Python', '/opt/homebrew/lib']);

  for (const homePath of homes) {
    for (const relativePath of PYTHON_PTH_ROOTS) {
      pthRoots.add(join(homePath, relativePath));
    }
  }

  for (const rootPath of roots) {
    pthRoots.add(join(rootPath, 'venv'));
    pthRoots.add(join(rootPath, '.venv'));
  }

  return [...pthRoots].filter((path) => {
    const stat = safeStat(path);
    return stat?.isDirectory();
  });
}

function scanPythonPthArtifacts(homes, roots, report, runtime) {
  const pthRoots = collectPythonPthScanRoots(homes, roots);

  walkTreeFiles(
    pthRoots,
    {
      maxDepth: 5,
      maxEntries: 12000,
      skipDirs: new Set([...WALK_SKIP_DIRS, 'node_modules']),
      runtime,
      scope: 'python-pth',
    },
    (fullPath) => {
      if (!fullPath.endsWith('.pth')) return;

      const finding = inspectTextEvidenceFile(fullPath);
      if (!finding) return;

      report.pythonPthFindings.push({
        kind: 'python-pth',
        ...finding,
      });

      addTimeline(report, {
        time: finding.modifiedAt,
        category: 'python-pth',
        severity: 'compromised',
        summary: '.pth file contains suspicious propagation or exfiltration indicators',
        path: finding.path,
      });
    },
  );
}

function scanImpactSurface(homes, roots, report, runtime) {
  const findings = [];

  for (const homePath of homes) {
    for (const entry of [...TARGETED_SECRET_PATHS, ...TARGETED_BROWSER_ROOTS, ...TARGETED_WALLET_PATHS]) {
      const fullPath = join(homePath, entry.relativePath);
      const stat = safeStat(fullPath);
      if (!stat) continue;
      findings.push({
        kind: entry.kind,
        label: entry.relativePath,
        path: fullPath,
        modifiedAt: isoTime(stat.mtimeMs),
        isDirectory: stat.isDirectory(),
      });
    }

    for (const browserRoot of TARGETED_BROWSER_ROOTS) {
      const fullPath = join(homePath, browserRoot.relativePath);
      const stat = safeStat(fullPath);
      if (!stat || !stat.isDirectory()) continue;

      for (const extension of TARGETED_BROWSER_EXTENSION_IDS) {
        walkTreeFiles(
          [fullPath],
          {
            maxDepth: 3,
            maxEntries: 1500,
            skipDirs: new Set([...WALK_SKIP_DIRS, 'Cache']),
            runtime,
            scope: 'impact-surface',
          },
          (candidatePath) => {
            if (!candidatePath.includes(`/Extensions/${extension.id}/`)) return;
            if (basename(candidatePath) !== 'manifest.json') return;
            const extensionStat = safeStat(candidatePath);
            if (!extensionStat) return;
            findings.push({
              kind: extension.kind,
              label: extension.name,
              path: candidatePath,
              modifiedAt: isoTime(extensionStat.mtimeMs),
              isDirectory: extensionStat.isDirectory(),
            });
          },
        );
      }
    }
  }

  for (const rootPath of roots) {
    const entries = safeReaddir(rootPath);
    if (!entries) continue;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/^\.(env|env\.)/i.test(entry.name)) continue;
      const fullPath = join(rootPath, entry.name);
      const stat = safeStat(fullPath);
      if (!stat) continue;
      findings.push({
        kind: 'secret-store',
        label: entry.name,
        path: fullPath,
        modifiedAt: isoTime(stat.mtimeMs),
        isDirectory: false,
      });
    }
  }

  report.impactSurfaceFindings = uniq(findings.map((entry) => JSON.stringify(entry))).map((entry) => JSON.parse(entry));
}

function collectTempRoots(platformInfo, homes, roots) {
  const tempRoots = new Set();

  for (const candidate of [
    process.env.TMPDIR,
    process.env.TEMP,
    process.env.TMP,
    '/tmp',
    '/var/tmp',
    platformInfo.platform === 'darwin' ? '/private/tmp' : null,
  ]) {
    if (candidate) tempRoots.add(candidate);
  }

  for (const homePath of homes) {
    // ~/.npm, ~/.npm/_npx, ~/.cache, ~/.bun intentionally omitted: dedicated
    // scanNpmCache / scanBunCache phases cover them with tighter caps; walking
    // them here surfaces hundreds of MB of content scans and bypasses
    // WALK_SKIP_DIRS (skip-set only filters sub-entries, not chosen roots).
    for (const candidate of [
      join(homePath, 'Library', 'Caches'),
      join(homePath, 'AppData', 'Local', 'Temp'),
      join(homePath, 'AppData', 'Local', 'npm-cache'),
    ]) {
      tempRoots.add(candidate);
    }
  }

  for (const rootPath of roots) {
    tempRoots.add(join(rootPath, '.npm'));
    tempRoots.add(join(rootPath, '.cache'));
    tempRoots.add(join(rootPath, 'tmp'));
  }

  return [...tempRoots].filter((path) => {
    const stat = safeStat(path);
    return stat?.isDirectory();
  });
}

function resolveTempBudgets(runtime) {
  const budgets = runtime?.options?.phaseBudgets || {};
  const filesOverride = Number(budgets['scanTempArtifacts.files']);
  const bytesOverride = Number(budgets['scanTempArtifacts.bytes']);
  const wallOverride = Number(budgets['scanTempArtifacts.wall_ms']);
  // Back-compat: `--phase-budget scanTempArtifacts=N` is interpreted as the
  // files-count cap (dominant failure mode for this phase).
  const shorthandOverride = Number(budgets.scanTempArtifacts);
  const files =
    Number.isFinite(filesOverride) && filesOverride >= 0
      ? filesOverride
      : Number.isFinite(shorthandOverride) && shorthandOverride >= 0
        ? shorthandOverride
        : DEFAULT_TEMP_FILES_BUDGET;
  const bytes = Number.isFinite(bytesOverride) && bytesOverride >= 0 ? bytesOverride : DEFAULT_TEMP_BYTES_BUDGET;
  const wallMs = Number.isFinite(wallOverride) && wallOverride >= 0 ? wallOverride : DEFAULT_TEMP_WALL_BUDGET_MS;
  return { files, bytes, wallMs };
}

function pushSizeCappedTempFinding(report, fullPath, stat, namedHits) {
  const finding = {
    path: fullPath,
    realpath: safeRealpath(fullPath),
    size: stat.size,
    modifiedAt: isoTime(stat.mtimeMs),
    nameMatches: namedHits,
    sha256: null,
    expectedSha256: expectedMalwareHashForBasename(basename(fullPath)),
    knownMalwareHash: false,
    iocMatches: [],
    versions: [],
    packageRefs: [],
    executionCommands: [],
    networkCommands: [],
    snippets: [],
    size_capped_not_hashed: true,
  };
  report.tempArtifactFindings.push(finding);
  addTimeline(report, {
    time: finding.modifiedAt,
    category: 'temp-artifact',
    severity: namedHits.some((value) => /env-compat\.(?:cjs|js)/i.test(value)) ? 'compromised' : 'affected',
    summary: 'temp or cache artifact matched known-bad basename; size-capped, content not scanned',
    path: fullPath,
  });
}

function inspectTempFileSync(fullPath, report) {
  const stat = safeStat(fullPath);
  if (!stat || !stat.isFile()) return { bytesRead: 0, skipped: true };

  const namedHits = collectNamedArtifactHits(fullPath);

  // Size guard applies universally (hotfix: close DoS via name-regex fast path).
  // Basename hits still surface a finding but content is NOT read/hashed.
  if (stat.size > MAX_TEMP_CONTENT_SCAN_SIZE) {
    if (namedHits.length > 0 && report.tempArtifactFindings.length < MAX_TEMP_FINDINGS) {
      pushSizeCappedTempFinding(report, fullPath, stat, namedHits);
    }
    return { bytesRead: 0, skipped: true };
  }

  const buffer = safeReadFile(fullPath);
  if (!buffer) return { bytesRead: 0, skipped: true };

  const bytesRead = buffer.length;
  const expanded = maybeGunzip(buffer);
  const iocMatches = searchBufferForIocs(expanded);
  const fileSha256 = sha256(expanded);
  const expectedSha256 = expectedMalwareHashForBasename(basename(fullPath));

  const text = expanded.toString('utf8');
  const indicators = collectTextIndicators(text);
  const versions = indicators.versions;
  const packageRefs = indicators.packageRefs;
  const executionCommands = indicators.executionCommands;
  const networkCommands = indicators.networkCommands;
  const snippets = extractInterestingSnippets(text);

  if (
    namedHits.length === 0 &&
    iocMatches.length === 0 &&
    versions.length === 0 &&
    packageRefs.length === 0 &&
    executionCommands.length === 0 &&
    networkCommands.length === 0
  ) {
    return { bytesRead, skipped: false };
  }

  const finding = {
    path: fullPath,
    realpath: safeRealpath(fullPath),
    size: stat.size,
    modifiedAt: isoTime(stat.mtimeMs),
    nameMatches: namedHits,
    sha256: fileSha256,
    expectedSha256,
    knownMalwareHash: Boolean(expectedSha256 && expectedSha256 === fileSha256),
    iocMatches,
    versions,
    packageRefs,
    executionCommands,
    networkCommands,
    snippets,
  };

  report.tempArtifactFindings.push(finding);
  addTimeline(report, {
    time: finding.modifiedAt,
    category: 'temp-artifact',
    severity:
      iocMatches.length > 0 ||
      namedHits.some((value) => /env-compat\.(?:cjs|js)/i.test(value)) ||
      Boolean(expectedSha256 && expectedSha256 === fileSha256)
        ? 'compromised'
        : 'affected',
    summary: 'temp or cache artifact retained suspicious package evidence',
    path: fullPath,
  });
  return { bytesRead, skipped: false };
}

async function processTempArtifactQueue(pending, report, runtime) {
  const { files: filesBudget, bytes: bytesBudget, wallMs: wallBudget } = resolveTempBudgets(runtime);
  let filesProcessed = 0;
  let bytesProcessed = 0;
  let capRecorded = false;
  const startMs = Date.now();

  const recordCapOnce = (reason, limit) => {
    if (capRecorded) return;
    capRecorded = true;
    if (runtime && typeof runtime.recordPhaseCapHit === 'function') {
      runtime.recordPhaseCapHit(reason, {
        // `root` is what `envelopeFromReport` greps for in `coverage.cappedRoots`;
        // without it a phase-budget breach does not surface in the coverage banner.
        root: 'scanTempArtifacts',
        limit,
        entries_processed: filesProcessed,
        bytes_processed: bytesProcessed,
      });
    }
  };

  for (const fullPath of pending) {
    if (runtime && typeof runtime.isInterrupted === 'function' && runtime.isInterrupted()) break;
    if (report.tempArtifactFindings.length >= MAX_TEMP_FINDINGS) break;
    // Wall first — a single slow `readFileSync` (spinning disk, NFS, large
    // near-limit file) can blow the other budgets' theoretical bounds; the
    // wall-clock check is the definitive "stop" signal.
    if (wallBudget > 0 && Date.now() - startMs >= wallBudget) {
      recordCapOnce('wall_budget', wallBudget);
      break;
    }
    if (filesProcessed >= filesBudget) {
      recordCapOnce('files_budget', filesBudget);
      break;
    }
    if (bytesProcessed >= bytesBudget) {
      recordCapOnce('bytes_budget', bytesBudget);
      break;
    }

    const { bytesRead } = inspectTempFileSync(fullPath, report);
    filesProcessed += 1;
    if (bytesRead > 0) bytesProcessed += bytesRead;
    if (runtime && typeof runtime.addBytes === 'function' && bytesRead > 0) runtime.addBytes(bytesRead);

    if (filesProcessed % TEMP_YIELD_INTERVAL === 0) {
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
    }
  }
  return { filesProcessed, bytesProcessed, capRecorded };
}

async function scanTempArtifacts(platformInfo, homes, roots, report, runtime) {
  const tempRoots = collectTempRoots(platformInfo, homes, roots);
  const pending = [];

  walkTreeFiles(
    tempRoots,
    {
      maxDepth: 4,
      maxEntries: MAX_TEMP_WALK_ENTRIES,
      skipDirs: new Set([...WALK_SKIP_DIRS, 'node_modules']),
      runtime,
      scope: 'temp-artifacts',
    },
    (fullPath) => {
      pending.push(fullPath);
    },
  );

  await processTempArtifactQueue(pending, report, runtime);
}

function scanLiveProcesses(report) {
  const suspectPaths = uniq(
    report.installFindings.flatMap((finding) => [finding.path, finding.realpath].filter(Boolean)),
  );

  const result =
    safeSpawn('ps', ['axo', 'pid=,ppid=,user=,etime=,command=']) ||
    safeSpawn('ps', ['-eo', 'pid=,ppid=,user=,etime=,args=']);

  if (!result || result.status !== 0) return;

  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;

    const [, pid, ppid, user, elapsed, command] = match;

    // Self-exclusion: the running scanner + any wrapping shell that invoked
    // it (e.g. `bash -c "npx @automagik/genie sec scan …"`) will always
    // match the tracked-package regexes in their own cmdline. Ignore both.
    if (String(pid) === String(process.pid)) continue;
    if (String(pid) === String(process.ppid)) continue;
    if (command.includes('sec-scan.cjs') || command.includes('/sec-scan ')) continue;
    if (
      /\bgenie\s+sec\s+(scan|remediate|restore|rollback|verify-install|quarantine|print-cleanup-commands)\b/.test(
        command,
      )
    ) {
      continue;
    }

    const indicators = collectTextIndicators(command);
    const namedHits = collectNamedArtifactHits(command);
    const matchedInstallPaths = suspectPaths.filter((path) => command.includes(path));

    // Hard evidence requires either an actual compromised version token in
    // the cmdline OR an IOC string hit OR a network-IOC command. Pure name
    // matches (e.g. `pgserve@1.1.10` where 1.1.10 is CLEAN) are NOT compromise
    // evidence — they only tell us the package is running, which is normal.
    const hasHardEvidence =
      indicators.iocMatches.length > 0 ||
      indicators.networkCommands.length > 0 ||
      indicators.versions.length > 0 ||
      matchedInstallPaths.length > 0;

    const hasWeakHit = hasHardEvidence || indicators.executionCommands.length > 0 || namedHits.length > 0;
    if (!hasWeakHit) continue;

    report.liveProcessFindings.push({
      pid: Number(pid),
      ppid: Number(ppid),
      user,
      elapsed,
      command,
      matchedInstallPaths,
      versions: indicators.versions,
      iocMatches: indicators.iocMatches,
      executionCommands: indicators.executionCommands,
      networkCommands: indicators.networkCommands,
      nameMatches: namedHits,
      hardEvidence: hasHardEvidence,
    });

    addTimeline(report, {
      time: null,
      category: 'live-process',
      severity: hasHardEvidence ? 'compromised' : 'observed',
      summary: hasHardEvidence
        ? `live process ${pid} matches suspicious package execution indicators`
        : `live process ${pid} running tracked package name (clean or unversioned) — informational`,
      path: command,
    });
  }
}

function countStrongProfileEvidence(report) {
  return report.shellProfileFindings.filter(
    (finding) =>
      finding.versions.length > 0 ||
      finding.iocMatches.length > 0 ||
      finding.executionCommands.length > 0 ||
      finding.networkCommands.length > 0,
  ).length;
}

// Hard execution evidence in shell history = actual network-IOC (curl/wget
// to exfil host) or raw IOC string or explicit compromised version. Pure
// `executionCommands` matches (exec:@automagik/genie, exec:npx @automagik/genie)
// fire every time the user runs the scanner itself or any other genie command
// and are NOT compromise evidence. Same for `installCommands` — cleanup
// activity (`npm uninstall -g @automagik/genie`) triggers them.
function countExecutionHistoryEvidence(report) {
  return report.shellHistoryFindings.filter(
    (finding) => finding.networkCommands.length > 0 || finding.iocMatches.length > 0 || finding.versions.length > 0,
  ).length;
}

function countInstallHistoryEvidence(report) {
  // Same logic: only count install lines that explicitly reference a
  // compromised version OR carry an IOC pattern. Bare install/uninstall
  // commands on tracked package names are ambient noise.
  return report.shellHistoryFindings.filter((finding) => finding.versions.length > 0 || finding.iocMatches.length > 0)
    .length;
}

// Strong temp-artifact evidence = actual malware bytes / IOC strings /
// env-compat artifact. Pure `executionCommands` (package-name execute
// pattern) in a text file (log, audit json, registry) is NOT compromise —
// dev tooling routinely writes package names into /tmp during tests.
function countStrongTempEvidence(report) {
  return report.tempArtifactFindings.filter(
    (finding) =>
      finding.iocMatches.length > 0 ||
      finding.knownMalwareHash ||
      finding.nameMatches.some((value) => /env-compat\.(?:cjs|js)/i.test(value)),
  ).length;
}

function buildRecommendations(summary) {
  if (summary.status === 'LIKELY COMPROMISED') {
    return [
      'Isolate the host from the network before making cleanup changes.',
      'Rotate npm, GitHub, cloud, and AI-provider credentials that were ever present on the host.',
      'Preserve volatile evidence: process list, network connections, and affected files before deleting artifacts.',
      'Rebuild the host or revert to a known-good snapshot if persistence or live execution evidence exists.',
    ];
  }

  if (summary.status === 'LIKELY AFFECTED') {
    return [
      'Remove compromised package versions from caches and installed locations.',
      'Rotate credentials that may have been readable by local package execution.',
      'Review shell history and project roots to confirm whether the package was only fetched or actually executed.',
    ];
  }

  if (summary.status === 'OBSERVED ONLY') {
    return [
      'Clear stale npm and bun cache entries referencing compromised versions.',
      'Review the referenced lockfiles and logs to confirm the package was not installed or executed.',
    ];
  }

  return ['No incident-specific evidence was found on this host.'];
}

function summarize(report) {
  const strongProfileEvidence = countStrongProfileEvidence(report);
  const executionHistoryEvidence = countExecutionHistoryEvidence(report);
  const installHistoryEvidence = countInstallHistoryEvidence(report);
  const strongTempEvidence = countStrongTempEvidence(report);

  const compromiseReasons = [];
  const affectedReasons = [];

  if (report.persistenceFindings.length > 0) {
    compromiseReasons.push('persistence locations reference suspicious package execution or IOCs');
  }
  if (strongProfileEvidence > 0) {
    compromiseReasons.push('shell startup files contain suspicious package execution or IOC references');
  }
  if (executionHistoryEvidence > 0) {
    compromiseReasons.push('shell history shows suspicious package execution or IOC-related commands');
  }
  if (strongTempEvidence > 0) {
    compromiseReasons.push('temp or cache directories retain dropped env-compat artifacts or IOC strings');
  }
  const hardEvidenceProcesses = report.liveProcessFindings.filter((entry) => entry.hardEvidence);
  if (hardEvidenceProcesses.length > 0) {
    compromiseReasons.push('live processes match suspicious package execution indicators');
  }
  if (report.pythonPthFindings.length > 0) {
    compromiseReasons.push('Python .pth files contain propagation or exfiltration indicators');
  }

  if (report.installFindings.length > 0) {
    affectedReasons.push('installed package directories contain compromised versions or IOC-bearing files');
  }
  if (report.npmTarballFetches.length > 0) {
    affectedReasons.push('npm cache fetched compromised tarballs');
  }
  if (report.bunCacheFindings.length > 0) {
    affectedReasons.push('bun cache retained compromised versions');
  }
  if (installHistoryEvidence > 0) {
    affectedReasons.push('shell history shows package installation commands');
  }
  // Weak temp findings (name-only matches on /tmp text files like Claude
  // session logs and bun task-output dumps) are NOT affected-grade evidence
  // — they're just text files that happen to contain the string "pgserve"
  // or "@automagik/genie". They still appear in the report for transparency
  // but must not elevate status from OBSERVED ONLY to LIKELY AFFECTED.
  // Only `strongTempEvidence` (IOC string, malware hash, env-compat name)
  // pushes a compromise/affected reason, via the `compromiseReasons` branch
  // above.

  const likelyCompromised = compromiseReasons.length > 0;
  const likelyAffected =
    likelyCompromised ||
    affectedReasons.length > 0 ||
    report.installFindings.length > 0 ||
    report.npmTarballFetches.length > 0 ||
    report.bunCacheFindings.length > 0;

  const observedOnly =
    !likelyAffected &&
    (report.npmCacheMetadata.length > 0 || report.npmLogHits.length > 0 || report.lockfileFindings.length > 0);

  let suspicionScore = 0;
  suspicionScore += Math.min(report.persistenceFindings.length * 30, 60);
  suspicionScore += Math.min(strongProfileEvidence * 20, 40);
  suspicionScore += Math.min(executionHistoryEvidence * 20, 40);
  suspicionScore += Math.min(strongTempEvidence * 20, 40);
  suspicionScore += Math.min(hardEvidenceProcesses.length * 25, 50);
  suspicionScore += Math.min(report.pythonPthFindings.length * 25, 50);
  suspicionScore += Math.min(report.installFindings.length * 12, 24);
  suspicionScore += Math.min(report.npmTarballFetches.length * 8, 24);
  suspicionScore += Math.min(report.bunCacheFindings.length * 8, 24);
  suspicionScore += Math.min(report.npmCacheMetadata.length * 2, 6);
  suspicionScore += Math.min(report.lockfileFindings.length * 2, 6);
  suspicionScore = Math.min(suspicionScore, 100);

  const status = likelyCompromised
    ? 'LIKELY COMPROMISED'
    : likelyAffected
      ? 'LIKELY AFFECTED'
      : observedOnly
        ? 'OBSERVED ONLY'
        : 'NO FINDINGS';

  return {
    status,
    likelyCompromised,
    likelyAffected,
    observedOnly,
    suspicionScore,
    compromiseReasons,
    affectedReasons,
    findingCounts: {
      npmCacheMetadata: report.npmCacheMetadata.length,
      npmTarballFetches: report.npmTarballFetches.length,
      bunCacheFindings: report.bunCacheFindings.length,
      installFindings: report.installFindings.length,
      lockfileFindings: report.lockfileFindings.length,
      npmLogHits: report.npmLogHits.length,
      shellProfileFindings: report.shellProfileFindings.length,
      shellHistoryFindings: report.shellHistoryFindings.length,
      persistenceFindings: report.persistenceFindings.length,
      pythonPthFindings: report.pythonPthFindings.length,
      tempArtifactFindings: report.tempArtifactFindings.length,
      liveProcessFindings: report.liveProcessFindings.length,
      impactSurfaceFindings: report.impactSurfaceFindings.length,
      errors: report.errors.length,
    },
    recommendations: buildRecommendations({ status }),
  };
}

function flattenPackageIocMatches(finding) {
  return uniq(finding.iocStrings.flatMap((entry) => entry.matches));
}

function flattenKnownHashHits(finding) {
  return (finding.iocFileHashes || []).filter((entry) => entry.knownMalwareHash);
}

function printTextFindingDetails(finding) {
  const matchGroups = [];
  if (finding.versions?.length > 0) matchGroups.push(`versions=${finding.versions.join(', ')}`);
  if (finding.iocMatches?.length > 0) matchGroups.push(`ioc=${finding.iocMatches.join(', ')}`);
  if (finding.packageRefs?.length > 0) matchGroups.push(`package=${finding.packageRefs.join(', ')}`);
  if (finding.installCommands?.length > 0) matchGroups.push(`install=${finding.installCommands.join(', ')}`);
  if (finding.executionCommands?.length > 0) matchGroups.push(`exec=${finding.executionCommands.join(', ')}`);
  if (finding.networkCommands?.length > 0) matchGroups.push(`network=${finding.networkCommands.join(', ')}`);
  if (matchGroups.length > 0) console.log(`  matches: ${matchGroups.join(' | ')}`);

  if (finding.snippets?.length > 0) {
    console.log('  snippets:');
    for (const snippet of finding.snippets) {
      console.log(`    - ${snippet}`);
    }
  }
}

function printCoverageBanner(report) {
  const coverage = report.coverage;
  if (!coverage) return;
  const capped = coverage.cappedRoots?.length || 0;
  const skipped = coverage.skippedRoots?.length || 0;
  const interrupted = Boolean(coverage.interrupted);
  if (!capped && !skipped && !interrupted) return;
  const pieces = [];
  if (interrupted) pieces.push(`interrupted (${coverage.interruptReason || 'signal'})`);
  if (capped) pieces.push(`${capped} capped roots`);
  if (skipped) pieces.push(`${skipped} skipped roots`);
  console.log(`⚠ INCOMPLETE SCAN: ${pieces.join(', ')}`);
  console.log('');
}

function printHumanReport(report) {
  const { summary } = report;

  printCoverageBanner(report);
  console.log('Genie Security Scan');
  console.log('');
  console.log(`Host: ${report.host}`);
  console.log(
    `Platform: ${report.platform.platform}${report.platform.isWSL ? ' (WSL)' : ''} ${report.platform.release} ${report.platform.arch}`,
  );
  console.log(`User: ${report.platform.user || 'unknown'}`);
  console.log(`Runtime: ${report.platform.runtime}`);
  console.log(`Scanned at: ${report.scannedAt}`);
  console.log(`Compromise window: ${report.compromiseWindow.start} .. ${report.compromiseWindow.end}`);
  console.log(
    `Tracked packages: ${TRACKED_PACKAGES.map((entry) => `${entry.name}@${entry.versions.join('|')}`).join(', ')}`,
  );
  console.log(`Homes: ${report.homes.join(', ') || '(none)'}`);
  console.log(`Roots: ${report.roots.join(', ') || '(none)'}`);
  console.log('');
  console.log(`Status: ${summary.status}`);
  console.log(`Suspicion score: ${summary.suspicionScore}/100`);

  if (summary.compromiseReasons.length > 0) {
    console.log('');
    console.log('Compromise reasons:');
    for (const reason of summary.compromiseReasons) {
      console.log(`- ${reason}`);
    }
  }

  if (summary.affectedReasons.length > 0) {
    console.log('');
    console.log('Affected reasons:');
    for (const reason of summary.affectedReasons) {
      console.log(`- ${reason}`);
    }
  }

  console.log('');
  console.log('Counts:');
  for (const [key, value] of Object.entries(summary.findingCounts)) {
    console.log(`- ${key}: ${value}`);
  }

  if (report.npmTarballFetches.length > 0) {
    console.log('');
    console.log('npm tarball fetches:');
    for (const finding of report.npmTarballFetches) {
      console.log(
        `- ${finding.packageName || PACKAGE_NAME}@${finding.version} from ${finding.home} at ${finding.time || finding.cacheRecordTime || 'unknown time'}`,
      );
      if (finding.iocHits.length > 0) {
        console.log(`  IOC hits: ${finding.iocHits.join(', ')}`);
      }
    }
  }

  if (report.bunCacheFindings.length > 0) {
    console.log('');
    console.log('bun cache findings:');
    for (const finding of report.bunCacheFindings) {
      console.log(`- ${finding.version} cached at ${finding.path}`);
      if (finding.iocFiles.length > 0) {
        console.log(`  IOC files: ${finding.iocFiles.join(', ')}`);
      }
      if (finding.iocStrings.length > 0) {
        console.log(`  IOC strings: ${uniq(finding.iocStrings.flatMap((entry) => entry.matches)).join(', ')}`);
      }
    }
  }

  if (report.installFindings.length > 0) {
    console.log('');
    console.log('install findings:');
    for (const finding of report.installFindings) {
      console.log(`- ${finding.kind} at ${finding.path}`);
      console.log(`  package: ${finding.packageName || 'unknown'}`);
      console.log(`  version: ${finding.version || 'unknown'}`);
      if (finding.realpath && finding.realpath !== finding.path) {
        console.log(`  realpath: ${finding.realpath}`);
      }
      if (finding.iocFiles.length > 0) {
        console.log(`  IOC files: ${finding.iocFiles.join(', ')}`);
      }
      const hashHits = flattenKnownHashHits(finding);
      if (hashHits.length > 0) {
        console.log(
          `  exact malware hashes: ${hashHits.map((entry) => `${basename(entry.path)}=${entry.sha256}`).join(', ')}`,
        );
      }
      const iocMatches = flattenPackageIocMatches(finding);
      if (iocMatches.length > 0) {
        console.log(`  IOC strings: ${iocMatches.join(', ')}`);
      }
    }
  }

  if (report.shellHistoryFindings.length > 0) {
    console.log('');
    console.log('shell history findings:');
    for (const finding of report.shellHistoryFindings) {
      console.log(`- ${finding.path} (${finding.exposure})`);
      printTextFindingDetails(finding);
    }
  }

  if (report.shellProfileFindings.length > 0) {
    console.log('');
    console.log('shell profile findings:');
    for (const finding of report.shellProfileFindings) {
      console.log(`- ${finding.kind} at ${finding.path}`);
      printTextFindingDetails(finding);
    }
  }

  if (report.persistenceFindings.length > 0) {
    console.log('');
    console.log('persistence findings:');
    for (const finding of report.persistenceFindings) {
      console.log(`- ${finding.kind} at ${finding.path}`);
      printTextFindingDetails(finding);
    }
  }

  if (report.pythonPthFindings.length > 0) {
    console.log('');
    console.log('python .pth findings:');
    for (const finding of report.pythonPthFindings) {
      console.log(`- ${finding.path}`);
      printTextFindingDetails(finding);
    }
  }

  if (report.tempArtifactFindings.length > 0) {
    console.log('');
    console.log('temp and cache artifact findings:');
    for (const finding of report.tempArtifactFindings) {
      console.log(`- ${finding.path}`);
      if (finding.nameMatches.length > 0) {
        console.log(`  names: ${finding.nameMatches.join(', ')}`);
      }
      if (finding.iocMatches.length > 0) {
        console.log(`  IOC hits: ${finding.iocMatches.join(', ')}`);
      }
      if (finding.knownMalwareHash) {
        console.log(`  exact malware hash: ${finding.sha256}`);
      }
      printTextFindingDetails(finding);
    }
  }

  if (report.liveProcessFindings.length > 0) {
    console.log('');
    console.log('live process findings:');
    for (const finding of report.liveProcessFindings) {
      console.log(`- pid ${finding.pid} user ${finding.user} elapsed ${finding.elapsed}`);
      console.log(`  command: ${trimSnippet(finding.command)}`);
      if (finding.matchedInstallPaths.length > 0) {
        console.log(`  matched installs: ${finding.matchedInstallPaths.join(', ')}`);
      }
      if (finding.iocMatches.length > 0) {
        console.log(`  IOC hits: ${finding.iocMatches.join(', ')}`);
      }
      if (finding.versions.length > 0) {
        console.log(`  versions: ${finding.versions.join(', ')}`);
      }
      if (finding.executionCommands.length > 0) {
        console.log(`  execution hits: ${finding.executionCommands.join(', ')}`);
      }
    }
  }

  if (report.impactSurfaceFindings.length > 0) {
    console.log('');
    console.log('at-risk local material present on host:');
    for (const finding of report.impactSurfaceFindings) {
      console.log(`- ${finding.kind} ${finding.label} at ${finding.path}`);
    }
  }

  if (report.npmCacheMetadata.length > 0) {
    console.log('');
    console.log('npm cache metadata observations:');
    for (const finding of report.npmCacheMetadata) {
      const tags = finding.distTags ? JSON.stringify(finding.distTags) : '{}';
      console.log(
        `- ${finding.home} observed versions ${finding.observedVersions.join(', ')} at ${finding.observedAt || finding.cacheRecordTime || 'unknown time'}`,
      );
      console.log(`  dist-tags: ${tags}`);
    }
  }

  if (report.lockfileFindings.length > 0) {
    console.log('');
    console.log('lockfile references:');
    for (const finding of report.lockfileFindings) {
      console.log(`- ${finding.path}: ${finding.versions.join(', ')}`);
    }
  }

  if (report.npmLogHits.length > 0) {
    console.log('');
    console.log('npm log hits:');
    for (const finding of report.npmLogHits) {
      console.log(`- ${finding.path}: ${finding.versions.join(', ') || 'no explicit version'}`);
      if (finding.installCommands.length > 0) {
        console.log(`  install: ${finding.installCommands.join(', ')}`);
      }
      if (finding.executionCommands.length > 0) {
        console.log(`  exec: ${finding.executionCommands.join(', ')}`);
      }
      if (finding.iocMatches.length > 0) {
        console.log(`  IOC hits: ${finding.iocMatches.join(', ')}`);
      }
    }
  }

  if (report.timeline.length > 0) {
    console.log('');
    console.log('evidence timeline:');
    for (const event of report.timeline.slice(0, MAX_TIMELINE_EVENTS)) {
      console.log(`- ${event.time || 'unknown time'} [${event.severity}] ${event.category}: ${event.summary}`);
      if (event.path) console.log(`  path: ${event.path}`);
    }
  }

  console.log('');
  console.log('Recommended next steps:');
  for (const recommendation of summary.recommendations) {
    console.log(`- ${recommendation}`);
  }

  if (report.errors.length > 0) {
    console.log('');
    console.log('errors:');
    for (const finding of report.errors) {
      console.log(`- [${finding.scope}] ${finding.path}: ${finding.error}`);
    }
  }
}

function writeEnvelope(envelope, options, stdout) {
  const out = stdout || process.stdout;
  try {
    if (options.json) {
      out.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      printHumanReport(envelope);
    }
  } catch {
    /* stdout closed */
  }
}

function emitSlowestRootsReport(envelope, options, stderr) {
  if (!options.verbose) return;
  if (options.quiet) return;
  const coverage = envelope.coverage;
  if (!coverage) return;
  const timings = coverage.rootTimings || [];
  if (timings.length === 0) return;
  const fingerprintsByRoot = new Map();
  for (const fp of coverage.rootFingerprints || []) {
    fingerprintsByRoot.set(fp.root, fp);
    if (fp.realpath) fingerprintsByRoot.set(fp.realpath, fp);
  }
  const sorted = [...timings]
    .filter((entry) => typeof entry.elapsed_ms === 'number')
    .sort((a, b) => b.elapsed_ms - a.elapsed_ms)
    .slice(0, 5);
  if (sorted.length === 0) return;
  const out = stderr || process.stderr;
  try {
    out.write('[sec-scan] top 5 slowest roots:\n');
    for (const entry of sorted) {
      const fp = fingerprintsByRoot.get(entry.root) || {};
      const mount = fp.fs_type || 'unknown';
      const realpath = fp.realpath || entry.root;
      out.write(`  ${entry.elapsed_ms.toFixed(0)}ms  ${mount}  ${realpath}\n`);
    }
  } catch {
    /* stderr closed */
  }
}

async function runPhase(runtime, id, scope, path, fn, report) {
  runtime.startPhase(id);
  try {
    await fn();
  } catch (error) {
    addError(report, scope, path, error);
  } finally {
    runtime.endPhase(id);
  }
}

async function main() {
  const options = parseArgs(process.argv);

  if (options.help) {
    printHelp();
    return 0;
  }

  if (isKillSwitchEnabled()) {
    return emitKillSwitchResponse(options);
  }

  const platformInfo = detectPlatform();
  const scannerVersion = readScannerVersion();
  const runtime = createRuntime({
    options,
    platformInfo,
    argv: process.argv,
    scannerVersion,
  });

  const homes = collectHomeDirs(options, platformInfo);
  const roots = collectScanRoots(options, homes);
  runtime.setRootFingerprints(computeRootFingerprints(uniq([...homes, ...roots]), platformInfo));

  const report = {
    host: hostname(),
    platform: platformInfo,
    scannedAt: runtime.startedAt,
    cwd: process.cwd(),
    homes,
    roots,
    compromisedVersions: COMPROMISED_VERSIONS,
    trackedPackages: TRACKED_PACKAGES,
    compromiseWindow: COMPROMISE_WINDOW,
    npmCacheMetadata: [],
    npmTarballFetches: [],
    bunCacheFindings: [],
    installFindings: [],
    lockfileFindings: [],
    npmLogHits: [],
    shellProfileFindings: [],
    shellHistoryFindings: [],
    persistenceFindings: [],
    pythonPthFindings: [],
    tempArtifactFindings: [],
    liveProcessFindings: [],
    impactSurfaceFindings: [],
    timeline: [],
    errors: [],
  };

  let flushed = false;
  const flush = (reason) => {
    if (flushed) return;
    flushed = true;
    try {
      report.timeline = sortTimeline(report.timeline);
      if (!report.summary) report.summary = summarize(report);
    } catch {
      /* partial report; continue */
    }
    const envelope = envelopeFromReport(runtime, report, { reason });
    writeEnvelope(envelope, options);
  };

  installSignalHandlers(runtime, flush);
  runtime.startTicker();

  for (const homePath of homes) {
    await runPhase(runtime, 'scanNpmCache', 'npm-cache', homePath, () => scanNpmCache(homePath, report), report);
    await runPhase(runtime, 'scanBunCache', 'bun-cache', homePath, () => scanBunCache(homePath, report), report);
  }

  await runPhase(
    runtime,
    'scanGlobalInstallCandidates',
    'global-installs',
    '(global)',
    () => scanGlobalInstallCandidates(homes, report),
    report,
  );
  await runPhase(
    runtime,
    'scanProjectRoots',
    'project-roots',
    roots.join(', '),
    () => scanProjectRoots(roots, report, runtime),
    report,
  );
  await runPhase(
    runtime,
    'scanShellHistories',
    'shell-histories',
    homes.join(', '),
    () => scanShellHistories(homes, report),
    report,
  );
  await runPhase(
    runtime,
    'scanShellProfiles',
    'shell-profiles',
    homes.join(', '),
    () => scanShellProfiles(homes, report, runtime),
    report,
  );
  await runPhase(
    runtime,
    'scanPersistenceLocations',
    'persistence',
    platformInfo.platform,
    () => scanPersistenceLocations(platformInfo, homes, report, runtime),
    report,
  );
  await runPhase(
    runtime,
    'scanPythonPthArtifacts',
    'python-pth',
    '(python)',
    () => scanPythonPthArtifacts(homes, roots, report, runtime),
    report,
  );
  await runPhase(
    runtime,
    'scanTempArtifacts',
    'temp-artifacts',
    '(temp)',
    () => scanTempArtifacts(platformInfo, homes, roots, report, runtime),
    report,
  );
  await runPhase(
    runtime,
    'scanImpactSurface',
    'impact-surface',
    '(surface)',
    () => scanImpactSurface(homes, roots, report, runtime),
    report,
  );
  await runPhase(
    runtime,
    'scanLiveProcesses',
    'live-processes',
    '(process table)',
    () => scanLiveProcesses(report),
    report,
  );

  report.timeline = sortTimeline(report.timeline);
  report.summary = summarize(report);

  flushed = true;
  const envelope = envelopeFromReport(runtime, report);
  writeEnvelope(envelope, options);
  emitSlowestRootsReport(envelope, options);

  const exitCode = computeExitCode(envelope);
  if (exitCode !== 0) process.exitCode = exitCode;
  return exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`sec-scan.cjs failed: ${error?.message ? error.message : error}\n`);
    process.exit(3);
  });
} else {
  module.exports = {
    REPORT_VERSION,
    DEFAULT_PROGRESS_INTERVAL_MS,
    DEFAULT_PROJECT_WALK_MAX_DEPTH,
    DEFAULT_PROJECT_WALK_MAX_ENTRIES,
    REMOTE_FS_TYPES,
    WALK_SKIP_DIRS,
    generateUlid,
    createHostId,
    readScannerVersion,
    createRuntime,
    buildInvocation,
    envelopeFromReport,
    computeExitCode,
    installSignalHandlers,
    isKillSwitchEnabled,
    emitKillSwitchResponse,
    parseArgs,
    printHelp,
    main,
    detectPlatform,
    walkTreeFiles,
    walkProjectRoots,
    dedupKey,
    readLinuxMountInfo,
    parseMacOsMountLine,
    readMacOsMounts,
    mountInfoForPath,
    isRemoteFsType,
    classifyRootFingerprint,
    computeRootFingerprints,
    printCoverageBanner,
    printHumanReport,
    emitSlowestRootsReport,
    collectTempRoots,
    scanTempArtifacts,
    processTempArtifactQueue,
    inspectTempFileSync,
    resolveTempBudgets,
    runPhase,
    MAX_TEMP_CONTENT_SCAN_SIZE,
    MAX_TEMP_WALK_ENTRIES,
    MAX_TEMP_FINDINGS,
    DEFAULT_TEMP_FILES_BUDGET,
    DEFAULT_TEMP_BYTES_BUDGET,
    TEMP_YIELD_INTERVAL,
  };
}
