/**
 * NATS Subject Registry — All subjects the genie-app backend publishes/subscribes to.
 *
 * Pattern: `khal.<orgId>.genie.<domain>.<action>`
 * Each builder takes an orgId and returns the fully-qualified NATS subject string.
 */

// ============================================================================
// Subject Builders
// ============================================================================

function s(orgId: string, path: string): string {
  return `khal.${orgId}.genie.${path}`;
}

/**
 * All NATS subjects used by the genie-app backend service.
 * Organized by domain matching the 9 frontend screens.
 */
export const GENIE_SUBJECTS = {
  // ---- Dashboard ----
  dashboard: {
    stats: (orgId: string) => s(orgId, 'dashboard.stats'),
  },

  // ---- Agents ----
  agents: {
    list: (orgId: string) => s(orgId, 'agents.list'),
    show: (orgId: string) => s(orgId, 'agents.show'),
  },

  // ---- Sessions ----
  sessions: {
    list: (orgId: string) => s(orgId, 'sessions.list'),
    content: (orgId: string) => s(orgId, 'sessions.content'),
    search: (orgId: string) => s(orgId, 'sessions.search'),
  },

  // ---- Tasks ----
  tasks: {
    list: (orgId: string) => s(orgId, 'tasks.list'),
    show: (orgId: string) => s(orgId, 'tasks.show'),
  },

  // ---- Boards ----
  boards: {
    list: (orgId: string) => s(orgId, 'boards.list'),
    show: (orgId: string) => s(orgId, 'boards.show'),
  },

  // ---- Costs ----
  costs: {
    summary: (orgId: string) => s(orgId, 'costs.summary'),
    sessions: (orgId: string) => s(orgId, 'costs.sessions'),
    tokens: (orgId: string) => s(orgId, 'costs.tokens'),
    efficiency: (orgId: string) => s(orgId, 'costs.efficiency'),
  },

  // ---- Schedules ----
  schedules: {
    list: (orgId: string) => s(orgId, 'schedules.list'),
  },

  // ---- System ----
  system: {
    health: (orgId: string) => s(orgId, 'system.health'),
    snapshots: (orgId: string) => s(orgId, 'system.snapshots'),
  },

  // ---- Settings ----
  settings: {
    get: (orgId: string) => s(orgId, 'settings.get'),
    set: (orgId: string) => s(orgId, 'settings.set'),
    templates: (orgId: string) => s(orgId, 'settings.templates'),
    skills: (orgId: string) => s(orgId, 'settings.skills'),
    rules: (orgId: string) => s(orgId, 'settings.rules'),
  },

  // ---- PTY (Terminal) ----
  pty: {
    create: (orgId: string) => s(orgId, 'pty.create'),
    input: (orgId: string) => s(orgId, 'pty.input'),
    data: (orgId: string) => s(orgId, 'pty.data'),
    resize: (orgId: string) => s(orgId, 'pty.resize'),
    kill: (orgId: string) => s(orgId, 'pty.kill'),
  },

  // ---- Filesystem ----
  fs: {
    list: (orgId: string) => s(orgId, 'fs.list'),
    read: (orgId: string) => s(orgId, 'fs.read'),
    write: (orgId: string) => s(orgId, 'fs.write'),
  },

  // ---- Events (PG LISTEN/NOTIFY bridged to NATS pub/sub) ----
  events: {
    agentState: (orgId: string) => s(orgId, 'events.agent_state'),
    executorState: (orgId: string) => s(orgId, 'events.executor_state'),
    taskStage: (orgId: string) => s(orgId, 'events.task_stage'),
    runtime: (orgId: string) => s(orgId, 'events.runtime'),
    audit: (orgId: string) => s(orgId, 'events.audit'),
    message: (orgId: string) => s(orgId, 'events.message'),
    mailbox: (orgId: string) => s(orgId, 'events.mailbox'),
    taskDep: (orgId: string) => s(orgId, 'events.task_dep'),
    trigger: (orgId: string) => s(orgId, 'events.trigger'),
  },
} as const;

/** Convenience type for the full subject tree. */
export type GenieSubjects = typeof GENIE_SUBJECTS;
