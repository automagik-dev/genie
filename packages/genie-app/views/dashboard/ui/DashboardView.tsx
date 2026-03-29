import type { DashboardViewProps } from '../../../lib/types';

export function DashboardView({ windowId }: DashboardViewProps) {
  return <div data-window-id={windowId}>Dashboard View</div>;
}
