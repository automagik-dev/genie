/**
 * Idempotent, backup-first merge of the `mcp_servers.genie` entry into a Hermes
 * `config.yaml`.
 *
 * ## Design contract
 *
 * The one non-negotiable rule is **never clobber unrelated user config**. A full
 * parse/re-serialize round-trip would reorder keys, drop comments, and reflow
 * scalars, so instead this module performs a *targeted text-level merge* and
 * only ever rewrites the bytes it owns. Untouched lines survive verbatim.
 *
 * `Bun.YAML.parse` is used **only to read** the current state (to decide
 * created/updated/unchanged and to compare the existing entry). Writes are pure
 * text surgery.
 *
 * ## Managed-marker rule
 *
 * When this module writes the genie entry it wraps it in marker comments:
 *
 * ```yaml
 * mcp_servers:
 *   # genie:managed:mcp_servers.genie — begin (managed by genie; edit via genie only)
 *   genie:
 *     command: "/abs/bin/genie"
 *     args:
 *       - mcp
 *   # genie:managed:mcp_servers.genie — end
 * ```
 *
 * Genie owns exactly the region between its markers. On subsequent runs it finds
 * that region and replaces only it. Resolution order when a write is required:
 *
 * 1. **Marker region present** → replace it in place (the steady-state path).
 * 2. **`mcp_servers:` present, unmarked `genie:` child present** → replace that
 *    child's line range with the marker-wrapped canonical block; every sibling
 *    server is preserved. This is how a pre-existing hand-written genie entry is
 *    adopted the first time its command drifts from canonical.
 * 3. **`mcp_servers:` present, no genie child** → append the marker-wrapped
 *    block as the last child of the existing block; siblings preserved.
 * 4. **No `mcp_servers:` key** → append a fresh `mcp_servers:` section at EOF;
 *    all prior content is preserved byte-for-byte as a prefix.
 *
 * A top-level `mcp_servers:` carrying an **inline/flow/scalar value on the same
 * line** (`mcp_servers: {}`, `mcp_servers: {other: {...}}`, `mcp_servers: null`)
 * is deliberately *not* merged: merging a block child into a flow value would
 * require re-serializing user bytes, and blindly appending a second `mcp_servers:`
 * key produces spec-invalid duplicate-key YAML or silently drops the user's
 * siblings on last-wins. Such a config is refused with a typed `HermesConfigError`
 * before any backup or write, so the original file survives byte-for-byte.
 *
 * The genie entry itself is genie-owned: its content is rewritten to canonical
 * whenever it differs. Everything *outside* the entry (other servers, other
 * top-level keys, comments, formatting) is never touched. A pre-existing entry
 * that already satisfies the canonical command/args is left completely alone
 * (no write, no backup), so user-added fields inside a matching entry survive.
 *
 * Backups: any mutation of an existing non-empty file writes a
 * `<config>.genie-backup-<timestamp>` copy of the original bytes first. Creating
 * a brand-new file is not a mutation and writes no backup.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { resolveGenieHome } from './genie-home.js';

/** Typed error for every Hermes config helper failure. */
export class HermesConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HermesConfigError';
    this.code = code;
  }
}

/** Canonical shape of the managed `mcp_servers.genie` entry. */
export interface McpGenieEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ResolveGenieBinaryOptions {
  /** Explicit absolute override. Empty string is an error; relative is an error. */
  binaryPath?: string;
  /** Global genie root; defaults to `resolveGenieHome()`. */
  genieHome?: string;
  /** Injectable existence check so callers/tests can prove the "preferred" branch. */
  fsExists?: (path: string) => boolean;
}

export interface MergeMcpGenieOptions extends ResolveGenieBinaryOptions {
  /** Path to the Hermes `config.yaml`. */
  configPath: string;
  /** Emit `env.GENIE_HOME` alongside the command. */
  includeGenieHomeEnv?: boolean;
  /** Clock injection for deterministic backup filenames. */
  now?: Date;
}

export interface MergeMcpGenieResult {
  status: 'created' | 'updated' | 'unchanged';
  path: string;
  backupPath?: string;
  entry: McpGenieEntry;
}

const MARKER_BEGIN = '# genie:managed:mcp_servers.genie — begin (managed by genie; edit via genie only)';
const MARKER_END = '# genie:managed:mcp_servers.genie — end';

