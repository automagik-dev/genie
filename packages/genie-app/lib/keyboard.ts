/**
 * Keyboard Shortcuts — Custom hook for vim-style navigation.
 *
 * j/k  — navigate up/down in lists
 * Enter — select/expand
 * Esc   — back/deselect
 * /     — focus search
 * ?     — show help overlay
 */

import { useCallback, useEffect, useState } from 'react';

export interface KeyboardActions {
  onDown?: () => void;
  onUp?: () => void;
  onSelect?: () => void;
  onBack?: () => void;
  onSearch?: () => void;
  onHelp?: () => void;
}

/**
 * Hook that registers keyboard shortcuts for the active view.
 * Returns `helpVisible` state and a `dismissHelp` function.
 */
export function useKeyboard(actions: KeyboardActions): {
  helpVisible: boolean;
  dismissHelp: () => void;
} {
  const [helpVisible, setHelpVisible] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Skip when typing in an input/textarea/select
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      switch (e.key) {
        case 'j':
          actions.onDown?.();
          break;
        case 'k':
          actions.onUp?.();
          break;
        case 'Enter':
          actions.onSelect?.();
          break;
        case 'Escape':
          if (helpVisible) {
            setHelpVisible(false);
          } else {
            actions.onBack?.();
          }
          break;
        case '/':
          e.preventDefault();
          actions.onSearch?.();
          break;
        case '?':
          setHelpVisible((v) => !v);
          actions.onHelp?.();
          break;
        default:
          return;
      }
    },
    [actions, helpVisible],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return {
    helpVisible,
    dismissHelp: () => setHelpVisible(false),
  };
}

/**
 * Shortcut definitions for the help overlay.
 */
export const shortcuts = [
  { key: 'j', label: 'Move down' },
  { key: 'k', label: 'Move up' },
  { key: 'Enter', label: 'Select / expand' },
  { key: 'Esc', label: 'Back / deselect' },
  { key: '/', label: 'Focus search' },
  { key: '?', label: 'Toggle help' },
] as const;
