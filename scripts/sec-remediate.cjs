#!/usr/bin/env node
/**
 * sec-remediate.cjs
 *
 * Reversible, auditable remediation pathway for findings produced by
 * `genie sec scan`. Sibling payload to `scripts/sec-scan.cjs` — it never
 * detects, it never deletes, it only quarantines, prints rotation guidance,
 * or (with explicit consent) sends a SIGTERM to a pre-listed PID.
 *
 * Usage:
 *   genie sec remediate --dry-run --scan-id <ulid>
 *   genie sec remediate --dry-run --scan-report <path>
 *   genie sec remediate --apply --plan <path>
 *   genie sec remediate --resume <resume-file>
 *   genie sec restore <quarantine-id>
 *
 * Exit codes:
 *   0 = success (dry-run wrote plan, apply finished cleanly, restore succeeded)
 *   1 = aborted (operator declined, missing inputs, drift refusal, etc.)
 *   2 = partial failure — resume file written
 *   3 = unexpected error
 */

const {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  chmodSync,
} = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const { homedir, userInfo } = require('node:os');
const { dirname, basename, isAbsolute, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline');

const VERSION = '1';

// Quarantine actions group every move under one timestamp dir; live processes
// require an explicit per-PID flag; credentials only emit text guidance.
const ACTION_TYPES = Object.freeze({
  QUARANTINE: 'quarantine',
  KILL_PROCESS: 'kill_process',
  EMIT_CREDENTIAL_ROTATION: 'emit_credential_rotation',
});

// Per-provider rotation playbooks. Every block ships an offline-fallback URL
// because the provider may be unreachable during incident response (reviewer G2).
const CREDENTIAL_TEMPLATES = Object.freeze({
  npm: {
    label: 'npm registry token',
    commands: ['npm token list', 'npm token revoke <TOKEN_ID>'],
    fallbackComment:
      '# If npm registry is unreachable: rotate via https://www.npmjs.com/settings/~/tokens — record completion in audit log manually',
  },
  github: {
    label: 'GitHub auth token / PAT',
    commands: ['gh auth refresh --scopes repo,read:org', 'gh auth status'],
    fallbackComment:
      '# If gh CLI is unreachable: rotate PATs at https://github.com/settings/tokens and SSH keys at https://github.com/settings/keys — record completion in audit log manually',
  },
  aws: {
    label: 'AWS IAM credentials',
    commands: [
      'aws sts get-caller-identity',
      'aws iam list-access-keys',
      'aws iam delete-access-key --access-key-id <ID>',
    ],
    fallbackComment:
      '# If aws CLI is unreachable: rotate via https://console.aws.amazon.com/iam/home#/security_credentials — record completion in audit log manually',
  },
  gcp: {
    label: 'GCP service-account / user credentials',
    commands: ['gcloud auth list', 'gcloud auth revoke <ACCOUNT>'],
    fallbackComment:
      '# If gcloud is unreachable: rotate via https://console.cloud.google.com/iam-admin/serviceaccounts — record completion in audit log manually',
  },
  azure: {
    label: 'Azure credentials',
    commands: ['az account show', 'az logout'],
    fallbackComment:
      '# If az CLI is unreachable: rotate via https://portal.azure.com/#view/Microsoft_AAD_IAM/UserDetailsMenuBlade — record completion in audit log manually',
  },
  anthropic: {
    label: 'Anthropic API key',
    commands: ['# No CLI rotation exists — must rotate via web console.'],
    fallbackComment:
      '# Rotate Anthropic API keys at https://console.anthropic.com/settings/keys — record completion in audit log manually',
  },
  openai: {
    label: 'OpenAI API key',
    commands: ['# No CLI rotation exists — must rotate via web console.'],
    fallbackComment:
      '# Rotate OpenAI API keys at https://platform.openai.com/api-keys — record completion in audit log manually',
  },
});

const PROVIDER_KIND_MAP = Object.freeze({
  'npm-token': 'npm',
  npmrc: 'npm',
  'github-token': 'github',
  'gh-config': 'github',
  'gh-hosts': 'github',
  'aws-credentials': 'aws',
  'aws-config': 'aws',
  'gcp-credentials': 'gcp',
  'gcloud-config': 'gcp',
  'azure-config': 'azure',
  'anthropic-key': 'anthropic',
  'openai-key': 'openai',
});

const SECRETS_DIR_MODE = 0o700;
const SECRETS_FILE_MODE = 0o600;

function genieHome() {
  return process.env.GENIE_HOME && process.env.GENIE_HOME.trim().length > 0
    ? resolve(process.env.GENIE_HOME)
    : join(homedir(), '.genie');
}

function secScanRoot() {
  return join(genieHome(), 'sec-scan');
}

function quarantineRoot() {
  return join(secScanRoot(), 'quarantine');
}

function plansDir() {
  return join(secScanRoot(), 'plans');
}

function resumeDir() {
  return join(secScanRoot(), 'resume');
}

function auditDir() {
  return join(secScanRoot(), 'audit');
}

function rollbackDir() {
  return join(secScanRoot(), 'rollback');
}

// Duration tokens are intentionally narrow: s, m, h, d. Anything else is a typo.
function parseDurationMs(spec) {
  const match = /^(\d+)([smhd])$/.exec(String(spec || '').trim());
  if (!match) {
    throw new Error(`invalid duration: "${spec}" (expected <N>[smhd], e.g. 30d, 24h, 15m)`);
  }
  const amount = Number.parseInt(match[1], 10);
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return amount * multiplier;
}

function ensureDir(path, mode = SECRETS_DIR_MODE) {
  mkdirSync(path, { recursive: true, mode });
  enforceMode(path, mode);
}

function enforceMode(path, mode) {
  try {
    chmodSync(path, mode);
  } catch (error) {
    if (mode === SECRETS_DIR_MODE || mode === SECRETS_FILE_MODE) {
      const fsName = filesystemName(path);
      process.stderr.write(
        `WARNING: cannot enforce mode ${mode.toString(8)} on ${path} (filesystem: ${fsName}). Audit-log/quarantine files may be world-readable on this filesystem.\n`,
      );
    } else {
      throw error;
    }
  }
}

function filesystemName(path) {
  const result = spawnSync('stat', ['-f', '-c', '%T', path], { encoding: 'utf8' });
  if (result.status === 0) return (result.stdout || '').trim() || 'unknown';
  const fallback = spawnSync('df', ['-T', path], { encoding: 'utf8' });
  if (fallback.status === 0) {
    const lines = (fallback.stdout || '').split('\n');
    return ((lines[1] || '').split(/\s+/)[1] || 'unknown').trim();
  }
  return 'unknown';
}

function ulid() {
  // Crockford ULID-ish (timestamp+random). Sufficient for monotonically-sortable IDs.
  const time = Date.now().toString(36).padStart(10, '0').toUpperCase();
  const rand = randomBytes(10).toString('hex').toUpperCase().slice(0, 16);
  return `${time}${rand}`;
}

function isoNow() {
  return new Date().toISOString();
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function dirSizeBytes(path) {
  const stack = [path];
  let total = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        const stat = statSafe(full);
        if (stat) total += stat.size;
      }
    }
  }
  return total;
}

