/**
 * Beads issues.jsonl helpers (minimal, local-file only)
 *
 * Canonical file: <repo>/.beads/issues.jsonl
 *
 * This module intentionally does NOT call `bd` and does not implement any
 * external ingestion. It only performs local JSONL upsert operations.
 */

import { access, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { exec as execCb } from 'child_process';

const execAsync = promisify(execCb);

export interface BeadsIssueRecord {
  id: string;
  title: string;
  status: 'open' | 'closed';
  source_repo: string;
  wish_slug: string;
  created_at: string;
  updated_at: string;
  depends_on: string[];
  // Allow forward-compatible fields
  [k: string]: unknown;
}

let _lastUtcNowMs = 0;

/**
 * RFC3339/ISO8601 UTC timestamp with a monotonic guarantee.
 *
 * Note: Date() only has millisecond resolution. When we write multiple records
 * in the same tick (common in tests and fast CLIs), we still want updated_at
 * to advance so downstream consumers can rely on it.
 */
export function utcNowRfc3339(): string {
  const ms = Date.now();
  const next = ms <= _lastUtcNowMs ? _lastUtcNowMs + 1 : ms;
  _lastUtcNowMs = next;
  return new Date(next).toISOString();
}

export async function ensureBeadsIssuesPath(repoPath: string): Promise<string> {
  const issuesPath = join(repoPath, '.beads', 'issues.jsonl');
  await mkdir(dirname(issuesPath), { recursive: true });
  return issuesPath;
}

function safeJsonParse(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Upsert a record by `id`.
 * - Idempotent: repeated calls update the same line
 * - Preserves other lines as-is
 * - Best-effort preservation of original created_at when updating
 */
export async function upsertBeadsIssueJsonl(
  issuesPath: string,
  record: Omit<BeadsIssueRecord, 'created_at' | 'updated_at'> & {
    created_at?: string;
    updated_at?: string;
  }
): Promise<BeadsIssueRecord> {
  const now = utcNowRfc3339();

  let lines: string[] = [];
  try {
    const content = await readFile(issuesPath, 'utf-8');
    lines = content.split('\n');
  } catch {
    // no file yet
  }

  let existingCreatedAt: string | undefined;

  const newLines: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const obj = safeJsonParse(line);
    if (!obj || typeof obj !== 'object') {
      // Preserve malformed lines (don't delete user data)
      newLines.push(line);
      continue;
    }
    if (obj.id === record.id) {
      if (typeof obj.created_at === 'string') existingCreatedAt = obj.created_at;
      // skip; will re-add updated line at end for simplicity
      continue;
    }
    newLines.push(JSON.stringify(obj));
  }

  const final: BeadsIssueRecord = {
    ...record,
    created_at: record.created_at || existingCreatedAt || now,
    updated_at: record.updated_at || now,
  } as BeadsIssueRecord;

  newLines.push(JSON.stringify(final));

  // Atomic write
  await mkdir(dirname(issuesPath), { recursive: true });
  const tmp = issuesPath + `.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, newLines.join('\n') + '\n', 'utf-8');
  await rename(tmp, issuesPath);

  return final;
}

/**
 * Normalize source_repo to one of:
 *   - git:<remote-url>
 *   - git:file:<abs-path>
 */
export async function getSourceRepo(repoPath: string): Promise<string> {
  // Prefer origin remote URL, normalized
  try {
    const { stdout } = await execAsync('git remote get-url origin', { cwd: repoPath });
    const url = stdout.trim();
    if (url) return `git:${normalizeGitRemote(url)}`;
  } catch {
    // ignore
  }
  return `git:file:${repoPath}`;
}

export function normalizeGitRemote(url: string): string {
  // Trim and strip trailing .git or slash
  let u = (url || '').trim();
  u = u.replace(/\s+/g, '');
  u = u.replace(/\.git$/i, '');
  u = u.replace(/\/$/, '');
  // Convert scp-like git@host:org/repo to ssh://git@host/org/repo
  if (/^[\w.-]+@[\w.-]+:/.test(u) && !u.startsWith('ssh://')) {
    const [userHost, path] = u.split(':', 2);
    u = `ssh://${userHost}/${path}`;
  }
  return u;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
