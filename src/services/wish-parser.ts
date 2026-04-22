/**
 * Markdown → WishDocument parser.
 *
 * The parser is deliberately two-layered:
 *   1. Hard structural checks that throw `WishParseError` with a rule ID + line.
 *      These correspond to failures the document cannot be meaningfully modeled
 *      past (missing title, no metadata table, no `## Execution Groups` header,
 *      zero execution groups).
 *   2. Best-effort extraction for everything else. Missing field labels, empty
 *      checklists, malformed depends-on values are modeled as empty strings /
 *      empty arrays in the returned document; the linter (Group 3) + Zod schema
 *      turn those into surfaced violations.
 *
 * This split keeps the parser useful as input for `wish lint --fix`: a document
 * with defects still parses so the linter can see and auto-repair them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DecisionRow,
  DependsOn,
  ExecutionGroup,
  RiskRow,
  ViolationRule,
  WaveEntry,
  WishDocument,
  WishMetadata,
} from './wish-schema.js';

export type { ViolationRule } from './wish-schema.js';

export class WishParseError extends Error {
  readonly rule: ViolationRule;
  readonly line: number;
  readonly column: number;
  readonly file?: string;

  constructor(opts: { rule: ViolationRule; line: number; column?: number; message: string; file?: string }) {
    super(opts.message);
    this.name = 'WishParseError';
    this.rule = opts.rule;
    this.line = opts.line;
    this.column = opts.column ?? 1;
    this.file = opts.file;
  }
}

interface SectionSpan {
  title: string;
  level: number;
  start: number; // 1-indexed line of the heading
  contentStart: number; // 1-indexed line of first content after heading
  end: number; // 1-indexed line of last content line (inclusive)
}

const METADATA_KEY_MAP: Record<string, keyof WishMetadata> = {
  status: 'status',
  slug: 'slug',
  date: 'date',
  author: 'author',
  appetite: 'appetite',
  branch: 'branch',
  'repos touched': 'reposTouched',
  design: 'design',
};

const REQUIRED_METADATA_FIELDS: ReadonlyArray<keyof WishMetadata> = [
  'status',
  'slug',
  'date',
  'author',
  'appetite',
  'branch',
];

function stripBackticks(value: string): string {
  return value.replace(/^`+|`+$/g, '').trim();
}

function stripBold(value: string): string {
  return value.replace(/^\*\*|\*\*$/g, '').trim();
}

function detectHeadings(lines: string[]): SectionSpan[] {
  const spans: Array<Omit<SectionSpan, 'end' | 'contentStart'> & { end?: number; contentStart?: number }> = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    spans.push({
      title: m[2] as string,
      level: (m[1] as string).length,
      start: i + 1,
    });
  }
  const total = lines.length;
  for (let i = 0; i < spans.length; i++) {
    const current = spans[i] as (typeof spans)[number];
    current.contentStart = current.start + 1;
    // Section ends at the next heading of the same or higher level (lower level number),
    // so an H2's range naturally contains its H3 children.
    let end = total;
    for (let j = i + 1; j < spans.length; j++) {
      const candidate = spans[j] as (typeof spans)[number];
      if (candidate.level <= current.level) {
        end = candidate.start - 1;
        break;
      }
    }
    current.end = end;
  }
  return spans as SectionSpan[];
}

function sliceContent(lines: string[], span: SectionSpan): string[] {
  const start = span.contentStart - 1;
  const end = span.end; // end is 1-indexed inclusive → slice exclusive == end
  return lines.slice(start, end);
}

function parseMetadataTable(lines: string[], startLine: number): WishMetadata {
  const metadata: Partial<WishMetadata> = {};
  let sawHeader = false;
  let sawDivider = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const line = raw.trim();
    if (!line.startsWith('|')) {
      if (sawHeader) break;
      continue;
    }
    if (!sawHeader) {
      sawHeader = true;
      continue;
    }
    if (!sawDivider) {
      sawDivider = true;
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    const keyRaw = stripBold(cells[0] as string).toLowerCase();
    const value = stripBackticks(cells[1] as string);
    const mapped = METADATA_KEY_MAP[keyRaw];
    if (mapped) {
      (metadata as Record<string, string>)[mapped] = value;
    }
  }
  if (!sawHeader) {
    throw new WishParseError({
      rule: 'metadata-table-missing-field',
      line: startLine,
      message: 'Metadata table not found at top of wish',
    });
  }
  for (const field of REQUIRED_METADATA_FIELDS) {
    if (!metadata[field]) {
      throw new WishParseError({
        rule: 'metadata-table-missing-field',
        line: startLine,
        message: `Metadata table is missing required field: ${field}`,
      });
    }
  }
  return metadata as WishMetadata;
}

function parseBullets(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const m = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (m) out.push((m[1] as string).trim());
  }
  return out;
}

function parseChecklist(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const m = /^\s*[-*]\s+\[[ xX]\]\s+(.*)$/.exec(raw);
    if (m) out.push((m[1] as string).trim());
  }
  return out;
}

function parsePipeTable(lines: string[]): string[][] {
  const rows: string[][] = [];
  let sawHeader = false;
  let sawDivider = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|')) {
      if (sawHeader) break;
      continue;
    }
    if (!sawHeader) {
      sawHeader = true;
      continue;
    }
    if (!sawDivider) {
      sawDivider = true;
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    rows.push(cells);
  }
  return rows;
}

function parseDecisions(lines: string[]): DecisionRow[] {
  return parsePipeTable(lines)
    .filter((r) => r.length >= 3)
    .map((cells) => ({
      number: cells[0] as string,
      decision: cells[1] as string,
      rationale: cells[2] as string,
    }));
}

function parseRisks(lines: string[]): RiskRow[] {
  return parsePipeTable(lines)
    .filter((r) => r.length >= 3)
    .map((cells) => ({
      risk: cells[0] as string,
      severity: cells[1] as string,
      mitigation: cells[2] as string,
    }));
}

function parseExecutionStrategy(allLines: string[], span: SectionSpan, allSpans: SectionSpan[]): WaveEntry[] {
  const entries: WaveEntry[] = [];
  const waveSpans = allSpans.filter(
    (s) => s.level === 3 && s.start > span.start && s.start <= span.end && /^wave\s+/i.exec(s.title),
  );
  for (const waveSpan of waveSpans) {
    const waveName = (/^(wave\s+\d+)/i.exec(waveSpan.title)?.[1] ?? waveSpan.title).trim();
    const rows = parsePipeTable(sliceContent(allLines, waveSpan));
    for (const row of rows) {
      if (row.length < 3) continue;
      entries.push({
        wave: waveName,
        group: row[0] as string,
        agent: row[1] as string,
        description: row[2] as string,
      });
    }
  }
  return entries;
}

function parseDependsOnValue(raw: string): { value: DependsOn; malformed: boolean } {
  const trimmed = raw.trim().replace(/\.$/, '');
  if (!trimmed) return { value: [], malformed: true };
  if (/^none$/i.test(trimmed)) return { value: 'none', malformed: false };
  // Accept `Group N`, `Foundation`, `wish-slug/group-1`, `repo/wish-slug/group-N`, or `slug#N`.
  const parts = trimmed.split(/\s*,\s*/).filter(Boolean);
  const refPattern =
    /^(?:Group\s+\d+|[A-Za-z][A-Za-z0-9_-]*(?:\/(?:Group\s+\d+|[A-Za-z][A-Za-z0-9_-]*))*|[A-Za-z][A-Za-z0-9_-]*#\d+)$/i;
  const malformed = parts.some((p) => !refPattern.test(p));
  return { value: parts, malformed };
}

