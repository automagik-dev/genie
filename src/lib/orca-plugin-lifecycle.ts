import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getGenieConfigPath, getGenieDir } from './genie-config.js';
import { type OrchestrationMode, resolveOrchestrationMode } from './orchestration-mode.js';

const OWNERSHIP_FILE = '.orca-plugin-ownership.json';
const BACKUP_DIR = 'backups/orchestration-mode';

/** Structural result of A3's public typed compatibility probe. */
export interface OrcaPluginCompatibilityResult {
  readonly runtimeId: string;
  readonly runtimeVersion: string;
  readonly contract: 'orchestration.contract.v1';
}

interface Ownership {
  schemaVersion: 1;
  owner: 'genie';
  manifestSha256: string;
  entrypointSha256: string;
}

export interface OrcaLifecycleInspection {
  mode: OrchestrationMode | 'invalid';
  payload: 'absent' | 'unmanaged' | 'owned-clean' | 'owned-modified' | 'unsafe-ownership';
  hostRegistration: 'not-managed';
  manifestPath: string;
  recovery?: string;
}

export interface OrcaModeSwitchDependencies {
  probe?: () => Promise<OrcaPluginCompatibilityResult>;
  /** Test-only boundary hooks. */
  hooks?: {
    afterBackup?: () => void;
    afterOwnership?: () => void;
    beforeConfigCommit?: () => void;
  };
}

export interface OrcaModeSwitchResult {
  changed: boolean;
  mode: OrchestrationMode;
  backupPath: string | null;
  compatibility: OrcaPluginCompatibilityResult | null;
}

function paths() {
  const home = getGenieDir();
  const payloadRoot = join(home, 'plugins', 'genie');
  return {
    home,
    config: getGenieConfigPath(),
    manifest: join(payloadRoot, 'orca-plugin.json'),
    entrypoint: join(payloadRoot, 'orca-entrypoint.min.js'),
    ownership: join(payloadRoot, OWNERSHIP_FILE),
    backups: join(home, BACKUP_DIR),
  };
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function expectedOwnership(): Ownership {
  const target = paths();
  if (!existsSync(target.manifest) || !existsSync(target.entrypoint)) {
    throw new Error('Orca plugin payload is incomplete; reinstall Genie before selecting Orca mode');
  }
  return {
    schemaVersion: 1,
    owner: 'genie',
    manifestSha256: digest(target.manifest),
    entrypointSha256: digest(target.entrypoint),
  };
}

function atomicWrite(path: string, bytes: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    writeFileSync(temporary, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readOwnership(path: string): Ownership | null | 'unsafe' {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unsafe';
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'entrypointSha256,manifestSha256,owner,schemaVersion' ||
      record.schemaVersion !== 1 ||
      record.owner !== 'genie' ||
      typeof record.manifestSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.manifestSha256) ||
      typeof record.entrypointSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.entrypointSha256)
    ) {
      return 'unsafe';
    }
    return record as unknown as Ownership;
  } catch {
    return 'unsafe';
  }
}

function sameOwnership(left: Ownership, right: Ownership): boolean {
  return left.manifestSha256 === right.manifestSha256 && left.entrypointSha256 === right.entrypointSha256;
}

