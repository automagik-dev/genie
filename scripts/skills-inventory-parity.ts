#!/usr/bin/env bun
/**
 * CI guard for the skills.sh inventory contract (wish `skills-everywhere`, C6).
 *
 * The published skill inventory is whatever `skills@<PINNED> add <local
 * checkout> --list` names for THIS commit. Genie's own record
 * (`inventoryFromSkillsDir`, `src/lib/skills-installer.ts`) instead derives the
 * inventory from the TOP-LEVEL `skills/*​/SKILL.md` names in the checkout. The
 * two must agree, or `genie uninstall` removes the wrong set and `doctor`
 * reports freshness against a list nobody published.
 *
 * REF CAVEAT: the source is the LOCAL checkout, never `automagik-dev/genie@<ref>`
 * — `skills@1.5.23` binds the third capture of its source spec to `skillFilter`,
 * not to a ref, so an `@<ref>` suffix is ignored and the repository's DEFAULT
 * branch is served (verified 2026-08-31). The ref-pinned form made this check
 * vacuous on PRs; a local path is the only way to list the commit under test.
 *
 * Usage (the `ci.yml` form — the CI job captures the real CLI's human output):
 *   npx -y skills@<PINNED> add "$PWD" --list > "$RUNNER_TEMP/skills-list.txt" 2>&1
 *   bun scripts/skills-inventory-parity.ts --repo . --list-file "$RUNNER_TEMP/skills-list.txt"
 *
 * The list may also arrive on stdin:
 *   npx -y skills@<PINNED> add "$PWD" --list 2>&1 \
 *     | bun scripts/skills-inventory-parity.ts --repo .
 *
 * Exit 0 only when every one of these holds:
 *   - the parsed `--list` names and the repo's top-level skill dirs are the
 *     same set,
 *   - every directory under `skills/` carries its own top-level `SKILL.md`,
 *   - no `SKILL.md` is nested deeper than `skills/<name>/SKILL.md`,
 *   - every skill name is a safe path segment (mirrors SKILL_NAME_PATTERN),
 *   - nothing under `skills/` is a symlink — the publisher copies physical
 *     files, so a symlinked skill directory would be silently unpublished,
 *   - the CLI's own "Found N skills" count, when printed, equals the number of
 *     names parsed (so a parser drift cannot silently shrink both sides).
 *
 * Anything else exits 1 with every failure named. There is no `--fix`: the
 * remedy is a source change, not a rewrite of CI's view of the source.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** Mirrors `SKILL_NAME_PATTERN` in src/lib/skills-installer.ts. */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The pinned CLI renders every list row inside a left box rule. */
const BOX_RULE = '│';

/** A skill NAME row is the box rule + exactly four spaces; descriptions use six. */
const NAME_ROW_INDENT = 4;

/** `<rule><indent><value>` with trailing padding tolerated. */
const LIST_ROW_PATTERN = new RegExp(`^${BOX_RULE}( +)(\\S.*?) *$`);

/** Recursion ceiling for the `skills/` walk — a real tree is two or three deep. */
const MAX_WALK_DEPTH = 12;

export interface SkillsListParse {
  names: string[];
  /** `Found N skills`, when the CLI printed it; `null` when it did not. */
  declaredCount: number | null;
}

export interface RepoSkillsScan {
  names: string[];
  /** Paths relative to `skills/` for every SKILL.md that is not `<name>/SKILL.md`. */
  nestedSkillFiles: string[];
  /** Directory names directly under `skills/` that carry no top-level SKILL.md. */
  dirsWithoutSkillMd: string[];
  /** Directory names directly under `skills/` that are not safe path segments. */
  invalidNames: string[];
  /**
   * Every symlink encountered under `skills/`, relative to `skills/`. The walk
   * refuses to follow them, so without this they would vanish from the scan and
   * a symlinked `skills/<name>` would look like a skill that simply is not
   * there. A symlink here is a contract violation, not a scan detail.
   */
  skippedSymlinks: string[];
}

export interface SkillsInventoryParityReport {
  listed: string[];
  repo: string[];
  /** Named by the CLI, absent from the checkout. */
  onlyListed: string[];
  /** Present in the checkout, never named by the CLI. */
  onlyRepo: string[];
  nestedSkillFiles: string[];
  dirsWithoutSkillMd: string[];
  invalidNames: string[];
  skippedSymlinks: string[];
  declaredCount: number | null;
}

/**
 * Drop CSI/OSC escapes and carriage returns. The CLI writes spinner frames with
 * `ESC[1G ESC[J` and no newline, so stripping first is what keeps the
 * line-anchored row match from being defeated by a redraw prefix.
 */
