import type { TmuxPane } from './diagnostics.js';

export const CLAUDE_CODE_ACTIVE_TITLE_PREFIX = '\u2733 ';
const CLAUDE_EXECUTABLE = /(^|[/\s])claude(\s|$)/i;
const PLAIN_SHELL_COMMANDS = new Set(['bash', 'fish', 'login', 'sh', 'tmux', 'zsh']);

function hasClaudeActiveTitle(title: string | undefined, command: string): boolean {
  return (title ?? '').startsWith(CLAUDE_CODE_ACTIVE_TITLE_PREFIX) && !PLAIN_SHELL_COMMANDS.has(command);
}

export function isClaudeLikeCommandTitle(
  command: string | undefined,
  title: string | undefined,
  processCommand: string | undefined,
): boolean {
  const cmd = (command ?? '').toLowerCase();
  const lowerTitle = (title ?? '').toLowerCase();
  return (
    CLAUDE_EXECUTABLE.test(processCommand ?? '') ||
    hasClaudeActiveTitle(title, cmd) ||
    cmd === 'claude' ||
    cmd.includes('claude') ||
    lowerTitle.includes('claude')
  );
}

export function isClaudeLikePane(pane: TmuxPane): boolean {
  return !pane.isDead && isClaudeLikeCommandTitle(pane.command, pane.title, pane.processCommand);
}
