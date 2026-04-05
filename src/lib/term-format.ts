/**
 * Shared formatting utilities for CLI table output.
 *
 * Consolidates padRight, truncate, formatDate, formatRelativeTimestamp,
 * formatTimestamp, and formatTime — previously duplicated across 14+ files.
 */

/** Pad a string to a minimum width with trailing spaces. */
export function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

/** Truncate a string with a trailing Unicode ellipsis (…). */
export function truncate(str: string, len: number): string {
  return str.length <= len ? str : `${str.slice(0, len - 1)}…`;
}

/** Format an ISO date as "Mon DD" (short locale date). Returns '-' for null/undefined. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Format a timestamp as a relative string ("3m ago") or absolute ISO if >24h. */
export function formatRelativeTimestamp(ts: string): string {
  const d = new Date(ts);
  const now = Date.now();
  const diffMs = now - d.getTime();
  if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s ago`;
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/** Format an ISO/Date timestamp as a locale string ("Mon DD, HH:MM" or with seconds). */
export function formatTimestamp(
  iso: string | null | undefined | Date,
  opts?: { fallback?: string; seconds?: boolean },
): string {
  if (!iso) return opts?.fallback ?? '-';
  const d = iso instanceof Date ? iso : new Date(iso);
  const fmt: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  if (opts?.seconds) fmt.second = '2-digit';
  return d.toLocaleString('en-US', fmt);
}

/** Format an ISO timestamp as "HH:MM" or "HH:MM:SS". Returns fallback on error. */
export function formatTime(iso: string, opts?: { seconds?: boolean; fallback?: string }): string {
  try {
    const date = new Date(iso);
    const fmt: Intl.DateTimeFormatOptions = {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    };
    if (opts?.seconds) fmt.second = '2-digit';
    return date.toLocaleTimeString('en-US', fmt);
  } catch {
    return opts?.fallback ?? '??:??';
  }
}

// ============================================================================
// ANSI Colors — for colored terminal output
// ============================================================================

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightCyan: '\x1b[96m',
} as const;

export type ColorName = keyof typeof ANSI;

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;

/** Wrap text in ANSI color (no-op when not a TTY or NO_COLOR is set). */
export function color(name: ColorName, text: string): string {
  return isTTY ? `${ANSI[name]}${text}${ANSI.reset}` : text;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: required to match ANSI escape sequences
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/** Strip ANSI escape sequences from a string. */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '');
}

/** Get the visible length of a string (ignoring ANSI codes). */
export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

// ============================================================================
// StreamTable — terminal-adaptive table for streaming output
// ============================================================================

export interface StreamColumn {
  /** Column header label */
  label: string;
  /** Fixed width in chars, or 'flex' to absorb remaining space */
  width: number | 'flex';
  /** How to truncate when content exceeds width (default: 'end') */
  truncate?: 'start' | 'end';
  /** Text alignment (default: 'left') */
  align?: 'left' | 'right';
  /** Wrap content across multiple lines instead of truncating (default: false) */
  wrap?: boolean;
}

const MIN_FLEX_WIDTH = 10;
const COLUMN_SEPARATOR = '  ';

/**
 * Streaming table that adapts to terminal width on every row.
 *
 * Usage:
 *   const table = new StreamTable([
 *     { label: 'TIME', width: 8 },
 *     { label: 'EVENT', width: 24 },
 *     { label: 'DETAILS', width: 'flex' },  // takes remaining space
 *   ]);
 *   console.log(table.header());
 *   for (const event of events) {
 *     console.log(table.row([event.time, event.name, event.details]));
 *   }
 *
 * Re-reads process.stdout.columns on every row, so tmux pane resize is
 * reflected automatically on the next printed line.
 */
export class StreamTable {
  constructor(private columns: StreamColumn[]) {}

  /** Format a header row (call once at start). */
  header(): string {
    const widths = this.computeWidths();
    const parts = this.columns.map((col, i) => this.formatCell(col.label, widths[i], col));
    return parts.join(COLUMN_SEPARATOR);
  }

  /**
   * Format a data row with current terminal width.
   * Columns with `wrap: true` break long content across multiple lines,
   * aligned under the column. Returns a multi-line string.
   */
  row(values: string[]): string {
    const widths = this.computeWidths();
    const wrapColIdx = this.columns.findIndex((c) => c.wrap);

    // No wrap columns — single-line row
    if (wrapColIdx === -1) {
      const parts = this.columns.map((col, i) => this.formatCell(values[i] ?? '', widths[i], col));
      return parts.join(COLUMN_SEPARATOR);
    }

    // With wrap: split the wrap column into chunks, emit continuation lines
    const wrapValue = (values[wrapColIdx] ?? '').replace(/[\r\n]+/g, ' ');
    const wrapWidth = widths[wrapColIdx];
    const chunks = this.chunkText(wrapValue, wrapWidth);
    if (chunks.length === 0) chunks.push('');

    // First line: full row with first chunk
    const firstParts = this.columns.map((col, i) => {
      const val = i === wrapColIdx ? chunks[0] : (values[i] ?? '');
      return this.formatCell(val, widths[i], col);
    });
    const lines = [firstParts.join(COLUMN_SEPARATOR)];

    // Continuation lines: empty cells for other columns, next chunk in wrap column
    const indent = this.columns
      .slice(0, wrapColIdx)
      .reduce((sum, _col, i) => sum + widths[i] + COLUMN_SEPARATOR.length, 0);
    for (let c = 1; c < chunks.length; c++) {
      lines.push(' '.repeat(indent) + chunks[c]);
    }
    return lines.join('\n');
  }

  private chunkText(text: string, width: number): string[] {
    if (width <= 0) return [text];
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > width) {
      // Try to break at the last whitespace within the width window
      let breakAt = remaining.lastIndexOf(' ', width);
      // If no space found in window or breakpoint is too early, hard-break at width
      if (breakAt <= 0 || breakAt < width / 2) {
        breakAt = width;
      }
      chunks.push(remaining.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt).trimStart();
    }
    if (remaining.length > 0) chunks.push(remaining);

    return chunks;
  }

  private computeWidths(): number[] {
    const termWidth = process.stdout.columns || 120;
    const separatorsWidth = COLUMN_SEPARATOR.length * (this.columns.length - 1);
    const fixedWidth = this.columns.reduce((sum, c) => (c.width === 'flex' ? sum : sum + c.width), 0);
    const flexCount = this.columns.filter((c) => c.width === 'flex').length;
    const remaining = Math.max(0, termWidth - fixedWidth - separatorsWidth);
    const flexWidth = flexCount > 0 ? Math.max(MIN_FLEX_WIDTH, Math.floor(remaining / flexCount)) : 0;
    return this.columns.map((c) => (c.width === 'flex' ? flexWidth : c.width));
  }

  private formatCell(value: string, width: number, col: StreamColumn): string {
    // Strip newlines (streaming output is single-line)
    const clean = value.replace(/[\r\n]+/g, ' ');
    const truncateMode = col.truncate ?? 'end';
    const visible = visibleLength(clean);

    let truncated: string;
    if (visible > width) {
      // Truncating ANSI-colored strings requires stripping colors first
      const plain = stripAnsi(clean);
      if (truncateMode === 'start') {
        truncated = `…${plain.slice(plain.length - (width - 1))}`;
      } else {
        truncated = `${plain.slice(0, width - 1)}…`;
      }
    } else {
      truncated = clean;
    }

    const padSize = width - visibleLength(truncated);
    if (padSize <= 0) return truncated;
    const padding = ' '.repeat(padSize);

    if (col.align === 'right') {
      return padding + truncated;
    }
    return truncated + padding;
  }
}
