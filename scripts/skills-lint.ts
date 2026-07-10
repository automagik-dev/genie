#!/usr/bin/env bun
/**
 * skills-lint: validate that every `genie <cmd>` / `omni <cmd>` invocation
 * inside a bash/sh code fence in any SKILL.md (or nested prompt .md)
 * corresponds to a real subcommand in the current CLI surface.
 *
 * Exit non-zero if any skill has missing commands.
 * Honors a `<!-- skills-lint:ignore -->` bailout marker to skip a file.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
// SKILLS_LINT_DIR lets tests point the scanner at a fixture tree; defaults to
// the repo's own skills/ directory.
const SKILLS_DIR = process.env.SKILLS_LINT_DIR ?? join(ROOT, 'skills');

// Resource-shipping allowlist: catalog/recipe content is allowed to show
// repo-root command recipes verbatim (they are illustrative, not runtime
// instructions). Matched by the first path segment under the scanned skills
// dir. skills/README.md is intentionally NOT allowlisted — real skill prose
// must ship its own resources via ${CLAUDE_SKILL_DIR}/${CLAUDE_PLUGIN_ROOT}.
const RESOURCE_ALLOWLIST_SEGMENTS = new Set(['genie-hacks']);

export function isResourceAllowlisted(file: string, skillsDir: string = SKILLS_DIR): boolean {
  const rel = relative(skillsDir, file);
  const first = rel.split(sep)[0];
  return RESOURCE_ALLOWLIST_SEGMENTS.has(first);
}

function collectSubcommands(helpText: string): Set<string> {
  const cmds = new Set<string>();
  const lines = helpText.split('\n');
  let inCommands = false;
  for (const line of lines) {
    if (/^Commands:/.test(line)) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    // Match "  name [options] ..." or "  name   description"
    const m = line.match(/^\s{2,}([a-z][a-z0-9:_-]*)\b/);
    if (m) cmds.add(m[1]);
  }
  return cmds;
}

function getGenieCommands(): Set<string> {
  // Validate against the repo's own freshly-built binary when present, not
  // whatever `genie` happens to be on PATH — a stale global install can lag
  // the source (e.g. missing the `v5` namespace) and produce false failures.
  // Run `bun run build` before linting so `dist/genie.js` reflects source.
  //
  // LIMITATION: only the FIRST token after `genie` is validated. `genie v5 task`
  // resolves to `v5`, so bogus subcommands under a valid namespace (e.g.
  // `genie v5 bogus-verb`) pass this lint. Command honesty below the namespace
  // level must be verified in review, not assumed from a green lint.
  const distBin = join(ROOT, 'dist', 'genie.js');
  const cmd = existsSync(distBin) ? `bun ${distBin} --help` : 'genie --help';
  const out = execSync(cmd, { encoding: 'utf8' });
  return collectSubcommands(out);
}

/**
 * Probe the omni CLI surface. Contract: a missing/broken omni binary is NOT a
 * lint failure by default — CI runners don't ship omni, so the probe degrades
 * to a loud stderr warning and returns null, and the caller skips ONLY the
 * omni-invocation checks (genie-command validation stays fully strict). Set
 * SKILLS_LINT_REQUIRE_OMNI=1 to restore the hard failure (exit 2) where omni
 * checks must be enforced. The old "never silently swallow" intent survives
 * as the warning + env knob — a skip is always visible in the output.
 */
function getOmniCommands(): Set<string> | null {
  let out: string;
  try {
    out = execSync('omni --help --all 2>/dev/null || omni --help', { encoding: 'utf8' });
  } catch (err) {
    if (process.env.SKILLS_LINT_REQUIRE_OMNI === '1') {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[skills-lint] failed to probe \`omni --help\`: ${detail}`);
      console.error('[skills-lint] install the omni CLI or unset skills linting before running.');
      process.exit(2);
    }
    console.error(
      '[skills-lint] omni CLI not found — skipping omni-invocation validation (set SKILLS_LINT_REQUIRE_OMNI=1 to enforce)',
    );
    return null;
  }
  // omni uses section headers (Core:, Management:, System:); strip them.
  const cmds = new Set<string>();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s{4,}([a-z][a-z0-9:_-]*)\s{2,}/);
    if (m) cmds.add(m[1]);
  }
  return cmds;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.md')) out.push(p);
  }
  return out;
}

function extractBashFences(text: string): string[] {
  const fences: string[] = [];
  const re = /```(?:bash|sh)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    fences.push(m[1]);
    m = re.exec(text);
  }
  return fences;
}

function extractInvocations(fence: string, tool: 'genie' | 'omni'): string[] {
  const hits: string[] = [];
  // Match start of a command: "genie cmd" or "$ genie cmd" or "| genie cmd"
  const re = new RegExp(`(?:^|[;&|\\n\`$(])\\s*${tool}\\s+([a-z][a-z0-9:_-]*)`, 'g');
  let m: RegExpExecArray | null = re.exec(fence);
  while (m !== null) {
    hits.push(m[1]);
    m = re.exec(fence);
  }
  return hits;
}

/** Extract inline-code spans (single-line backtick spans) from markdown. */
export function extractInlineCodeSpans(text: string): string[] {
  const spans: string[] = [];
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    spans.push(m[1]);
    m = re.exec(text);
  }
  return spans;
}

export type ResourceRule = 'cp-repo-template' | 'unguarded-repo-lint' | 'repo-script-invocation';

export interface ResourceViolation {
  rule: ResourceRule;
  snippet: string;
}

