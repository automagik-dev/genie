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
 * with a typed `HermesConfigError('inline-top-level-key')` before any backup or
 * write, so the original file survives byte-for-byte.
 *
 * The same fail-closed philosophy extends one level down. Inside a block-style
 * `skills:`, a nested `external_dirs` child is merged **in place** — never appended
 * as a second key:
 *   - a block-style child gets the single managed entry merged/replaced inside it;
 *   - an inline **empty** child (`external_dirs: []`) is rewritten to the managed
 *     block, leaving every surrounding sibling byte-for-byte;
 *   - an inline **non-empty** child (`external_dirs: [/x]`) cannot be merged without
 *     re-serializing user bytes, so it is refused with a typed
 *     `HermesConfigError('inline-nested-key')` before any backup or write.
 *
 * ## Duplicate-key repair (DF-1)
 *
 * An earlier buggy genie release could append a second `external_dirs:` child
 * key under `skills:` instead of merging into the existing one — spec-invalid
 * duplicate-key YAML that `Bun.YAML.parse` silently resolves last-wins, so it
 * is invisible to any check that only reads the parsed document and survives
 * every future merge untouched. `mergeSkillsExternalDir` detects this textual
 * duplicate BEFORE deciding `unchanged`/`updated`/`created` and repairs it when
 * safe: exactly one occurrence carries the genie marker (the managed entry) and
 * every other occurrence is either empty (`[]` / an empty block) or a subset of
 * the managed entry's own items — those duplicates are collapsed away, leaving
 * exactly one `external_dirs` key. Any other duplicate shape (two non-empty
 * non-managed lists, or content genie cannot prove is safe to drop) is refused
 * with a typed `HermesConfigError` before any backup or write, so the original
 * file survives byte-for-byte — refusal is always acceptable, corruption never
 * is.
 *
 * ## Stale-marker orphan avoidance
 *
 * The old "unchanged" check only asked whether the resolved root appeared
 * *anywhere* in the parsed `external_dirs` list. That let a stale scenario slip
 * through forever: the genie-marked entry still points at a previous root while
 * the current root also appears as a separate, hand-added, unmarked entry — the
 * marker never migrates, orphaning it. The check now asks specifically whether
 * the *marked* entry (when one exists) already equals the resolved root; if not,
 * the marked line is rewritten to the current root exactly like a normal root
 * change, and any genuine user-added unmarked entry is left untouched.
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
  const diskOriginal = exists ? readFileSync(opts.configPath, 'utf8') : '';

  // DF-1: repair a spec-invalid duplicate `external_dirs` child key BEFORE any
  // other decision — see the module doc comment. Throws (fail-closed) when the
  // duplicate shape cannot be proven safe to collapse.
  const repaired = exists ? repairDuplicateSkillsExternalDirs(diskOriginal) : diskOriginal;
  const wasRepaired = repaired !== diskOriginal;

  // "Already correct" now asks specifically about the *marked* entry (when one
  // exists) rather than "root appears anywhere" — see the stale-marker-orphan
  // doc comment above. A repair always forces a write, since the duplicate key
  // itself must be removed from disk even if the managed value is unchanged.
  const marked = exists ? markedExternalDirValue(repaired) : undefined;
  const rootListed = exists ? listedExternalDirs(repaired).includes(skillsRoot) : false;
  const alreadyCorrect = marked !== undefined ? marked === skillsRoot : rootListed;
  if (exists && !wasRepaired && alreadyCorrect) {
    return { status: 'unchanged', path: opts.configPath, skillsRoot };
  }

  const status: 'created' | 'updated' = exists && diskOriginal.length > 0 ? 'updated' : 'created';
  const nextText = spliceExternalDir(repaired, skillsRoot);
  assertMergedSkillsInvariant(nextText, skillsRoot);

  let backupPath: string | undefined;
  if (exists && diskOriginal.length > 0) {
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

/**
 * The value carried by the genie-marked `external_dirs` list item, or
 * `undefined` when no marker is present anywhere in the text. Scans raw lines
 * rather than the parsed document: the parsed value alone cannot distinguish
 * "the marked item already equals the resolved root" from "the root merely
 * appears somewhere else in the list" — exactly the distinction the
 * stale-marker-orphan fix depends on.
 */
function markedExternalDirValue(text: string): string | undefined {
  const markerRe = new RegExp(`^\\s*-\\s+(.*?)\\s+${escapeRegExp(MARKER)}\\s*$`);
  for (const line of text.split('\n')) {
    const match = line.match(markerRe);
    if (!match) continue;
    try {
      const parsed = Bun.YAML.parse(match[1]);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* fall through to the raw token below */
    }
    return match[1].trim();
  }
  return undefined;
}

interface ExternalDirsOccurrence {
  headerIndex: number;
  kind: 'block' | 'inline';
  /** Item line range for a block occurrence; absent for an inline occurrence. */
  itemsRange?: { start: number; end: number };
  /** True only for an inline empty flow list (`external_dirs: []`). */
  isEmptyInline: boolean;
}

/**
 * Every `external_dirs` child-key occurrence under a `skills:` block, block or
 * inline, in document order. Unlike `findChildKeyLine`/`findInlineChildKeyLine`
 * (which each return only the FIRST match of their own kind), this is the
 * duplicate-detection primitive: a spec-invalid config can carry more than one
 * `external_dirs` key, mixing block and inline shapes.
 */
function findAllExternalDirsOccurrences(
  lines: string[],
  start: number,
  blockEnd: number,
  childIndent: number,
): ExternalDirsOccurrence[] {
  const blockRe = new RegExp(`^ {${childIndent}}external_dirs:\\s*(#.*)?$`);
  const inlinePrefix = new RegExp(`^ {${childIndent}}external_dirs:(?:\\s|$)`);
  const emptyRe = new RegExp(`^ {${childIndent}}external_dirs:\\s+\\[\\s*\\]\\s*(#.*)?$`);
  const out: ExternalDirsOccurrence[] = [];
  for (let i = start; i < blockEnd; i++) {
    if (indentOf(lines[i]) !== childIndent) continue;
    if (blockRe.test(lines[i])) {
      const end = blockEndIndexFrom(lines, i, blockEnd, childIndent);
      out.push({ headerIndex: i, kind: 'block', itemsRange: { start: i + 1, end }, isEmptyInline: false });
    } else if (inlinePrefix.test(lines[i])) {
      out.push({ headerIndex: i, kind: 'inline', isEmptyInline: emptyRe.test(lines[i]) });
    }
  }
  return out;
}

/** Parsed list-item values of an occurrence, plus whether any item carries the genie marker. */
function occurrenceItems(lines: string[], occ: ExternalDirsOccurrence): { items: string[]; hasMarker: boolean } {
  if (occ.kind === 'inline') {
    // An empty inline list has no items; a non-empty inline list cannot be
    // safely compared without re-serializing user bytes, so it is treated as an
    // opaque, never-subset-safe blob (a sentinel that matches nothing).
    return occ.isEmptyInline ? { items: [], hasMarker: false } : { items: ['<inline-non-empty>'], hasMarker: false };
  }
  const items: string[] = [];
  let hasMarker = false;
  const range = occ.itemsRange;
  if (!range) return { items, hasMarker };
  for (let i = range.start; i < range.end; i++) {
    const line = lines[i];
    if (isSkippable(line)) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith('-')) continue;
    const withMarker = line.includes(MARKER);
    const valuePart = trimmed
      .replace(/^-\s*/, '')
      .replace(new RegExp(`\\s*${escapeRegExp(MARKER)}\\s*$`), '')
      .trim();
    let value: string;
    try {
      const parsed = Bun.YAML.parse(valuePart);
      value = typeof parsed === 'string' ? parsed : valuePart;
    } catch {
      value = valuePart;
    }
    items.push(value);
    if (withMarker) hasMarker = true;
  }
  return { items, hasMarker };
}

