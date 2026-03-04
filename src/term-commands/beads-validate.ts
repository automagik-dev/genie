/**
 * beads-validate command
 *
 * Scriptable validation for .beads/issues.jsonl existence + JSONL parse.
 * Minimal by design.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface BeadsValidateOptions {
  repo?: string;
  json?: boolean;
}

function validateJsonlLine(
  line: string,
  lineNum: number,
  ids: Set<string>,
  errors: Array<{ line: number; error: string }>,
): boolean {
  if (!line.trim()) return false;
  try {
    const obj = JSON.parse(line);
    if (!obj?.id) {
      errors.push({ line: lineNum, error: 'missing id' });
    } else if (ids.has(obj.id)) {
      errors.push({ line: lineNum, error: `duplicate id: ${obj.id}` });
    } else {
      ids.add(obj.id);
    }
    return true;
  } catch (e) {
    errors.push({ line: lineNum, error: e instanceof Error ? e.message : 'invalid json' });
    return true;
  }
}

function printValidationResult(
  ok: boolean,
  issuesPath: string,
  count: number,
  errors: Array<{ line: number; error: string }>,
): void {
  if (ok) {
    console.log(`✅ Beads issues.jsonl valid (${count} records) at ${issuesPath}`);
    return;
  }
  console.error(`❌ Beads issues.jsonl invalid at ${issuesPath}`);
  for (const e of errors.slice(0, 20)) {
    console.error(`   line ${e.line}: ${e.error}`);
  }
  if (errors.length > 20) {
    console.error(`   ...and ${errors.length - 20} more`);
  }
}

export async function beadsValidateCommand(options: BeadsValidateOptions = {}): Promise<void> {
  const repoPath = resolve(options.repo || process.cwd());
  const issuesPath = join(repoPath, '.beads', 'issues.jsonl');

  let content: string;
  try {
    content = await readFile(issuesPath, 'utf-8');
  } catch {
    const msg = `❌ Missing: ${issuesPath}`;
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: msg, issuesPath }, null, 2));
    } else {
      console.error(msg);
    }
    process.exit(1);
  }

  const errors: Array<{ line: number; error: string }> = [];
  const ids = new Set<string>();
  let count = 0;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (validateJsonlLine(lines[i], i + 1, ids, errors)) count++;
  }

  const ok = errors.length === 0;

  if (options.json) {
    console.log(JSON.stringify({ ok, issuesPath, count, errors }, null, 2));
  } else {
    printValidationResult(ok, issuesPath, count, errors);
  }

  if (!ok) process.exit(1);
}
