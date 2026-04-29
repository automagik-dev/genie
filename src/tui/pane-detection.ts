import type { TmuxPane } from './diagnostics.js';

export const CLAUDE_CODE_ACTIVE_TITLE_PREFIX = '\u2733 ';
const SEMVER_COMMAND = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/**
 * Claude Code v2 can report the pane command as its version string (for
 * example `2.1.123`) while setting the tmux title to `\u2733 agent-name`.
 */
export function isClaudeLikeCommandTitle(command: string | undefined, title: string | undefined): boolean {
  const cmd = (command ?? '').toLowerCase();
  const paneTitle = title ?? '';
  const lowerTitle = paneTitle.toLowerCase();
  const isClaudeCodeV2Title =
    SEMVER_COMMAND.test(command ?? '') && paneTitle.startsWith(CLAUDE_CODE_ACTIVE_TITLE_PREFIX);
  return cmd === 'claude' || cmd.includes('claude') || lowerTitle.includes('claude') || isClaudeCodeV2Title;
}

export function isClaudeLikePane(pane: TmuxPane): boolean {
  return !pane.isDead && isClaudeLikeCommandTitle(pane.command, pane.title);
}
