#!/usr/bin/env bun
/**
 * skills-lint validates both the command surface and the shipped Codex skill
 * contract: strict SKILL.md frontmatter, matching agents/openai.yaml metadata,
 * skill-relative resources, real `genie` commands, the retired-role
 * vocabulary ban, the 40–90 line house size, the hazard/residue ban, the
 * skills.sh directory shape, and the two skill-intake guards (house size, and
 * no undelivered candidate staged under `<GENIE_HOME>/skills`).
 *
 * Frontmatter carries two OPTIONAL closed-enum keys beyond name/description:
 * `category` (the catalog taxonomy) and `mutates`. `mutates` is ADVISORY
 * metadata — it states the widest blast radius a skill's body claims, and NO
 * code path anywhere gates on it. Its one enforcement is below: a
 * `mutates: none` skill whose ``` fences carry repo-write commands fails, so
 * the label is earned rather than asserted.
 *
 * Exit non-zero if any skill has missing commands.
 * Honors a `<!-- skills-lint:ignore -->` bailout marker to skip a file's
 * command/resource checks — the vocabulary scan below is deliberately NOT
 * skippable (see BANNED_TOKEN_GUIDANCE).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import {
  SKILL_CATEGORIES,
  SKILL_MUTATES_LEVELS,
  checkSkillCatalogDrift,
  parseSkillFrontmatter,
  scanRepoSkills,
} from './skills-inventory-parity.ts';

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

/**
 * BANNED-15 — the retired role/runtime vocabulary, matched as PLAIN SUBSTRINGS
 * (`String.includes`; no regex, no word boundaries, no "used as an agent name"
 * judgement call) in EVERY file under the scanned skills dir, `.md` and
 * non-`.md` alike: `agents/openai.yaml` starter prompts are shipped skill
 * content an agent reads and acts on.
 *
 * Two properties are deliberate and must not be relaxed:
 *   - There is NO allowlist. `RESOURCE_ALLOWLIST_SEGMENTS` and the README
 *     exemption are scoped to the resource-path rule only: a hack recipe naming
 *     a deleted agent profile misleads exactly as much as an executable skill
 *     does, because a recipe is copied, not read.
 *   - The scan runs BEFORE the `<!-- skills-lint:ignore -->` bailout, so an
 *     ignore marker added for a command fence cannot silently disable the
 *     vocabulary contract for that file.
 *
 * Each entry carries the replacement the offending file must adopt, so the
 * failure names the fix and not just the sin.
 */
export const BANNED_TOKEN_GUIDANCE: ReadonlyArray<readonly [token: string, guidance: string]> = [
  [
    'genie_engineer_trivial',
    'name the portable role `implementor-low`, not the runtime profile `genie_engineer_trivial`',
  ],
  [
    'genie_engineer_standard',
    'name the portable role `implementor-mid`, not the runtime profile `genie_engineer_standard`',
  ],
  [
    'genie_engineer_complex',
    'name the portable role `implementor-high`, not the runtime profile `genie_engineer_complex`',
  ],
  ['genie_reviewer', 'name the portable role `reviewer`, not the runtime profile `genie_reviewer`'],
  ['genie_fixer', 'name the portable role `fixer`, not the runtime profile `genie_fixer`'],
  ['genie_final_gate', 'name the portable role `final-gate`, not the runtime profile `genie_final_gate`'],
  ['genie_scout', 'name the portable role `scout`, not the runtime profile `genie_scout`'],
  ['engineer-trivial', 'name the portable role `implementor-low`, not the retired tier `engineer-trivial`'],
  ['engineer-standard', 'name the portable role `implementor-mid`, not the retired tier `engineer-standard`'],
  ['engineer-complex', 'name the portable role `implementor-high`, not the retired tier `engineer-complex`'],
  [
    '$genie:',
    'describe invocation as skills.sh discovery (`$wish`, `$work`, a bare name, or natural language), not a `$genie:` plugin selector',
  ],
  [
    'CLAUDE_PLUGIN_ROOT',
    'resolve skill-shipped files from the loaded SKILL.md directory; `CLAUDE_PLUGIN_ROOT` is a retired host-specific root',
  ],
  [
    'LENS_ROOT',
    'resolve skill-shipped files from the loaded SKILL.md directory; `LENS_ROOT` is a retired host-specific root',
  ],
  [
    'Claude Code',
    'address the runtime neutrally (`a runtime that runs saved workflows`, `the active runtime`); a shipped skill never names one client tool as the actor',
  ],
  [
    'Workflow tool',
    'say WHERE the workflow file is and hand it over as the explicit script path; a shipped skill never names the surface of one client tool',
  ],
];

export interface BannedTokenViolation {
  token: string;
  /** 1-indexed line within the scanned file. */
  line: number;
  guidance: string;
}

