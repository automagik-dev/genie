/** @jsxImportSource @opentui/react */
/** Context menu overlay for agent actions in the tree view. */

import { useKeyboard } from '@opentui/react';
import { useCallback, useRef, useState } from 'react';
import { palette } from '../theme.js';
import type { MenuItem } from '../types.js';

interface ContextMenuProps {
  items: MenuItem[];
  onAction: (action: string, payload?: string) => void;
  onClose: () => void;
  /** Row offset from top to position the menu near the triggering node */
  positionY?: number;
}

export function ContextMenu({ items, onAction, onClose, positionY = 0 }: ContextMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputMode, setInputMode] = useState(false);
  const inputRef = useRef('');

  const selectOptions = items.map((item) => ({
    name: `${item.label}${item.shortcut ? `  ${item.shortcut}` : ''}`,
    description: '',
    value: item.action,
  }));

  useKeyboard(
    useCallback(
      (key: { name: string }) => {
        if (inputMode) return; // let input handle everything
        if (key.name === 'escape') {
          onClose();
          return;
        }
        // Shortcut keys
        for (const item of items) {
          if (item.shortcut && key.name === item.shortcut.toLowerCase()) {
            if (item.needsInput) {
              setInputMode(true);
              inputRef.current = '';
              setSelectedIndex(items.indexOf(item));
            } else {
              onAction(item.action);
            }
            return;
          }
        }
      },
      [inputMode, items, onAction, onClose],
    ),
  );

  const handleSelect = useCallback(
    (_index: number, option: { value?: unknown } | null) => {
      const value = option?.value as string | undefined;
      if (!value) return;
      const item = items.find((i) => i.action === value);
      if (item?.needsInput) {
        setInputMode(true);
        inputRef.current = '';
        return;
      }
      onAction(value);
    },
    [items, onAction],
  );

  const handleInputChange = useCallback((v: string) => {
    inputRef.current = v;
  }, []);

  const handleInputSubmit = useCallback(() => {
    const item = items[selectedIndex];
    const value = inputRef.current.trim();
    if (item && value) {
      onAction(item.action, value);
    }
    setInputMode(false);
    inputRef.current = '';
  }, [items, selectedIndex, onAction]);

  if (items.length === 0) {
    onClose();
    return null;
  }

  return (
    <box position="absolute" width="100%" height="100%" onMouseDown={() => onClose()}>
      {positionY > 0 ? <box height={positionY} /> : null}
      <box
        border
        borderStyle="rounded"
        borderColor={palette.borderActive}
        backgroundColor={palette.bgRaised}
        width={32}
        height={inputMode ? items.length + 5 : items.length + 2}
        flexDirection="column"
        onMouseDown={(e: { stopPropagation?: () => void }) => e.stopPropagation?.()}
      >
        <select
          options={selectOptions}
          selectedIndex={selectedIndex}
          onSelect={handleSelect}
          onChange={(index: number) => setSelectedIndex(index)}
          focused={!inputMode}
          height={items.length}
          showDescription={false}
          selectedBackgroundColor={palette.accentDim}
          selectedTextColor={palette.accentBright}
        />

        {inputMode ? (
          <box paddingX={1} height={3} flexDirection="column">
            <text>
              <span fg={palette.textDim}>{items[selectedIndex]?.label ?? 'Input'}:</span>
            </text>
            <input
              onChange={handleInputChange}
              onSubmit={handleInputSubmit as () => void}
              placeholder="Type and press Enter..."
              focused
              width={28}
              backgroundColor={palette.bg}
              textColor={palette.text}
              placeholderColor={palette.textMuted}
            />
          </box>
        ) : null}
      </box>
    </box>
  );
}