function fsyncWriteFile(path, contents, mode = SECRETS_FILE_MODE) {
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  ensureDir(dirname(path));
  const fd = openSync(path, 'w', mode);
  try {
    writeSync(fd, buffer, 0, buffer.length, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  enforceMode(path, mode);
}

function fsyncAppendLine(path, line, mode = SECRETS_FILE_MODE) {
  ensureDir(dirname(path));
  const text = line.endsWith('\n') ? line : `${line}\n`;
  const fd = openSync(path, 'a', mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  enforceMode(path, mode);
}

function appendAuditEvent(scanId, event) {
  const path = join(auditDir(), `${scanId}.jsonl`);
  fsyncAppendLine(path, JSON.stringify(event));
  return path;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ----- Argument parsing ---------------------------------------------------

function parseArgs(argv) {
  const out = {
    mode: null, // 'dry-run' | 'apply' | 'resume' | 'restore' | 'rollback' | 'quarantine-list' | 'quarantine-gc' | 'help'
    json: false,
    scanReport: null,
    scanId: null,
    plan: null,
    resume: null,
    restoreId: null,
    rollbackScanId: null,
    quarantineDir: null,
    unsafeUnverified: null,
    remediatePartial: false,
    confirmIncomplete: null,
    olderThan: null,
    confirmGc: null,
    killPids: [],
    autoConfirm: null, // for tests / non-interactive: object map action_id -> token
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        out.mode = 'dry-run';
        break;
      case '--apply':
        out.mode = 'apply';
        break;
      case '--resume':
        out.mode = 'resume';
        out.resume = argv[++i];
        break;
      case '--restore':
        out.mode = 'restore';
        out.restoreId = argv[++i];
        break;
      case '--rollback':
        out.mode = 'rollback';
        out.rollbackScanId = argv[++i];
        break;
      case '--quarantine-list':
        out.mode = 'quarantine-list';
        break;
      case '--quarantine-gc':
        out.mode = 'quarantine-gc';
        break;
      case '--older-than':
        out.olderThan = argv[++i];
        break;
      case '--confirm-gc':
        out.confirmGc = argv[++i];
        break;
      case '--scan-report':
        out.scanReport = argv[++i];
        break;
      case '--scan-id':
        out.scanId = argv[++i];
        break;
      case '--plan':
        out.plan = argv[++i];
        break;
      case '--quarantine-dir':
        out.quarantineDir = argv[++i];
        break;
      case '--unsafe-unverified':
        out.unsafeUnverified = argv[++i];
        break;
      case '--remediate-partial':
        out.remediatePartial = true;
        break;
      case '--confirm-incomplete-scan':
        out.confirmIncomplete = argv[++i];
        break;
      case '--kill-pid':
        out.killPids.push(Number.parseInt(argv[++i], 10));
        break;
      case '--auto-confirm-from':
        out.autoConfirm = readJson(argv[++i]);
        break;
      case '--json':
        out.json = true;
        break;
      case '--help':
      case '-h':
        out.mode = 'help';
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    [
      'genie sec remediate — reversible, auditable host-compromise remediation',
      '',
      'Modes:',
      '  --dry-run --scan-report <path>           Generate plan from a scan JSON file',
      '  --dry-run --scan-id <ulid>               Generate plan from a persisted scan',
      '  --apply --plan <path>                    Execute a frozen plan (sha256-drift + signature checks)',
      '  --resume <resume-file>                   Resume a partially-applied plan',
      '  --restore <quarantine-id>                Restore every action under a quarantine id',
      '  --rollback <scan_id>                     Bulk undo every quarantined action for a scan (reverse order)',
      '  --quarantine-list                        List quarantine dirs (id, timestamp, size, status, scan_id)',
      '  --quarantine-gc --older-than <dur>       Delete restored/abandoned quarantines older than <dur>',
      '',
      'Options:',
      '  --quarantine-dir <path>                  Override quarantine root (must be on same device as targets)',
      '  --unsafe-unverified <INCIDENT_ID>        Bypass signature requirement (logs incident id + ack)',
      '  --remediate-partial                      Allow remediation against a coverage-capped scan',
      '  --confirm-incomplete-scan <ack>          Typed ack for --remediate-partial',
      '  --kill-pid <pid>                         Authorize SIGTERM to a PID (must match a plan entry)',
      '  --auto-confirm-from <path>               Non-interactive consent JSON (testing only)',
      '  --older-than <duration>                  GC threshold (30d, 24h, 15m, 60s) — required for --quarantine-gc',
      '  --confirm-gc <token>                     Typed GC ack: CONFIRM-GC-<6-hex>',
      '  --json                                   Emit JSON summary to stdout',
      '',
    ].join('\n'),
  );
}

// ----- Scan ingest --------------------------------------------------------

function loadScan(options) {
  let path = options.scanReport;
  if (!path && options.scanId) {
    path = join(secScanRoot(), `${options.scanId}.json`);
  }
  if (!path) {
    throw new Error('remediate requires --scan-report <path> or --scan-id <ulid>');
  }
  if (!existsSync(path)) {
    throw new Error(`scan report not found: ${path}`);
  }
  const data = readJson(path);
  if (!data.scan_id) {
    // Forward-compatibility: the wish notes sec-scan-progress will inject scan_id +
    // reportVersion. Until then, derive a deterministic id from the report contents.
    data.scan_id = `S${sha256Buffer(readFileSync(path)).slice(0, 24).toUpperCase()}`;
  }
  if (!data.reportVersion) {
    data.reportVersion = 1;
  }
  return { scan: data, scanPath: path };
}

// ----- Plan generation ----------------------------------------------------

function targetPathExists(path) {
  return existsSync(path);
}

function safeShortHex(value) {
  return (
    value
      .replace(/[^a-fA-F0-9]/g, '')
      .toLowerCase()
      .slice(0, 6) || '000000'
  );
}

function buildQuarantineActionFromFinding(finding, sourceCategory) {
  const targetPath = finding.path || finding.realpath;
  if (!targetPath || !isAbsolute(targetPath)) return null;
  if (!targetPathExists(targetPath)) return null;

  const stat = statSafe(targetPath);
  if (!stat) return null;

  const iocSummary = collectIocSummary(finding);
  const isFile = stat.isFile();
  const sha256_before = isFile ? sha256File(targetPath) : null;
  const action_id = ulid();

  return {
    action_id,
    action_type: ACTION_TYPES.QUARANTINE,
    finding_ref: `${sourceCategory}:${finding.kind || sourceCategory}:${targetPath}`,
    target_path: targetPath,
    is_directory: !isFile,
    sha256_before,
    size_bytes: isFile ? stat.size : null,
    ioc_hit: iocSummary,
    reason: buildReasonText(sourceCategory, finding, iocSummary),
  };
}

function collectIocSummary(finding) {
  const parts = [];
  if (finding.compromisedVersion) parts.push(`version=${finding.version || finding.compromisedVersion}`);
  if (finding.iocFiles && finding.iocFiles.length > 0) parts.push(`files=${finding.iocFiles.slice(0, 3).join('|')}`);
  if (finding.iocStrings && finding.iocStrings.length > 0) {
    const sample = finding.iocStrings
      .flatMap((entry) => entry.matches || [])
      .slice(0, 3)
      .join('|');
    if (sample) parts.push(`strings=${sample}`);
  }
  if (finding.iocMatches && finding.iocMatches.length > 0) {
    parts.push(`ioc=${finding.iocMatches.slice(0, 3).join('|')}`);
  }
  if (finding.knownMalwareHash) parts.push('known-malware-hash');
  return parts.join(' ') || 'compromise-evidence';
}

function buildReasonText(category, finding, ioc) {
  const summary = finding.summary || `${category} finding for remediation`;
  return `${category}: ${ioc} (${summary})`;
}

function buildKillProcessAction(finding) {
  return {
    action_id: ulid(),
    action_type: ACTION_TYPES.KILL_PROCESS,
    finding_ref: `live-process:${finding.pid}`,
    target_pid: finding.pid,
    target_command: finding.command,
    matched_install_paths: finding.matchedInstallPaths || [],
    reason: `live-process: pid=${finding.pid} command=${finding.command}`,
  };
}

function buildCredentialEmissionAction(finding) {
  const provider = PROVIDER_KIND_MAP[finding.kind] || guessProviderFromLabel(finding.label || finding.path || '');
  if (!provider) return null;
  return {
    action_id: ulid(),
    action_type: ACTION_TYPES.EMIT_CREDENTIAL_ROTATION,
    finding_ref: `impact-surface:${finding.kind}:${finding.path}`,
    target_path: finding.path,
    provider,
    reason: `impact-surface: ${finding.kind || provider} at ${finding.path} — emit rotation guidance only`,
  };
}

function guessProviderFromLabel(label) {
  const lowered = label.toLowerCase();
  if (lowered.includes('npmrc')) return 'npm';
  if (lowered.includes('aws')) return 'aws';
  if (lowered.includes('gcloud') || lowered.includes('gcp')) return 'gcp';
  if (lowered.includes('azure')) return 'azure';
  if (lowered.includes('github') || lowered.includes('hub.com')) return 'github';
  if (lowered.includes('anthropic')) return 'anthropic';
  if (lowered.includes('openai')) return 'openai';
  return null;
}

function generatePlan(scan) {
  const actions = [];
  const categories = [
    ['installFindings', 'install'],
    ['bunCacheFindings', 'bun-cache'],
    ['tempArtifactFindings', 'temp-artifact'],
    ['pythonPthFindings', 'python-pth'],
    ['persistenceFindings', 'persistence'],
  ];
  for (const [field, label] of categories) {
    for (const finding of scan[field] || []) {
      const action = buildQuarantineActionFromFinding(finding, label);
      if (action) actions.push(action);
    }
  }
  for (const finding of scan.liveProcessFindings || []) {
    actions.push(buildKillProcessAction(finding));
  }
  for (const finding of scan.impactSurfaceFindings || []) {
    const action = buildCredentialEmissionAction(finding);
    if (action) actions.push(action);
  }

  return {
    plan_version: VERSION,
    plan_id: `P${ulid()}`,
    scan_id: scan.scan_id,
    generated_at: isoNow(),
    operator_uid: userInfo().uid,
    actions,
    coverage: extractCoverage(scan),
  };
}

function extractCoverage(scan) {
  const coverage = scan.coverage || {};
  return {
    caps_hit: Number.isFinite(coverage.caps_hit) ? coverage.caps_hit : 0,
    skipped_roots: Number.isFinite(coverage.skipped_roots) ? coverage.skipped_roots : 0,
  };
}

// ----- Coverage-gap gate --------------------------------------------------

function enforceCoverageGate(plan, scanId, options) {
  const caps = plan.coverage?.caps_hit ?? 0;
  const skipped = plan.coverage?.skipped_roots ?? 0;
  if (caps === 0 && skipped === 0) return;

  const expected = `CONFIRM-INCOMPLETE-SCAN-${safeShortHex(scanId)}`;
  if (!options.remediatePartial || options.confirmIncomplete !== expected) {
    throw new Error(
      `scan coverage is incomplete (caps_hit=${caps}, skipped_roots=${skipped}). ` +
        `Re-run with --remediate-partial --confirm-incomplete-scan ${expected}`,
    );
  }
}

// ----- Apply path --------------------------------------------------------

function loadPlan(path) {
  if (!existsSync(path)) throw new Error(`plan not found: ${path}`);
  const plan = readJson(path);
  if (!plan.plan_id || !plan.scan_id) throw new Error(`plan ${path} missing required fields`);
  return plan;
}

function verifyScanReferenced(plan) {
  // Plan's scan_id must reference a persisted scan, OR remediate must have been
  // invoked from a scan-report path. We accept either: when the persisted file
  // exists, verify; when it doesn't, we trust the operator (apply does its own
  // sha256-drift check on each target).
  const persisted = join(secScanRoot(), `${plan.scan_id}.json`);
  return existsSync(persisted) ? persisted : null;
}

function ensureSignatureVerified(options, scanId) {
  if (process.env.GENIE_SEC_SKIP_SIG_CHECK === '1') return { verified: true, mode: 'skipped-env' };

  // Best-effort: the genie-supply-chain-signing wish ships the verifier. Until
  // that lands, we treat the binary as unverified and require the unsafe ack.
  const verifier = process.env.GENIE_SEC_VERIFY_BINARY;
  if (verifier && existsSync(verifier)) {
    const result = spawnSync(verifier, ['verify-install'], { encoding: 'utf8', stdio: 'pipe' });
    if (result.status === 0) return { verified: true, mode: 'cosign' };
  }

  if (!options.unsafeUnverified) {
    throw new Error(
      'binary signature is not verified and signing is not yet shipped. ' +
        'Pass --unsafe-unverified <INCIDENT_ID> to proceed (logged to audit).',
    );
  }
  process.stderr.write(
    `\n!!! UNSAFE: running unverified binary under incident id ${options.unsafeUnverified}. This is logged to the audit trail. Required only until genie-supply-chain-signing ships.\n\n`,
  );
  appendAuditEvent(scanId, {
    ts: isoNow(),
    actor: 'remediate',
    scan_id: scanId,
    event: 'unsafe.unverified.ack',
    incident_id: options.unsafeUnverified,
  });
  return { verified: false, mode: 'unsafe-unverified', incident_id: options.unsafeUnverified };
}

function detectPlanDrift(plan) {
  const drifts = [];
  for (const action of plan.actions) {
    if (action.action_type !== ACTION_TYPES.QUARANTINE) continue;
    if (!action.target_path) continue;
    if (!existsSync(action.target_path)) {
      drifts.push({ action_id: action.action_id, target_path: action.target_path, reason: 'target-missing' });
      continue;
    }
    if (action.is_directory) {
      // Directories: skip sha256 — directory contents change frequently. The
      // existence + atomic rename are the safety bars.
      continue;
    }
    if (!action.sha256_before) continue;
    const current = sha256File(action.target_path);
    if (current !== action.sha256_before) {
      drifts.push({
        action_id: action.action_id,
        target_path: action.target_path,
        reason: `sha256 mismatch (expected ${action.sha256_before}, got ${current})`,
      });
    }
  }
  return drifts;
}

function expectedConsentToken(action) {
  return `CONFIRM-QUARANTINE-${action.action_id.slice(-6).toLowerCase()}`;
}

async function promptConsent(action, options) {
  const expected = expectedConsentToken(action);
  if (options.autoConfirm) {
    const provided = options.autoConfirm[action.action_id];
    if (provided === expected) return true;
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolveAnswer) => {
      rl.question(`Type "${expected}" to authorize this action (or anything else to skip): `, resolveAnswer);
    });
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}

function describeAction(action) {
  switch (action.action_type) {
    case ACTION_TYPES.QUARANTINE: {
      const shortHash = action.sha256_before ? action.sha256_before.slice(0, 12) : '(directory)';
      return [
        '',
        'Action: quarantine (move to safe storage)',
        `  action_id : ${action.action_id}`,
        `  target    : ${action.target_path}`,
        `  ioc       : ${action.ioc_hit}`,
        `  sha256    : ${shortHash}`,
        `  reason    : ${action.reason}`,
      ].join('\n');
    }
    case ACTION_TYPES.KILL_PROCESS:
      return [
        '',
        'Action: SIGTERM live process',
        `  action_id : ${action.action_id}`,
        `  pid       : ${action.target_pid}`,
        `  command   : ${action.target_command}`,
        `  reason    : ${action.reason}`,
      ].join('\n');
    case ACTION_TYPES.EMIT_CREDENTIAL_ROTATION:
      return [
        '',
        'Action: emit credential-rotation guidance (no API calls)',
        `  action_id : ${action.action_id}`,
        `  provider  : ${action.provider}`,
        `  trigger   : ${action.target_path}`,
        `  reason    : ${action.reason}`,
      ].join('\n');
    default:
      return `Unknown action: ${JSON.stringify(action)}`;
  }
}

function quarantineFile(action, plan, runRoot) {
  const stat = statSafe(action.target_path);
  if (!stat) throw new Error(`target disappeared before move: ${action.target_path}`);

  // Cross-device guard: rename will fail with EXDEV if mount boundaries
  // differ. Detect early and refuse with an actionable error.
  const targetDevice = stat.dev;
  const quarantineProbe = ensureRunRootOnSameDevice(runRoot, targetDevice, action.target_path);

  const actionDir = join(quarantineProbe, action.action_id);
  ensureDir(actionDir);
  const destination = join(actionDir, basename(action.target_path));

  const tsBefore = isoNow();
  const sha256_before = action.sha256_before;
  let sha256_after = null;
  try {
    renameSync(action.target_path, destination);
  } catch (error) {
    if (error.code === 'EXDEV') {
      throw new Error(
        `cross-device quarantine refused: target ${action.target_path} and quarantine ${quarantineProbe} are on different devices. Re-run with --quarantine-dir <same-device-path>`,
      );
    }
    throw error;
  }
  if (action.sha256_before && !action.is_directory) {
    sha256_after = sha256File(destination);
  }
  const sidecar = {
    action_id: action.action_id,
    scan_id: plan.scan_id,
    plan_id: plan.plan_id,
    original_path: action.target_path,
    quarantine_path: destination,
    ioc_hit: action.ioc_hit,
    sha256_before,
    sha256_after,
    size_bytes: action.size_bytes,
    ts_before: tsBefore,
    ts_after: isoNow(),
    operator_uid: userInfo().uid,
    dry_run: false,
    reversal_token: randomBytes(16).toString('hex'),
    actor: 'remediate',
  };
  fsyncWriteFile(join(actionDir, 'action.json'), JSON.stringify(sidecar, null, 2));
  return sidecar;
}

function ensureRunRootOnSameDevice(runRoot, targetDevice, targetPath) {
  ensureDir(runRoot);
  const runStat = statSafe(runRoot);
  if (runStat && runStat.dev === targetDevice) return runRoot;
  throw new Error(
    `cross-device quarantine refused: target ${targetPath} (dev=${targetDevice}) and quarantine root ${runRoot} ` +
      `(dev=${runStat?.dev}) are on different filesystems. Re-run with --quarantine-dir <same-device-path>`,
  );
}

function emitCredentialRotation(action) {
  const template = CREDENTIAL_TEMPLATES[action.provider];
  if (!template) {
    process.stdout.write(`# Provider ${action.provider} has no rotation template — rotate manually.\n`);
    return { provider: action.provider, commands: [], fallback: '(no template)' };
  }
  const lines = [
    '',
    `# === ${template.label} ===`,
    `# triggered_by: ${action.target_path}`,
    ...template.commands,
    template.fallbackComment,
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return { provider: action.provider, commands: template.commands, fallback: template.fallbackComment };
}

function killProcess(action) {
  const psBefore = spawnSync('ps', ['-o', 'comm=,pid=,ppid=,uid=,args=', '-p', String(action.target_pid)], {
    encoding: 'utf8',
  });
  const pre_state = psBefore.status === 0 ? (psBefore.stdout || '').trim() : `(no live pid ${action.target_pid})`;
  const killResult = spawnSync('kill', [String(action.target_pid)], { encoding: 'utf8' });
  const aliveCheck = spawnSync('kill', ['-0', String(action.target_pid)], { encoding: 'utf8' });
  return {
    pre_state,
    post_state_kill0: aliveCheck.status,
    kill_status: killResult.status,
  };
}

// ----- Apply orchestrator -------------------------------------------------

async function applyPlan(options) {
  const plan = loadPlan(options.plan);
  const { scan_id: scanId } = plan;
  ensureDir(secScanRoot());
  enforceCoverageGate(plan, scanId, options);
  const sigStatus = ensureSignatureVerified(options, scanId);

  const persistedScanPath = verifyScanReferenced(plan);
  if (!persistedScanPath && !options.scanReport) {
    process.stderr.write(
      `WARNING: plan references scan_id ${scanId}, but no persisted scan was found at ` +
        `${join(secScanRoot(), `${scanId}.json`)}. Continuing without scan-side cross-check.\n`,
    );
  }

  const drifts = detectPlanDrift(plan);
  if (drifts.length > 0) {
    const detail = drifts.map((d) => `  - ${d.target_path} (${d.reason})`).join('\n');
    throw new Error(
      `plan ${plan.plan_id} refused: file state drifted between dry-run and apply.\n${detail}\nRe-run --dry-run to regenerate the plan.`,
    );
  }

  const runTs = compactTimestamp();
  const runRoot = options.quarantineDir ? resolve(options.quarantineDir, runTs) : join(quarantineRoot(), runTs);
  ensureDir(runRoot);

  const auditPath = join(auditDir(), `${scanId}.jsonl`);
  ensureDir(dirname(auditPath));

  appendAuditEvent(scanId, {
    ts: isoNow(),
    actor: 'remediate',
    scan_id: scanId,
    plan_id: plan.plan_id,
    event: 'apply.start',
    sig_status: sigStatus,
    quarantine_root: runRoot,
    action_count: plan.actions.length,
  });

  const completed = [];
  const skipped = [];
  const failed = [];
  const remaining = [];

  for (let i = 0; i < plan.actions.length; i += 1) {
    const action = plan.actions[i];

    if (action.action_type === ACTION_TYPES.KILL_PROCESS && !options.killPids.includes(action.target_pid)) {
      skipped.push({ action_id: action.action_id, reason: 'kill-pid not authorized via --kill-pid <pid>' });
      continue;
    }

    process.stdout.write(`${describeAction(action)}\n`);
    const consent = await promptConsent(action, options);
    if (!consent) {
      skipped.push({ action_id: action.action_id, reason: 'operator declined typed consent' });
      appendAuditEvent(scanId, {
        ts: isoNow(),
        actor: 'remediate',
        scan_id: scanId,
        plan_id: plan.plan_id,
        action_id: action.action_id,
        event: 'action.skipped',
        reason: 'consent-declined',
      });
      continue;
    }

    appendAuditEvent(scanId, {
      ts: isoNow(),
      actor: 'remediate',
      scan_id: scanId,
      plan_id: plan.plan_id,
      action_id: action.action_id,
      event: 'action.start',
      action_type: action.action_type,
    });

    try {
      let payload;
      switch (action.action_type) {
        case ACTION_TYPES.QUARANTINE:
          payload = quarantineFile(action, plan, runRoot);
          break;
        case ACTION_TYPES.KILL_PROCESS:
          payload = killProcess(action);
          break;
        case ACTION_TYPES.EMIT_CREDENTIAL_ROTATION:
          payload = emitCredentialRotation(action);
          break;
        default:
          throw new Error(`unknown action type: ${action.action_type}`);
      }
      completed.push(action.action_id);
      appendAuditEvent(scanId, {
        ts: isoNow(),
        actor: 'remediate',
        scan_id: scanId,
        plan_id: plan.plan_id,
        action_id: action.action_id,
        event: 'action.end',
        action_type: action.action_type,
        result: 'ok',
        payload,
      });
    } catch (error) {
      failed.push({ action_id: action.action_id, error: error.message });
      remaining.push(...plan.actions.slice(i + 1));
      appendAuditEvent(scanId, {
        ts: isoNow(),
        actor: 'remediate',
        scan_id: scanId,
        plan_id: plan.plan_id,
        action_id: action.action_id,
        event: 'action.end',
        action_type: action.action_type,
        result: 'error',
        error: error.message,
      });
      break;
    }
  }

  appendAuditEvent(scanId, {
    ts: isoNow(),
    actor: 'remediate',
    scan_id: scanId,
    plan_id: plan.plan_id,
    event: 'apply.end',
    completed: completed.length,
    skipped: skipped.length,
    failed: failed.length,
    remaining: remaining.length,
  });

  let resumeFile = null;
  if (failed.length > 0 || remaining.length > 0) {
    resumeFile = writeResumeFile(plan, completed, skipped, failed, remaining);
  }

  const sizeBytes = dirSizeBytes(runRoot);
  if (sizeBytes > 100 * 1024 * 1024) {
    process.stderr.write(
      `\nWARNING: quarantine size ${(sizeBytes / 1024 / 1024).toFixed(1)}MB exceeds 100MB threshold. Run \`genie sec restore <id>\` once verified, or \`genie sec quarantine gc --older-than <duration>\` to release space.\n`,
    );
  }

  printCompletionBanner({
    scanId,
    runTs,
    runRoot,
    auditPath,
    completed: completed.length,
    skipped: skipped.length,
    failed: failed.length,
    resumeFile,
    sizeBytes,
  });

  return {
    completed,
    skipped,
    failed,
    remaining: remaining.map((a) => a.action_id),
    resumeFile,
    runRoot,
  };
}

function writeResumeFile(plan, completed, skipped, failed, remaining) {
  const resumePath = join(resumeDir(), `${plan.scan_id}.json`);
  const resumeData = {
    scan_id: plan.scan_id,
    plan_id: plan.plan_id,
    saved_at: isoNow(),
    plan_snapshot: plan,
    completed_action_ids: completed,
    skipped_action_ids: skipped.map((s) => s.action_id),
    failed_action_ids: failed.map((f) => f.action_id),
    remaining_actions: remaining,
  };
  fsyncWriteFile(resumePath, JSON.stringify(resumeData, null, 2));
  return resumePath;
}

async function resumeApply(options) {
  if (!options.resume) throw new Error('--resume requires a path argument');
  const resumeData = readJson(options.resume);
  // Build a synthetic plan whose actions are only the remaining ones, then
  // delegate to applyPlan.
  const continuationPlan = {
    ...resumeData.plan_snapshot,
    plan_id: resumeData.plan_id,
    scan_id: resumeData.scan_id,
    actions: resumeData.remaining_actions,
    coverage: resumeData.plan_snapshot?.coverage || { caps_hit: 0, skipped_roots: 0 },
  };
  const tempPlanPath = join(plansDir(), `${resumeData.scan_id}-resume-${compactTimestamp()}.json`);
  fsyncWriteFile(tempPlanPath, JSON.stringify(continuationPlan, null, 2));
  return applyPlan({ ...options, plan: tempPlanPath });
}

function printCompletionBanner({
  scanId,
  runTs,
  runRoot,
  auditPath,
  completed,
  skipped,
  failed,
  resumeFile,
  sizeBytes,
}) {
  const lines = [
    '',
    '─── genie sec remediate complete ───',
    `scan_id        : ${scanId}`,
    `quarantine id  : ${runTs}`,
    `quarantine dir : ${runRoot}`,
    `quarantine size: ${(sizeBytes / 1024).toFixed(1)} KB`,
    `audit log      : ${auditPath}`,
    `actions        : ${completed} completed, ${skipped} skipped, ${failed} failed`,
    '',
    `Restore individual quarantine: genie sec restore ${runTs}`,
    `Bulk undo:                     genie sec rollback ${scanId}`,
  ];
  if (resumeFile) {
    lines.push(`Resume partial:                genie sec remediate --resume ${resumeFile}`);
  }
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);
}

// ----- Dry-run path -------------------------------------------------------

function runDryRun(options) {
  const { scan } = loadScan(options);
  const plan = generatePlan(scan);
  enforceCoverageGate(plan, plan.scan_id, options);

  ensureDir(plansDir());
  const planPath = join(plansDir(), `${plan.scan_id}-${compactTimestamp()}.json`);
  fsyncWriteFile(planPath, JSON.stringify(plan, null, 2));

  appendAuditEvent(plan.scan_id, {
    ts: isoNow(),
    actor: 'remediate',
    scan_id: plan.scan_id,
    plan_id: plan.plan_id,
    event: 'dryrun.plan',
    plan_path: planPath,
    action_count: plan.actions.length,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ plan_path: planPath, plan }, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        '',
        '─── genie sec remediate (dry-run) ───',
        `scan_id    : ${plan.scan_id}`,
        `plan_id    : ${plan.plan_id}`,
        `actions    : ${plan.actions.length}`,
        `plan path  : ${planPath}`,
        '',
        `Apply with: genie sec remediate --apply --plan ${planPath}`,
        '',
      ].join('\n'),
    );
    for (const action of plan.actions) {
      process.stdout.write(`${describeAction(action)}\n`);
    }
  }

  return { planPath, plan };
}

// ----- Restore ------------------------------------------------------------

function restoreQuarantine(quarantineId) {
  const dir = join(quarantineRoot(), quarantineId);
  if (!existsSync(dir)) {
    throw new Error(`quarantine id not found: ${dir}`);
  }
  const actionDirs = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name));

  const restored = [];
  const failed = [];
  let scanId = null;

  for (const actionDir of actionDirs) {
    const sidecarPath = join(actionDir, 'action.json');
    if (!existsSync(sidecarPath)) {
      failed.push({ action_dir: actionDir, error: 'sidecar missing' });
      continue;
    }
    const sidecar = readJson(sidecarPath);
    scanId = sidecar.scan_id;
    try {
      if (existsSync(sidecar.original_path)) {
        throw new Error(`original path already occupied: ${sidecar.original_path}`);
      }
      ensureDir(dirname(sidecar.original_path));
      renameSync(sidecar.quarantine_path, sidecar.original_path);
      let restoredHash = null;
      if (sidecar.sha256_before) {
        restoredHash = sha256File(sidecar.original_path);
        if (restoredHash !== sidecar.sha256_before) {
          throw new Error(`sha256 mismatch after restore (expected ${sidecar.sha256_before}, got ${restoredHash})`);
        }
      }
      restored.push({ action_id: sidecar.action_id, original_path: sidecar.original_path, sha256: restoredHash });
      appendAuditEvent(scanId || 'orphan', {
        ts: isoNow(),
        actor: 'restore',
        scan_id: scanId,
        plan_id: sidecar.plan_id,
        action_id: sidecar.action_id,
        event: 'action.restore',
        original_path: sidecar.original_path,
        quarantine_id: quarantineId,
        sha256_match: restoredHash === sidecar.sha256_before,
      });
    } catch (error) {
      failed.push({ action_id: sidecar.action_id, error: error.message });
      appendAuditEvent(scanId || 'orphan', {
        ts: isoNow(),
        actor: 'restore',
        scan_id: scanId,
        plan_id: sidecar.plan_id,
        action_id: sidecar.action_id,
        event: 'action.restore.error',
        error: error.message,
      });
    }
  }

  if (failed.length > 0) {
    const partialResume = join(resumeDir(), `${quarantineId}-restore-partial.json`);
    fsyncWriteFile(
      partialResume,
      JSON.stringify({ quarantine_id: quarantineId, restored, failed, saved_at: isoNow() }, null, 2),
    );
    process.stderr.write(`\nWARNING: ${failed.length} action(s) failed to restore. Partial: ${partialResume}\n`);
  }
  return { quarantine_id: quarantineId, restored, failed };
}

