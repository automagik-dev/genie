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