function backupConfig(backupRoot: string, bytes: string | null): string {
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backupPath = join(backupRoot, `config-${Date.now()}-${randomBytes(8).toString('hex')}.json`);
  writeFileSync(backupPath, bytes ?? '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return backupPath;
}

function restore(path: string, bytes: string | null): void {
  if (bytes === null) rmSync(path, { force: true });
  else atomicWrite(path, bytes);
}

function nextConfig(original: string | null, mode: OrchestrationMode): string {
  let value: Record<string, unknown> = {};
  if (original !== null) {
    const parsed = JSON.parse(original) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Invalid Genie config');
    value = parsed as Record<string, unknown>;
  }
  return `${JSON.stringify({ ...value, orchestration: { mode } }, null, 2)}\n`;
}

/** Explicit, backup-first authority switch. It never reads or changes lifecycle history. */
export async function switchOrchestrationMode(
  mode: OrchestrationMode,
  dependencies: OrcaModeSwitchDependencies = {},
): Promise<OrcaModeSwitchResult> {
  const current = resolveOrchestrationMode();
  if (current === mode) return { changed: false, mode, backupPath: null, compatibility: null };

  const target = paths();
  const originalConfig = existsSync(target.config) ? readFileSync(target.config, 'utf8') : null;
  const originalOwnership = existsSync(target.ownership) ? readFileSync(target.ownership, 'utf8') : null;
  let compatibility: OrcaPluginCompatibilityResult | null = null;
  let ownership: Ownership | null = null;

  if (mode === 'orca') {
    ownership = expectedOwnership();
    const existing = readOwnership(target.ownership);
    if (existing === 'unsafe' || (existing !== null && !sameOwnership(existing, ownership))) {
      throw new Error('Orca plugin ownership metadata is unsafe or does not match the shipped payload');
    }
    const probe =
      dependencies.probe ??
      (async () => {
        const { createOrcaPluginRuntime } = await import('../../plugins/genie/orca-runtime.js');
        return createOrcaPluginRuntime().probe();
      });
    compatibility = await probe();
  }

  const backupPath = backupConfig(target.backups, originalConfig);
  dependencies.hooks?.afterBackup?.();
  try {
    if (ownership !== null) atomicWrite(target.ownership, `${JSON.stringify(ownership, null, 2)}\n`);
    dependencies.hooks?.afterOwnership?.();
    dependencies.hooks?.beforeConfigCommit?.();
    atomicWrite(target.config, nextConfig(originalConfig, mode));
  } catch (error) {
    restore(target.config, originalConfig);
    restore(target.ownership, originalOwnership);
    throw error;
  }
  return { changed: true, mode, backupPath, compatibility };
}

/** Read-only status used by doctor; host registration is intentionally user-managed. */
export function inspectOrcaPluginLifecycle(): OrcaLifecycleInspection {
  const target = paths();
  let mode: OrcaLifecycleInspection['mode'];
  try {
    mode = resolveOrchestrationMode();
  } catch {
    mode = 'invalid';
  }
  const base = { mode, hostRegistration: 'not-managed' as const, manifestPath: target.manifest };
  if (!existsSync(target.manifest) && !existsSync(target.entrypoint)) return { ...base, payload: 'absent' };
  if (!existsSync(target.manifest) || !existsSync(target.entrypoint)) {
    return { ...base, payload: 'owned-modified', recovery: 'reinstall Genie to restore the complete Orca payload' };
  }
  const existing = readOwnership(target.ownership);
  if (existing === null) return { ...base, payload: 'unmanaged' };
  if (existing === 'unsafe') {
    return { ...base, payload: 'unsafe-ownership', recovery: 'review the ownership marker; Genie will not replace it' };
  }
  return sameOwnership(existing, expectedOwnership())
    ? { ...base, payload: 'owned-clean' }
    : { ...base, payload: 'owned-modified', recovery: 'reinstall or update Genie; modified payload was preserved' };
}

/** Remove only the digest-proven ownership marker; payload and all history remain untouched. */
export function uninstallOwnedOrcaPluginMetadata(): 'removed' | 'absent' | 'preserved' {
  const target = paths();
  const existing = readOwnership(target.ownership);
  if (existing === null) return 'absent';
  if (existing === 'unsafe') return 'preserved';
  let expected: Ownership;
  try {
    expected = expectedOwnership();
  } catch {
    return 'preserved';
  }
  if (!sameOwnership(existing, expected)) return 'preserved';
  rmSync(target.ownership);
  return 'removed';
}

/** Refresh a prior Genie ownership claim after update/rollback replaces the verified payload. */
export async function refreshOwnedOrcaPluginMetadata(
  probeOverride?: () => Promise<OrcaPluginCompatibilityResult>,
): Promise<'standalone' | 'unmanaged' | 'unchanged' | 'refreshed'> {
  if (resolveOrchestrationMode() !== 'orca') return 'standalone';
  const target = paths();
  const previous = readOwnership(target.ownership);
  if (previous === null) return 'unmanaged';
  if (previous === 'unsafe') throw new Error('Orca plugin ownership metadata is unsafe; update preserved it');
  const expected = expectedOwnership();
  if (sameOwnership(previous, expected)) return 'unchanged';
  const probe =
    probeOverride ??
    (async () => {
      const { createOrcaPluginRuntime } = await import('../../plugins/genie/orca-runtime.js');
      return createOrcaPluginRuntime().probe();
    });
  await probe();
  const original = readFileSync(target.ownership, 'utf8');
  try {
    atomicWrite(target.ownership, `${JSON.stringify(expected, null, 2)}\n`);
  } catch (error) {
    atomicWrite(target.ownership, original);
    throw error;
  }
  return 'refreshed';
}