// ----- Rollback + quarantine lifecycle ------------------------------------

function readAuditEvents(scanId) {
  const path = join(auditDir(), `${scanId}.jsonl`);
  if (!existsSync(path)) {
    throw new Error(`audit log not found for scan_id ${scanId}: ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return [];
  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch (error) {
      // Tampering or partial write: surface via stderr but continue — the rest
      // of the audit trail is still the operator's best evidence.
      process.stderr.write(`WARNING: audit log has a corrupt entry (${error.message}): ${trimmed.slice(0, 120)}\n`);
    }
  }
  return events;
}

function rollbackActionFromSidecar(sidecar, rollbackId, scanId) {
  if (!existsSync(sidecar.quarantine_path)) {
    throw new Error(`quarantine path already missing (already restored?): ${sidecar.quarantine_path}`);
  }
  if (existsSync(sidecar.original_path)) {
    throw new Error(`original path already occupied: ${sidecar.original_path}`);
  }
  ensureDir(dirname(sidecar.original_path));
  renameSync(sidecar.quarantine_path, sidecar.original_path);
  let restoredHash = null;
  if (sidecar.sha256_before) {
    restoredHash = sha256File(sidecar.original_path);
    if (restoredHash !== sidecar.sha256_before) {
      throw new Error(`sha256 mismatch after rollback (expected ${sidecar.sha256_before}, got ${restoredHash})`);
    }
  }
  appendAuditEvent(scanId, {
    ts: isoNow(),
    actor: 'rollback',
    scan_id: scanId,
    plan_id: sidecar.plan_id,
    action_id: sidecar.action_id,
    event: 'action.rollback',
    rollback_id: rollbackId,
    original_path: sidecar.original_path,
    sha256_match: restoredHash === sidecar.sha256_before,
  });
  return { action_id: sidecar.action_id, original_path: sidecar.original_path, sha256: restoredHash };
}

function performRollback(scanId) {
  const events = readAuditEvents(scanId);

  // A quarantine action is roll-back-eligible iff its `action.end` says
  // result=ok AND action_type=quarantine. Order by the audit-log sequence,
  // then reverse so we undo in LIFO — the same discipline as filesystem
  // unrolling: later actions first.
  const quarantineEnds = events
    .filter(
      (e) => e.actor === 'remediate' && e.event === 'action.end' && e.result === 'ok' && e.action_type === 'quarantine',
    )
    .reverse();

  const rollbackId = `R${ulid()}`;
  const startedAt = isoNow();
  const startMs = Date.now();
  const actionsUndone = [];
  const actionsFailed = [];

  appendAuditEvent(scanId, {
    ts: startedAt,
    actor: 'rollback',
    scan_id: scanId,
    event: 'rollback.start',
    rollback_id: rollbackId,
    eligible_actions: quarantineEnds.length,
  });

  for (const event of quarantineEnds) {
    const payload = event.payload || {};
    const quarantinePath = payload.quarantine_path;
    const actionId = event.action_id || payload.action_id;
    try {
      if (!quarantinePath) {
        throw new Error('audit entry missing quarantine_path in payload');
      }
      const sidecarPath = join(dirname(quarantinePath), 'action.json');
      if (!existsSync(sidecarPath)) {
        throw new Error(`sidecar missing: ${sidecarPath}`);
      }
      const sidecar = readJson(sidecarPath);
      const result = rollbackActionFromSidecar(sidecar, rollbackId, scanId);
      actionsUndone.push(result);
    } catch (error) {
      actionsFailed.push({ action_id: actionId || '(unknown)', reason: error.message });
      appendAuditEvent(scanId, {
        ts: isoNow(),
        actor: 'rollback',
        scan_id: scanId,
        action_id: actionId || '(unknown)',
        event: 'action.rollback.error',
        rollback_id: rollbackId,
        error: error.message,
      });
    }
  }

  const finishedAt = isoNow();
  const durationMs = Date.now() - startMs;
  const summary = {
    rollback_id: rollbackId,
    scan_id: scanId,
    started_at: startedAt,
    finished_at: finishedAt,
    actions_undone: actionsUndone,
    actions_failed: actionsFailed,
    duration_ms: durationMs,
  };
  ensureDir(rollbackDir());
  const summaryPath = join(rollbackDir(), `${rollbackId}.json`);
  fsyncWriteFile(summaryPath, JSON.stringify(summary, null, 2));

  appendAuditEvent(scanId, {
    ts: finishedAt,
    actor: 'rollback',
    scan_id: scanId,
    event: 'rollback.end',
    rollback_id: rollbackId,
    summary_path: summaryPath,
    actions_undone: actionsUndone.length,
    actions_failed: actionsFailed.length,
    duration_ms: durationMs,
  });

  return { ...summary, summary_path: summaryPath };
}

function readSidecarSafely(actionDir) {
  const sidecarPath = join(actionDir, 'action.json');
  if (!existsSync(sidecarPath)) return null;
  try {
    return readJson(sidecarPath);
  } catch {
    return null;
  }
}

function classifyQuarantineDir(quarantineDir) {
  if (!existsSync(quarantineDir)) {
    return { status: 'abandoned', scan_id: null, action_counts: { active: 0, restored: 0, abandoned: 0 } };
  }
  const entries = readdirSync(quarantineDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  let active = 0;
  let restored = 0;
  let abandoned = 0;
  let scanId = null;
  for (const entry of entries) {
    const actionDir = join(quarantineDir, entry.name);
    const sidecar = readSidecarSafely(actionDir);
    if (!sidecar) {
      abandoned += 1;
      continue;
    }
    if (!scanId && sidecar.scan_id) scanId = sidecar.scan_id;
    if (existsSync(sidecar.quarantine_path)) {
      active += 1;
    } else {
      restored += 1;
    }
  }
  const status = active > 0 ? 'active' : restored > 0 ? 'restored' : 'abandoned';
  return { status, scan_id: scanId, action_counts: { active, restored, abandoned } };
}

function listQuarantines() {
  const root = quarantineRoot();
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  const out = [];
  for (const entry of entries) {
    const dir = join(root, entry.name);
    const stat = statSafe(dir);
    const classification = classifyQuarantineDir(dir);
    out.push({
      id: entry.name,
      timestamp: entry.name,
      mtime_ms: stat ? stat.mtimeMs : 0,
      size_bytes: dirSizeBytes(dir),
      status: classification.status,
      scan_id: classification.scan_id,
      action_counts: classification.action_counts,
    });
  }
  out.sort((a, b) => a.mtime_ms - b.mtime_ms);
  return out;
}

function formatQuarantineTable(rows) {
  if (rows.length === 0) return 'No quarantines present.\n';
  const header = ['ID', 'TIMESTAMP', 'SIZE', 'STATUS', 'SCAN_ID'];
  const lines = [header.join('\t')];
  for (const row of rows) {
    const sizeStr = `${(row.size_bytes / 1024).toFixed(1)}KB`;
    lines.push([row.id, row.timestamp, sizeStr, row.status, row.scan_id || '(unknown)'].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

function expectedGcToken(eligibleIds) {
  const digest = createHash('sha256').update(eligibleIds.slice().sort().join('|')).digest('hex');
  return `CONFIRM-GC-${digest.slice(0, 6)}`;
}

function performGc(options) {
  if (!options.olderThan) {
    throw new Error('--quarantine-gc requires --older-than <duration> (e.g. 30d, 24h, 15m).');
  }
  const thresholdMs = parseDurationMs(options.olderThan);
  const now = Date.now();
  const all = listQuarantines();
  const active = all.filter((q) => q.status === 'active');
  const stale = all.filter((q) => q.status !== 'active' && now - q.mtime_ms >= thresholdMs);
  const staleIds = stale.map((q) => q.id);
  const expected = expectedGcToken(staleIds);

  const summary = {
    older_than: options.olderThan,
    threshold_ms: thresholdMs,
    eligible_ids: staleIds,
    eligible_size_bytes: stale.reduce((sum, q) => sum + q.size_bytes, 0),
    active_refused: active.length,
    expected_token: expected,
  };

  if (active.length > 0) {
    summary.active_refused_ids = active.map((q) => q.id);
  }

  if (staleIds.length === 0) {
    summary.status = 'nothing-to-gc';
    return summary;
  }

  if (options.confirmGc !== expected) {
    summary.status = 'needs-typed-confirmation';
    summary.hint = `Re-run with: --confirm-gc ${expected}`;
    return summary;
  }

  const deleted = [];
  const failed = [];
  for (const q of stale) {
    const dir = join(quarantineRoot(), q.id);
    try {
      rmSync(dir, { recursive: true, force: true });
      deleted.push(q.id);
      if (q.scan_id) {
        appendAuditEvent(q.scan_id, {
          ts: isoNow(),
          actor: 'gc',
          scan_id: q.scan_id,
          event: 'quarantine.gc',
          quarantine_id: q.id,
          size_bytes: q.size_bytes,
          older_than: options.olderThan,
        });
      }
    } catch (error) {
      failed.push({ id: q.id, reason: error.message });
    }
  }
  summary.status = failed.length > 0 ? 'partial' : 'ok';
  summary.deleted_ids = deleted;
  summary.failed = failed;
  return summary;
}

// ----- Entry point --------------------------------------------------------

async function main() {
  let options;
  try {
    options = parseArgs(process.argv);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    printHelp();
    process.exit(1);
  }

  if (options.mode === 'help' || !options.mode) {
    printHelp();
    process.exit(options.mode === 'help' ? 0 : 1);
  }

  if (options.mode === 'dry-run') {
    runDryRun(options);
    return;
  }
  if (options.mode === 'apply') {
    if (!options.plan) {
      process.stderr.write('error: --apply requires --plan <path>. Generate one with --dry-run.\n');
      process.exit(1);
    }
    const result = await applyPlan(options);
    if (result.failed.length > 0 || result.remaining.length > 0) {
      process.exit(2);
    }
    return;
  }
  if (options.mode === 'resume') {
    const result = await resumeApply(options);
    if (result.failed.length > 0 || result.remaining.length > 0) {
      process.exit(2);
    }
    return;
  }
  if (options.mode === 'restore') {
    if (!options.restoreId) {
      process.stderr.write('error: --restore requires a quarantine id argument\n');
      process.exit(1);
    }
    const result = restoreQuarantine(options.restoreId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.failed.length > 0) process.exit(2);
    return;
  }
  if (options.mode === 'rollback') {
    if (!options.rollbackScanId) {
      process.stderr.write('error: --rollback requires a scan_id argument\n');
      process.exit(1);
    }
    const summary = performRollback(options.rollbackScanId);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          '',
          '─── genie sec rollback complete ───',
          `rollback_id    : ${summary.rollback_id}`,
          `scan_id        : ${summary.scan_id}`,
          `started_at     : ${summary.started_at}`,
          `finished_at    : ${summary.finished_at}`,
          `duration_ms    : ${summary.duration_ms}`,
          `actions_undone : ${summary.actions_undone.length}`,
          `actions_failed : ${summary.actions_failed.length}`,
          `summary        : ${summary.summary_path}`,
          '',
        ].join('\n'),
      );
      if (summary.actions_failed.length > 0) {
        process.stdout.write('Failed actions:\n');
        for (const f of summary.actions_failed) {
          process.stdout.write(`  - ${f.action_id}: ${f.reason}\n`);
        }
        process.stdout.write('\n');
      }
    }
    if (summary.actions_failed.length > 0) process.exit(2);
    return;
  }
  if (options.mode === 'quarantine-list') {
    const rows = listQuarantines();
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ quarantines: rows }, null, 2)}\n`);
    } else {
      process.stdout.write(formatQuarantineTable(rows));
    }
    return;
  }
  if (options.mode === 'quarantine-gc') {
    const summary = performGc(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      const eligibleSize = (summary.eligible_size_bytes / 1024).toFixed(1);
      const lines = [
        '',
        '─── genie sec quarantine gc ───',
        `older_than        : ${summary.older_than}`,
        `eligible ids      : ${summary.eligible_ids.length}`,
        `eligible size     : ${eligibleSize} KB`,
        `active refused    : ${summary.active_refused}`,
      ];
      if (summary.status === 'nothing-to-gc') {
        lines.push('status            : nothing-to-gc');
      } else if (summary.status === 'needs-typed-confirmation') {
        lines.push('status            : needs-typed-confirmation');
        lines.push('');
        lines.push(`Re-run with:  --confirm-gc ${summary.expected_token}`);
      } else {
        lines.push(`deleted ids       : ${summary.deleted_ids?.length ?? 0}`);
        lines.push(`status            : ${summary.status}`);
        if (summary.failed && summary.failed.length > 0) {
          lines.push('failed:');
          for (const f of summary.failed) lines.push(`  - ${f.id}: ${f.reason}`);
        }
      }
      lines.push('');
      process.stdout.write(`${lines.join('\n')}\n`);
    }
    if (summary.status === 'needs-typed-confirmation' || summary.status === 'partial') {
      process.exit(2);
    }
    return;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`sec-remediate.cjs failed: ${error.message}\n`);
    process.exit(3);
  });
}

module.exports = {
  ACTION_TYPES,
  CREDENTIAL_TEMPLATES,
  buildCredentialEmissionAction,
  buildKillProcessAction,
  buildQuarantineActionFromFinding,
  classifyQuarantineDir,
  detectPlanDrift,
  enforceCoverageGate,
  ensureRunRootOnSameDevice,
  emitCredentialRotation,
  expectedConsentToken,
  expectedGcToken,
  generatePlan,
  listQuarantines,
  loadPlan,
  parseArgs,
  parseDurationMs,
  performGc,
  performRollback,
  promptConsent,
  quarantineFile,
  readAuditEvents,
  restoreQuarantine,
  runDryRun,
  applyPlan,
  resumeApply,
  ulid,
  appendAuditEvent,
  // for testing
  _internals: {
    genieHome,
    secScanRoot,
    quarantineRoot,
    plansDir,
    resumeDir,
    auditDir,
    rollbackDir,
    sha256File,
    sha256Buffer,
  },
};
