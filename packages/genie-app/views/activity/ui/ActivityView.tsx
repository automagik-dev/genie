import type { ActivityViewProps } from '../../../lib/types';

export function ActivityView({ windowId }: ActivityViewProps) {
  return <div data-window-id={windowId}>Activity View</div>;
}
