#!/usr/bin/env node

// SHIPPED TWICE, BYTE-IDENTICALLY: `brainstorm/references/` creates the
// evidence block and `wish/references/` verifies it, and skills.sh supports
// installing ONE skill (`--skill wish`), so neither copy may reach outside its
// own skill directory. The wish copy used to be a shim re-exporting this file
// through `../../brainstorm/...`, which died with ERR_MODULE_NOT_FOUND on any
// subset install — the wish design gate could not run at all rather than
// refusing cleanly. `scripts/design-review-evidence.test.ts` pins the two
// copies byte-for-byte, so edit this file and copy it over the other.

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A refusal the design gate itself understands: one line in skill vocabulary,
 * exit 1. Anything else (a bug in this helper) keeps exit 2, so an operator can
 * tell "the gate refuses" from "the gate could not run".
 */
export class DesignEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DesignEvidenceError';
  }
}

// Raw libuv text ("ENOENT: no such file or directory, open '<path>'", and worse
// "EISDIR: illegal operation on a directory, read" which names no path at all)
// is not a diagnostic a design gate may emit: every failure names the path and
// what was expected.
const READ_FAILURES = {
  ENOENT: (path) => `DESIGN.md not found at ${path}; create the design first, or pass the path to an existing one`,
  EISDIR: (path) => `DESIGN.md path is a directory, not a file: ${path}; pass the DESIGN.md inside it`,
  ENOTDIR: (path) => `DESIGN.md path is unreachable (a parent is not a directory): ${path}`,
  ELOOP: (path) => `DESIGN.md path is a symbolic-link loop: ${path}`,
  EACCES: (path) => `DESIGN.md is not readable (permission denied): ${path}`,
  EPERM: (path) => `DESIGN.md is not readable (operation not permitted): ${path}`,
};

const WRITE_FAILURES = {
  EISDIR: (path) => `stamped DESIGN.md cannot be written: the path is a directory: ${path}`,
  ENOENT: (path) => `stamped DESIGN.md cannot be written: ${path} disappeared while stamping`,
  EACCES: (path) => `stamped DESIGN.md is not writable (permission denied): ${path}`,
  EPERM: (path) => `stamped DESIGN.md is not writable (operation not permitted): ${path}`,
  EROFS: (path) => `stamped DESIGN.md is not writable (read-only file system): ${path}`,
  ENOSPC: (path) => `stamped DESIGN.md could not be written (no space left on device): ${path}`,
};

function fileFailure(action, path, error) {
  const describe = (action === 'read' ? READ_FAILURES : WRITE_FAILURES)[error?.code];
  if (describe) return new DesignEvidenceError(describe(path));
  const reason = error?.code ?? (error instanceof Error ? error.message : String(error));
  return new DesignEvidenceError(`could not ${action} DESIGN.md at ${path}: ${String(reason).split('\n')[0]}`);
}

export function readDesign(designPath) {
  try {
    return readFileSync(designPath, 'utf8');
  } catch (error) {
    throw fileFailure('read', designPath, error);
  }
}

export function writeDesign(designPath, contents) {
  try {
    writeFileSync(designPath, contents);
  } catch (error) {
    throw fileFailure('write', designPath, error);
  }
}

export const DESIGN_REVIEW_START = '<!-- genie-design-review:start -->';
export const DESIGN_REVIEW_END = '<!-- genie-design-review:end -->';
export const DESIGN_REVIEW_VERDICTS = new Set(['SHIP', 'FIX-FIRST', 'BLOCKED']);

function occurrences(source, token) {
  return source.split(token).length - 1;
}

/** Exact UTF-8 review subject: DESIGN.md with its one evidence block removed. */
export function reviewableDesign(source) {
  if (occurrences(source, DESIGN_REVIEW_START) !== 1 || occurrences(source, DESIGN_REVIEW_END) !== 1) {
    throw new Error('DESIGN.md must contain exactly one bounded design-review evidence block');
  }
  const start = source.indexOf(DESIGN_REVIEW_START);
  const endMarker = source.indexOf(DESIGN_REVIEW_END, start);
  if (endMarker < start) throw new Error('design-review evidence markers are out of order');
  let end = endMarker + DESIGN_REVIEW_END.length;
  if (source.slice(end, end + 2) === '\r\n') end += 2;
  else if (source[end] === '\n') end += 1;
  return `${source.slice(0, start)}${source.slice(end)}`;
}

export function designReviewDigest(source) {
  return createHash('sha256').update(reviewableDesign(source), 'utf8').digest('hex');
}

function evidenceBlock(source) {
  const start = source.indexOf(DESIGN_REVIEW_START);
  const end = source.indexOf(DESIGN_REVIEW_END, start);
  if (start < 0 || end < 0) return '';
  return source.slice(start, end + DESIGN_REVIEW_END.length);
}

