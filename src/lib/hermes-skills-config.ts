/**
 * Idempotent, backup-first merge of the Genie product-skills root into a Hermes
 * `config.yaml`'s `skills.external_dirs`, plus a digest-managed copy fallback for
 * older Hermes builds that cannot register external skill dirs.
 *
 * ## Product-skills root resolution (fallback chain)
 *
 * `$GENIE_HOME/skills` is materialized on every `genie install`/`genie update`
 * (see `syncAuxiliaryContent`/`normalizeAuxLayout`); it is the canonical answer.
 * But it only exists after a real install, so resolution degrades gracefully:
 *
 * 1. an explicit `skillsRoot` override (a deliberate dev/CI choice — highest
 *    precedence when provided), then
 * 2. `$GENIE_HOME/skills` (the installed layout), then
 * 3. `$GENIE_HOME/plugins/genie/skills` (the byte-checked plugin mirror, also
 *    converged by install/update).
 *
 * A candidate counts only when **populated** — the directory exists and holds at
 * least one `<name>/SKILL.md` — so an empty stub never shadows a real mirror. If no
 * candidate is populated a typed `HermesConfigError` is thrown; the caller must
 * never register a non-existent dir into Hermes config. See
 * `.genie/wishes/hermes-homogeneous-integration/reports/skills-root-resolution.md`.
 *
 * ## Merge contract
 *
 * Exactly one entry — the resolved root — is merged into `skills.external_dirs`.
 * The managed item carries a trailing `# genie:managed:skills.external_dirs`
 * marker so that a later root change replaces that single line instead of
 * accumulating a second genie entry. All other list items and unrelated keys are
 * preserved byte-for-byte; `Bun.YAML.parse` is used only to read current state.
 * Presence of the resolved root in the parsed list means "unchanged" (no write,
 * no backup). Any mutation of an existing non-empty file writes a
 * `<config>.genie-backup-<timestamp>` copy first.
 *
 * A top-level `skills:` carrying an **inline/flow/scalar value on the same line**
 * (`skills: {}`, `skills: {external_dirs: [/x]}`, `skills: null`) is deliberately
 * *not* merged: merging into a flow value would require re-serializing user bytes,
 * and blindly appending a second `skills:` key produces spec-invalid duplicate-key
 * YAML or silently drops the user's siblings on last-wins. Such a config is refused
 * with a typed `HermesConfigError` before any backup or write, so the original file
 * survives byte-for-byte.
 *
 * ## Older-Hermes fallback
 *
 * `copyProductSkillsDigestManaged` stages the resolved skills tree into a
 * Hermes-managed directory and records a content digest manifest, so a second
 * run with an unchanged source performs no copy. This is the explicit,
 * opt-in path for Hermes builds without `skills.external_dirs` support.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { resolveGenieHome } from './genie-home.js';
import { HermesConfigError } from './hermes-mcp-config.js';

export interface ResolveSkillsRootOptions {
  /** Explicit absolute product-skills root override (highest precedence). */
  skillsRoot?: string;
  /** Global genie root; defaults to `resolveGenieHome()`. */
  genieHome?: string;
  /** Injectable "populated" predicate (defaults to a real `<name>/SKILL.md` scan). */
  isPopulated?: (root: string) => boolean;
}

export interface MergeSkillsExternalDirOptions extends ResolveSkillsRootOptions {
  /** Path to the Hermes `config.yaml`. */
  configPath: string;
  /** Clock injection for deterministic backup filenames. */
  now?: Date;
}

export interface MergeSkillsResult {
  status: 'created' | 'updated' | 'unchanged';
  path: string;
  backupPath?: string;
  skillsRoot: string;
}

export interface CopyProductSkillsOptions extends ResolveSkillsRootOptions {
  /** Hermes-managed destination directory for the copied skills tree. */
  targetDir: string;
}

export interface CopyProductSkillsResult {
  status: 'copied' | 'unchanged';
  targetDir: string;
  skillsRoot: string;
  digest: string;
}

const MARKER = '# genie:managed:skills.external_dirs';
const DIGEST_MANIFEST = '.genie-skills-digest.json';

