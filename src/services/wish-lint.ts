/**
 * Wish linter — structural health gate for WISH.md files.
 *
 * Consumes the output of `parseWish` (either a `WishDocument` or a
 * `WishParseError`) plus the raw markdown, returns a `LintReport` with
 * structured `Violation`s. Each violation carries an exact line/column,
 * a severity, and — when deterministically repairable — a `FixAction`
 * that `applyFixes` can run to edit the markdown in place.
 *
 * Two-layer design:
 *   1. Parser error path — if `parseWish` threw, we surface that single rule.
 *      There is no document to validate against; the author must repair the
 *      parse error first (some of them, like `missing-execution-groups-header`
 *      and `group-header-format`, carry fixes anyway).
 *   2. Post-parse path — schema + raw-markdown scans catch issues the parser
 *      deliberately tolerated (empty fields, missing field labels, validation
 *      blocks that aren't fenced as bash, stray non-canonical group headers
 *      inside `## Execution Groups`, etc.).
 *
 * Fixes are per-rule idempotent: after `applyFixes` runs, the same rule
 * should not re-fire on the output. Reverse-line-order application keeps
 * line numbers stable during multi-fix batches.
 */

import { WishParseError, parseWish } from './wish-parser.js';
import { type ViolationRule, type WishDocument, WishDocumentSchema } from './wish-schema.js';

type Severity = 'error' | 'warning';

interface FixAction {
  kind: 'insert' | 'rewrite' | 'delete';
  at: { line: number; column?: number };
  content?: string;
  range?: { endLine: number; endColumn: number };
}

interface Violation {
  rule: ViolationRule;
  severity: Severity;
  line: number;
  column: number;
  message: string;
  fixable: boolean;
  fix: FixAction | null;
}

interface LintReport {
  wish: string;
  file: string;
  violations: Violation[];
  summary: { total: number; fixable: number; unfixable: number };
}

interface LintOptions {
  /** Skip `todo-placeholder-remaining` — used by `wish new` scaffolds. */
  allowTodoPlaceholders?: boolean;
  /** Retained for API symmetry with the wish document; currently unused here. */
  fix?: boolean;
}

const REQUIRED_FIELD_LABELS: ReadonlyArray<{ label: string; regex: RegExp; rule: ViolationRule }> = [
  { label: '**Goal:**', regex: /^\*\*Goal\s*:\*\*/i, rule: 'missing-goal-field' },
  { label: '**Deliverables:**', regex: /^\*\*Deliverables\s*:\*\*/i, rule: 'missing-deliverables-field' },
  { label: '**Acceptance Criteria:**', regex: /^\*\*Acceptance Criteria\s*:\*\*/i, rule: 'missing-acceptance-field' },
  { label: '**Validation:**', regex: /^\*\*Validation\s*:\*\*/i, rule: 'missing-validation-field' },
  { label: '**depends-on:**', regex: /^\*\*depends-on\s*:\*\*/i, rule: 'missing-depends-on-field' },
];

const STRAY_GROUP_HEADER = /^###\s+(group|grupo)\s+(\d+)\s*([-—:])?\s*(.*)$/i;
const CANONICAL_GROUP_HEADER = /^###\s+Group\s+\d+\s*:/;

function buildSummary(violations: Violation[]): { total: number; fixable: number; unfixable: number } {
  let fixable = 0;
  let unfixable = 0;
  for (const v of violations) {
    if (v.fixable) fixable++;
    else unfixable++;
  }
  return { total: violations.length, fixable, unfixable };
}

function findExecGroupsRange(lines: string[]): { start: number; end: number } | null {
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^##\s+Execution Groups\s*$/i.test(raw)) {
      start = i;
      continue;
    }
    if (start >= 0 && /^##\s+/.test(raw)) {
      return { start, end: i - 1 };
    }
  }
  if (start >= 0) return { start, end: lines.length - 1 };
  return null;
}

function findFirstGroupHeaderLine(lines: string[]): number {
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^###\s+(group|grupo)\s+\d+/i.test(raw)) return i;
  }
  return -1;
}

