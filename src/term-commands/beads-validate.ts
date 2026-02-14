/**
 * beads-validate command
 *
 * Scriptable validation for .beads/issues.jsonl existence + JSONL parse.
 * Minimal by design.
 */

import { readFile } from 'fs/promises';
import { join, resolve } from 'path';

export interface BeadsValidateOptions {
  repo?: string;
  json?: boolean;
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
      process.exit(1);
    }
    console.error(msg);
    process.exit(1);
  }

  const errors: Array<{ line: number; error: string }> = [];
  let count = 0;
  const ids = new Set<string>();

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      count++;
      if (obj?.id) {
        if (ids.has(obj.id)) {
          errors.push({ line: i + 1, error: `duplicate id: ${obj.id}` });
        }
        ids.add(obj.id);
      } else {
        errors.push({ line: i + 1, error: 'missing id' });
      }
    } catch (e: any) {
      errors.push({ line: i + 1, error: e?.message || 'invalid json' });
    }
  }

  const ok = errors.length === 0;

  if (options.json) {
    console.log(JSON.stringify({ ok, issuesPath, count, errors }, null, 2));
  } else {
    if (ok) {
      console.log(`✅ Beads issues.jsonl valid (${count} records) at ${issuesPath}`);
    } else {
      console.error(`❌ Beads issues.jsonl invalid at ${issuesPath}`);
      for (const e of errors.slice(0, 20)) {
        console.error(`   line ${e.line}: ${e.error}`);
      }
      if (errors.length > 20) {
        console.error(`   ...and ${errors.length - 20} more`);
      }
    }
  }

  if (!ok) process.exit(1);
}