/** Resolve the canonical product-skills root via the documented fallback chain. */
export function resolveProductSkillsRoot(opts: ResolveSkillsRootOptions = {}): string {
  const genieHome = opts.genieHome ?? resolveGenieHome();
  const populated = opts.isPopulated ?? isPopulatedSkillsRoot;

  const candidates: string[] = [];
  if (opts.skillsRoot !== undefined) {
    if (opts.skillsRoot.trim() === '') {
      throw new HermesConfigError('empty-skills-root', 'product-skills root override is empty');
    }
    if (!isAbsolute(opts.skillsRoot)) {
      throw new HermesConfigError('relative-skills-root', `product-skills root must be absolute: ${opts.skillsRoot}`);
    }
    candidates.push(opts.skillsRoot);
  }
  candidates.push(join(genieHome, 'skills'));
  candidates.push(join(genieHome, 'plugins', 'genie', 'skills'));

  for (const candidate of candidates) {
    if (populated(candidate)) return candidate;
  }
  throw new HermesConfigError(
    'unresolved-skills-root',
    `no populated product-skills root found (checked: ${candidates.join(', ')})`,
  );
}

/** A skills root is populated when it holds at least one `<name>/SKILL.md`. */
function isPopulatedSkillsRoot(root: string): boolean {
  if (!existsSync(root)) return false;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, entry.name, 'SKILL.md'))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Merge the resolved product-skills root into `skills.external_dirs`. */
export function mergeSkillsExternalDir(opts: MergeSkillsExternalDirOptions): MergeSkillsResult {
  const now = opts.now ?? new Date();
  const skillsRoot = resolveProductSkillsRoot(opts);

  const exists = existsSync(opts.configPath);
  const original = exists ? readFileSync(opts.configPath, 'utf8') : '';
  if (exists && listedExternalDirs(original).includes(skillsRoot)) {
    return { status: 'unchanged', path: opts.configPath, skillsRoot };
  }

  const status: 'created' | 'updated' = exists && original.length > 0 ? 'updated' : 'created';
  const nextText = spliceExternalDir(original, skillsRoot);

  let backupPath: string | undefined;
  if (exists && original.length > 0) {
    backupPath = writeBackup(opts.configPath, now);
  }
  mkdirSync(dirname(opts.configPath), { recursive: true });
  writeFileSync(opts.configPath, nextText, 'utf8');
  return { status, path: opts.configPath, backupPath, skillsRoot };
}

/** Stage the resolved skills tree into a Hermes-managed dir, digest-idempotent. */
export function copyProductSkillsDigestManaged(opts: CopyProductSkillsOptions): CopyProductSkillsResult {
  const skillsRoot = resolveProductSkillsRoot(opts);
  const digest = digestTree(skillsRoot);
  const manifestPath = join(opts.targetDir, DIGEST_MANIFEST);

  if (existsSync(manifestPath) && readManifestDigest(manifestPath) === digest) {
    return { status: 'unchanged', targetDir: opts.targetDir, skillsRoot, digest };
  }

  // Prune the managed target before re-copying so a skill removed upstream does not
  // linger stale. The target is genie-managed by definition, so a full replace is safe.
  rmSync(opts.targetDir, { recursive: true, force: true });
  mkdirSync(opts.targetDir, { recursive: true });
  cpSync(skillsRoot, opts.targetDir, { recursive: true });
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ digest, source: skillsRoot, syncedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  return { status: 'copied', targetDir: opts.targetDir, skillsRoot, digest };
}

/** Parsed `skills.external_dirs` list, or [] if absent/malformed. */
function listedExternalDirs(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.skills)) return [];
  const dirs = parsed.skills.external_dirs;
  return Array.isArray(dirs) ? dirs.filter((d): d is string => typeof d === 'string') : [];
}

/** Produce the next config text with exactly one managed external_dirs entry. */
function spliceExternalDir(original: string, skillsRoot: string): string {
  const managedItem = (indent: number) => `${' '.repeat(indent)}- ${yamlScalar(skillsRoot)}  ${MARKER}`;

  if (original.length === 0) {
    return `${['skills:', '  external_dirs:', managedItem(4)].join('\n')}\n`;
  }

  const { lines, trailingNewline } = toLines(original);
  assertNoInlineTopLevelKey(lines, 'skills');
  const skillsHeader = findTopLevelKeyLine(lines, 'skills');
  if (skillsHeader < 0) {
    const section = `${['skills:', '  external_dirs:', managedItem(4)].join('\n')}\n`;
    return `${original}${original.endsWith('\n') ? '' : '\n'}${section}`;
  }

  const skillsEnd = blockEndIndex(lines, skillsHeader);
  const childIndent = childIndentOf(lines, skillsHeader, skillsEnd);
  const extHeader = findChildKeyLine(lines, skillsHeader + 1, skillsEnd, childIndent, 'external_dirs');

  if (extHeader < 0) {
    lines.splice(skillsEnd, 0, `${' '.repeat(childIndent)}external_dirs:`, managedItem(childIndent + 2));
    return fromLines(lines, trailingNewline);
  }

  const listEnd = blockEndIndexFrom(lines, extHeader, skillsEnd, childIndent);
  const itemIndent = listItemIndentOf(lines, extHeader + 1, listEnd, childIndent);
  const managed = findMarkedItem(lines, extHeader + 1, listEnd);
  if (managed >= 0) {
    lines.splice(managed, 1, managedItem(itemIndent));
  } else {
    lines.splice(listEnd, 0, managedItem(itemIndent));
  }
  return fromLines(lines, trailingNewline);
}

