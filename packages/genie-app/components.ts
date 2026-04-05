'use client';
import { type ComponentType, lazy } from 'react';

interface AppComponentProps {
  windowId: string;
  meta?: Record<string, unknown>;
}

export const components: Record<string, ComponentType<AppComponentProps>> = {
  // ── Existing views ──
  agents: lazy(() => import('./views/agents/ui/AgentsView').then((m) => ({ default: m.AgentsView }))),
  tasks: lazy(() => import('./views/tasks/ui/TasksView').then((m) => ({ default: m.TasksView }))),
  terminal: lazy(() => import('./views/terminal/ui/TerminalView').then((m) => ({ default: m.TerminalView }))),
  dashboard: lazy(() => import('./views/dashboard/ui/DashboardView').then((m) => ({ default: m.DashboardView }))),
  wizard: lazy(() => import('./views/wizard/ui/WizardView').then((m) => ({ default: m.WizardView }))),
  activity: lazy(() => import('./views/activity/ui/ActivityView').then((m) => ({ default: m.ActivityView }))),
  // ── New views ──
  sessions: lazy(() => import('./views/sessions/ui/SessionsView').then((m) => ({ default: m.SessionsView }))),
  costs: lazy(() => import('./views/costs/ui/CostIntelligence').then((m) => ({ default: m.CostIntelligence }))),
  files: lazy(() => import('./views/files/ui/FilesView').then((m) => ({ default: m.FilesView }))),
  settings: lazy(() => import('./views/settings/ui/SettingsView').then((m) => ({ default: m.SettingsView }))),
  scheduler: lazy(() => import('./views/scheduler/ui/SchedulerView').then((m) => ({ default: m.SchedulerView }))),
  system: lazy(() => import('./views/system/ui/SystemView').then((m) => ({ default: m.SystemView }))),
};
