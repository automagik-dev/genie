/**
 * Shared formatting utilities for CLI table output.
 *
 * Consolidates padRight, truncate, and formatTimestamp.
 */

/** Pad a string to a minimum width with trailing spaces. */
export function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

/** Truncate a string with a trailing Unicode ellipsis (…). */
export function truncate(str: string, len: number): string {
  return str.length <= len ? str : `${str.slice(0, len - 1)}…`;
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

type ColorName = keyof typeof ANSI;

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;

/** Wrap text in ANSI color (no-op when not a TTY or NO_COLOR is set). */
export function color(name: ColorName, text: string): string {
  return isTTY ? `${ANSI[name]}${text}${ANSI.reset}` : text;
}
