/**
 * QA State — Persistent storage for QA run results.
 *
 * Specs live in `{repo}/.genie/qa/` (tracked in git, per-repo).
 * Results live in `~/.genie/qa/{repo-hash}/` (local, never tracked).
 * Each entry is keyed by domain-relative spec path (e.g. "messaging/round-trip-response").
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { ExpectReport, SpecReport } from './qa-runner.js';

// ============================================================================
// Types
// ============================================================================

export interface StoredResult {
  lastRun: string;
  result: 'pass' | 'fail' | 'error';
  durationMs: number;
  specHash: string;
  expectations: ExpectReport[];
  error?: string;
}

interface QaResults {
  [specKey: string]: StoredResult;
}

export interface SpecEntry {
  key: string;
  domain: string;
  name: string;
  filePath: string;
}

// ============================================================================
// Paths
// ============================================================================

/** Hash a repo path to a short ID for global results storage. */
function repoHash(repoPath: string): string {
  return createHash('sha256').update(resolve(repoPath)).digest('hex').slice(0, 12);
}

/** Global results directory: ~/.genie/qa/{repo-hash}/ */
function resultsDir(repoPath: string): string {
  const base = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  return join(base, 'qa', repoHash(repoPath));
}

function resultsPath(repoPath: string): string {
  return join(resultsDir(repoPath), 'results.json');
}

// ============================================================================
// Core API
// ============================================================================

/** Load all stored QA results. Returns empty object if no results file exists. */
export async function loadResults(repoPath: string): Promise<QaResults> {
  try {
    const raw = await readFile(resultsPath(repoPath), 'utf-8');
    return JSON.parse(raw) as QaResults;
  } catch {
    return {};
  }
}

/** Save a single spec result. Merges into existing results file. */
export async function saveResult(repoPath: string, specKey: string, report: SpecReport): Promise<void> {
  const dir = resultsDir(repoPath);
  await mkdir(dir, { recursive: true });

  const results = await loadResults(repoPath);

  const specHash = await hashSpecFile(report.file);
  results[specKey] = {
    lastRun: new Date().toISOString(),
    result: report.result,
    durationMs: report.durationMs,
    specHash,
    expectations: report.expectations,
    error: report.error,
  };

  await writeFile(resultsPath(repoPath), JSON.stringify(results, null, 2));
}

/** Check if a spec's result is stale (spec file changed since last run). */
export async function isStale(repoPath: string, specKey: string, specFilePath: string): Promise<boolean> {
  const results = await loadResults(repoPath);
  const stored = results[specKey];
  if (!stored) return false; // Never run = not stale, just "never"

  const currentHash = await hashSpecFile(specFilePath);
  return currentHash !== stored.specHash;
}

/** List all QA spec files recursively, organized by domain. */
export async function listAllSpecs(specDir: string): Promise<SpecEntry[]> {
  const entries: SpecEntry[] = [];
  await walkSpecs(specDir, specDir, entries);
  return entries.sort((a, b) => {
    if (a.domain !== b.domain) return a.domain.localeCompare(b.domain);
    return a.name.localeCompare(b.name);
  });
}

// ============================================================================
// Helpers
// ============================================================================

/** Compute SHA-256 hash of a spec file's content. */
async function hashSpecFile(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return createHash('sha256').update(content).digest('hex').slice(0, 12);
  } catch {
    return 'unknown';
  }
}

/** Recursively walk spec directory, collecting .md files. */
async function walkSpecs(baseDir: string, dir: string, entries: SpecEntry[]): Promise<void> {
  const items = await readdir(dir);
  for (const item of items) {
    const fullPath = join(dir, item);
    const s = await stat(fullPath);
    if (s.isDirectory()) {
      await walkSpecs(baseDir, fullPath, entries);
    } else if (item.endsWith('.md')) {
      const rel = relative(baseDir, fullPath);
      const parts = rel.replace(/\.md$/, '').split('/');
      const domain = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
      const name = parts[parts.length - 1];
      entries.push({
        key: rel.replace(/\.md$/, ''),
        domain,
        name,
        filePath: fullPath,
      });
    }
  }
}

/** Compute the spec key (domain/name) from a file path relative to specDir. */
export function specKeyFromPath(specDir: string, filePath: string): string {
  return relative(specDir, filePath).replace(/\.md$/, '');
}

/** Format relative time string for display. */
export function formatTimeAgo(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
