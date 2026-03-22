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
  if (step === 0) throw new Error('Cron step value cannot be 0');
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
export interface CronOptions {
  /** Compute next occurrence after this time. Defaults to now. */
  after?: Date;
  /** IANA timezone (e.g. 'America/New_York'). When set, cron fields are matched against wall-clock time in this timezone. */
  timezone?: string;
}

/** Get the wall-clock components of a UTC Date in a given timezone. */
function getTimeParts(
  date: Date,
  tz?: string,
): { month: number; dom: number; dow: number; hour: number; minute: number } {
  if (!tz) {
    return {
      month: date.getMonth() + 1,
      dom: date.getDate(),
      dow: date.getDay(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  return {
    month: get('month'),
    dom: get('day'),
    dow: dayMap[weekday] ?? 0,
    hour: get('hour') === 24 ? 0 : get('hour'),
    minute: get('minute'),
  };
}

function parseOpts(afterOrOpts?: Date | CronOptions): { after?: Date; timezone?: string } {
  if (afterOrOpts instanceof Date) return { after: afterOrOpts };
  if (afterOrOpts) return { after: afterOrOpts.after, timezone: afterOrOpts.timezone };
  return {};
}

/** Advance candidate to the start of the next day in the given timezone. */
function advanceToNextDay(candidate: Date, tz?: string): void {
  candidate.setTime(candidate.getTime() + 24 * 60 * 60 * 1000);
  const tp = getTimeParts(candidate, tz);
  candidate.setTime(candidate.getTime() - tp.hour * 3_600_000 - tp.minute * 60_000);
}

interface ParsedCron {
  minutes: number[];
  hours: number[];
  doms: number[];
  months: number[];
  dows: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseCronExpr(cronExpr: string): ParsedCron {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) throw new Error(`Invalid cron expression: "${cronExpr}"`);
  const [minField, hourField, domField, monthField, dowField] = parts;
  return {
    minutes: parseCronField(minField, 0, 59),
    hours: parseCronField(hourField, 0, 23),
    doms: parseCronField(domField, 1, 31),
    months: parseCronField(monthField, 1, 12),
    dows: parseCronField(dowField, 0, 6),
    domRestricted: domField !== '*',
    dowRestricted: dowField !== '*',
  };
}

export function computeNextCronDue(cronExpr: string, afterOrOpts?: Date | CronOptions): Date {
  const { after, timezone } = parseOpts(afterOrOpts);
  const cron = parseCronExpr(cronExpr);

  const base = after ?? new Date();
  const candidate = new Date(base.getTime());
  candidate.setSeconds(0, 0);
  candidate.setTime(candidate.getTime() + 60_000);

  const limit = new Date(candidate.getTime() + 366 * 24 * 60 * 60 * 1000);

  while (candidate <= limit) {
    const tp = getTimeParts(candidate, timezone);

    if (!cron.months.includes(tp.month)) {
      advanceToNextDay(candidate, timezone);
      continue;
    }

    const dayMatch =
      cron.domRestricted && cron.dowRestricted
        ? cron.doms.includes(tp.dom) || cron.dows.includes(tp.dow)
        : cron.doms.includes(tp.dom) && cron.dows.includes(tp.dow);

    if (!dayMatch) {
      advanceToNextDay(candidate, timezone);
      continue;
    }

    if (!cron.hours.includes(tp.hour)) {
      candidate.setTime(candidate.getTime() + 3_600_000 - tp.minute * 60_000);
      continue;
    }

    if (cron.minutes.includes(tp.minute)) return candidate;

    candidate.setTime(candidate.getTime() + 60_000);
  }

  throw new Error(`No next cron occurrence found for "${cronExpr}" within 366 days`);
}
