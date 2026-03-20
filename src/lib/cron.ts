/**
 * Cron expression parsing, next-due computation, and duration parsing.
 * Shared by schedule CLI commands and the scheduler daemon.
 */

// ============================================================================
// Duration parsing
// ============================================================================

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)s?$/i;

/**
 * Parse a human-friendly duration string into milliseconds.
 * Supports: "30s", "10m", "2h", "24h", "1d", "1.5h"
 */
export function parseDuration(input: string): number {
  const match = input.trim().match(DURATION_RE);
  if (!match) throw new Error(`Invalid duration: "${input}". Expected format: 10m, 2h, 24h, 1d`);

  const value = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  const multipliers: Record<string, number> = {
    s: 1000,
    sec: 1000,
    m: 60_000,
    min: 60_000,
    h: 3_600_000,
    hr: 3_600_000,
    d: 86_400_000,
    day: 86_400_000,
  };

  const ms = value * multipliers[unit];
  if (ms <= 0) throw new Error(`Duration must be positive: "${input}"`);
  return ms;
}

// ============================================================================
// Cron parsing
// ============================================================================

/** Expand a range (start-end) or wildcard (*) with an optional step into a list of values. */
function expandRange(range: string, step: number, min: number, max: number): number[] {
  if (range === '*') {
    const out: number[] = [];
    for (let i = min; i <= max; i += step) out.push(i);
    return out;
  }
  if (range.includes('-')) {
    const [start, end] = range.split('-').map(Number);
    const out: number[] = [];
    for (let i = start; i <= end; i += step) out.push(i);
    return out;
  }
  return [Number.parseInt(range, 10)];
}

/**
 * Parse a single cron field into a sorted array of valid integer values.
 * Supports: wildcards (*), ranges (1-5), steps (star/5, 1-10/2), lists (1,3,5)
 */
function parseCronField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? Number.parseInt(stepMatch[2], 10) : 1;
    const range = stepMatch ? stepMatch[1] : part;
    for (const v of expandRange(range, step, min, max)) values.add(v);
  }

  return [...values].sort((a, b) => a - b);
}

/**
 * Compute the next occurrence of a 5-field cron expression after a given time.
 * Fields: minute hour day-of-month month day-of-week (0=Sunday)
 *
 * Follows POSIX day-matching semantics:
 *   - If both DOM and DOW are restricted (not *), the day matches if EITHER matches (union).
 *   - Otherwise, both must match (intersection — wildcards always match).
 */
export function computeNextCronDue(cronExpr: string, after?: Date): Date {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) throw new Error(`Invalid cron expression: "${cronExpr}"`);

  const [minField, hourField, domField, monthField, dowField] = parts;

  const minutes = parseCronField(minField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);
  const doms = parseCronField(domField, 1, 31);
  const months = parseCronField(monthField, 1, 12);
  const dows = parseCronField(dowField, 0, 6);

  const domRestricted = domField !== '*';
  const dowRestricted = dowField !== '*';

  const base = after ?? new Date();
  const candidate = new Date(base.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const limit = new Date(candidate.getTime() + 366 * 24 * 60 * 60 * 1000);

  while (candidate <= limit) {
    const month = candidate.getMonth() + 1;
    const dom = candidate.getDate();
    const dow = candidate.getDay();
    const hour = candidate.getHours();
    const minute = candidate.getMinutes();

    if (!months.includes(month)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    let dayMatch: boolean;
    if (domRestricted && dowRestricted) {
      dayMatch = doms.includes(dom) || dows.includes(dow);
    } else {
      dayMatch = doms.includes(dom) && dows.includes(dow);
    }

    if (!dayMatch) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    if (!hours.includes(hour)) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }

    if (minutes.includes(minute)) {
      return candidate;
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(`No next cron occurrence found for "${cronExpr}" within 366 days`);
}
