export interface StopEvent {
  label: string;
  detail?: string;
  status: 'done' | 'pending' | 'failed';
  message?: string;
}

interface StopViewParams {
  target: string;
  events: StopEvent[];
  summary: string;
  followUps?: string[];
}

export function buildStopView(params: StopViewParams): string {
  const counts = countStatuses(params.events);
  const lines: string[] = [];

  lines.push(`# Stop signal • ${params.target}`);
  lines.push('');
  lines.push(`**${counts.done} stopped** · **${counts.pending} pending** · **${counts.failed} failed**`);
  lines.push('');

  // Timeline of events
  for (const event of params.events) {
    const icon = event.status === 'done' ? '✓' : event.status === 'pending' ? '○' : '✗';
    lines.push(`${icon} **${event.label}**`);
    if (event.detail) {
      lines.push(`  ${event.detail}`);
    }
    if (event.message) {
      lines.push(`  *${event.message}*`);
    }
  }

  lines.push('');

  // Summary
  const allDone = params.events.every((e) => e.status === 'done');
  const summaryIcon = allDone ? '✅' : '⚠️';
  lines.push(`${summaryIcon} **Summary**`);
  lines.push(params.summary);

  // Follow-ups
  if (params.followUps && params.followUps.length > 0) {
    lines.push('');
    for (const followUp of params.followUps) {
      lines.push(`- ${followUp}`);
    }
  }

  return lines.join('\n');
}

function countStatuses(events: StopEvent[]): { done: number; pending: number; failed: number } {
  return events.reduce(
    (acc, event) => {
      if (event.status === 'done') acc.done += 1;
      else if (event.status === 'pending') acc.pending += 1;
      else if (event.status === 'failed') acc.failed += 1;
      return acc;
    },
    { done: 0, pending: 0, failed: 0 }
  );
}
