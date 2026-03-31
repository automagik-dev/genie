/** @jsxImportSource @opentui/react */
/** Quit confirmation popup — shown on Ctrl+Q */

import { useKeyboard } from '@opentui/react';
import { palette } from '../theme.js';

interface QuitDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export function QuitDialog({ onConfirm, onCancel }: QuitDialogProps) {
  useKeyboard((key) => {
    if (key.name === 'enter' || key.name === 'return' || key.name === 'y') {
      onConfirm();
    } else if (key.name === 'escape' || key.name === 'n') {
      onCancel();
    }
  });

  return (
    <box
      position="absolute"
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
      backgroundColor="#0a0a0a"
    >
      <box
        border
        borderColor={palette.violet}
        backgroundColor="#111111"
        paddingX={3}
        paddingY={1}
        flexDirection="column"
        alignItems="center"
        gap={1}
      >
        <text>
          <span fg={palette.purple}>Quit genie?</span>
        </text>
        <text>
          <span fg={palette.text}>Enter</span>
          <span fg={palette.textDim}> to quit </span>
          <span fg={palette.textMuted}> | </span>
          <span fg={palette.text}> Esc</span>
          <span fg={palette.textDim}> to cancel</span>
        </text>
        <text>
          <span fg={palette.textMuted}>Hint: Ctrl+D to detach (keep running)</span>
        </text>
      </box>
    </box>
  );
}
