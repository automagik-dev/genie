import { useCallback, useEffect, useState } from 'react';

/**
 * Keyboard navigation hook for list/grid views.
 * Supports j/k (vim), arrow keys, Home/End, and Enter for selection.
 */
export function useKeyboardNav(itemCount: number, onSelect?: (index: number) => void) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Clamp index when item count changes
  useEffect(() => {
    if (itemCount === 0) {
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex((prev) => Math.min(prev, itemCount - 1));
  }, [itemCount]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (itemCount === 0) return;

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => (prev >= itemCount - 1 ? 0 : prev + 1));
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => (prev <= 0 ? itemCount - 1 : prev - 1));
          break;
        case 'Home':
          e.preventDefault();
          setSelectedIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setSelectedIndex(itemCount - 1);
          break;
        case 'Enter':
          e.preventDefault();
          onSelect?.(selectedIndex);
          break;
      }
    },
    [itemCount, selectedIndex, onSelect],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return { selectedIndex, setSelectedIndex };
}
