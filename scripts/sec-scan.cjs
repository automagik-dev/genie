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
const {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} = require('node:fs');
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

const IOC_FILE_SUFFIXES = [
  'dist/env-compat.cjs',
  'dist/env-compat.js',
  'dist/public.pem',
];

const MALWARE_FILE_HASHES = {
  'dist/env-compat.cjs': 'c19c4574d09e60636425f9555d3b63e8cb5c9d63ceb1c982c35e5a310c97a839',
  'dist/public.pem': '834b6e5db5710b9308d0598978a0148a9dc832361f1fa0b7ad4343dcceba2812',
};

const MALWARE_RSA_FINGERPRINTS = [
  '87259b0d1d017ad8b8daa7c177c2d9f0940e457f8dd1ab3abab3681e433ca88e',
];

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

const SHELL_PROFILE_DIRS = [
  '.config/fish/conf.d',
  '.config/environment.d',
  '.profile.d',
];

const SHELL_HISTORY_FILES = [
  '.bash_history',
  '.zsh_history',
  '.zhistory',
  '.ash_history',
  '.sh_history',
  '.local/share/fish/fish_history',
  '.histfile',
];

const PYTHON_PTH_ROOTS = [
  '.local/lib',
  'Library/Python',
  '.pyenv/versions',
  '.virtualenvs',
  'venv',
  '.venv',
];

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
const MAX_TIMELINE_EVENTS = 120;