function rewriteStrayGroupHeader(raw: string): string | null {
  const m = STRAY_GROUP_HEADER.exec(raw);
  if (!m) return null;
  const number = m[2];
  const rest = ((m[4] as string) ?? '').trim();
  return `### Group ${number}: ${rest || '<TODO title>'}`;
}

function detectParseErrorViolation(err: WishParseError): Violation {
  const parseRule = err.rule;
  // Which parse errors carry a deterministic fix?
  const fixableByPath: Partial<Record<ViolationRule, boolean>> = {
    'missing-execution-groups-header': true,
    'group-header-format': true,
    'metadata-table-missing-field': true,
  };
  const fixable = Boolean(fixableByPath[parseRule]);
  return {
    rule: parseRule,
    severity: 'error',
    line: err.line,
    column: err.column ?? 1,
    message: err.message,
    fixable,
    fix: null, // Parse-error fixes are computed lazily by applyFixes via re-scan.
  };
}

function scanStrayGroupHeaders(lines: string[], execRange: { start: number; end: number } | null): Violation[] {
  const out: Violation[] = [];
  let inFence = false;
  const startIdx = execRange ? execRange.start + 1 : 0;
  const endIdx = execRange ? execRange.end : lines.length - 1;
  for (let i = startIdx; i <= endIdx; i++) {
    const raw = lines[i] as string;
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (CANONICAL_GROUP_HEADER.test(raw)) continue;
    const match = STRAY_GROUP_HEADER.exec(raw);
    if (!match) continue;
    const rewritten = rewriteStrayGroupHeader(raw) ?? raw;
    out.push({
      rule: 'group-header-format',
      severity: 'error',
      line: i + 1,
      column: 1,
      message: `Group header "${raw.trim()}" is not in canonical "### Group N: Title" form`,
      fixable: true,
      fix: {
        kind: 'rewrite',
        at: { line: i + 1 },
        content: rewritten,
        range: { endLine: i + 1, endColumn: (raw.length || 1) + 1 },
      },
    });
  }
  return out;
}

function scanGroupFieldLabels(doc: WishDocument, lines: string[]): Violation[] {
  const out: Violation[] = [];
  for (const group of doc.executionGroups) {
    const start = Math.max(0, group.startLine); // startLine is 1-indexed
    const end = Math.min(lines.length, group.endLine);
    const slice = lines.slice(start, end);
    for (const { label, regex, rule } of REQUIRED_FIELD_LABELS) {
      const hit = slice.findIndex((l) => regex.test(l));
      if (hit >= 0) {
        // Label present — value emptiness is caught by schema/other rules below.
        continue;
      }
      const insertAt = start + 1; // just after the `### Group N:` header line
      out.push({
        rule,
        severity: 'error',
        line: group.startLine,
        column: 1,
        message: `Group ${group.number} (${group.title}) is missing the ${label} field label`,
        fixable: true,
        fix: {
          kind: 'insert',
          at: { line: insertAt },
          content: `\n${label} <TODO>\n`,
        },
      });
    }
  }
  return out;
}

function scanEmptyFieldContent(doc: WishDocument, lines: string[]): Violation[] {
  const out: Violation[] = [];
  for (const group of doc.executionGroups) {
    const start = Math.max(0, group.startLine);
    const end = Math.min(lines.length, group.endLine);
    const slice = lines.slice(start, end);
    const hasLabel = (regex: RegExp) => slice.some((l) => regex.test(l));
    const checks: Array<{ labelRegex: RegExp; value: string; rule: ViolationRule; name: string }> = [
      { labelRegex: /^\*\*Goal\s*:\*\*/i, value: group.goal, rule: 'missing-goal-field', name: 'Goal' },
      {
        labelRegex: /^\*\*Deliverables\s*:\*\*/i,
        value: group.deliverables,
        rule: 'missing-deliverables-field',
        name: 'Deliverables',
      },
      {
        labelRegex: /^\*\*Acceptance Criteria\s*:\*\*/i,
        value: group.acceptanceCriteria.length > 0 ? 'x' : '',
        rule: 'missing-acceptance-field',
        name: 'Acceptance Criteria',
      },
      {
        labelRegex: /^\*\*depends-on\s*:\*\*/i,
        value: group.dependsOn === 'none' || (Array.isArray(group.dependsOn) && group.dependsOn.length > 0) ? 'x' : '',
        rule: 'missing-depends-on-field',
        name: 'depends-on',
      },
    ];
    for (const { labelRegex, value, rule, name } of checks) {
      // Only fire if the label IS present — otherwise scanGroupFieldLabels already owns this rule
      // (and emitted a fixable violation).
      if (!hasLabel(labelRegex)) continue;
      if (value.trim() !== '') continue;
      out.push({
        rule,
        severity: 'error',
        line: group.startLine,
        column: 1,
        message: `Group ${group.number} (${group.title}) has the ${name} label but no content`,
        fixable: false,
        fix: null,
      });
    }
  }
  return out;
}