/** Every BANNED-15 substring hit in `text`, with its 1-indexed line. */
export function collectBannedTokenViolations(text: string): BannedTokenViolation[] {
  const violations: BannedTokenViolation[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    for (const [token, guidance] of BANNED_TOKEN_GUIDANCE) {
      if (line.includes(token)) violations.push({ token, line: index + 1, guidance });
    }
  }
  return violations;
}

export interface StructureViolation {
  rule: 'empty skill dir' | 'nested skill dir';
  detail: string;
}

/**
 * The skills.sh directory shape, IMPORTED rather than re-derived:
 * `scanRepoSkills` already computes both findings and is already CI-gated by
 * the `skills-inventory-parity` job. Two implementations of one contract can
 * disagree; one cannot.
 */
export function collectStructureViolations(skillsDir: string = SKILLS_DIR): StructureViolation[] {
  const scan = scanRepoSkills(ROOT, skillsDir);
  const violations: StructureViolation[] = [];
  for (const name of scan.dirsWithoutSkillMd) {
    violations.push({
      rule: 'empty skill dir',
      detail: `${name}/ has no SKILL.md at its root — skills.sh does not discover it; add ${name}/SKILL.md or remove the directory`,
    });
  }
  for (const nested of scan.nestedSkillFiles) {
    const segments = nested.split('/');
    const where = segments.length > 1 ? `hides under ${segments[0]}/` : 'sits at the skills root';
    violations.push({
      rule: 'nested skill dir',
      detail: `${nested} ${where} — skills.sh does not discover it, and \`--full-depth\` collides with the top-level name; move it to a uniquely named top-level directory`,
    });
  }
  return violations;
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

export function getGenieCommands(root: string = ROOT): Set<string> {
  // Validate against the repo's own freshly-built binary when present, not
  // whatever `genie` happens to be on PATH — a stale global install can lag
  // the source (e.g. missing the `v5` namespace) and produce false failures.
  // A clean checkout has no dist/, so probe src/genie.ts directly rather than
  // falling back to a possibly stale globally installed Genie.
  //
  // LIMITATION: only the FIRST token after `genie` is validated. `genie v5 task`
  // resolves to `v5`, so bogus subcommands under a valid namespace (e.g.
  // `genie v5 bogus-verb`) pass this lint. Command honesty below the namespace
  // level must be verified in review, not assumed from a green lint.
  const distBin = join(root, 'dist', 'genie.js');
  const cli = existsSync(distBin) ? distBin : join(root, 'src', 'genie.ts');
  const out = execFileSync('bun', [cli, '--help'], { encoding: 'utf8' });
  return collectSubcommands(out);
}

/**
 * Every file under `dir`, `.md` and non-`.md` alike. The vocabulary scan needs
 * the whole tree (Decision 10: `agents/openai.yaml` starter prompts are shipped
 * skill content); the command/resource/metadata checks stay markdown-only and
 * filter this list themselves.
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else out.push(p);
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

function extractInvocations(fence: string, tool: 'genie'): string[] {
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
  /** The declared `category`, or null when the optional key is absent. */
  category: string | null;
  /** The declared `mutates`, or null when the optional key is absent. */
  mutates: string | null;
  violations: string[];
}

const ALLOWED_FRONTMATTER_KEYS = new Set(['name', 'description', 'category', 'mutates']);

/**
 * Repo-write commands, as they appear inside a ``` fence. A `mutates: none`
 * skill that shows one of these is claiming a blast radius its own body
 * contradicts.
 *
 * Fences only: inline code is prose-adjacent (`review` names the coordinator's
 * `genie task comment` relay in a sentence, and that sentence is documentation
 * of somebody else's write, not an instruction this skill executes). A fence is
 * a runnable recipe, so a fence is where the label has to hold.
 */
const REPO_WRITE_PATTERNS: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
  ['git commit', /\bgit\s+commit\b/],
  ['git push', /\bgit\s+push\b/],
  // `\bgit\s+merge\b` also matched `git merge-base` and `git merge-tree`: `-`
  // is a non-word character, so the word boundary sat happily between `merge`
  // and the hyphen. Both siblings are read-only plumbing — `merge-base` prints
  // an ancestor SHA, `merge-tree` computes a merge in memory and writes
  // nothing — and `context`/`review` recipes call them to locate a base. They
  // are exempted BY NAME, not by a blanket `merge-*` exemption, so a sibling
  // that does write (`git merge-file` rewrites a worktree file) still fails.
  ['git merge', /\bgit\s+merge(?!-(?:base|tree)\b)\b/],
  ['git rebase', /\bgit\s+rebase\b/],
  ['gh pr create', /\bgh\s+pr\s+create\b/],
  ['gh pr merge', /\bgh\s+pr\s+merge\b/],
  ['genie task export --write', /\bgenie\s+task\s+export\b[^\n]*--write\b/],
  [
    'genie task <mutating verb>',
    /\bgenie\s+task\s+(?:create|move|done|delete|checkout|report|comment|adopt|assign|set-wish|import|sync)\b/,
  ],
  ['rm -rf', /\brm\s+-[A-Za-z]*(?:rf|fr)[A-Za-z]*\b/],
  ['cp -r', /\bcp\s+-[A-Za-z]*[rR][A-Za-z]*\b/],
  ['mkdir -p', /\bmkdir\s+-[A-Za-z]*p[A-Za-z]*\b/],
];