interface ExtractedField {
  value: string;
  startLine: number;
  endLine: number;
  found: boolean;
}

function extractLabeledField(
  lines: string[],
  groupStartLine: number,
  labelRegex: RegExp,
  stopRegex: RegExp,
): ExtractedField {
  let idx = lines.findIndex((l) => labelRegex.test(l));
  if (idx < 0) return { value: '', startLine: groupStartLine, endLine: groupStartLine, found: false };
  const labelLine = lines[idx] as string;
  // Content may start on the same line (after the label) or on following lines.
  const inlineMatch = labelRegex.exec(labelLine);
  const inline = inlineMatch ? labelLine.slice(inlineMatch.index + inlineMatch[0].length).trim() : '';
  const collected: string[] = [];
  if (inline) collected.push(inline);
  const startLine = groupStartLine + idx;
  idx += 1;
  while (idx < lines.length) {
    const line = lines[idx] as string;
    if (stopRegex.test(line)) break;
    collected.push(line);
    idx += 1;
  }
  // Trim trailing blank lines.
  while (collected.length > 0 && (collected[collected.length - 1] as string).trim() === '') {
    collected.pop();
  }
  return {
    value: collected.join('\n').trim(),
    startLine,
    endLine: groupStartLine + idx - 1,
    found: true,
  };
}

