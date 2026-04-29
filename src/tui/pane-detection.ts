import type { TmuxPane } from './diagnostics.js';

export const CLAUDE_CODE_ACTIVE_TITLE_PREFIX = '\u2733 ';
const CLAUDE_EXECUTABLE = /(^|[/\s])claude(\s|$)/i;

export function isClaudeLikeCommandTitle(
  command: string | undefined,
  title: string | undefined,
  processCommand: string | undefined,
): boolean {
  const cmd = (command ?? '').toLowerCase();
  const lowerTitle = (title ?? '').toLowerCase();
  return (
    CLAUDE_EXECUTABLE.test(processCommand ?? '') ||
    cmd === 'claude' ||
    cmd.includes('claude') ||
    lowerTitle.includes('claude')
  );
}

export function isClaudeLikePane(pane: TmuxPane): boolean {
  return !pane.isDead && isClaudeLikeCommandTitle(pane.command, pane.title, pane.processCommand);
}
