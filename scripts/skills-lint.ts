#!/usr/bin/env bun
/**
 * skills-lint validates both the command surface and the shipped Codex skill
 * contract: strict SKILL.md frontmatter, matching agents/openai.yaml metadata,
 * skill-relative resources, and real `genie` / `omni` commands.
 *
 * Exit non-zero if any skill has missing commands.
 * Honors a `<!-- skills-lint:ignore -->` bailout marker to skip a file.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
// SKILLS_LINT_DIR lets tests point the scanner at a fixture tree; defaults to
// the repo's own skills/ directory.
const SKILLS_DIR = process.env.SKILLS_LINT_DIR ?? join(ROOT, 'skills');

// Resource-shipping allowlist: catalog/recipe content is allowed to show
// repo-root command recipes verbatim (they are illustrative, not runtime
// instructions). Matched by the first path segment under the scanned skills
// dir. The top-level README is contributor documentation and may name repo
// scripts; executable skill prose must address resources relative to the
// loaded SKILL.md, not a repo root or a host-specific environment variable.
const RESOURCE_ALLOWLIST_SEGMENTS = new Set(['genie-hacks']);

export function isResourceAllowlisted(file: string, skillsDir: string = SKILLS_DIR): boolean {
  const rel = relative(skillsDir, file);
  if (rel === 'README.md') return true;
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

export type ResourceRule =
  | 'cp-repo-template'
  | 'host-specific-skill-root'
  | 'unguarded-repo-lint'
  | 'repo-script-invocation';

export interface ResourceViolation {
  rule: ResourceRule;
  snippet: string;
}

export interface SkillMetadataValidation {
  name: string | null;
  violations: string[];
}

const ALLOWED_FRONTMATTER_KEYS = new Set(['name', 'description']);

/** Validate the portable SKILL.md + Codex UI metadata contract for one skill. */
export function validateSkillMetadata(skillDir: string): SkillMetadataValidation {
  const skillPath = join(skillDir, 'SKILL.md');
  const violations: string[] = [];
  if (!existsSync(skillPath)) return { name: null, violations: ['missing SKILL.md'] };

  const text = readFileSync(skillPath, 'utf8');
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return { name: null, violations: ['SKILL.md must start with YAML frontmatter'] };
  const end = lines.indexOf('---', 1);
  if (end < 0) return { name: null, violations: ['SKILL.md frontmatter is not closed'] };

  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') continue;
    const match = /^([a-z][a-z0-9_-]*):\s*(.+)$/.exec(line);
    if (!match) {
      violations.push(`unsupported frontmatter syntax: ${line.trim()}`);
      continue;
    }
    const [, key, value] = match;
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) violations.push(`unsupported frontmatter field: ${key}`);
    if (fields.has(key)) violations.push(`duplicate frontmatter field: ${key}`);
    fields.set(key, value.trim());
  }

  const name = fields.get('name')?.replace(/^['"]|['"]$/g, '') ?? null;
  const description = fields.get('description')?.replace(/^['"]|['"]$/g, '') ?? '';
  if (!name) violations.push('missing frontmatter field: name');
  if (!description) violations.push('missing frontmatter field: description');
  if (name && name !== basename(skillDir)) {
    violations.push(
      `frontmatter name ${JSON.stringify(name)} does not match directory ${JSON.stringify(basename(skillDir))}`,
    );
  }
  if (name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) violations.push(`invalid skill name: ${name}`);

  for (const token of ['CLAUDE_SKILL_DIR', 'CLAUDE_PLUGIN_ROOT', '$ARGUMENTS']) {
    if (text.includes(token)) violations.push(`host-specific skill construct is unsupported: ${token}`);
  }
  if (/^!`[^`]+`\s*$/m.test(text)) violations.push('host-specific bang-command injection is unsupported');

  const openaiPath = join(skillDir, 'agents', 'openai.yaml');
  if (!existsSync(openaiPath)) {
    violations.push('missing agents/openai.yaml');
    return { name, violations };
  }

  try {
    const parsed = Bun.YAML.parse(readFileSync(openaiPath, 'utf8')) as {
      interface?: Record<string, unknown>;
      policy?: Record<string, unknown>;
    };
    const ui = parsed?.interface;
    if (!ui || typeof ui !== 'object') {
      violations.push('agents/openai.yaml is missing interface metadata');
    } else {
      if (typeof ui.display_name !== 'string' || ui.display_name.trim() === '') {
        violations.push('agents/openai.yaml interface.display_name must be a non-empty string');
      }
      if (
        typeof ui.short_description !== 'string' ||
        ui.short_description.length < 25 ||
        ui.short_description.length > 64
      ) {
        violations.push('agents/openai.yaml interface.short_description must be 25-64 characters');
      }
      const prompt = ui.default_prompt;
      if (typeof prompt !== 'string' || prompt.trim() === '') {
        violations.push('agents/openai.yaml interface.default_prompt must be a non-empty string');
      } else if (/\$(?:[a-z0-9][a-z0-9-]*:)?[a-z0-9][a-z0-9-]*/i.test(prompt)) {
        violations.push(
          'agents/openai.yaml interface.default_prompt must be selector-free because metadata ships in multiple physical tiers',
        );
      }
    }
    if (parsed.policy !== undefined && typeof parsed.policy.allow_implicit_invocation !== 'boolean') {
      violations.push('agents/openai.yaml policy.allow_implicit_invocation must be boolean');
    }
  } catch (error) {
    violations.push(`agents/openai.yaml is invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { name, violations };
}

/**
 * Inspect a single line of command context (a fence line or an inline-code
 * span) for imperative resource-shipping violations. Skill-shipped files must
 * be resolved from the loaded SKILL.md directory; repo-only commands must be
 * guarded by a same-line package.json existence probe. Bare
 * descriptive path mentions in prose never reach here (only code context does)
 * and never match — every rule keys on an imperative verb.
 */
export function checkResourceLine(line: string): ResourceViolation[] {
  const violations: ResourceViolation[] = [];
  const snippet = line.trim();

  if (/\$\{?(?:CLAUDE_SKILL_DIR|CLAUDE_PLUGIN_ROOT)\}?/.test(line)) {
    violations.push({ rule: 'host-specific-skill-root', snippet });
  }

  // (a) Imperative repo-root template copy: `cp templates/...`. Portable skill
  // prose resolves the owning skill directory first, so a bare templates/
  // source is ambiguous and rejected.
  if (/\bcp\b(?:\s+-\S+)*\s+["']?(?:\.\/)?templates\//.test(line)) {
    violations.push({ rule: 'cp-repo-template', snippet });
  }

  // (b) Repo-only lint invocation without the SAME-LINE package.json guard.
  // The guard must be a package.json probe that short-circuits (`&&`) INTO the
  // command, e.g. `grep -q '"wishes:lint"' package.json 2>/dev/null && bun run
  // wishes:lint` or `test -f package.json && bun run skills:lint`. A bare
  // mention of package.json elsewhere on the line — a trailing comment, an echo
  // arg, or a reference AFTER the command — does not gate the run, so it must
  // NOT exempt it. A split-line guard (probe on the previous line) also fails:
  // the probe must sit on the same line, ahead of the command it protects.
  const lintMatch = /\bbun run (?:wishes|skills):lint\b/.exec(line);
  if (lintMatch) {
    const guard = line.slice(0, lintMatch.index);
    const guarded = /\bpackage\.json\b[^&|;]*&&/.test(guard);
    if (!guarded) violations.push({ rule: 'unguarded-repo-lint', snippet });
  }

  // (c) Imperative execution of a repo-root script — scripts/*.ts is repo-only.
  // A descriptive `scripts/foo.ts` mention (no run verb) does not match.
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
  metadataViolations: string[];
}

function main() {
  const genieCmds = getGenieCommands();

  if (genieCmds.size === 0) {
    console.error('skills-lint: failed to load `genie --help` output');
    process.exit(2);
  }

  const files = walk(SKILLS_DIR);
  const reports: Report[] = [];
  const metadataBySkill = new Map<string, string[]>();
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(SKILLS_DIR, entry.name, 'SKILL.md'))) continue;
    metadataBySkill.set(entry.name, validateSkillMetadata(join(SKILLS_DIR, entry.name)).violations);
  }

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
    // Catalog/recipe content and the contributor-facing top-level README may
    // show repo-root commands; executable skill instructions must ship their
    // own resources.
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
    const topLevelSkill = relative(SKILLS_DIR, file).split(sep)[0];
    const metadataViolations = file.endsWith(`${sep}SKILL.md`) ? (metadataBySkill.get(topLevelSkill) ?? []) : [];
    reports.push({
      skill: relative(ROOT, file),
      missingCommands: missing,
      resourceViolations: resource,
      metadataViolations,
    });
  }

  const missingFailed = reports.filter((r) => r.missingCommands.length > 0);
  const resourceFailed = reports.filter((r) => r.resourceViolations.length > 0);
  const metadataFailed = reports.filter((r) => r.metadataViolations.length > 0);
  console.log(JSON.stringify(reports, null, 2));

  if (missingFailed.length > 0 || resourceFailed.length > 0 || metadataFailed.length > 0) {
    if (missingFailed.length > 0) {
      console.error(`\nskills-lint: ${missingFailed.length} skill(s) reference missing commands`);
    }
    if (resourceFailed.length > 0) {
      console.error(`\nskills-lint: ${resourceFailed.length} skill(s) reference repo-only resources`);
      console.error('skills-lint: resolve skill-shipped paths from the loaded SKILL.md directory');
      for (const r of resourceFailed) {
        for (const v of r.resourceViolations) {
          console.error(`  ${r.skill}: [${v.rule}] ${v.snippet}`);
        }
      }
    }
    if (metadataFailed.length > 0) {
      console.error(`\nskills-lint: ${metadataFailed.length} skill(s) have invalid Codex metadata`);
      for (const r of metadataFailed) {
        for (const violation of r.metadataViolations) console.error(`  ${r.skill}: ${violation}`);
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