function parseExecutionGroup(
  allLines: string[],
  headerLine: string,
  headerLineNumber: number,
  bodyLines: string[],
  bodyStartLine: number,
  bodyEndLine: number,
): ExecutionGroup {
  const headerMatch = /^###\s+Group\s+(\d+)\s*:\s*(.+?)\s*$/i.exec(headerLine);
  if (!headerMatch) {
    throw new WishParseError({
      rule: 'group-header-format',
      line: headerLineNumber,
      message: `Execution group header not in canonical "### Group N: Title" form: ${headerLine.trim()}`,
    });
  }
  const number = Number.parseInt(headerMatch[1] as string, 10);
  const title = (headerMatch[2] as string).trim();

  // Field labels are bold markdown lines. A field ends at the next bold label or at a horizontal rule.
  const stopRegex = /^(\*\*(Goal|Deliverables|Acceptance Criteria|Validation|depends-on)\s*:\*\*|---\s*$)/i;

  const goalField = extractLabeledField(bodyLines, bodyStartLine, /^\*\*Goal:\*\*/i, stopRegex);
  const deliverablesField = extractLabeledField(bodyLines, bodyStartLine, /^\*\*Deliverables:\*\*/i, stopRegex);
  const acceptanceField = extractLabeledField(bodyLines, bodyStartLine, /^\*\*Acceptance Criteria:\*\*/i, stopRegex);
  const validationField = extractLabeledField(bodyLines, bodyStartLine, /^\*\*Validation:\*\*/i, stopRegex);
  const dependsOnField = extractLabeledField(bodyLines, bodyStartLine, /^\*\*depends-on:\*\*/i, stopRegex);

  // Acceptance checklist extraction.
  const acceptanceItems = acceptanceField.found ? parseChecklist(acceptanceField.value.split('\n')) : [];

  // Validation fenced block extraction: first ```bash (or ``` ) block after the label.
  let validationBody = '';
  if (validationField.found) {
    const vLines = validationField.value.split('\n');
    let inFence = false;
    let fenceTag: string | null = null;
    const collected: string[] = [];
    for (const l of vLines) {
      const fenceOpen = /^\s*```(\S*)\s*$/.exec(l);
      if (fenceOpen) {
        if (!inFence) {
          inFence = true;
          fenceTag = (fenceOpen[1] as string) || '';
          continue;
        }
        inFence = false;
        break;
      }
      if (inFence) collected.push(l);
    }
    // If no fence present, keep raw content (the linter rule `validation-not-fenced-bash` handles this).
    validationBody = collected.length > 0 ? collected.join('\n') : validationField.value;
    // Suppress unused fence-tag warning; parser does not branch on it yet (linter does).
    void fenceTag;
  }

  const { value: dependsOnValue } = dependsOnField.found
    ? parseDependsOnValue(dependsOnField.value)
    : { value: [] as string[] };

  void allLines; // retained for future line-range utilities

  return {
    name: `Group ${number}: ${title}`,
    number,
    title,
    goal: goalField.value,
    deliverables: deliverablesField.value,
    acceptanceCriteria: acceptanceItems,
    validation: validationBody,
    dependsOn: dependsOnValue,
    startLine: headerLineNumber,
    endLine: bodyEndLine,
  };
}

function parseExecutionGroups(
  allLines: string[],
  executionGroupsSpan: SectionSpan,
  allSpans: SectionSpan[],
): ExecutionGroup[] {
  const groupSpans = allSpans.filter(
    (s) => s.level === 3 && s.start > executionGroupsSpan.start && s.start <= executionGroupsSpan.end,
  );
  const groups: ExecutionGroup[] = [];
  for (const span of groupSpans) {
    const headerLine = allLines[span.start - 1] as string;
    if (!/^###\s+Group\s+\d+\s*:/i.test(headerLine)) continue;
    const bodyLines = sliceContent(allLines, span);
    groups.push(parseExecutionGroup(allLines, headerLine, span.start, bodyLines, span.contentStart, span.end));
  }
  return groups;
}

function detectStrayGroupHeaders(lines: string[]): { line: number; text: string } | null {
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Match "### Grupo N — X", "### Group N - X", "### Group N X" — any H3 with Group/Grupo + digit that
    // doesn't match our canonical colon form. These are strong signals that the author intended an
    // execution group, so flag if the `## Execution Groups` header is missing.
    if (/^###\s+(group|grupo)\s+\d+/i.test(raw) && !/^###\s+Group\s+\d+\s*:/i.test(raw)) {
      return { line: i + 1, text: raw.trim() };
    }
    if (/^###\s+Group\s+\d+\s*:/i.test(raw)) {
      return { line: i + 1, text: raw.trim() };
    }
  }
  return null;
}

function stripHorizontalRules(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*-{3,}\s*$/.test(l))
    .join('\n')
    .trim();
}