/**
 * `>` / `>>` redirection into a path. Checked against a line whose `<...>`
 * placeholders have been stripped first — `cmd <instance-id> <name>` ends a
 * placeholder with `> ` and is not a redirect. `2>&1` does not match either:
 * the target class holds no `&`.
 */
const REDIRECT_PATTERN = /(?:^|\s)\d?>>?\s*["']?[A-Za-z0-9_.$~/-]/;
const PLACEHOLDER_PATTERN = /<[^<>\n]*>/g;

export interface MutationViolation {
  /** The repo-write command class, named as the operator would fix it. */
  command: string;
  /** 1-indexed line within the scanned file. */
  line: number;
  snippet: string;
}

/**
 * Walk `text` line by line, telling the visitor whether each line sits inside
 * a ``` (or ~~~) fence. Fence lines themselves are never visited. One walker
 * serves the mutates-none rule and the hazard rule below, so the two cannot
 * disagree about what "inside a fence" means.
 */
function eachContentLine(text: string, visit: (line: string, lineNumber: number, inFence: boolean) => void): void {
  const lines = text.split(/\r?\n/);
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] as string;
    const opener = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (opener !== null) {
      const marker = opener[1] as string;
      if (fence === null) fence = marker[0] as string;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    visit(raw, index + 1, fence !== null);
  }
}

/**
 * Every repo-write command inside a ``` fence, with its 1-indexed line. Fence
 * language is irrelevant: a `text` fence showing `git push` is still a recipe.
 */
export function collectMutationViolations(text: string): MutationViolation[] {
  const violations: MutationViolation[] = [];
  eachContentLine(text, (line, lineNumber, inFence) => {
    if (inFence) violations.push(...checkMutationLine(line, lineNumber));
  });
  return violations;
}

/** Every repo-write hit on one fence line. Exported so the rule is unit-testable without a fence. */
export function checkMutationLine(line: string, lineNumber = 1): MutationViolation[] {
  const snippet = line.trim();
  const hits: MutationViolation[] = [];
  for (const [command, pattern] of REPO_WRITE_PATTERNS) {
    if (pattern.test(line)) hits.push({ command, line: lineNumber, snippet });
  }
  if (REDIRECT_PATTERN.test(line.replace(PLACEHOLDER_PATTERN, ' '))) {
    hits.push({ command: '> redirection into a path', line: lineNumber, snippet });
  }
  return hits;
}

/**
 * HOUSE SIZE — every shipped `skills/<name>/SKILL.md` stays between 40 and 90
 * lines. Under the floor a "skill" is a stub that belongs inside whichever
 * skill owns the workflow; over the ceiling it stops being loadable context
 * and becomes a manual, and its on-demand half belongs in `references/`.
 *
 * Counted the way `wc -l` counts — newline-terminated lines — except that a
 * file with no trailing newline also counts its last, unterminated line. One
 * line of slack never decides a 40–90 window, and the stricter reading is the
 * honest one for a file that is missing its final newline.
 */
export const SKILL_MIN_LINES = 40;
export const SKILL_MAX_LINES = 90;

export interface SkillSizeWaiver {
  readonly min: number;
  readonly max: number;
  readonly reason: string;
}

/**
 * The house-size waiver table: skill name → the window that ONE skill may
 * occupy, and why. Two properties are deliberate:
 *   - Every row carries a real ceiling, pinned to the file's current size. A
 *     waiver that allowed "any size" would let the exception grow silently,
 *     which is the failure the rule exists to catch.
 *   - Every row carries the condition that retires it, so a stale waiver is
 *     visible in review rather than permanent by default.
 */
export const SKILL_SIZE_WAIVERS: ReadonlyMap<string, SkillSizeWaiver> = new Map<string, SkillSizeWaiver>([
  [
    'quick',
    {
      min: 0,
      max: 8,
      // A deliberate retirement stub that points at the wish skill and is
      // deleted after three measured runs. Ceiling 8 = its current size: the
      // stub may shrink or disappear, and can never grow back into a skill.
      reason: 'retirement stub, deleted after three measured runs — it may shrink, never grow',
    },
  ],
]);

export interface SkillSizeViolation {
  skill: string;
  lines: number;
  detail: string;
}

