/**
 * Trust allowlist — the security boundary of the .genie/hooks/ loader.
 *
 * Filesystem-presence is NOT consent. Every external `.ts` hook file (per-team,
 * per-repo, or global) must be listed in `~/.genie/hooks/trusted.json` with a
 * matching SHA-256 before the loader will dynamic-`import()` it. A file landing
 * in a repo via `git clone`, npm postinstall, or hostile PR does not silently
 * arm — the loader rejects it as `[BROKEN]`.
 *
 * Threat model: single-operator machine, $HOME assumed trusted (an attacker who
 * can write `trusted.json` already owns the box). The allowlist is a guard
 * against ACCIDENTAL inclusion (drive-by clones), not against a $HOME-write
 * adversary; real isolation is the deferred `vm.Context` work in delivery #4.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Tier scopes — which directory the trusted file lives under. */
export type TrustScope = 'global' | 'team' | 'repo';

/**
 * On-disk shape for a single trust entry.
 *
 * `path` is always absolute. `sha256` is the lowercase hex digest of the file's
 * bytes at trust time — re-trust is required after any edit. `repoRemoteUrl`
 * is set only for `scope: 'repo'` entries and pins the trust to a specific
 * git remote; the same `.ts` in a different clone is independently untrusted.
 */
export interface TrustEntry {
  path: string;
  sha256: string;
  scope: TrustScope;
  /** Required when `scope === 'repo'`. */
  repoRemoteUrl?: string;
  /** ISO 8601 timestamp of when the entry was added. */
  trustedAt: string;
  /** Optional human-readable note set at trust time. */
  note?: string;
  /** Capabilities declared in the file's `// @capabilities: ...` JSDoc. */
  capabilities?: string[];
}

/** On-disk shape of `~/.genie/hooks/trusted.json`. */
export interface TrustFile {
  version: 1;
  entries: TrustEntry[];
}

/** Default location of the trust file. Override in tests. */
export function defaultTrustPath(): string {
  return join(homedir(), '.genie', 'hooks', 'trusted.json');
}

/** Reasons the verifier rejects a file. Surfaced by `genie hook list`. */
export type RejectReason =
  | 'not_in_trust_file'
  | 'sha256_mismatch'
  | 'repo_remote_mismatch'
  | 'missing_repo_remote'
  | 'file_missing';

export type VerifyResult = { trusted: true; entry: TrustEntry } | { trusted: false; reason: RejectReason };

/**
 * Compute SHA-256 (lowercase hex) of a file's bytes.
 *
 * Throws if the file doesn't exist — callers map ENOENT to `file_missing`.
 */
export function sha256OfFile(path: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

/** Read the trust file from disk. Returns an empty `entries` array if absent. */
export function readTrustFile(path: string = defaultTrustPath()): TrustFile {
  if (!existsSync(path)) return { version: 1, entries: [] };
  const raw = readFileSync(path, 'utf-8');
  if (raw.trim().length === 0) return { version: 1, entries: [] };
  const parsed = JSON.parse(raw) as TrustFile;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported trust file version: ${parsed.version} (expected 1)`);
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error('Malformed trust file: entries must be an array');
  }
  return parsed;
}

/**
 * Verify a single file path against the trust file.
 *
 * For `scope: 'repo'` entries, callers must supply `currentRepoRemoteUrl`
 * (resolved via `git config --get remote.origin.url` at the file's repo root)
 * so the verifier can pin the trust to the active clone.
 */
export function verifyTrust(
  filePath: string,
  trustFile: TrustFile,
  options: { currentRepoRemoteUrl?: string } = {},
): VerifyResult {
  if (!existsSync(filePath)) return { trusted: false, reason: 'file_missing' };

  const entry = trustFile.entries.find((e) => e.path === filePath);
  if (!entry) return { trusted: false, reason: 'not_in_trust_file' };

  const actualSha = sha256OfFile(filePath);
  if (actualSha !== entry.sha256) return { trusted: false, reason: 'sha256_mismatch' };

  if (entry.scope === 'repo') {
    if (!entry.repoRemoteUrl) return { trusted: false, reason: 'missing_repo_remote' };
    if (options.currentRepoRemoteUrl !== entry.repoRemoteUrl) {
      return { trusted: false, reason: 'repo_remote_mismatch' };
    }
  }

  return { trusted: true, entry };
}

/**
 * Parse capability declarations from a file's source.
 *
 * Looks for a single line of the form `// @capabilities: cap1, cap2, cap3` —
 * surfaced at trust time so the operator approves the blast radius explicitly.
 * Returns an empty array if no declaration is found.
 */
export function parseCapabilities(source: string): string[] {
  const match = source.match(/^\/\/\s*@capabilities:\s*(.+)$/m);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}
