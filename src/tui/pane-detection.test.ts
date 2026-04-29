import { describe, expect, test } from 'bun:test';
import { CLAUDE_CODE_ACTIVE_TITLE_PREFIX, isClaudeLikeCommandTitle } from './pane-detection.js';

describe('isClaudeLikeCommandTitle', () => {
  test('recognizes Claude Code panes by the actual process command line', () => {
    expect(
      isClaudeLikeCommandTitle(
        'opaque-runtime-title',
        `${CLAUDE_CODE_ACTIVE_TITLE_PREFIX}genie-genie`,
        '/Users/example/.local/bin/claude --agent-id genie@genie',
      ),
    ).toBe(true);
  });

  test('does not treat every active-looking tmux title as Claude Code', () => {
    expect(isClaudeLikeCommandTitle('zsh', `${CLAUDE_CODE_ACTIVE_TITLE_PREFIX}genie-genie`, '/bin/zsh')).toBe(false);
  });
});