/**
 * DF-1 repair: detect and collapse a spec-invalid duplicate `external_dirs`
 * child key under `skills:` — see the module doc comment for the full
 * contract. Returns `original` unchanged when there is nothing to repair
 * (fewer than 2 occurrences, or no `skills:` block at all — an inline
 * top-level `skills:` is left for `assertNoInlineTopLevelKey` to refuse
 * downstream). Throws a typed `HermesConfigError` for any duplicate shape that
 * cannot be proven safe to collapse.
 */
function repairDuplicateSkillsExternalDirs(original: string): string {
  if (original.length === 0) return original;
  const { lines, trailingNewline } = toLines(original);
  const skillsHeader = findTopLevelKeyLine(lines, 'skills');
  if (skillsHeader < 0) return original;

  const skillsEnd = blockEndIndex(lines, skillsHeader);
  const childIndent = childIndentOf(lines, skillsHeader, skillsEnd);
  const occurrences = findAllExternalDirsOccurrences(lines, skillsHeader + 1, skillsEnd, childIndent);
  if (occurrences.length < 2) return original;

  const classified = occurrences.map((occ) => ({ occ, ...occurrenceItems(lines, occ) }));
  const marked = classified.filter((c) => c.hasMarker);
  if (marked.length !== 1) {
    throw new HermesConfigError(
      'duplicate-external-dirs-unmarked',
      `cannot repair: "skills.external_dirs" appears ${occurrences.length} times under "skills:" and ${marked.length} of them carry the genie marker (expected exactly 1); resolve the duplicate manually`,
    );
  }
  const managed = marked[0];
  const managedItemSet = new Set(managed.items);
  for (const other of classified) {
    if (other === managed) continue;
    const safe = other.items.length === 0 || other.items.every((item) => managedItemSet.has(item));
    if (!safe) {
      throw new HermesConfigError(
        'duplicate-external-dirs-conflict',
        `cannot repair: a duplicate "external_dirs" under "skills:" (line ${other.occ.headerIndex + 1}) has entries genie cannot prove are safe to drop; resolve the duplicate manually`,
      );
    }
  }

  // Safe: drop every non-managed occurrence's lines entirely, keeping the
  // managed one exactly as-is. Remove last-to-first so earlier indices survive.
  const sorted = [...occurrences].sort((a, b) => b.headerIndex - a.headerIndex);
  for (const occ of sorted) {
    if (occ === managed.occ) continue;
    const delEnd = occ.kind === 'block' ? (occ.itemsRange?.end ?? occ.headerIndex + 1) : occ.headerIndex + 1;
    lines.splice(occ.headerIndex, delEnd - occ.headerIndex);
  }
  return fromLines(lines, trailingNewline);
}