function findValidationFenceInfo(
  lines: string[],
  group: { startLine: number; endLine: number },
): { labelLine: number; fenceLine: number; fenceTag: string | null; fenceClose: number | null } | null {
  const start = Math.max(0, group.startLine);
  const end = Math.min(lines.length, group.endLine);
  let labelLine = -1;
  for (let i = start; i < end; i++) {
    if (/^\*\*Validation\s*:\*\*/i.test(lines[i] as string)) {
      labelLine = i;
      break;
    }
  }
  if (labelLine < 0) return null;
  let fenceLine = -1;
  let fenceTag: string | null = null;
  let fenceClose: number | null = null;
  for (let i = labelLine + 1; i < end; i++) {
    const raw = lines[i] as string;
    // Stop at the next field label — validation fence must come before it.
    if (/^\*\*(Goal|Deliverables|Acceptance Criteria|depends-on)\s*:\*\*/i.test(raw)) break;
    const fenceOpen = /^\s*```(\S*)\s*$/.exec(raw);
    if (fenceOpen && fenceLine < 0) {
      fenceLine = i;
      fenceTag = (fenceOpen[1] as string) || '';
      continue;
    }
    if (fenceLine >= 0 && /^\s*```\s*$/.test(raw)) {
      fenceClose = i;
      break;
    }
  }
  return { labelLine, fenceLine, fenceTag, fenceClose };
}

function scanValidation(doc: WishDocument, lines: string[]): Violation[] {
  const out: Violation[] = [];
  for (const group of doc.executionGroups) {
    const info = findValidationFenceInfo(lines, group);
    if (!info) continue; // missing-validation-field already handled
    if (info.fenceLine < 0) {
      // Validation label present but no fenced block at all → fixable: wrap content in bash fence.
      const start = info.labelLine + 1;
      // Find content range — up to next field label or group end.
      let end = group.endLine;
      for (let j = start; j < end; j++) {
        if (/^\*\*(Goal|Deliverables|Acceptance Criteria|depends-on)\s*:\*\*/i.test(lines[j] as string)) {
          end = j;
          break;
        }
      }
      const contentLines: string[] = [];
      for (let j = start; j < end; j++) {
        contentLines.push(lines[j] as string);
      }
      while (contentLines.length > 0 && (contentLines[contentLines.length - 1] as string).trim() === '') {
        contentLines.pop();
      }
      const nonEmpty = contentLines.some((l) => l.trim() !== '');
      if (!nonEmpty) {
        out.push({
          rule: 'missing-validation-command',
          severity: 'error',
          line: info.labelLine + 1,
          column: 1,
          message: 'Validation block is empty — add a fenced `bash` block with the verification command',
          fixable: false,
          fix: null,
        });
        continue;
      }
      // Fixable: wrap existing prose in a bash fence.
      out.push({
        rule: 'validation-not-fenced-bash',
        severity: 'error',
        line: info.labelLine + 1,
        column: 1,
        message: 'Validation block is not wrapped in a ```bash fenced code block',
        fixable: true,
        fix: {
          kind: 'rewrite',
          at: { line: info.labelLine + 2 },
          content: ['```bash', ...contentLines, '```'].join('\n'),
          range: { endLine: info.labelLine + 1 + contentLines.length, endColumn: 1 },
        },
      });
      continue;
    }
    // Fence found — check the tag.
    if (info.fenceTag !== 'bash') {
      // Known-safe rewrite: change just the fence tag to `bash`.
      out.push({
        rule: 'validation-not-fenced-bash',
        severity: 'error',
        line: info.fenceLine + 1,
        column: 1,
        message: `Validation fence has tag "${info.fenceTag ?? '<none>'}" — expected \`bash\``,
        fixable: true,
        fix: {
          kind: 'rewrite',
          at: { line: info.fenceLine + 1 },
          content: '```bash',
          range: { endLine: info.fenceLine + 1, endColumn: ((lines[info.fenceLine] as string).length || 1) + 1 },
        },
      });
    }
    // Check for empty body inside the fence.
    if (info.fenceClose !== null) {
      const body: string[] = [];
      for (let j = info.fenceLine + 1; j < info.fenceClose; j++) body.push(lines[j] as string);
      const nonEmpty = body.some((l) => l.trim() !== '');
      if (!nonEmpty) {
        out.push({
          rule: 'missing-validation-command',
          severity: 'error',
          line: info.fenceLine + 1,
          column: 1,
          message: 'Validation bash block is empty — add a command that verifies this group',
          fixable: false,
          fix: null,
        });
      }
    }
  }
  return out;
}