/**
 * Resolve the absolute genie binary for the MCP command. Prefers
 * `$GENIE_HOME/bin/genie` when it exists (the installed layout), otherwise falls
 * back to an explicit absolute override. An empty or relative override, or a
 * total failure to resolve an absolute path, is a typed error.
 */
export function resolveGenieBinaryPath(opts: ResolveGenieBinaryOptions = {}): string {
  const fsExists = opts.fsExists ?? existsSync;
  const genieHome = opts.genieHome ?? resolveGenieHome();

  if (opts.binaryPath !== undefined) {
    if (opts.binaryPath.trim() === '') {
      throw new HermesConfigError('empty-binary-path', 'genie binary path is empty');
    }
    if (!isAbsolute(opts.binaryPath)) {
      throw new HermesConfigError('relative-binary-path', `genie binary path must be absolute: ${opts.binaryPath}`);
    }
  }

  const preferred = join(genieHome, 'bin', 'genie');
  if (fsExists(preferred)) return preferred;
  if (opts.binaryPath) return opts.binaryPath;
  throw new HermesConfigError(
    'unresolved-binary-path',
    `cannot resolve an absolute genie binary; ${preferred} not found and no binaryPath given`,
  );
}

/** Merge `mcp_servers.genie` into the Hermes config, idempotent and backup-first. */
export function mergeMcpServersGenie(opts: MergeMcpGenieOptions): MergeMcpGenieResult {
  const now = opts.now ?? new Date();
  const genieHome = opts.genieHome ?? resolveGenieHome();
  const command = resolveGenieBinaryPath({ binaryPath: opts.binaryPath, genieHome, fsExists: opts.fsExists });

  const entry: McpGenieEntry = { command, args: ['mcp'] };
  if (opts.includeGenieHomeEnv) entry.env = { GENIE_HOME: genieHome };

  const exists = existsSync(opts.configPath);
  const original = exists ? readFileSync(opts.configPath, 'utf8') : '';
  const existingGenie = exists ? readGenieEntry(original) : undefined;

  if (existingGenie && entrySatisfies(existingGenie, entry)) {
    return { status: 'unchanged', path: opts.configPath, entry };
  }

  const status: 'created' | 'updated' = existingGenie ? 'updated' : 'created';
  const nextText = spliceGenieEntry(original, entry);

  let backupPath: string | undefined;
  if (exists && original.length > 0) {
    backupPath = writeBackup(opts.configPath, now);
  }
  mkdirSync(dirname(opts.configPath), { recursive: true });
  writeFileSync(opts.configPath, nextText, 'utf8');
  return { status, path: opts.configPath, backupPath, entry };
}

/** Read the parsed `mcp_servers.genie` object, or undefined if absent/malformed. */
function readGenieEntry(text: string): McpGenieEntry | undefined {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const servers = parsed.mcp_servers;
  if (!isRecord(servers)) return undefined;
  const genie = servers.genie;
  if (!isRecord(genie)) return undefined;
  const command = typeof genie.command === 'string' ? genie.command : undefined;
  const args = Array.isArray(genie.args) ? genie.args.filter((a): a is string => typeof a === 'string') : [];
  if (command === undefined) return undefined;
  const env = isRecord(genie.env)
    ? Object.fromEntries(Object.entries(genie.env).filter(([, v]) => typeof v === 'string'))
    : undefined;
  return env ? { command, args, env: env as Record<string, string> } : { command, args };
}

/** The desired entry is satisfied when the existing one carries the same command, args, and any desired env. */
function entrySatisfies(existing: McpGenieEntry, desired: McpGenieEntry): boolean {
  if (existing.command !== desired.command) return false;
  if (!stringArraysEqual(existing.args, desired.args)) return false;
  if (desired.env) {
    for (const [k, v] of Object.entries(desired.env)) {
      if (existing.env?.[k] !== v) return false;
    }
  }
  return true;
}

