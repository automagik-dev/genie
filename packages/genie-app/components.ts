'use client';
import { type ComponentType, lazy } from 'react';

interface AppComponentProps {
  windowId: string;
  meta?: Record<string, unknown>;
}

export const components: Record<string, ComponentType<AppComponentProps>> = {
  agents: lazy(() => import('./views/agents/ui/AgentsView').then((m) => ({ default: m.AgentsView }))),
  tasks: lazy(() => import('./views/tasks/ui/TasksView').then((m) => ({ default: m.TasksView }))),
  terminal: lazy(() => import('./views/terminal/ui/TerminalView').then((m) => ({ default: m.TerminalView }))),
  dashboard: lazy(() => import('./views/dashboard/ui/DashboardView').then((m) => ({ default: m.DashboardView }))),
  activity: lazy(() => import('./views/activity/ui/ActivityView').then((m) => ({ default: m.ActivityView }))),
};
