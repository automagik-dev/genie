/**
 * Export/Import format — schema-versioned JSON document for data portability.
 *
 * Every export produces an ExportDocument with version, metadata, and data keyed by table name.
 * The version field enables forward-compatible schema evolution.
 */

export const EXPORT_VERSION = '1.0' as const;

export interface ExportDocument {
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  exportedBy: string;
  genieVersion: string;
  type: 'full' | 'partial';
  groups: string[];
  skippedTables: string[];
  data: Record<string, unknown[]>;
}

export type ExportGroup =
  | 'boards'
  | 'tasks'
  | 'tags'
  | 'projects'
  | 'schedules'
  | 'agents'
  | 'apps'
  | 'comms'
  | 'config';

/** Tables belonging to each export group */
export const GROUP_TABLES: Record<ExportGroup, string[]> = {
  boards: ['boards', 'board_templates', 'task_types'],
  tasks: ['tasks', 'task_tags', 'task_actors', 'task_dependencies', 'task_stage_log'],
  tags: ['tags'],
  projects: ['projects'],
  schedules: ['schedules'],
  agents: ['agents', 'agent_templates', 'agent_checkpoints'],
  apps: ['app_store', 'installed_apps', 'app_versions'],
  comms: ['conversations', 'conversation_members', 'messages', 'mailbox', 'team_chat', 'notification_preferences'],
  config: ['os_config', 'instances', 'warm_pool', 'golden_images'],
};

export const ALL_GROUPS: ExportGroup[] = [
  'boards',
  'tasks',
  'tags',
  'projects',
  'schedules',
  'agents',
  'apps',
  'comms',
  'config',
];

export type ConflictMode = 'fail' | 'merge' | 'overwrite';

/** Create a new empty ExportDocument shell */
export function createExportDocument(
  type: 'full' | 'partial',
  groups: string[],
  genieVersion: string,
  actor: string,
): ExportDocument {
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: actor,
    genieVersion,
    type,
    groups,
    skippedTables: [],
    data: {},
  };
}

/** Validate that a parsed JSON object is a valid ExportDocument */
export function validateExportDocument(
  obj: unknown,
): { valid: true; doc: ExportDocument } | { valid: false; error: string } {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, error: 'Not a valid JSON object' };
  }
  const doc = obj as Record<string, unknown>;
  if (doc.version !== EXPORT_VERSION) {
    return { valid: false, error: `Unsupported version: ${doc.version} (expected ${EXPORT_VERSION})` };
  }
  if (!doc.exportedAt || typeof doc.exportedAt !== 'string') {
    return { valid: false, error: 'Missing or invalid exportedAt' };
  }
  if (!doc.data || typeof doc.data !== 'object') {
    return { valid: false, error: 'Missing or invalid data' };
  }
  return { valid: true, doc: doc as unknown as ExportDocument };
}
