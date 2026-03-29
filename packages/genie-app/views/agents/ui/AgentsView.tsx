import type { AgentsViewProps } from '../../../lib/types';

export function AgentsView({ windowId }: AgentsViewProps) {
  return <div data-window-id={windowId}>Agents View</div>;
}