const ESC = String.fromCharCode(27);
/** OSC (`ESC ] ... BEL|ESC \\`) then CSI (`ESC [ ... final`). Built from a char
 * code so no control character ever appears inside a regex literal. */
const OSC_PATTERN = new RegExp(`${ESC}\\][\\s\\S]*?(?:\\u0007|${ESC}\\\\)`, 'g');
const CSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(OSC_PATTERN, '').replace(CSI_PATTERN, '').replace(/\r/g, '');
}

/**
 * Parse the pinned CLI's human `--list` output.
 *
 * Rows look like:
 *   `│    architecture`            <- name, indent 4
 *   `│      Use when reviewing…`   <- description, indent 6
 * Only the `Available Skills` section is considered when that header is
 * present, so header/summary chrome can never be read as a skill name.
 */
export function parseSkillsListOutput(rawText: string): SkillsListParse {
  const text = stripAnsi(rawText);
  const declaredMatch = text.match(/Found\s+(\d+)\s+skills?\b/);
  const declaredCount = declaredMatch === null ? null : Number.parseInt(declaredMatch[1] as string, 10);
  const headerIndex = text.indexOf('Available Skills');
  const section = headerIndex === -1 ? text : text.slice(headerIndex);
  const names: string[] = [];
  for (const line of section.split('\n')) {
    const row = line.match(LIST_ROW_PATTERN);
    if (row === null) continue;
    const [, indent, value] = row as unknown as [string, string, string];
    if (indent.length !== NAME_ROW_INDENT) continue;
    if (!SKILL_NAME_PATTERN.test(value)) continue;
    names.push(value);
  }
  return { names, declaredCount };
}

interface WalkEntry {
  relativePath: string;
  isDirectory: boolean;
}

/**
 * Physical, symlink-refusing listing. Dot-entries are never published skills.
 * Every refused symlink is recorded in `skipped` so the caller can fail on it
 * instead of silently seeing a smaller tree.
 */
