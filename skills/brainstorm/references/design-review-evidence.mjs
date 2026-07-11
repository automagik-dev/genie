#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function stampDesignReview(source, { verdict, reviewer, reviewedAt = new Date().toISOString() }) {
  reviewableDesign(source);
  if (!DESIGN_REVIEW_VERDICTS.has(verdict)) throw new Error(`unsupported design-review verdict: ${verdict}`);
  if (typeof reviewer !== 'string' || reviewer.trim() === '' || /[\r\n]/.test(reviewer)) {
    throw new Error('reviewer must be a non-empty single-line identifier');
  }
  if (Number.isNaN(Date.parse(reviewedAt)) || !reviewedAt.endsWith('Z')) {
    throw new Error('reviewed-at must be an ISO-8601 UTC instant');
  }
  const digest = designReviewDigest(source);
  const block = [
    DESIGN_REVIEW_START,
    '## Design Review Evidence',
    '',
    `- **Verdict:** ${verdict}`,
    `- **Reviewed content SHA-256:** \`${digest}\``,
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
      'usage: design-review-evidence.mjs digest|verify <DESIGN.md> | stamp <DESIGN.md> --verdict <verdict> --reviewer <id> [--reviewed-at <ISO>]',
    );
  }
  const source = readFileSync(designPath, 'utf8');
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
    reviewer: option(args, '--reviewer'),
    reviewedAt: option(args, '--reviewed-at'),
  });
  writeFileSync(designPath, stamped);
  process.stdout.write(`${designReviewDigest(stamped)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runDesignReviewEvidenceCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