/** Produce the next config text with the genie entry merged in via targeted surgery. */
function spliceGenieEntry(original: string, entry: McpGenieEntry): string {
  if (original.length === 0) {
    return `${['mcp_servers:', ...renderManagedBlock(2, entry)].join('\n')}\n`;
  }

  const { lines, trailingNewline } = toLines(original);

  const markerRange = findMarkerRange(lines);
  if (markerRange) {
    const indent = indentOf(lines[markerRange.begin]);
    lines.splice(markerRange.begin, markerRange.end - markerRange.begin + 1, ...renderManagedBlock(indent, entry));
    return fromLines(lines, trailingNewline);
  }

  assertNoInlineTopLevelKey(lines, 'mcp_servers');

  const header = findTopLevelKeyLine(lines, 'mcp_servers');
  if (header >= 0) {
    spliceIntoBlock(lines, header, entry);
    return fromLines(lines, trailingNewline);
  }

  return appendMcpServersSection(original, entry);
}

/** Insert/replace the genie child inside an existing `mcp_servers:` block. */
function spliceIntoBlock(lines: string[], header: number, entry: McpGenieEntry): void {
  const blockEnd = blockEndIndex(lines, header);
  const childIndent = childIndentOf(lines, header, blockEnd);
  const existing = findChildRange(lines, header + 1, blockEnd, childIndent, 'genie');
  const block = renderManagedBlock(childIndent, entry);
  if (existing) {
    lines.splice(existing.start, existing.end - existing.start, ...block);
  } else {
    lines.splice(blockEnd, 0, ...block);
  }
}

/** Append a fresh `mcp_servers:` section, preserving all prior bytes as a prefix. */
function appendMcpServersSection(original: string, entry: McpGenieEntry): string {
  const section = `${['mcp_servers:', ...renderManagedBlock(2, entry)].join('\n')}\n`;
  const separator = original.endsWith('\n') ? '' : '\n';
  return `${original}${separator}${section}`;
}

/** Marker-wrapped genie entry lines rendered at the given indent. */
function renderManagedBlock(indent: number, entry: McpGenieEntry): string[] {
  const pad = ' '.repeat(indent);
  const out = [
    `${pad}${MARKER_BEGIN}`,
    `${pad}genie:`,
    `${pad}  command: ${yamlScalar(entry.command)}`,
    `${pad}  args:`,
    ...entry.args.map((arg) => `${pad}    - ${yamlScalar(arg)}`),
  ];
  if (entry.env) {
    out.push(`${pad}  env:`);
    for (const [key, value] of Object.entries(entry.env)) out.push(`${pad}    ${key}: ${yamlScalar(value)}`);
  }
  out.push(`${pad}${MARKER_END}`);
  return out;
}

/** Double-quoted scalar — always valid YAML for the path/env strings we emit. */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function writeBackup(configPath: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backupPath = `${configPath}.genie-backup-${stamp}`;
  copyFileSync(configPath, backupPath);
  return backupPath;
}

// --- line-level helpers (shared indentation surgery) ---

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

function findMarkerRange(lines: string[]): { begin: number; end: number } | null {
  let begin = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (begin < 0 && trimmed === MARKER_BEGIN) begin = i;
    else if (begin >= 0 && trimmed === MARKER_END) return { begin, end: i };
  }
  return null;
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

/** First line index after a block header where the block's children end. */
function blockEndIndex(lines: string[], header: number): number {
  let end = header + 1;
  while (end < lines.length && (isBlank(lines[end]) || indentOf(lines[end]) > 0)) end++;
  return end;
}

/** Indentation of the first non-blank child line, defaulting to 2. */
function childIndentOf(lines: string[], header: number, blockEnd: number): number {
  for (let i = header + 1; i < blockEnd; i++) {
    if (!isBlank(lines[i])) return indentOf(lines[i]);
  }
  return 2;
}

/** Line range [start, end) of a named child entry at a given indent. */
function findChildRange(
  lines: string[],
  start: number,
  blockEnd: number,
  childIndent: number,
  name: string,
): { start: number; end: number } | null {
  const keyRe = new RegExp(`^ {${childIndent}}${name}:\\s*(.*)$`);
  let found = -1;
  for (let i = start; i < blockEnd; i++) {
    if (!isBlank(lines[i]) && indentOf(lines[i]) === childIndent && keyRe.test(lines[i])) {
      found = i;
      break;
    }
  }
  if (found < 0) return null;
  let end = found + 1;
  while (end < blockEnd && (isBlank(lines[end]) || indentOf(lines[end]) > childIndent)) end++;
  return { start: found, end };
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