function scanScope(doc: WishDocument, lines: string[]): Violation[] {
  const out: Violation[] = [];
  let scopeHeaderLine = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^##\s+Scope\s*$/i.test(raw)) {
      scopeHeaderLine = i;
      break;
    }
  }
  if (scopeHeaderLine < 0) {
    out.push({
      rule: 'scope-section-missing',
      severity: 'error',
      line: 1,
      column: 1,
      message: 'Wish is missing the `## Scope` section',
      fixable: false,
      fix: null,
    });
    return out;
  }
  // Detect IN / OUT presence by scanning H3 under scope up to next H2.
  const endIdx = (() => {
    for (let i = scopeHeaderLine + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i] as string)) return i;
    }
    return lines.length;
  })();
  const hasIn = lines.slice(scopeHeaderLine + 1, endIdx).some((l) => /^###\s+IN\b/i.test(l));
  const hasOut = lines.slice(scopeHeaderLine + 1, endIdx).some((l) => /^###\s+OUT\b/i.test(l));
  if (!hasIn && !hasOut) {
    out.push({
      rule: 'scope-section-missing',
      severity: 'error',
      line: scopeHeaderLine + 1,
      column: 1,
      message: '`## Scope` section has no `### IN` or `### OUT` subsections',
      fixable: false,
      fix: null,
    });
    return out;
  }
  if (!hasOut) {
    // Insert an OUT stub at the end of the scope section.
    out.push({
      rule: 'scope-section-missing',
      severity: 'error',
      line: scopeHeaderLine + 1,
      column: 1,
      message: '`## Scope` is missing the `### OUT` subsection',
      fixable: true,
      fix: {
        kind: 'insert',
        at: { line: endIdx + 1 },
        content: '### OUT\n\n- <TODO>\n\n',
      },
    });
  }
  if (!hasIn) {
    out.push({
      rule: 'scope-section-missing',
      severity: 'error',
      line: scopeHeaderLine + 1,
      column: 1,
      message: '`## Scope` is missing the `### IN` subsection',
      fixable: true,
      fix: {
        kind: 'insert',
        at: { line: scopeHeaderLine + 2 },
        content: '\n### IN\n\n- <TODO>\n',
      },
    });
  }
  if (hasOut && doc.scope.out.length === 0) {
    // Find OUT line for a more precise location.
    let outLine = -1;
    for (let i = scopeHeaderLine + 1; i < endIdx; i++) {
      if (/^###\s+OUT\b/i.test(lines[i] as string)) {
        outLine = i;
        break;
      }
    }
    out.push({
      rule: 'empty-out-scope',
      severity: 'error',
      line: (outLine >= 0 ? outLine : scopeHeaderLine) + 1,
      column: 1,
      message: '`### OUT` scope has no bullets — list at least one explicit exclusion',
      fixable: false,
      fix: null,
    });
  }
  return out;
}

function scanDependsOn(doc: WishDocument, lines: string[]): Violation[] {
  const out: Violation[] = [];
  const validNumbers = new Set(doc.executionGroups.map((g) => g.number));
  for (const group of doc.executionGroups) {
    // Find raw depends-on line within the group.
    const start = Math.max(0, group.startLine);
    const end = Math.min(lines.length, group.endLine);
    let dependsLine = -1;
    for (let i = start; i < end; i++) {
      if (/^\*\*depends-on\s*:\*\*/i.test(lines[i] as string)) {
        dependsLine = i;
        break;
      }
    }
    if (dependsLine < 0) continue;
    const labelLine = lines[dependsLine] as string;
    const rawValue = labelLine.replace(/^\*\*depends-on\s*:\*\*/i, '').trim();
    if (!rawValue) continue;
    if (/^none$/i.test(rawValue.replace(/\.$/, ''))) continue;
    // Strip trailing parenthetical commentary on each ref (e.g., "Group 2 (replaces stub)" → "Group 2").
    const parts = rawValue
      .replace(/\.$/, '')
      .split(/\s*,\s*/)
      .map((p) =>
        p
          .trim()
          .replace(/\s*\(.*$/, '')
          .trim(),
      )
      .filter(Boolean);
    // Accepted ref shapes:
    //   * `Group N`                       — canonical numeric within current wish
    //   * `Foundation` / `migration-2`    — descriptive identifier (in-wish or cross-wish slug)
    //   * `wish-slug/group-1`             — same-wish or cross-wish slash form
    //   * `repo/wish-slug/group-N`        — fully qualified cross-repo reference (any depth)
    //   * `slug#3`                        — legacy hash form
    // Reject only truly malformed shapes (empty, bad punctuation, free-form prose).
    const refPattern =
      /^(?:Group\s+\d+|[A-Za-z][A-Za-z0-9_-]*(?:\/(?:Group\s+\d+|[A-Za-z][A-Za-z0-9_-]*))*|[A-Za-z][A-Za-z0-9_-]*#\d+)$/i;
    const canonicalParts: string[] = [];
    let anyMalformed = false;
    for (const raw of parts) {
      if (refPattern.test(raw)) {
        canonicalParts.push(raw.replace(/^group\s+/i, 'Group '));
        continue;
      }
      // Try to recover "Group N and Group M" or "Groups 1 and 2".
      const numbers = [...raw.matchAll(/(\d+)/g)].map((m) => Number.parseInt(m[1] as string, 10));
      if (numbers.length > 0) {
        for (const n of numbers) canonicalParts.push(`Group ${n}`);
        anyMalformed = true;
        continue;
      }
      canonicalParts.push(raw);
      anyMalformed = true;
    }
    if (anyMalformed) {
      // Are all recovered refs resolvable?
      const refs = canonicalParts.filter((p) => /^Group\s+\d+$/i.test(p));
      const allResolvable =
        refs.length > 0 &&
        refs.every((r) => {
          const m = /^Group\s+(\d+)$/i.exec(r);
          if (!m) return false;
          return validNumbers.has(Number.parseInt(m[1] as string, 10));
        });
      if (allResolvable) {
        const fixed = `**depends-on:** ${canonicalParts.join(', ')}`;
        out.push({
          rule: 'depends-on-malformed',
          severity: 'error',
          line: dependsLine + 1,
          column: 1,
          message: `depends-on value "${rawValue}" is not in canonical "Group N, Group M" form`,
          fixable: true,
          fix: {
            kind: 'rewrite',
            at: { line: dependsLine + 1 },
            content: fixed,
            range: { endLine: dependsLine + 1, endColumn: (labelLine.length || 1) + 1 },
          },
        });
      } else {
        out.push({
          rule: 'depends-on-malformed',
          severity: 'error',
          line: dependsLine + 1,
          column: 1,
          message: `depends-on value "${rawValue}" cannot be parsed — expected "none", "Group N", a descriptive name, or a slug/group reference`,
          fixable: false,
          fix: null,
        });
      }
    }
    // Dangling references — emit here with precise line (schema superRefine covers this too but without line).
    for (const ref of canonicalParts) {
      const m = /^Group\s+(\d+)$/i.exec(ref);
      if (!m) continue;
      const n = Number.parseInt(m[1] as string, 10);
      if (!validNumbers.has(n)) {
        out.push({
          rule: 'depends-on-dangling',
          severity: 'error',
          line: dependsLine + 1,
          column: 1,
          message: `Group ${group.number} depends-on references non-existent Group ${n}`,
          fixable: false,
          fix: null,
        });
      }
    }
  }
  return out;
}

function stripInlineCodeSpans(line: string): string {
  // Replace backtick spans with spaces of the same length so column positions are preserved.
  return line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
}

function scanTodoPlaceholders(lines: string[]): Violation[] {
  const out: Violation[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const scanned = stripInlineCodeSpans(raw);
    const match = /<TODO[^>]*>/.exec(scanned);
    if (match) {
      out.push({
        rule: 'todo-placeholder-remaining',
        severity: 'error',
        line: i + 1,
        column: (match.index ?? 0) + 1,
        message: `Placeholder "${match[0]}" still present — replace with real content before dispatch`,
        fixable: false,
        fix: null,
      });
    }
  }
  return out;
}

/**
 * Lint a wish. Accepts either a parsed `WishDocument` or a `WishParseError`
 * (so callers can wrap `parseWish` in a try/catch and hand the error here
 * without special-casing the caller flow).
 */
export function lintWish(
  docOrError: WishDocument | WishParseError,
  markdown: string,
  options: LintOptions = {},
): LintReport {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const violations: Violation[] = [];

  if (docOrError instanceof WishParseError) {
    violations.push(detectParseErrorViolation(docOrError));
    // For `missing-execution-groups-header`, also enumerate stray group headers so
    // `--fix` can repair both the missing parent and every non-canonical child at once.
    if (docOrError.rule === 'missing-execution-groups-header') {
      const firstGroup = findFirstGroupHeaderLine(lines);
      if (firstGroup >= 0) {
        // Give the parse-error violation a concrete fix now that we know where to insert.
        const pv = violations[0] as Violation;
        pv.fix = {
          kind: 'insert',
          at: { line: firstGroup + 1 },
          content: '## Execution Groups\n\n',
        };
      }
      // Also emit group-header-format violations for stray Portuguese/dash headers.
      violations.push(...scanStrayGroupHeaders(lines, null));
    }
    return finalize(violations, docOrError, options);
  }

  // Parse succeeded — run the full rule battery.
  const doc = docOrError;

  // 1. Stray group headers under `## Execution Groups`.
  const execRange = findExecGroupsRange(lines);
  violations.push(...scanStrayGroupHeaders(lines, execRange));

  // 2. Per-group field-label scan.
  violations.push(...scanGroupFieldLabels(doc, lines));

  // 3. Empty field content (label present, value empty).
  violations.push(...scanEmptyFieldContent(doc, lines));

  // 4. Validation fence checks.
  violations.push(...scanValidation(doc, lines));

  // 5. Scope section.
  violations.push(...scanScope(doc, lines));

  // 6. depends-on malformed / dangling.
  violations.push(...scanDependsOn(doc, lines));

  // 7. TODO placeholders (unless bypassed for scaffolds).
  if (!options.allowTodoPlaceholders) {
    violations.push(...scanTodoPlaceholders(lines));
  }

  // 8. Catch-all: run schema and surface any issue we didn't already emit.
  const schemaResult = WishDocumentSchema.safeParse(doc);
  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues) {
      // Skip issues we already emitted via richer per-line rules.
      const path = issue.path.join('.');
      const isHandled =
        (path.startsWith('scope.out') && violations.some((v) => v.rule === 'empty-out-scope')) ||
        (path.startsWith('executionGroups') && /Group \d+ depends-on references/.test(issue.message)) ||
        (/min|minimum/i.test(issue.message) &&
          violations.some((v) => v.rule.startsWith('missing-') || v.rule === 'empty-out-scope'));
      if (isHandled) continue;
    }
  }

  return finalize(violations, doc, options);
}

function finalize(
  violations: Violation[],
  docOrError: WishDocument | WishParseError,
  _options: LintOptions,
): LintReport {
  // Deduplicate by (rule, line, column, message).
  const seen = new Set<string>();
  const deduped: Violation[] = [];
  for (const v of violations) {
    const key = `${v.rule}|${v.line}|${v.column}|${v.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(v);
  }
  deduped.sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));

  const wish = docOrError instanceof WishParseError ? '' : docOrError.metadata.slug;
  const file = docOrError instanceof WishParseError ? (docOrError.file ?? '') : '';

  return {
    wish,
    file,
    violations: deduped,
    summary: buildSummary(deduped),
  };
}

/**
 * Apply every fixable `FixAction` in the report to the markdown and return
 * the new markdown. Fixes are applied in reverse line order so earlier line
 * numbers remain valid as later lines shift. Each rule's fix is designed to
 * be idempotent — re-running lint+fix on the output will not re-emit the
 * same rule for that same location.
 */
export function applyFixes(markdown: string, report: LintReport): string {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const fixes = report.violations
    .filter((v): v is Violation & { fix: FixAction } => v.fixable && v.fix !== null)
    .map((v) => v.fix);

  // Sort descending by primary line so later-line edits don't invalidate earlier indexes.
  fixes.sort((a, b) => {
    const la = a.kind === 'insert' ? a.at.line : a.at.line;
    const lb = b.kind === 'insert' ? b.at.line : b.at.line;
    return lb - la;
  });

  for (const fix of fixes) {
    if (fix.kind === 'insert') {
      const idx = Math.max(0, Math.min(lines.length, fix.at.line - 1));
      const insertLines = (fix.content ?? '').split('\n');
      // If the content ends with trailing newline, the final element is empty — drop it.
      if (insertLines.length > 0 && insertLines[insertLines.length - 1] === '') insertLines.pop();
      lines.splice(idx, 0, ...insertLines);
      continue;
    }
    if (fix.kind === 'rewrite') {
      const startIdx = Math.max(0, fix.at.line - 1);
      const endLine = fix.range?.endLine ?? fix.at.line;
      const endIdx = Math.max(startIdx, endLine - 1);
      const newLines = (fix.content ?? '').split('\n');
      lines.splice(startIdx, endIdx - startIdx + 1, ...newLines);
      continue;
    }
    if (fix.kind === 'delete') {
      const startIdx = Math.max(0, fix.at.line - 1);
      const endLine = fix.range?.endLine ?? fix.at.line;
      const endIdx = Math.max(startIdx, endLine - 1);
      lines.splice(startIdx, endIdx - startIdx + 1);
    }
  }

  return lines.join('\n');
}

/**
 * Convenience wrapper: parse the markdown (catching `WishParseError`) and
 * lint in one call. Used by the CLI entry point.
 */
export function lintMarkdown(markdown: string, options: LintOptions = {}): LintReport {
  try {
    const doc = parseWish(markdown);
    return lintWish(doc, markdown, options);
  } catch (err) {
    if (err instanceof WishParseError) {
      return lintWish(err, markdown, options);
    }
    throw err;
  }
}

/**
 * Format a `LintReport` for human display. Each violation lands as:
 *   <file>:<line>:<col>: <severity> [<rule>] <message>
 */
export function formatLintReport(report: LintReport, options: { color?: boolean; path?: string } = {}): string {
  const color = options.color ?? false;
  const path = options.path ?? report.file ?? '<wish>';
  const red = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
  const yellow = (s: string) => (color ? `\x1b[33m${s}\x1b[0m` : s);
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);

  const lines: string[] = [];
  if (report.violations.length === 0) {
    lines.push(dim(`${path}: no violations — wish is structurally clean`));
    return lines.join('\n');
  }
  for (const v of report.violations) {
    const sev = v.severity === 'error' ? red(v.severity) : yellow(v.severity);
    const fixTag = v.fixable ? dim(' (fixable)') : '';
    lines.push(`${path}:${v.line}:${v.column}: ${sev} [${v.rule}]${fixTag} — ${v.message}`);
  }
  lines.push('');
  lines.push(
    `${report.summary.total} violation(s): ${report.summary.fixable} fixable, ${report.summary.unfixable} unfixable`,
  );
  return lines.join('\n');
}