function field(block, name) {
  const match = block.match(new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.+?)\\s*$`, 'm'));
  return match?.[1]?.replace(/^`|`$/g, '').trim();
}

export function parseDesignReviewEvidence(source) {
  // Validate marker cardinality/order before extracting fields.
  reviewableDesign(source);
  const block = evidenceBlock(source);
  return {
    verdict: field(block, 'Verdict'),
    digest: field(block, 'Reviewed content SHA-256'),
    reviewer: field(block, 'Reviewer'),
    reviewedAt: field(block, 'Reviewed at'),
  };
}

export function designReviewViolations(source) {
  let evidence;
  let digest;
  try {
    evidence = parseDesignReviewEvidence(source);
    digest = designReviewDigest(source);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const violations = [];
  if (evidence.verdict !== 'SHIP') violations.push('design review verdict must be SHIP');
  if (!evidence.digest || !/^[a-f0-9]{64}$/.test(evidence.digest)) {
    violations.push('reviewed content SHA-256 must be 64 lowercase hex characters');
  } else if (evidence.digest !== digest) {
    violations.push('design changed after review; reviewed content SHA-256 no longer matches');
  }
  if (!evidence.reviewer || evidence.reviewer === 'PENDING')
    violations.push('design review must identify the reviewer');
  if (
    !evidence.reviewedAt ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(evidence.reviewedAt) ||
    Number.isNaN(Date.parse(evidence.reviewedAt))
  ) {
    violations.push('design review timestamp must be an ISO-8601 UTC instant');
  }
  return violations;
}

export function stampDesignReview(
  source,
  { verdict, reviewedSha256, reviewer, reviewedAt = new Date().toISOString() },
) {
  reviewableDesign(source);
  if (!DESIGN_REVIEW_VERDICTS.has(verdict)) throw new Error(`unsupported design-review verdict: ${verdict}`);
  if (typeof reviewedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reviewedSha256)) {
    throw new Error('reviewed content SHA-256 must be 64 lowercase hex characters');
  }
  if (typeof reviewer !== 'string' || reviewer.trim() === '' || /[\r\n]/.test(reviewer)) {
    throw new Error('reviewer must be a non-empty single-line identifier');
  }
  if (Number.isNaN(Date.parse(reviewedAt)) || !reviewedAt.endsWith('Z')) {
    throw new Error('reviewed-at must be an ISO-8601 UTC instant');
  }
  const digest = designReviewDigest(source);
  if (reviewedSha256 !== digest) {
    throw new Error('design changed after review; reviewed content SHA-256 no longer matches');
  }
  const block = [
    DESIGN_REVIEW_START,
    '## Design Review Evidence',
    '',
    `- **Verdict:** ${verdict}`,
    `- **Reviewed content SHA-256:** \`${reviewedSha256}\``,
    `- **Reviewer:** ${reviewer.trim()}`,
    `- **Reviewed at:** ${new Date(reviewedAt).toISOString()}`,
    DESIGN_REVIEW_END,
  ].join('\n');
  const start = source.indexOf(DESIGN_REVIEW_START);
  const end = source.indexOf(DESIGN_REVIEW_END, start) + DESIGN_REVIEW_END.length;
  return source.slice(0, start) + block + source.slice(end);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function runDesignReviewEvidenceCli() {
  const [command, designPath, ...args] = process.argv.slice(2);
  if (!designPath || !['digest', 'verify', 'stamp'].includes(command)) {
    throw new Error(
      'usage: design-review-evidence.mjs digest|verify <DESIGN.md> | stamp <DESIGN.md> --verdict <verdict> --reviewed-sha256 <sha256> --reviewer <id> [--reviewed-at <ISO>]',
    );
  }
  const source = readDesign(designPath);
  if (command === 'digest') {
    process.stdout.write(`${designReviewDigest(source)}\n`);
    return;
  }
  if (command === 'verify') {
    const violations = designReviewViolations(source);
    if (violations.length > 0) {
      for (const violation of violations) process.stderr.write(`${violation}\n`);
      process.exitCode = 1;
    }
    return;
  }
  const stamped = stampDesignReview(source, {
    verdict: option(args, '--verdict'),
    reviewedSha256: option(args, '--reviewed-sha256'),
    reviewer: option(args, '--reviewer'),
    reviewedAt: option(args, '--reviewed-at'),
  });
  writeDesign(designPath, stamped);
  process.stdout.write(`${designReviewDigest(stamped)}\n`);
}

function resolvedEntryPath(argvPath) {
  const resolved = resolve(argvPath);
  try {
    return realpathSync(resolved);
  } catch {
    // argv[1] need not exist on disk; fall back to the plain resolved path.
    return resolved;
  }
}

// Compare REAL paths on BOTH sides: reached through a symlinked path the two
// spellings disagree, the CLI body silently never runs, and `verify` exits 0
// having checked nothing (the gate fails open).
if (process.argv[1] && resolvedEntryPath(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    runDesignReviewEvidenceCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    // A gate refusal is exit 1 (the caller's design is not ready); exit 2 stays
    // reserved for a helper that could not run at all (usage, internal error).
    process.exitCode = error instanceof DesignEvidenceError ? 1 : 2;
  }
}