const TEMP_ARTIFACT_NAME_REGEX = /(?:genie-(4\.260421\.(?:33|34|35|36|37|38|39|40))\.tgz|pgserve-1\.1\.(?:11|12|13)\.tgz|websocket-1\.0\.(?:38|39)\.tgz|loopback-connector-es-1\.4\.(?:3|4)\.tgz|design-tokens-1\.0\.3\.tgz|theme-owc-1\.0\.3\.tgz|env-compat\.(?:cjs|js)|public\.pem)$/i;

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
  { label: 'ioc:node dist/env-compat.cjs || true', category: 'ioc', regex: /node\s+dist\/env-compat\.cjs\s*\|\|\s*true/i },
  { label: 'ioc:.pth injection', category: 'ioc', regex: /\.pth\b/i },
  { label: 'ioc:twine upload', category: 'ioc', regex: /\btwine\b/i },
  { label: 'ioc:rsa fingerprint', category: 'ioc', regex: /87259b0d1d017ad8b8daa7c177c2d9f0940e457f8dd1ab3abab3681e433ca88e/i },
  { label: 'package:@automagik/genie', category: 'package', regex: /@automagik\/genie(?:@[0-9.]+)?/i },
  { label: 'package:pgserve', category: 'package', regex: /\bpgserve(?:@[0-9.]+)?\b/i },
  { label: 'package:@fairwords/websocket', category: 'package', regex: /@fairwords\/websocket(?:@[0-9.]+)?/i },
  { label: 'package:@fairwords/loopback-connector-es', category: 'package', regex: /@fairwords\/loopback-connector-es(?:@[0-9.]+)?/i },
  { label: 'package:@openwebconcept/design-tokens', category: 'package', regex: /@openwebconcept\/design-tokens(?:@[0-9.]+)?/i },
  { label: 'package:@openwebconcept/theme-owc', category: 'package', regex: /@openwebconcept\/theme-owc(?:@[0-9.]+)?/i },
  {
    label: 'package:compromised-tarball',
    category: 'package',
    regex: /(?:genie-4\.260421\.(?:33|34|35|36|37|38|39|40)|pgserve-1\.1\.(?:11|12|13)|websocket-1\.0\.(?:38|39)|loopback-connector-es-1\.4\.(?:3|4)|design-tokens-1\.0\.3|theme-owc-1\.0\.3)\.tgz/i,
  },
  {
    label: 'install:npm @automagik/genie',
    category: 'install',
    regex: /\bnpm\b[^\n]*\b(?:install|i|add|update|exec|ci)\b[^\n]*@automagik\/genie(?:@[0-9.]+)?/i,
  },
  {
    label: 'install:pnpm @automagik/genie',
    category: 'install',
    regex: /\bpnpm\b[^\n]*\b(?:add|install|update|up)\b[^\n]*@automagik\/genie(?:@[0-9.]+)?/i,
  },
  {
    label: 'install:yarn @automagik/genie',
    category: 'install',
    regex: /\byarn\b[^\n]*\b(?:add|install|up|upgrade)\b[^\n]*@automagik\/genie(?:@[0-9.]+)?/i,
  },
  {
    label: 'install:bun @automagik/genie',
    category: 'install',
    regex: /\bbun\b[^\n]*\b(?:add|install|pm add)\b[^\n]*@automagik\/genie(?:@[0-9.]+)?/i,
  },
  {
    label: 'exec:npx @automagik/genie',
    category: 'execution',
    regex: /\bnpx\b[^\n]*@automagik\/genie(?:@[0-9.]+)?/i,
  },
  {
    label: 'exec:bunx @automagik/genie',
    category: 'execution',
    regex: /\bbunx\b[^\n]*@automagik\/genie(?:@[0-9.]+)?/i,
  },
  {
    label: 'exec:node_modules/@automagik/genie',
    category: 'execution',
    regex: /node_modules\/@automagik\/genie\//i,
  },
  {
    label: 'exec:env-compat',
    category: 'execution',
    regex: /\b(?:node|bun|bash|sh)\b[^\n]*env-compat\.(?:cjs|js)\b/i,
  },
  {
    label: 'network:curl-wget IOC',
    category: 'network',
    regex: /\b(?:curl|wget|fetch|Invoke-WebRequest)\b[^\n]*(?:telemetry\.api-monitor\.com|raw\.icp0\.io\/drop)/i,
  },
];

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArgs(argv) {
  const options = {
    json: false,
    allHomes: false,
    roots: [],
    homes: [],
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
      const value = argv[i + 1];
      if (!value) throw new Error('--root requires a path');
      options.roots.push(resolve(value));
      i += 1;
      continue;
    }
    if (arg === '--home') {
      const value = argv[i + 1];
      if (!value) throw new Error('--home requires a path');
      options.homes.push(resolve(value));
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/sec-scan.cjs [--json] [--all-homes] [--home PATH] [--root PATH]
  genie sec scan [--json] [--all-homes] [--home PATH] [--root PATH]

Options:
  --json        Print JSON only
  --all-homes   Scan /root, /home/*, /Users/*, and WSL Windows homes when present
  --home PATH   Add a specific home directory to scan
  --root PATH   Add an application root to scan for lockfiles and node_modules installs
  --help, -h    Show this help

Examples:
  node scripts/sec-scan.cjs
  node scripts/sec-scan.cjs --json
  genie sec scan --json
  sudo node scripts/sec-scan.cjs --all-homes --root /srv --root /opt
`.trim());
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
    .map((path) => resolve(path))
    .filter((path) => {
      const stat = safeStat(path);
      return stat && stat.isDirectory();
    })
    .sort();
}

function collectScanRoots(options, homes) {
  const roots = new Set([process.cwd(), ...options.roots]);

  for (const homePath of homes) {
    for (const relativePath of COMMON_WORKSPACE_DIRS) {
      const candidate = join(homePath, relativePath);
      const stat = safeStat(candidate);
      if (stat && stat.isDirectory()) roots.add(candidate);
    }
  }

  return [...roots]
    .map((path) => resolve(path))
    .filter((path) => {
      const stat = safeStat(path);
      return stat && stat.isDirectory();
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
  return [
    join(homePath, '.npm', '_cacache'),
    join(homePath, 'AppData', 'Local', 'npm-cache', '_cacache'),
  ].filter((path) => safeExists(path));
}

function detectNpmLogRoots(homePath) {
  return [
    join(homePath, '.npm', '_logs'),
    join(homePath, 'AppData', 'Local', 'npm-cache', '_logs'),
  ].filter((path) => safeExists(path));
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
        `\\b(?:npm|pnpm|yarn|bun)\\b[^\\n]*(?:install|i|add|update|up|upgrade|exec|ci|pm add)?[^\\n]*${escapedName}(?:@[0-9.]+)?`,
        'i',
      ).test(text)
    ) {
      indicators.installCommands.push(`install:${trackedPackage.name}`);
    }

    if (
      new RegExp(`\\b(?:npx|bunx)\\b[^\\n]*${escapedName}(?:@[0-9.]+)?`, 'i').test(text) ||
      new RegExp(`${escapedName}[^\\n]*node_modules`, 'i').test(text)
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
        typeof MALWARE_FILE_HASHES[relativeSuffix] === 'string' &&
        MALWARE_FILE_HASHES[relativeSuffix] === fileHash,
    });
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

function walkTreeFiles(roots, options, onFile) {
  const stack = roots
    .filter((path) => safeExists(path))
    .map((path) => ({ path, depth: 0 }));

  const seen = new Set();
  let visitedEntries = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    const real = safeRealpath(current.path);
    if (seen.has(real)) continue;
    seen.add(real);

    const entries = safeReaddir(current.path);
    if (!entries) continue;

    for (const entry of entries) {
      if (visitedEntries >= (options.maxEntries ?? Number.POSITIVE_INFINITY)) return;
      visitedEntries += 1;

      const fullPath = join(current.path, entry.name);

      if (entry.isDirectory()) {
        if (current.depth >= (options.maxDepth ?? Number.POSITIVE_INFINITY)) continue;
        if (options.skipDirs?.has(entry.name)) continue;
        stack.push({ path: fullPath, depth: current.depth + 1 });
        continue;
      }

      if (entry.isFile()) {
        onFile(fullPath, entry, current.depth + 1);
      }
    }
  }
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
      const text = safeReadText(fullPath);
      if (!text || !TRACKED_PACKAGES.some(({ name }) => text.includes(name))) continue;

      const versions = findVersionsInText(text);
      const indicators = collectTextIndicators(text);
      if (
        versions.length === 0 &&
        indicators.installCommands.length === 0 &&
        indicators.executionCommands.length === 0 &&
        indicators.iocMatches.length === 0
      ) {
        continue;
      }

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
    if (inspection.compromisedVersion || inspection.iocFiles.length > 0 || inspection.iocStrings.length > 0) {
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
        summary: `bun global install contains suspicious ${(inspection.packageName || PACKAGE_NAME)} bytes`,
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

  for (const systemPath of [
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
  ]) {
    candidates.add(systemPath);
  }

  for (const nodeModulesPath of candidates) {
    if (!safeExists(nodeModulesPath)) continue;

    for (const candidate of findTrackedPackageDirs(nodeModulesPath)) {
      const inspection = inspectPackageDirectory(candidate);
      if (!inspection.compromisedVersion && inspection.iocFiles.length === 0 && inspection.iocStrings.length === 0) {
        continue;
      }

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
        summary: `global install contains suspicious ${(inspection.packageName || PACKAGE_NAME)} bytes`,
        path: candidate,
      });
    }
  }
}

function walkProjectRoots(roots, onNodeModules, onLockfile) {
  const stack = [...roots];
  const seen = new Set();

  while (stack.length > 0) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);

    const entries = safeReaddir(current);
    if (!entries) continue;

    for (const entry of entries) {
      const fullPath = join(current, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') {
          onNodeModules(fullPath);
          continue;
        }

        if (WALK_SKIP_DIRS.has(entry.name)) continue;
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!LOCKFILE_NAMES.has(entry.name)) continue;
      onLockfile(fullPath);
    }
  }
}

function scanProjectRoots(roots, report) {
  walkProjectRoots(
    roots,
    (nodeModulesPath) => {
      for (const packageDir of findTrackedPackageDirs(nodeModulesPath)) {
        const inspection = inspectPackageDirectory(packageDir);
        if (!inspection.compromisedVersion && inspection.iocFiles.length === 0 && inspection.iocStrings.length === 0) {
          continue;
        }

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
          summary: `project node_modules contains suspicious ${(inspection.packageName || PACKAGE_NAME)} bytes`,
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

function scanShellProfiles(homes, report) {
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
      { maxDepth: 2, maxEntries: 1000, skipDirs: WALK_SKIP_DIRS },
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

      const exposure =
        finding.executionCommands.length > 0 || finding.networkCommands.length > 0
          ? 'execution'
          : finding.installCommands.length > 0
            ? 'install'
            : 'reference';

      report.shellHistoryFindings.push({
        kind: 'shell-history',
        home: homePath,
        exposure,
        ...finding,
      });

      addTimeline(report, {
        time: finding.modifiedAt,
        category: 'shell-history',
        severity: exposure === 'execution' ? 'compromised' : 'affected',
        summary: `shell history shows ${exposure} evidence for suspicious package activity`,
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
      targets.push({ kind: 'systemd-user', home: homePath, path: join(homePath, '.local', 'share', 'systemd', 'user') });
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

function scanPersistenceLocations(platformInfo, homes, report) {
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
      { maxDepth: 3, maxEntries: 4000, skipDirs: WALK_SKIP_DIRS },
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
  const pthRoots = new Set([
    '/usr/local/lib',
    '/usr/lib',
    '/Library/Python',
    '/opt/homebrew/lib',
  ]);

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
    return stat && stat.isDirectory();
  });
}

function scanPythonPthArtifacts(homes, roots, report) {
  const pthRoots = collectPythonPthScanRoots(homes, roots);

  walkTreeFiles(
    pthRoots,
    { maxDepth: 5, maxEntries: 12000, skipDirs: new Set([...WALK_SKIP_DIRS, 'node_modules']) },
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

function scanImpactSurface(homes, roots, report) {
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
          { maxDepth: 3, maxEntries: 1500, skipDirs: new Set([...WALK_SKIP_DIRS, 'Cache']) },
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
    for (const candidate of [
      join(homePath, '.npm'),
      join(homePath, '.npm', '_npx'),
      join(homePath, '.cache'),
      join(homePath, '.bun'),
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
    return stat && stat.isDirectory();
  });
}

function scanTempArtifacts(platformInfo, homes, roots, report) {
  const tempRoots = collectTempRoots(platformInfo, homes, roots);

  walkTreeFiles(
    tempRoots,
    {
      maxDepth: 4,
      maxEntries: MAX_TEMP_WALK_ENTRIES,
      skipDirs: new Set([...WALK_SKIP_DIRS, 'node_modules']),
    },
    (fullPath) => {
      if (report.tempArtifactFindings.length >= MAX_TEMP_FINDINGS) return;

      const stat = safeStat(fullPath);
      if (!stat || !stat.isFile()) return;

      const namedHits = collectNamedArtifactHits(fullPath);
      let iocMatches = [];
      let versions = [];
      let packageRefs = [];
      let executionCommands = [];
      let networkCommands = [];
      let snippets = [];

      if (namedHits.length === 0 && stat.size > MAX_TEMP_CONTENT_SCAN_SIZE) return;

      const buffer = safeReadFile(fullPath);
      if (!buffer) return;

      const expanded = maybeGunzip(buffer);
      iocMatches = searchBufferForIocs(expanded);
      const fileSha256 = sha256(expanded);
      const expectedSha256 = expectedMalwareHashForBasename(basename(fullPath));

      const text = expanded.toString('utf8');
      const indicators = collectTextIndicators(text);
      versions = indicators.versions;
      packageRefs = indicators.packageRefs;
      executionCommands = indicators.executionCommands;
      networkCommands = indicators.networkCommands;
      snippets = extractInterestingSnippets(text);

      if (
        namedHits.length === 0 &&
        iocMatches.length === 0 &&
        versions.length === 0 &&
        packageRefs.length === 0 &&
        executionCommands.length === 0 &&
        networkCommands.length === 0
      ) {
        return;
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
    },
  );
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
    const indicators = collectTextIndicators(command);
    const namedHits = collectNamedArtifactHits(command);
    const matchedInstallPaths = suspectPaths.filter((path) => command.includes(path));

    const isStrongHit =
      indicators.iocMatches.length > 0 ||
      indicators.executionCommands.length > 0 ||
      indicators.networkCommands.length > 0 ||
      indicators.versions.length > 0 ||
      namedHits.length > 0 ||
      matchedInstallPaths.length > 0;

    if (!isStrongHit) continue;

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
    });

    addTimeline(report, {
      time: null,
      category: 'live-process',
      severity: 'compromised',
      summary: `live process ${pid} matches suspicious package execution indicators`,
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

function countExecutionHistoryEvidence(report) {
  return report.shellHistoryFindings.filter(
    (finding) =>
      finding.executionCommands.length > 0 ||
      finding.networkCommands.length > 0 ||
      finding.iocMatches.length > 0,
  ).length;
}

function countInstallHistoryEvidence(report) {
  return report.shellHistoryFindings.filter((finding) => finding.installCommands.length > 0).length;
}

function countStrongTempEvidence(report) {
  return report.tempArtifactFindings.filter(
    (finding) =>
      finding.iocMatches.length > 0 ||
      finding.executionCommands.length > 0 ||
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
  if (report.liveProcessFindings.length > 0) {
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
  if (report.tempArtifactFindings.length > 0 && strongTempEvidence === 0) {
    affectedReasons.push('temp or cache directories retain suspicious tarball or package references');
  }

  const likelyCompromised = compromiseReasons.length > 0;
  const likelyAffected =
    likelyCompromised ||
    affectedReasons.length > 0 ||
    report.installFindings.length > 0 ||
    report.npmTarballFetches.length > 0 ||
    report.bunCacheFindings.length > 0;

  const observedOnly =
    !likelyAffected &&
    (report.npmCacheMetadata.length > 0 ||
      report.npmLogHits.length > 0 ||
      report.lockfileFindings.length > 0);

  let suspicionScore = 0;
  suspicionScore += Math.min(report.persistenceFindings.length * 30, 60);
  suspicionScore += Math.min(strongProfileEvidence * 20, 40);
  suspicionScore += Math.min(executionHistoryEvidence * 20, 40);
  suspicionScore += Math.min(strongTempEvidence * 20, 40);
  suspicionScore += Math.min(report.liveProcessFindings.length * 25, 50);
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

function printHumanReport(report) {
  const { summary } = report;

  console.log('Genie Security Scan');
  console.log('');
  console.log(`Host: ${report.host}`);
  console.log(`Platform: ${report.platform.platform}${report.platform.isWSL ? ' (WSL)' : ''} ${report.platform.release} ${report.platform.arch}`);
  console.log(`User: ${report.platform.user || 'unknown'}`);
  console.log(`Runtime: ${report.platform.runtime}`);
  console.log(`Scanned at: ${report.scannedAt}`);
  console.log(`Compromise window: ${report.compromiseWindow.start} .. ${report.compromiseWindow.end}`);
  console.log(`Tracked packages: ${TRACKED_PACKAGES.map((entry) => `${entry.name}@${entry.versions.join('|')}`).join(', ')}`);
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
      console.log(`- ${(finding.packageName || PACKAGE_NAME)}@${finding.version} from ${finding.home} at ${finding.time || finding.cacheRecordTime || 'unknown time'}`);
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
        console.log(`  exact malware hashes: ${hashHits.map((entry) => `${basename(entry.path)}=${entry.sha256}`).join(', ')}`);
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
      console.log(`- ${finding.home} observed versions ${finding.observedVersions.join(', ')} at ${finding.observedAt || finding.cacheRecordTime || 'unknown time'}`);
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

function main() {
  const options = parseArgs(process.argv);
  const platformInfo = detectPlatform();
  const homes = collectHomeDirs(options, platformInfo);
  const roots = collectScanRoots(options, homes);

  const report = {
    host: hostname(),
    platform: platformInfo,
    scannedAt: new Date().toISOString(),
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

  for (const homePath of homes) {
    try {
      scanNpmCache(homePath, report);
    } catch (error) {
      addError(report, 'npm-cache', homePath, error);
    }

    try {
      scanBunCache(homePath, report);
    } catch (error) {
      addError(report, 'bun-cache', homePath, error);
    }
  }

  try {
    scanGlobalInstallCandidates(homes, report);
  } catch (error) {
    addError(report, 'global-installs', '(global)', error);
  }

  try {
    scanProjectRoots(roots, report);
  } catch (error) {
    addError(report, 'project-roots', roots.join(', '), error);
  }

  try {
    scanShellHistories(homes, report);
  } catch (error) {
    addError(report, 'shell-histories', homes.join(', '), error);
  }

  try {
    scanShellProfiles(homes, report);
  } catch (error) {
    addError(report, 'shell-profiles', homes.join(', '), error);
  }

  try {
    scanPersistenceLocations(platformInfo, homes, report);
  } catch (error) {
    addError(report, 'persistence', platformInfo.platform, error);
  }

  try {
    scanPythonPthArtifacts(homes, roots, report);
  } catch (error) {
    addError(report, 'python-pth', '(python)', error);
  }

  try {
    scanTempArtifacts(platformInfo, homes, roots, report);
  } catch (error) {
    addError(report, 'temp-artifacts', '(temp)', error);
  }

  try {
    scanImpactSurface(homes, roots, report);
  } catch (error) {
    addError(report, 'impact-surface', '(surface)', error);
  }

  try {
    scanLiveProcesses(report);
  } catch (error) {
    addError(report, 'live-processes', '(process table)', error);
  }

  report.timeline = sortTimeline(report.timeline);
  report.summary = summarize(report);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }

  process.exitCode = report.summary.likelyAffected || report.summary.likelyCompromised ? 2 : report.summary.observedOnly ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(`sec-scan.cjs failed: ${error.message}`);
  process.exit(3);
}
