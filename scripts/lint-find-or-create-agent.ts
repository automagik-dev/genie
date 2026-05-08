#!/usr/bin/env bun
/**
 * CI lint rule — `findOrCreateAgent` ownership wireup guard.
 *
 * Wish agent-spawn-ownership-wireup Group 1, deliverable #5: every non-test
 * caller of `findOrCreateAgent` MUST pass an `opts` object containing a
 * `reportsTo` key, otherwise the spawn defaults `reports_to=NULL` and the
 * GENERATED `agents.kind` column infers `'permanent'` for an ephemeral
 * worker — exactly the bug this wish exists to fix.
 *
 * The guard scans every `*.ts` file under `src/` (excluding `*.test.ts`),
 * walks each `findOrCreateAgent(...)` call expression, and asserts the call
 * either:
 *   1. is the function definition itself (`export async function findOrCreateAgent(`)
 *   2. is the deps re-export (`findOrCreateAgent: registry.findOrCreateAgent`)
 *   3. references the symbol in a comment / string / error message (no `(`)
 *   4. is a real call site whose argument list contains `reportsTo`
 *
 * Anything else fails the lint with a pointer to this wish.
 *
 * Wired into `bun run check` via package.json (`lint:owner`).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

export type OwnerLintFinding = { path: string; line: number; snippet: string };

function walk(dir: string, visit: (absPath: string) => void): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
      walk(abs, visit);
    } else if (st.isFile()) {
      visit(abs);
    }
  }
}

function isCheckableFile(path: string): boolean {
  if (!/\.ts$/.test(path)) return false;
  if (/\.test\.ts$/.test(path)) return false;
  return true;
}

/**
 * Pull the full call expression starting at `start` (the index of the `(`
 * after the function name). Returns the substring up to and including the
 * matching `)`, or null if parens never balance (malformed input — skip).
 */
function readCallArgs(src: string, start: number): string | null {
  if (src[start] !== '(') return null;
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function checkFile(abs: string, rootForRelative: string, findings: OwnerLintFinding[]): void {
  const rel = relative(rootForRelative, abs);
  const src = readFileSync(abs, 'utf8');

  // Match every appearance of the bare token `findOrCreateAgent` followed by
  // `(`. We re-confirm context from the source itself so comments and
  // string-only mentions don't trip the guard.
  const re = /\bfindOrCreateAgent\s*\(/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iter
  while ((match = re.exec(src)) !== null) {
    const idx = match.index;
    const lineStart = src.lastIndexOf('\n', idx) + 1;
    const lineEnd = src.indexOf('\n', idx);
    const lineText = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    const lineNo = src.slice(0, idx).split('\n').length;

    // The function definition itself.
    if (/export\s+async\s+function\s+findOrCreateAgent\s*\(/.test(lineText)) continue;

    // Deps map / type re-exports — `foo: registry.findOrCreateAgent as typeof registry.findOrCreateAgent`.
    if (/findOrCreateAgent\s*:\s*registry\.findOrCreateAgent/.test(lineText)) continue;
    if (/typeof\s+registry\.findOrCreateAgent/.test(lineText)) continue;

    // Comments — `// findOrCreateAgent(...)` or `* findOrCreateAgent(...)`.
    const beforeMatch = src.slice(lineStart, idx);
    if (/^\s*(\/\/|\*)/.test(beforeMatch)) continue;

    // The actual call expression — read the arg list.
    const parenIdx = src.indexOf('(', idx + 'findOrCreateAgent'.length);
    if (parenIdx === -1) continue;
    const args = readCallArgs(src, parenIdx);
    if (args === null) continue;

    if (args.includes('reportsTo')) continue;

    findings.push({
      path: rel,
      line: lineNo,
      snippet: lineText.trim(),
    });
  }
}

/**
 * Run the guard against an arbitrary source root. Test fixtures call this
 * directly; the CLI invocation below points it at `<repo>/src`.
 */
export function lintFindOrCreateAgent(srcRoot: string, rootForRelative: string = srcRoot): OwnerLintFinding[] {
  const findings: OwnerLintFinding[] = [];
  walk(srcRoot, (abs) => {
    if (!isCheckableFile(abs)) return;
    checkFile(abs, rootForRelative, findings);
  });
  return findings;
}

if (import.meta.main) {
  const findings = lintFindOrCreateAgent(join(REPO_ROOT, 'src'), REPO_ROOT);
  if (findings.length > 0) {
    process.stderr.write(`\nfind-or-create-agent lint: ${findings.length} violation(s)\n\n`);
    for (const f of findings) {
      process.stderr.write(`  ${f.path}:${f.line}: ${f.snippet}\n`);
    }
    process.stderr.write(
      '\nEvery non-test caller of findOrCreateAgent must pass an opts object containing reportsTo.\n',
    );
    process.stderr.write('See wish agent-spawn-ownership-wireup Group 1.\n\n');
    process.exit(1);
  }
  process.stdout.write('find-or-create-agent lint: ok\n');
}