function extractFencedBlock(content: string): string {
  const m = /```[^\n]*\n([\s\S]*?)\n```/m.exec(content);
  return m ? (m[1] as string) : '';
}

export function parseWish(markdown: string): WishDocument {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const spans = detectHeadings(lines);

  // Title (H1).
  const titleSpan = spans.find((s) => s.level === 1);
  if (!titleSpan || !/^Wish:\s*/i.test(titleSpan.title)) {
    throw new WishParseError({
      rule: 'missing-title',
      line: titleSpan?.start ?? 1,
      message: 'Wish must start with a `# Wish: <title>` heading',
    });
  }
  const title = titleSpan.title.replace(/^Wish:\s*/i, '').trim();

  // Metadata table lives between the title and the first H2.
  const firstH2 = spans.find((s) => s.level === 2);
  const metaLines = lines.slice(titleSpan.start, firstH2 ? firstH2.start - 1 : lines.length);
  const metadata = parseMetadataTable(metaLines, titleSpan.start + 1);

  // Summary.
  const summarySpan = spans.find((s) => s.level === 2 && /^summary$/i.test(s.title));
  if (!summarySpan) {
    throw new WishParseError({
      rule: 'missing-summary',
      line: firstH2?.start ?? titleSpan.start,
      message: 'Wish is missing the `## Summary` section',
    });
  }
  const summary = sliceContent(lines, summarySpan).join('\n').trim();

  // Scope.
  const scopeSpan = spans.find((s) => s.level === 2 && /^scope$/i.test(s.title));
  const scopeIn: string[] = [];
  const scopeOut: string[] = [];
  if (scopeSpan) {
    const scopeSubs = spans.filter((s) => s.level === 3 && s.start > scopeSpan.start && s.start <= scopeSpan.end);
    for (const sub of scopeSubs) {
      const content = sliceContent(lines, sub);
      if (/^in\b/i.test(sub.title)) scopeIn.push(...parseBullets(content));
      else if (/^out\b/i.test(sub.title)) scopeOut.push(...parseBullets(content));
    }
  }

  // Decisions.
  const decisionsSpan = spans.find((s) => s.level === 2 && /^decisions$/i.test(s.title));
  const decisions = decisionsSpan ? parseDecisions(sliceContent(lines, decisionsSpan)) : [];

  // Success Criteria.
  const successSpan = spans.find((s) => s.level === 2 && /^success criteria$/i.test(s.title));
  const successCriteria = successSpan ? parseChecklist(sliceContent(lines, successSpan)) : [];

  // Execution Strategy.
  const strategySpan = spans.find((s) => s.level === 2 && /^execution strategy$/i.test(s.title));
  const executionStrategy = strategySpan ? parseExecutionStrategy(lines, strategySpan, spans) : [];

  // Execution Groups — hard-required section.
  const execGroupsSpan = spans.find((s) => s.level === 2 && /^execution groups$/i.test(s.title));
  if (!execGroupsSpan) {
    const stray = detectStrayGroupHeaders(lines);
    throw new WishParseError({
      rule: 'missing-execution-groups-header',
      line: stray?.line ?? firstH2?.start ?? titleSpan.start,
      message: stray
        ? `Wish contains a "${stray.text}" header but the parent "## Execution Groups" header is missing`
        : 'Wish is missing the `## Execution Groups` section',
    });
  }
  const executionGroups = parseExecutionGroups(lines, execGroupsSpan, spans);
  if (executionGroups.length === 0) {
    throw new WishParseError({
      rule: 'missing-execution-group',
      line: execGroupsSpan.start,
      message: 'Wish contains `## Execution Groups` but no `### Group N: …` subsections',
    });
  }

  // QA Criteria.
  const qaSpan = spans.find((s) => s.level === 2 && /^qa criteria$/i.test(s.title));
  const qaCriteria = qaSpan ? parseChecklist(sliceContent(lines, qaSpan)) : [];

  // Assumptions / Risks.
  const risksSpan = spans.find((s) => s.level === 2 && /^assumptions\s*\/\s*risks$/i.test(s.title));
  const assumptionsRisks = risksSpan ? parseRisks(sliceContent(lines, risksSpan)) : [];

  // Review Results.
  const reviewSpan = spans.find((s) => s.level === 2 && /^review results$/i.test(s.title));
  const reviewResults = reviewSpan ? stripHorizontalRules(sliceContent(lines, reviewSpan).join('\n')) : '';

  // Files to Create/Modify.
  const filesSpan = spans.find((s) => s.level === 2 && /^files to create(\/modify)?$/i.test(s.title));
  const filesToCreate = filesSpan ? extractFencedBlock(sliceContent(lines, filesSpan).join('\n')) : '';

  return {
    title,
    metadata,
    summary,
    scope: { in: scopeIn, out: scopeOut },
    decisions,
    successCriteria,
    executionStrategy,
    executionGroups,
    qaCriteria,
    assumptionsRisks,
    reviewResults,
    filesToCreate,
  };
}

/**
 * Read `.genie/wishes/<slug>/WISH.md` relative to `options.repoRoot` (cwd by default)
 * and parse it. Throws `WishParseError` with `rule: 'missing-title'` if the file does not exist.
 */
export function parseWishFile(slug: string, options: { repoRoot?: string } = {}): WishDocument {
  const root = options.repoRoot ?? process.cwd();
  const path = join(root, '.genie', 'wishes', slug, 'WISH.md');
  if (!existsSync(path)) {
    throw new WishParseError({
      rule: 'missing-title',
      line: 1,
      file: path,
      message: `Wish file not found: ${path}`,
    });
  }
  const markdown = readFileSync(path, 'utf8');
  try {
    return parseWish(markdown);
  } catch (err) {
    if (err instanceof WishParseError) {
      throw new WishParseError({
        rule: err.rule,
        line: err.line,
        column: err.column,
        message: err.message,
        file: path,
      });
    }
    throw err;
  }
}