/** `wc -l`, plus a final unterminated line when the file has no trailing newline. */
export function countSkillLines(text: string): number {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** The house-size verdict for one shipped SKILL.md, or null when it fits. */
export function checkSkillSize(skill: string, text: string): SkillSizeViolation | null {
  const lines = countSkillLines(text);
  const waiver = SKILL_SIZE_WAIVERS.get(skill) ?? null;
  const min = waiver?.min ?? SKILL_MIN_LINES;
  const max = waiver?.max ?? SKILL_MAX_LINES;
  if (lines >= min && lines <= max) return null;
  const window =
    waiver === null
      ? `house size ${SKILL_MIN_LINES}-${SKILL_MAX_LINES}`
      : `waived window ${min}-${max}: ${waiver.reason}`;
  const fix =
    lines > max
      ? `trim to ${max} line(s) or fewer — move the on-demand half into ${skill}/references/`
      : `grow to at least ${min} line(s), or fold the workflow into the skill that owns it and delete the directory`;
  return { skill, lines, detail: `${lines} lines — ${fix} (${window})` };
}

/**
 * STAGED CANDIDATES — `<GENIE_HOME>/skills` is a DELIVERY tree, not a workbench.
 *
 * `genie install` / `genie update` point the pinned skills CLI at that exact
 * directory with `--skill '*'`, so every directory sitting in it is copied into
 * every detected agent home and recorded in `skills-install.json` as
 * genie-owned. A candidate staged there — the 2026-09-18 skill-intake round
 * staged 38 of them — would therefore ship under genie's name, and `genie
 * uninstall` would later delete it as genie's own.
 *
 * The rule refuses any directory there that is NEITHER delivered by the tree
 * being linted NOR named by the install record's `inventory` (a skill this
 * release dropped is still legitimately on disk until the next update retires
 * it — `omni` at v6 is exactly that case).
 *
 * Fail-open in ONE place, deliberately: a record that exists but cannot be
 * parsed leaves genie unable to tell delivered from staged, and a guard that
 * cannot tell must not convict every directory on the host. An ABSENT record
 * is different — nothing was ever delivered there — so the tree alone decides.
 */
export interface StagedCandidateViolation {
  skill: string;
  /** Absolute path of the staged directory. */
  path: string;
  detail: string;
}

/**
 * The staged-candidate waiver table: skill name → why one directory may sit in
 * the delivery tree without being delivered. Empty on purpose — a waiver here
 * says "ship this to every agent home under genie's name", so every row must be
 * argued in review rather than added in passing.
 */
export const STAGED_CANDIDATE_WAIVERS: ReadonlyMap<string, string> = new Map<string, string>();

export function isStagedCandidateWaived(skill: string): boolean {
  return STAGED_CANDIDATE_WAIVERS.has(skill);
}

/**
 * `<GENIE_HOME>/skills` for this host, or null when neither `GENIE_HOME` nor
 * `HOME` says where it would be. Resolved from the environment rather than
 * imported from `src/lib/genie-home.ts` so the gate stays a standalone script.
 */
export function resolveGenieSkillsHome(env: Record<string, string | undefined> = process.env): string | null {
  const home = env.GENIE_HOME ?? (env.HOME === undefined ? null : join(env.HOME, '.genie'));
  return home === null ? null : join(home, 'skills');
}

/** The `inventory` the install record beside `<GENIE_HOME>/skills` names, or null when it cannot be read. */
function recordedInventory(skillsHome: string): string[] | null {
  const record = join(skillsHome, '..', 'skills-install.json');
  if (!existsSync(record)) return [];
  try {
    const parsed = JSON.parse(readFileSync(record, 'utf8')) as { inventory?: unknown };
    if (!Array.isArray(parsed.inventory)) return null;
    return parsed.inventory.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return null;
  }
}

/** What counts as delivered: the linted tree's own skills ∪ what the install record recorded. */
export function deliveredSkillNames(skillsDir: string = SKILLS_DIR, recordPath?: string): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md'))) names.add(entry.name);
  }
  if (recordPath !== undefined && existsSync(recordPath)) {
    try {
      const parsed = JSON.parse(readFileSync(recordPath, 'utf8')) as { inventory?: unknown };
      if (Array.isArray(parsed.inventory)) {
        for (const entry of parsed.inventory) if (typeof entry === 'string') names.add(entry);
      }
    } catch {
      /* an unreadable record adds nothing; the staged scan handles that case */
    }
  }
  return names;
}

/** Every directory staged under `<GENIE_HOME>/skills` that nothing proves genie delivers. */
export function collectStagedCandidateViolations(
  skillsHome: string | null,
  delivered: ReadonlySet<string>,
  waived: (skill: string) => boolean = isStagedCandidateWaived,
): StagedCandidateViolation[] {
  if (skillsHome === null || !existsSync(skillsHome)) return [];
  const recorded = recordedInventory(skillsHome);
  if (recorded === null) return [];
  const known = new Set([...delivered, ...recorded]);
  const violations: StagedCandidateViolation[] = [];
  for (const entry of readdirSync(skillsHome, { withFileTypes: true })) {
    if (!entry.isDirectory() || known.has(entry.name) || waived(entry.name)) continue;
    const path = join(skillsHome, entry.name);
    if (!existsSync(join(path, 'SKILL.md'))) continue;
    violations.push({
      skill: entry.name,
      path,
      detail: `staged in the delivery tree but not delivered by this release — \`genie install\`/\`genie update\` run the pinned skills CLI over this directory with \`--skill '*'\`, so it would be installed into every detected agent home as a genie-owned skill; stage candidates outside <GENIE_HOME>/skills`,
    });
  }
  return violations;
}

