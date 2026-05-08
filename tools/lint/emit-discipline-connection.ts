#!/usr/bin/env bun
/**
 * Emit-discipline lint — connection / bootstrap modules.
 *
 * Wish G9 follow-up: prevents new informational `process.stderr.write` and
 * `console.error` calls from creeping into connection / bootstrap modules
 * without an explicit exemption comment.
 *
 * The earlier `[pgserve] connected to <db>` line landed on stderr by default
 * and made `genie ls --json 2>&1 | head` noisy on every CLI invocation. The
 * gate at `src/lib/db.ts:maybePrintBanner` now hides it behind `DEBUG=pgserve`.
 * Without this guard, the next informational line added to a connection
 * module would silently re-introduce the same noise.
 *
 * Rule:
 *   - Listed connection / bootstrap modules MUST NOT contain
 *     `process.stderr.write(...)` or `console.error(...)` calls unless the
 *     same line carries an explicit exemption marker:
 *
 *       // emit-discipline: ok — <reason>
 *
 *     The marker may sit on the same line OR the line immediately before
 *     the offending call (so it can be placed on the comment line above
 *     a multi-line emit block).
 *
 * Real warnings / errors stay default-on by tagging them with the marker.
 *
 * Wired into `bun run check:fast` via `scripts/lint-emit-discipline.ts`,
 * which delegates to this module so the existing CI gate still owns the
 * single failure surface.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

/**
 * Connection / bootstrap modules — anything that opens a DB pool, supervises
 * pgserve, runs migrations, or seeds at startup. Adding a new file here is
 * intentional: every new entry should be paired with an audit of its existing
 * informational stderr writes.
 */
const CONNECTION_MODULES: ReadonlyArray<string> = [
  'src/lib/db.ts',
  // Future entries land alongside their audit; keep this list short and
  // explicit so the gate is easy to reason about.
];

const EMIT_RE = /\b(?:process\.stderr\.write|console\.error)\s*\(/;
const EXEMPTION_RE = /\/\/\s*emit-discipline:\s*ok\b/;

export interface ConnectionFinding {
  path: string;
  line: number;
  message: string;
}

export function checkConnectionEmitDiscipline(repoRoot: string = REPO_ROOT): ConnectionFinding[] {
  const findings: ConnectionFinding[] = [];

  for (const rel of CONNECTION_MODULES) {
    const abs = join(repoRoot, rel);
    let exists = true;
    try {
      statSync(abs);
    } catch {
      exists = false;
    }
    if (!exists) continue;

    const src = readFileSync(abs, 'utf8');
    const lines = src.split('\n');

    lines.forEach((line, idx) => {
      if (!EMIT_RE.test(line)) return;
      if (EXEMPTION_RE.test(line)) return;
      const prev = idx > 0 ? lines[idx - 1] : '';
      if (EXEMPTION_RE.test(prev)) return;
      findings.push({
        path: relative(repoRoot, abs),
        line: idx + 1,
        message:
          'informational stderr emit in connection/bootstrap module without exemption — ' +
          'gate behind a debug flag (e.g. process.env.DEBUG?.includes(...)) or annotate ' +
          'with `// emit-discipline: ok — <reason>` if the call is a real warning/error.',
      });
    });
  }

  return findings;
}

// Allow direct execution: `bun tools/lint/emit-discipline-connection.ts`.
// When imported by scripts/lint-emit-discipline.ts the entry-point guard
// suppresses the auto-run so the parent CI script owns the exit code.
const isMain = (() => {
  try {
    return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const findings = checkConnectionEmitDiscipline();
  if (findings.length > 0) {
    process.stderr.write(`\nemit-discipline (connection): ${findings.length} violation(s)\n\n`);
    for (const f of findings) {
      process.stderr.write(`  ${f.path}:${f.line}: ${f.message}\n`);
    }
    process.stderr.write('\n');
    process.exit(1);
  }
  process.stdout.write('emit-discipline (connection): ok\n');
}