/**
 * Inspect a single line of command context (a fence line or an inline-code
 * span) for imperative resource-shipping violations. Skill-shipped files MUST
 * be addressed via ${CLAUDE_SKILL_DIR}/${CLAUDE_PLUGIN_ROOT}; repo-only
 * commands MUST be guarded by a same-line package.json existence probe. Bare
 * descriptive path mentions in prose never reach here (only code context does)
 * and never match — every rule keys on an imperative verb.
 */
export function checkResourceLine(line: string): ResourceViolation[] {
  const violations: ResourceViolation[] = [];
  const snippet = line.trim();

  // (a) Imperative repo-root template copy: `cp templates/...`. The shipped
  // form is `cp "${CLAUDE_SKILL_DIR}/templates/..."`, whose source token is
  // NOT a bare `templates/`, so it is not matched.
  if (/\bcp\b(?:\s+-\S+)*\s+["']?(?:\.\/)?templates\//.test(line)) {
    violations.push({ rule: 'cp-repo-template', snippet });
  }

  // (b) Repo-only lint invocation without the SAME-LINE package.json guard.
  // A split-line guard (probe on the previous line) does not count — the probe
  // must sit on the same line as the command it protects.
  if (/\bbun run (?:wishes|skills):lint\b/.test(line) && !line.includes('package.json')) {
    violations.push({ rule: 'unguarded-repo-lint', snippet });
  }

  // (c) Imperative execution of a repo-root script — scripts/*.ts is repo-only.
  // Runtime instructions must address skill-shipped scripts via
  // ${CLAUDE_SKILL_DIR}. A descriptive `scripts/foo.ts` mention (no run verb)
  // does not match.
  if (/(?:\bbun run |\bbun |\bnode |\.\/|\bsh |\bbash )scripts\/[A-Za-z0-9_./-]+\.ts\b/.test(line)) {
    violations.push({ rule: 'repo-script-invocation', snippet });
  }

  return violations;
}

/**
 * Collect resource-shipping violations across a skill's command surface:
 * every bash/sh fence line AND every inline-code span. Prose outside code
 * context is never scanned, so descriptive path mentions cannot trip the rule.
 */
export function collectResourceViolations(text: string): ResourceViolation[] {
  const lines: string[] = [];
  for (const fence of extractBashFences(text)) {
    lines.push(...fence.split('\n'));
  }
  lines.push(...extractInlineCodeSpans(text));
  const violations: ResourceViolation[] = [];
  for (const line of lines) {
    violations.push(...checkResourceLine(line));
  }
  return violations;
}

interface Report {
  skill: string;
  missingCommands: Array<{ tool: string; command: string }>;
  resourceViolations: ResourceViolation[];
}

function main() {
  const genieCmds = getGenieCommands();

  if (genieCmds.size === 0) {
    console.error('skills-lint: failed to load `genie --help` output');
    process.exit(2);
  }

  const files = walk(SKILLS_DIR);
  const reports: Report[] = [];

  // First pass: collect all invocations from non-ignored skills. The omni CLI
  // is only probed when some scanned skill actually references it; when the
  // probe fails, getOmniCommands() returns null and omni checks are skipped
  // (loudly) instead of failing the gate — see its contract comment.
  const scanned: Array<{ file: string; genie: string[]; omni: string[]; resource: ResourceViolation[] }> = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (text.includes('<!-- skills-lint:ignore -->')) continue;
    const genie: string[] = [];
    const omni: string[] = [];
    for (const fence of extractBashFences(text)) {
      genie.push(...extractInvocations(fence, 'genie'));
      omni.push(...extractInvocations(fence, 'omni'));
    }
    // Catalog/recipe content (genie-hacks) is allowed to show repo-root
    // recipes verbatim; every other skill must ship its own resources.
    const resource = isResourceAllowlisted(file) ? [] : collectResourceViolations(text);
    scanned.push({ file, genie, omni, resource });
  }

  const omniNeeded = scanned.some((s) => s.omni.length > 0);
  const omniCmds = omniNeeded ? getOmniCommands() : new Set<string>();
  const omniSkipped = omniCmds === null;

  for (const { file, genie, omni, resource } of scanned) {
    const missing: Report['missingCommands'] = [];
    for (const cmd of genie) {
      if (!genieCmds.has(cmd)) missing.push({ tool: 'genie', command: cmd });
    }
    if (omniCmds !== null && omniCmds.size > 0) {
      for (const cmd of omni) {
        if (!omniCmds.has(cmd)) missing.push({ tool: 'omni', command: cmd });
      }
    }
    reports.push({ skill: relative(ROOT, file), missingCommands: missing, resourceViolations: resource });
  }

  const missingFailed = reports.filter((r) => r.missingCommands.length > 0);
  const resourceFailed = reports.filter((r) => r.resourceViolations.length > 0);
  console.log(JSON.stringify(reports, null, 2));

  if (missingFailed.length > 0 || resourceFailed.length > 0) {
    if (missingFailed.length > 0) {
      console.error(`\nskills-lint: ${missingFailed.length} skill(s) reference missing commands`);
    }
    if (resourceFailed.length > 0) {
      console.error(`\nskills-lint: ${resourceFailed.length} skill(s) reference repo-only resources`);
      console.error('skills-lint: skill-shipped paths must use ${CLAUDE_SKILL_DIR}/${CLAUDE_PLUGIN_ROOT}');
      for (const r of resourceFailed) {
        for (const v of r.resourceViolations) {
          console.error(`  ${r.skill}: [${v.rule}] ${v.snippet}`);
        }
      }
    }
    process.exit(1);
  }
  const omniNote = omniSkipped ? ', omni checks skipped' : '';
  console.error(`skills-lint: OK (${reports.length} files scanned, 0 missing, 0 resource violations${omniNote})`);
}

// Only run the linter when executed directly, not when imported by tests.
if (import.meta.main) {
  main();
}