/**
 * HAZARDS AND RESIDUE — patterns no shipped `.md` under skills/ may carry.
 *
 * Two scopes, because the same string means different things in different
 * places:
 *   - `fence` rules match only inside a ``` fence, on the same reasoning the
 *     mutates-none rule uses: a fence is a runnable recipe that gets copied,
 *     while prose (and prose-adjacent inline code) is where a skill documents
 *     somebody else's command or forbids one outright. "Never run `git stash`
 *     in a shared checkout" is the sentence we want skills to carry, so it
 *     must not be the sentence that fails the gate.
 *   - `file` rules match anywhere in the file, because the string is residue
 *     with no legitimate use in shipped text at all — a foreign runtime name
 *     or a foreign record id is wrong in prose exactly as it is in a fence.
 *
 * Every rule names the replacement, in the same shape as the retired-token
 * vocabulary ban: the failure states the fix, not just the sin.
 */
export type HazardScope = 'fence' | 'file';

export interface HazardRule {
  readonly label: string;
  readonly scope: HazardScope;
  /** True when `subject` carries the hazard. */
  readonly matches: (subject: string) => boolean;
  readonly guidance: string;
}

/**
 * An `npx` package argument is pinned when it carries an explicit `@version`
 * suffix — a literal version or a documented `<version>` placeholder. A bare
 * name, a bare `@scope/name`, and the moving tags (`@latest`, `@next`, `@*`)
 * are all unpinned: they resolve to whatever the registry serves that minute.
 */
export function isPinnedNpxPackage(pkg: string): boolean {
  const at = pkg.lastIndexOf('@');
  if (at <= 0) return false;
  const version = pkg.slice(at + 1);
  return version !== '' && !['latest', 'next', '*'].includes(version);
}

