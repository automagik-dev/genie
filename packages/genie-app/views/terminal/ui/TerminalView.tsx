import type { TerminalViewProps } from '../../../lib/types';

export function TerminalView({ windowId }: TerminalViewProps) {
  return <div data-window-id={windowId}>Terminal View</div>;
}
