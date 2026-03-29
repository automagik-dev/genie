import type { TasksViewProps } from '../../../lib/types';

export function TasksView({ windowId }: TasksViewProps) {
  return <div data-window-id={windowId}>Tasks View</div>;
}