/** The one unpinned invocation shipped skills already document, allowed verbatim. */
const DOCUMENTED_NPX_INSTALL = /^skills\s+add\s+automagik-dev\/genie\b/;
const NPX_INVOCATION = /\bnpx\s+(?:-{1,2}[A-Za-z][A-Za-z0-9-]*\s+)*([^\s'"`]+)([^\n]*)/g;

/** True when `subject` runs `npx` on a package that is neither pinned nor the documented installer. */
export function hasUnpinnedNpxInstaller(subject: string): boolean {
  for (const match of subject.matchAll(NPX_INVOCATION)) {
    const pkg = match[1] as string;
    const rest = match[2] ?? '';
    if (isPinnedNpxPackage(pkg)) continue;
    if (DOCUMENTED_NPX_INSTALL.test(`${pkg}${rest}`)) continue;
    return true;
  }
  return false;
}

const matcher =
  (pattern: RegExp) =>
  (subject: string): boolean =>
    pattern.test(subject);

export const HAZARD_RULES: readonly HazardRule[] = [
  {
    label: 'sudo',
    scope: 'fence',
    matches: matcher(/\bsudo\b/),
    guidance: 'run as the invoking user; a skill never escalates to root on somebody else’s machine',
  },
  {
    label: 'unpinned npx installer',
    scope: 'fence',
    matches: hasUnpinnedNpxInstaller,
    guidance:
      'pin the package (`npx -y skills@<version>`) or use the documented `npx skills add automagik-dev/genie` form',
  },
  {
    label: 'pip install',
    scope: 'fence',
    matches: matcher(/\bpip3?\s+install\b/),
    guidance: 'state the dependency as a prerequisite; a skill never installs packages into the host environment',
  },
  {
    label: '--break-system-packages',
    scope: 'fence',
    matches: matcher(/--break-system-packages\b/),
    guidance: 'state the prerequisite instead of overriding the host package manager’s protection',
  },
  {
    label: 'curl with an Authorization header',
    scope: 'fence',
    matches: (subject) => /\bcurl\b/.test(subject) && /authorization\s*:/i.test(subject),
    guidance: 'fetch public URLs only, or use the tool that owns the credential (`gh`); never hand a token to curl',
  },
  {
    label: 'GITHUB_TOKEN',
    scope: 'fence',
    matches: matcher(/\bGITHUB_TOKEN\b/),
    guidance: 'let `gh` resolve its own credential; a skill never reads a token out of the environment',
  },
  {
    label: '.git-credentials',
    scope: 'fence',
    matches: matcher(/\.git-credentials\b/),
    guidance: 'let git and `gh` resolve their own credentials; a skill never reads the credential store',
  },
  {
    label: 'git stash',
    scope: 'fence',
    matches: matcher(/\bgit\s+stash\b/),
    guidance: 'commit on a branch or leave the tree alone; `git stash` hides work the operator never handed over',
  },
  {
    label: 'git add -A',
    scope: 'fence',
    // `git add <path>` is fine and stays fine: only the sweep-everything forms
    // (-A, --all, -u, `.`) match, because those are what pull an unrelated
    // worker's files into a commit in a shared checkout.
    matches: matcher(/\bgit\s+add\s+(?:-A|--all|-u|\.)(?:\s|$)/),
    guidance: 'stage by path — `git add -A` sweeps up files this skill never touched',
  },
  {
    label: '--dangerously flag',
    scope: 'fence',
    matches: matcher(/--dangerously/),
    guidance: 'earn the permission the ordinary way; a permission-bypass flag never ships in a skill',
  },
  {
    label: 'SKIP_TRUST',
    scope: 'file',
    matches: matcher(/\bSKIP_TRUST/),
    guidance: 'drop the foreign trust-bypass switch; Genie skills carry no such escape hatch',
  },
  {
    label: 'Hermes',
    scope: 'file',
    matches: matcher(/\bhermes\b/i),
    guidance: 'name the runtime-neutral role instead; shipped skill text names no vendor runtime',
  },
  {
    label: 'brn_ identifier',
    scope: 'file',
    matches: matcher(/\bbrn_[A-Za-z0-9]/),
    guidance: 'strip the foreign record id; shipped skill text carries no external identifier',
  },
];

export interface HazardWaiver {
  /** Path relative to the scanned skills dir, POSIX-separated. */
  readonly file: string;
  /** The `HazardRule.label` this one file may carry. */
  readonly label: string;
  readonly reason: string;
}

/**
 * The hazard waiver table: one file, one rule, one reason. Pre-existing
 * shipped text only — every row names text that was already on this branch
 * when the rule landed, so the rule could be added without editing files
 * other workers own. A row is deleted with the text it covers; a stale row
 * fails nothing, because a waiver that outlived its hit is a review finding,
 * not a reason to redden everybody else's gate.
 */
export const HAZARD_WAIVERS: readonly HazardWaiver[] = [];

export function isHazardWaived(relativeFile: string, label: string): boolean {
  return HAZARD_WAIVERS.some((waiver) => waiver.file === relativeFile && waiver.label === label);
}

export interface HazardViolation {
  label: string;
  /** 1-indexed line within the scanned file. */
  line: number;
  snippet: string;
  guidance: string;
}

/** Every hazard hit on one line, given whether that line sits inside a fence. */
export function checkHazardLine(line: string, context: HazardScope | 'prose', lineNumber = 1): HazardViolation[] {
  const snippet = line.trim();
  const hits: HazardViolation[] = [];
  for (const rule of HAZARD_RULES) {
    if (rule.scope === 'fence' && context !== 'fence') continue;
    if (rule.matches(line)) hits.push({ label: rule.label, line: lineNumber, snippet, guidance: rule.guidance });
  }
  return hits;
}

/** Every hazard hit in one markdown file, with its 1-indexed line. */
export function collectHazardViolations(text: string): HazardViolation[] {
  const violations: HazardViolation[] = [];
  eachContentLine(text, (line, lineNumber, inFence) => {
    violations.push(...checkHazardLine(line, inFence ? 'fence' : 'prose', lineNumber));
  });
  return violations;
}

/** Validate the portable SKILL.md + Codex UI metadata contract for one skill. */
export function validateSkillMetadata(skillDir: string): SkillMetadataValidation {
  const skillPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillPath)) return { name: null, category: null, mutates: null, violations: ['missing SKILL.md'] };

  const text = readFileSync(skillPath, 'utf8');
  const parsed = parseSkillFrontmatter(text);
  const violations = [...parsed.violations];
  if (parsed.fields === null) return { name: null, category: null, mutates: null, violations };
  const fields = parsed.fields;
  for (const key of fields.keys()) {
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) violations.push(`unsupported frontmatter field: ${key}`);
  }

  const name = fields.get('name') ?? null;
  const description = fields.get('description') ?? '';
  // Both optional: absent is legal, a value outside the closed enum is not.
  const category = fields.get('category') ?? null;
  const mutates = fields.get('mutates') ?? null;
  if (category !== null && !(SKILL_CATEGORIES as readonly string[]).includes(category)) {
    violations.push(`unsupported category: ${category} (one of ${SKILL_CATEGORIES.join(', ')})`);
  }
  if (mutates !== null && !(SKILL_MUTATES_LEVELS as readonly string[]).includes(mutates)) {
    violations.push(`unsupported mutates: ${mutates} (one of ${SKILL_MUTATES_LEVELS.join(', ')})`);
  }
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
    return { name, category, mutates, violations };
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

  return { name, category, mutates, violations };
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
  bannedTokens: BannedTokenViolation[];
  mutationViolations: MutationViolation[];
  hazardViolations: HazardViolation[];
}

