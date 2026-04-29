import { describe, expect, test } from 'bun:test';
import { CLAUDE_CODE_ACTIVE_TITLE_PREFIX, isClaudeLikeCommandTitle } from './pane-detection.js';

describe('isClaudeLikeCommandTitle', () => {
  test('recognizes Claude Code v2 tmux panes by version command and active title prefix', () => {
    expect(isClaudeLikeCommandTitle('2.1.123', `${CLAUDE_CODE_ACTIVE_TITLE_PREFIX}genie-genie`)).toBe(true);
  });

  test('does not treat every active-looking tmux title as Claude Code', () => {
    expect(isClaudeLikeCommandTitle('zsh', `${CLAUDE_CODE_ACTIVE_TITLE_PREFIX}genie-genie`)).toBe(false);
  });
});