/**
 * Read-only textual duplicate-key detector for `genie doctor` — mirrors the
 * repair machinery's occurrence scan but never repairs or throws. True when
 * `skills.external_dirs` appears more than once under `skills:`, even if the
 * parsed document happens to look correct (last-wins hides the duplicate from
 * any parse-only check).
 */
export function hasDuplicateSkillsExternalDirsKeys(text: string): boolean {
  if (text.length === 0) return false;
  const { lines } = toLines(text);
  const header = findTopLevelKeyLine(lines, 'skills');
  if (header < 0) return false;
  const blockEnd = blockEndIndex(lines, header);
  const childIndent = childIndentOf(lines, header, blockEnd);
  return findAllExternalDirsOccurrences(lines, header + 1, blockEnd, childIndent).length > 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Final fail-closed safety net: the line-level splice above handles every
 * documented shape (bare block, inline empty/non-empty child, comment lines
 * interleaved among children), but a sufficiently pathological comment layout
 * could still slip past the matchers undetected. Rather than trust that no such
 * layout exists, verify the actual output before it is ever written: it must
 * parse as YAML, and it must contain exactly one `skills.external_dirs` entry
 * equal to the resolved root (the never-clobber invariant — refusal is always
 * acceptable, corruption never is).
 */
function assertMergedSkillsInvariant(nextText: string, skillsRoot: string): void {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(nextText);
  } catch (err) {
    throw new HermesConfigError(
      'unparseable-merge-result',
      `refusing to write: merged config would not parse as YAML (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const dirs =
    isRecord(parsed) && isRecord(parsed.skills) && Array.isArray(parsed.skills.external_dirs)
      ? parsed.skills.external_dirs.filter((d): d is string => typeof d === 'string')
      : [];
  const occurrences = dirs.filter((d) => d === skillsRoot).length;
  if (occurrences !== 1) {
    throw new HermesConfigError(
      'unverified-merge',
      `refusing to write: merged config would contain ${occurrences} occurrence(s) of "${skillsRoot}" in skills.external_dirs instead of exactly 1`,
    );
  }
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
    const inline = findInlineChildKeyLine(lines, skillsHeader + 1, skillsEnd, childIndent, 'external_dirs');
    if (inline.index >= 0) {
      if (!inline.empty) {
        throw new HermesConfigError(
          'inline-nested-key',
          `cannot merge: nested "skills.external_dirs" has an inline non-empty value on the same line (${lines[inline.index].trim()}); rewrite it as a block list so genie can merge without deleting your entries`,
        );
      }
      // Inline empty `external_dirs: []` → replace that single line with the managed
      // block entry in place, preserving every surrounding sibling byte-for-byte.
      lines.splice(inline.index, 1, `${' '.repeat(childIndent)}external_dirs:`, managedItem(childIndent + 2));
      return fromLines(lines, trailingNewline);
    }
    lines.splice(skillsEnd, 0, `${' '.repeat(childIndent)}external_dirs:`, managedItem(childIndent + 2));
    return fromLines(lines, trailingNewline);
  }

  const listEnd = blockEndIndexFrom(lines, extHeader, skillsEnd, childIndent);
  const itemIndent = listItemIndentOf(lines, extHeader + 1, listEnd, childIndent);
  const managed = findMarkedItem(lines, extHeader + 1, listEnd);
  if (managed >= 0) {
    // Stale-marker orphan avoidance: if the resolved root ALREADY appears as a
    // separate, unmarked item (e.g. hand-added by a user, or left behind by an
    // older root), drop that redundant duplicate value first. Replacing only the
    // marked line while leaving the duplicate in place would produce two items
    // with the same value — violating the "exactly one occurrence" invariant
    // enforced below — and leaving the marker on its stale old-root value would
    // orphan it forever instead of migrating to the current root.
    const duplicate = findPlainItemWithValue(lines, extHeader + 1, listEnd, skillsRoot, managed);
    if (duplicate >= 0) {
      lines.splice(duplicate, 1);
      const adjusted = duplicate < managed ? managed - 1 : managed;
      lines.splice(adjusted, 1, managedItem(itemIndent));
    } else {
      lines.splice(managed, 1, managedItem(itemIndent));
    }
  } else {
    lines.splice(listEnd, 0, managedItem(itemIndent));
  }
  return fromLines(lines, trailingNewline);
}

/** Scalar value of a block list item line, stripping the leading `- ` and any trailing marker comment. */
function parseListItemValue(line: string): string {
  const withoutDash = line.trim().replace(/^-\s*/, '');
  const withoutMarker = withoutDash.replace(new RegExp(`\\s*${escapeRegExp(MARKER)}\\s*$`), '').trim();
  try {
    const parsed = Bun.YAML.parse(withoutMarker);
    return typeof parsed === 'string' ? parsed : withoutMarker;
  } catch {
    return withoutMarker;
  }
}

/** Index of a block list item (other than `excludeIndex`) whose value equals `value`, or -1. */
function findPlainItemWithValue(
  lines: string[],
  start: number,
  end: number,
  value: string,
  excludeIndex: number,
): number {
  for (let i = start; i < end; i++) {
    if (i === excludeIndex || isBlank(lines[i]) || !lines[i].trim().startsWith('-')) continue;
    if (parseListItemValue(lines[i]) === value) return i;
  }
  return -1;
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

/**
 * A YAML comment-only line is valid at ANY indentation and carries no structural
 * weight. Every boundary-detection helper below must treat it exactly like a
 * blank line: it never terminates a block and it is never mistaken for "the
 * first real child" when deriving a block's child indent.
 */
function isCommentOnly(line: string): boolean {
  return line.trim().startsWith('#');
}

/** True for a line with no structural weight: blank or comment-only. */
function isSkippable(line: string): boolean {
  return isBlank(line) || isCommentOnly(line);
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

/**
 * End of a top-level block: first following line at indent 0. A comment-only
 * line is skipped regardless of its own indentation — YAML comments are valid
 * at any column and never close a block on their own.
 */
function blockEndIndex(lines: string[], header: number): number {
  let end = header + 1;
  while (end < lines.length && (isCommentOnly(lines[end]) || isBlank(lines[end]) || indentOf(lines[end]) > 0)) end++;
  return end;
}

/** End of a nested block whose header sits at `parentIndent`. Comments never close it. */
function blockEndIndexFrom(lines: string[], header: number, hardEnd: number, parentIndent: number): number {
  let end = header + 1;
  while (end < hardEnd && (isCommentOnly(lines[end]) || isBlank(lines[end]) || indentOf(lines[end]) > parentIndent))
    end++;
  return end;
}

/** Indentation of the first real (non-blank, non-comment) child line. */
function childIndentOf(lines: string[], header: number, blockEnd: number): number {
  for (let i = header + 1; i < blockEnd; i++) {
    if (!isSkippable(lines[i])) return indentOf(lines[i]);
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

/**
 * Locate a nested child key that carries an inline/flow value on the same line
 * (e.g. `external_dirs: []`, `external_dirs: [/x]`) rather than a bare block
 * header. Block-style headers are handled by `findChildKeyLine`; this covers the
 * inline sibling class. `empty` is true only for an empty flow list (`[]`/`[ ]`),
 * which can be replaced in place; any other inline value is unmergeable.
 */
function findInlineChildKeyLine(
  lines: string[],
  start: number,
  blockEnd: number,
  childIndent: number,
  name: string,
): { index: number; empty: boolean } {
  const prefix = new RegExp(`^ {${childIndent}}${name}:(?:\\s|$)`);
  const bare = new RegExp(`^ {${childIndent}}${name}:\\s*(#.*)?$`);
  const empty = new RegExp(`^ {${childIndent}}${name}:\\s+\\[\\s*\\]\\s*(#.*)?$`);
  for (let i = start; i < blockEnd; i++) {
    if (indentOf(lines[i]) !== childIndent) continue;
    if (!prefix.test(lines[i]) || bare.test(lines[i])) continue;
    return { index: i, empty: empty.test(lines[i]) };
  }
  return { index: -1, empty: false };
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