/** Print the hazard/residue failures. No-op on an empty list. */
function reportHazardFailures(hazardFailed: Report[]): void {
  if (hazardFailed.length === 0) return;
  console.error(`\nskills-lint: ${hazardFailed.length} file(s) ship a hazard or a residue marker`);
  for (const r of hazardFailed) {
    for (const v of r.hazardViolations) {
      console.error(`  ${r.skill}:${v.line}: [hazard] ${v.label} — ${v.guidance}`);
    }
  }
}

/** Print the house-size failures. No-op on an empty list. */
function reportSizeFailures(sizeViolations: SkillSizeViolation[]): void {
  if (sizeViolations.length === 0) return;
  console.error(
    `\nskills-lint: ${sizeViolations.length} skill(s) outside the ${SKILL_MIN_LINES}-${SKILL_MAX_LINES} line house size`,
  );
  for (const v of sizeViolations) console.error(`  ${v.skill}/SKILL.md: ${v.detail}`);
}

/** Print the staged-candidate failures. No-op on an empty list. */
function reportStagedFailures(stagedViolations: StagedCandidateViolation[]): void {
  if (stagedViolations.length === 0) return;
  console.error(`\nskills-lint: ${stagedViolations.length} dir(s) staged under <GENIE_HOME>/skills are not delivered`);
  for (const v of stagedViolations) console.error(`  ${v.path}: [staged-candidate] ${v.skill} — ${v.detail}`);
}

/** Emit every failing category. Returns true when the gate must exit non-zero. */
function reportFailures(
  reports: Report[],
  structureViolations: StructureViolation[],
  catalogViolations: string[],
  sizeViolations: SkillSizeViolation[],
  stagedViolations: StagedCandidateViolation[],
): boolean {
  const missingFailed = reports.filter((r) => r.missingCommands.length > 0);
  const resourceFailed = reports.filter((r) => r.resourceViolations.length > 0);
  const metadataFailed = reports.filter((r) => r.metadataViolations.length > 0);
  const tokenFailed = reports.filter((r) => r.bannedTokens.length > 0);
  const mutationFailed = reports.filter((r) => r.mutationViolations.length > 0);
  const hazardFailed = reports.filter((r) => r.hazardViolations.length > 0);
  if (
    missingFailed.length === 0 &&
    resourceFailed.length === 0 &&
    metadataFailed.length === 0 &&
    tokenFailed.length === 0 &&
    mutationFailed.length === 0 &&
    hazardFailed.length === 0 &&
    sizeViolations.length === 0 &&
    stagedViolations.length === 0 &&
    catalogViolations.length === 0 &&
    structureViolations.length === 0
  ) {
    return false;
  }

  if (missingFailed.length > 0) {
    console.error(`\nskills-lint: ${missingFailed.length} skill(s) reference missing commands`);
  }
  if (resourceFailed.length > 0) {
    console.error(`\nskills-lint: ${resourceFailed.length} skill(s) reference repo-only resources`);
    console.error('skills-lint: resolve skill-shipped paths from the loaded SKILL.md directory');
    for (const r of resourceFailed) {
      for (const v of r.resourceViolations) console.error(`  ${r.skill}: [${v.rule}] ${v.snippet}`);
    }
  }
  if (metadataFailed.length > 0) {
    console.error(`\nskills-lint: ${metadataFailed.length} skill(s) have invalid Codex metadata`);
    for (const r of metadataFailed) {
      for (const violation of r.metadataViolations) console.error(`  ${r.skill}: ${violation}`);
    }
  }
  if (tokenFailed.length > 0) {
    console.error(`\nskills-lint: ${tokenFailed.length} file(s) name a retired agent/runtime token`);
    for (const r of tokenFailed) {
      for (const v of r.bannedTokens) {
        console.error(`  ${r.skill}:${v.line}: [retired-token] ${v.token} — ${v.guidance}`);
      }
    }
  }
  if (mutationFailed.length > 0) {
    console.error(`\nskills-lint: ${mutationFailed.length} file(s) claim \`mutates: none\` but fence a repo write`);
    console.error('skills-lint: declare the real blast radius, or move the write out of the fence');
    for (const r of mutationFailed) {
      for (const v of r.mutationViolations) {
        console.error(`  ${r.skill}:${v.line}: [mutates-none] ${v.command} — ${v.snippet}`);
      }
    }
  }
  reportHazardFailures(hazardFailed);
  reportSizeFailures(sizeViolations);
  reportStagedFailures(stagedViolations);
  if (catalogViolations.length > 0) {
    console.error(`\nskills-lint: ${catalogViolations.length} skills/README.md catalog violation(s)`);
    for (const violation of catalogViolations) console.error(`  ${violation}`);
  }
  if (structureViolations.length > 0) {
    console.error(`\nskills-lint: ${structureViolations.length} skills/ directory shape violation(s)`);
    for (const v of structureViolations) console.error(`  [${v.rule}] ${v.detail}`);
  }
  return true;
}