function listPhysicalEntries(dir: string, prefix: string, skipped?: Set<string>): WalkEntry[] {
  const entries: WalkEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) {
      skipped?.add(prefix === '' ? entry.name : `${prefix}/${entry.name}`);
      continue;
    }
    entries.push({
      relativePath: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      isDirectory: entry.isDirectory(),
    });
  }
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/** Every non-hidden `SKILL.md` under `skills/`, as paths relative to `skills/`. */
function collectSkillFiles(skillsRoot: string, skipped?: Set<string>): string[] {
  const found: string[] = [];
  const queue: Array<{ dir: string; prefix: string; depth: number }> = [{ dir: skillsRoot, prefix: '', depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift() as { dir: string; prefix: string; depth: number };
    if (current.depth > MAX_WALK_DEPTH) continue;
    for (const entry of listPhysicalEntries(current.dir, current.prefix, skipped)) {
      if (entry.isDirectory) {
        queue.push({
          dir: join(current.dir, entry.relativePath.split('/').pop() as string),
          prefix: entry.relativePath,
          depth: current.depth + 1,
        });
        continue;
      }
      // Anchored on the BASENAME: `endsWith` would also match `NOTSKILL.md`.
      if (entry.relativePath.slice(entry.relativePath.lastIndexOf('/') + 1) === 'SKILL.md') {
        found.push(entry.relativePath);
      }
    }
  }
  return found.sort();
}

/**
 * The checkout side of the contract: top-level `skills/<name>/SKILL.md` only.
 *
 * `skillsRoot` defaults to `<repoRoot>/skills`. It is an explicit override so a
 * caller that already holds a skills root — `scripts/skills-lint.ts`, whose
 * `SKILLS_LINT_DIR` fixture hook points straight at one — reuses THIS walk
 * instead of re-deriving the nested/empty contract in a second implementation.
 */
export function scanRepoSkills(repoRoot: string, skillsRoot: string = join(repoRoot, 'skills')): RepoSkillsScan {
  const skippedSymlinks = new Set<string>();
  const topLevel = listPhysicalEntries(skillsRoot, '', skippedSymlinks);
  const directories = topLevel.filter((entry) => entry.isDirectory).map((entry) => entry.relativePath);
  const skillFiles = collectSkillFiles(skillsRoot, skippedSymlinks);
  const canonical = new Set(directories.map((name) => `${name}/SKILL.md`));
  const present = new Set(skillFiles);
  const names: string[] = [];
  const dirsWithoutSkillMd: string[] = [];
  const invalidNames: string[] = [];
  for (const name of directories) {
    if (!SKILL_NAME_PATTERN.test(name)) invalidNames.push(name);
    if (present.has(`${name}/SKILL.md`)) names.push(name);
    else dirsWithoutSkillMd.push(name);
  }
  // Anything the canonical `<name>/SKILL.md` set does not contain is either a
  // stray `skills/SKILL.md` or a deeper `skills/<name>/<sub>/SKILL.md`.
  const nestedSkillFiles = skillFiles.filter((path) => !canonical.has(path));
  return {
    names: names.sort(),
    nestedSkillFiles,
    dirsWithoutSkillMd: dirsWithoutSkillMd.sort(),
    invalidNames,
    skippedSymlinks: [...skippedSymlinks].sort(),
  };
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const other = new Set(right);
  return left.filter((value) => !other.has(value)).sort();
}

export function evaluateSkillsInventoryParity(listOutput: string, repoRoot: string): SkillsInventoryParityReport {
  const parsed = parseSkillsListOutput(listOutput);
  const scan = scanRepoSkills(repoRoot);
  const listed = [...parsed.names].sort();
  return {
    listed,
    repo: scan.names,
    onlyListed: difference(listed, scan.names),
    onlyRepo: difference(scan.names, listed),
    nestedSkillFiles: scan.nestedSkillFiles,
    dirsWithoutSkillMd: scan.dirsWithoutSkillMd,
    invalidNames: scan.invalidNames,
    skippedSymlinks: scan.skippedSymlinks,
    declaredCount: parsed.declaredCount,
  };
}

/** Empty means the contract holds. Every entry is one operator-actionable line. */
export function formatSkillsInventoryParityFailures(report: SkillsInventoryParityReport): string[] {
  const failures: string[] = [];
  if (report.listed.length === 0) {
    failures.push('the skills CLI --list output named no skills (parser drift, or the CLI failed upstream)');
  }
  if (report.declaredCount !== null && report.declaredCount !== report.listed.length) {
    failures.push(
      `the CLI reported "Found ${report.declaredCount} skills" but ${report.listed.length} name(s) were parsed`,
    );
  }
  if (report.skippedSymlinks.length > 0) {
    failures.push(
      `symlinks under skills/ are never published (the installer copies physical files): ${report.skippedSymlinks.join(', ')}`,
    );
  }
  if (report.invalidNames.length > 0) {
    failures.push(`skills/ directory names are not safe path segments: ${report.invalidNames.join(', ')}`);
  }
  if (report.dirsWithoutSkillMd.length > 0) {
    failures.push(`skills/ directories without a top-level SKILL.md: ${report.dirsWithoutSkillMd.join(', ')}`);
  }
  if (report.nestedSkillFiles.length > 0) {
    failures.push(
      `nested SKILL.md under skills/ (only skills/<name>/SKILL.md ships): ${report.nestedSkillFiles.join(', ')}`,
    );
  }
  if (report.onlyListed.length > 0) {
    failures.push(`named by the skills CLI but absent from skills/: ${report.onlyListed.join(', ')}`);
  }
  if (report.onlyRepo.length > 0) {
    failures.push(`present in skills/ but never named by the skills CLI: ${report.onlyRepo.join(', ')}`);
  }
  return failures;
}

interface CliOptions {
  repoRoot: string;
  listFile: string | null;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let repoRoot = process.cwd();
  let listFile: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--repo' || flag === '--list-file') {
      if (value === undefined) throw new Error(`${flag} requires a value`);
      if (flag === '--repo') repoRoot = isAbsolute(value) ? value : resolve(process.cwd(), value);
      else listFile = isAbsolute(value) ? value : resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${flag}`);
  }
  return { repoRoot, listFile };
}

async function readListInput(listFile: string | null): Promise<string> {
  if (listFile !== null) return readFileSync(listFile, 'utf8');
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const skillsRoot = join(options.repoRoot, 'skills');
  if (!statSync(skillsRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`no skills/ directory under ${options.repoRoot}`);
  }
  const report = evaluateSkillsInventoryParity(await readListInput(options.listFile), options.repoRoot);
  const failures = formatSkillsInventoryParityFailures(report);
  if (failures.length === 0) {
    console.log(`skills-inventory-parity: OK — ${report.repo.length} skills agree (${report.repo.join(', ')})`);
    return;
  }
  for (const failure of failures) console.error(`skills-inventory-parity: ${failure}`);
  console.error(`skills-inventory-parity: --list named [${report.listed.join(', ')}]`);
  console.error(`skills-inventory-parity: skills/ holds [${report.repo.join(', ')}]`);
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`skills-inventory-parity: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
