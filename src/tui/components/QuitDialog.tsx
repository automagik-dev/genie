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
      backgroundColor={palette.bgOverlay}
    >
      <box
        border
        borderColor={palette.borderActive}
        backgroundColor={palette.bgRaised}
        paddingX={3}
        paddingY={1}
        flexDirection="column"
        alignItems="center"
        gap={1}
      >
        <text>
          <span fg={palette.accent}>Close TUI?</span>
        </text>
        <text>
          <span fg={palette.text}>Enter</span>
          <span fg={palette.textDim}> to close </span>
          <span fg={palette.textMuted}> | </span>
          <span fg={palette.text}> Esc</span>
          <span fg={palette.textDim}> to cancel</span>
        </text>
        <text>
          <span fg={palette.textMuted}>Daemon keeps running. `genie serve stop` to shut down.</span>
        </text>
      </box>
    </box>
  );
}