function main() {
  const genieCmds = getGenieCommands();

  if (genieCmds.size === 0) {
    console.error('skills-lint: failed to load `genie --help` output');
    process.exit(2);
  }

  const files = walk(SKILLS_DIR);
  const structureViolations = collectStructureViolations(SKILLS_DIR);
  const genieSkillsHome = resolveGenieSkillsHome();
  const stagedViolations = collectStagedCandidateViolations(genieSkillsHome, deliveredSkillNames(SKILLS_DIR));
  const catalogViolations = checkSkillCatalogDrift(SKILLS_DIR);
  const reports: Report[] = [];
  const metadataBySkill = new Map<string, string[]>();
  const mutatesBySkill = new Map<string, string | null>();
  const sizeViolations: SkillSizeViolation[] = [];
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    const skillPath = join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (!entry.isDirectory() || !existsSync(skillPath)) continue;
    const metadata = validateSkillMetadata(join(SKILLS_DIR, entry.name));
    metadataBySkill.set(entry.name, metadata.violations);
    mutatesBySkill.set(entry.name, metadata.mutates);
    const size = checkSkillSize(entry.name, readFileSync(skillPath, 'utf8'));
    if (size !== null) sizeViolations.push(size);
  }

  // First pass: collect all invocations from non-ignored skills.
  const scanned: Array<{
    file: string;
    genie: string[];
    resource: ResourceViolation[];
    banned: BannedTokenViolation[];
    mutation: MutationViolation[];
    hazard: HazardViolation[];
  }> = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    // A `mutates: none` claim is a safety label, so — like the vocabulary scan —
    // it is checked on every markdown file of the skill and BEFORE the ignore
    // bailout, with no allowlist. A recipe is copied, not read.
    const owningSkill = relative(SKILLS_DIR, file).split(sep)[0] as string;
    const mutation =
      file.endsWith('.md') && mutatesBySkill.get(owningSkill) === 'none' ? collectMutationViolations(text) : [];
    // Decision 9: the vocabulary scan runs on EVERY file the walk finds and
    // BEFORE the ignore bailout. The bailout below skips only the
    // command/resource checks it was introduced for.
    const banned = collectBannedTokenViolations(text);
    // Hazards are a safety contract too, so — like the vocabulary scan and the
    // mutates-none rule — they are checked on every markdown file of every
    // skill and BEFORE the ignore bailout. The only exemption is the explicit,
    // reasoned waiver table, matched on file AND rule.
    const relativeFile = relative(SKILLS_DIR, file).split(sep).join('/');
    const hazard = file.endsWith('.md')
      ? collectHazardViolations(text).filter((v) => !isHazardWaived(relativeFile, v.label))
      : [];
    const commandChecksSkipped = !file.endsWith('.md') || text.includes('<!-- skills-lint:ignore -->');
    if (commandChecksSkipped) {
      scanned.push({ file, genie: [], resource: [], banned, mutation, hazard });
      continue;
    }
    const genie: string[] = [];
    for (const fence of extractBashFences(text)) {
      genie.push(...extractInvocations(fence, 'genie'));
    }
    // Catalog/recipe content and the contributor-facing top-level README may
    // show repo-root commands; executable skill instructions must ship their
    // own resources.
    const resource = isResourceAllowlisted(file) ? [] : collectResourceViolations(text);
    scanned.push({ file, genie, resource, banned, mutation, hazard });
  }

  for (const { file, genie, resource, banned, mutation, hazard } of scanned) {
    const missing: Report['missingCommands'] = [];
    for (const cmd of genie) {
      if (!genieCmds.has(cmd)) missing.push({ tool: 'genie', command: cmd });
    }
    const topLevelSkill = relative(SKILLS_DIR, file).split(sep)[0];
    const metadataViolations = file.endsWith(`${sep}SKILL.md`) ? (metadataBySkill.get(topLevelSkill) ?? []) : [];
    reports.push({
      skill: relative(ROOT, file),
      missingCommands: missing,
      resourceViolations: resource,
      metadataViolations,
      bannedTokens: banned,
      mutationViolations: mutation,
      hazardViolations: hazard,
    });
  }

  console.log(JSON.stringify(reports, null, 2));

  if (reportFailures(reports, structureViolations, catalogViolations, sizeViolations, stagedViolations))
    process.exit(1);
  console.error(
    `skills-lint: OK (${reports.length} files scanned, 0 missing, 0 resource violations, 0 retired tokens, 0 mutates-none violations, 0 structure violations, 0 hazards, 0 house-size violations, 0 staged candidates)`,
  );
}

// Only run the linter when executed directly, not when imported by tests.
if (import.meta.main) {
  main();
}