// --- digest helpers ---

function digestTree(root: string): string {
  const files = walkFiles(root).sort();
  const hash = createHash('sha256');
  hash.update('genie-hermes-skills-v1\0');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(root, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(relative(root, abs));
    }
  };
  walk(root);
  return out;
}

function readManifestDigest(manifestPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return isRecord(parsed) && typeof parsed.digest === 'string' ? parsed.digest : undefined;
  } catch {
    return undefined;
  }
}

function writeBackup(configPath: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backupPath = `${configPath}.genie-backup-${stamp}`;
  copyFileSync(configPath, backupPath);
  return backupPath;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

// --- line-level helpers ---

function toLines(text: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), trailingNewline };
}

function fromLines(lines: string[], trailingNewline: boolean): string {
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function indentOf(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function findTopLevelKeyLine(lines: string[], key: string): number {
  const re = new RegExp(`^${key}:\\s*(#.*)?$`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

/**
 * Refuse to merge when a top-level `key:` carries an inline/flow/scalar value on
 * the same line (e.g. `key: {}`, `key: {a: b}`, `key: null`). Only a bare block
 * header (`key:` optionally trailed by a comment) is mergeable; anything else can
 * only be merged by re-serializing user bytes, so we raise a typed error before
 * any write instead of appending a duplicate top-level key.
 */
function assertNoInlineTopLevelKey(lines: string[], key: string): void {
  const keyLine = new RegExp(`^${key}:(?:\\s|$)`);
  const blockHeader = new RegExp(`^${key}:\\s*(#.*)?$`);
  for (const line of lines) {
    if (keyLine.test(line) && !blockHeader.test(line)) {
      throw new HermesConfigError(
        'inline-top-level-key',
        `cannot merge: top-level "${key}" has an inline value on the same line (${line.trim()}); rewrite it as a block mapping so genie can merge without deleting your entries`,
      );
    }
  }
}

/** End of a top-level block: first following line at indent 0. */
function blockEndIndex(lines: string[], header: number): number {
  let end = header + 1;
  while (end < lines.length && (isBlank(lines[end]) || indentOf(lines[end]) > 0)) end++;
  return end;
}

/** End of a nested block whose header sits at `parentIndent`. */
function blockEndIndexFrom(lines: string[], header: number, hardEnd: number, parentIndent: number): number {
  let end = header + 1;
  while (end < hardEnd && (isBlank(lines[end]) || indentOf(lines[end]) > parentIndent)) end++;
  return end;
}

function childIndentOf(lines: string[], header: number, blockEnd: number): number {
  for (let i = header + 1; i < blockEnd; i++) {
    if (!isBlank(lines[i])) return indentOf(lines[i]);
  }
  return 2;
}

function findChildKeyLine(lines: string[], start: number, blockEnd: number, childIndent: number, name: string): number {
  const re = new RegExp(`^ {${childIndent}}${name}:\\s*(#.*)?$`);
  for (let i = start; i < blockEnd; i++) {
    if (indentOf(lines[i]) === childIndent && re.test(lines[i])) return i;
  }
  return -1;
}

/** Indentation of the first list item, defaulting to childIndent + 2. */
function listItemIndentOf(lines: string[], start: number, listEnd: number, childIndent: number): number {
  for (let i = start; i < listEnd; i++) {
    if (!isBlank(lines[i]) && lines[i].trimStart().startsWith('- ')) return indentOf(lines[i]);
  }
  return childIndent + 2;
}

function findMarkedItem(lines: string[], start: number, listEnd: number): number {
  for (let i = start; i < listEnd; i++) {
    if (lines[i].includes(MARKER)) return i;
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
