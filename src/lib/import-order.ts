/**
 * Import ordering — FK dependency graph for safe transactional inserts.
 *
 * Tables are grouped into dependency levels. Each level can be inserted
 * in any order, but all tables in level N must be inserted before level N+1.
 *
 * Self-referential tables (tasks.parent_id, messages.reply_to_id) are handled
 * by inserting with NULLed self-refs first, then updating after all rows exist.
 */

/** Tables at each FK dependency level (0 = no FK deps, higher = more deps) */
const IMPORT_LEVELS: string[][] = [
  // Level 0: No FK dependencies
  [
    'schedules',
    'sessions',
    'projects',
    'agent_templates',
    'agent_checkpoints',
    'tags',
    'task_types',
    'notification_preferences',
    // Optional (KhalOS)
    'os_config',
    'golden_images',
    'warm_pool',
    'instances',
  ],
  // Level 1: Depend on Level 0
  ['triggers', 'boards', 'board_templates', 'agents', 'conversations'],
  // Level 2: Depend on Level 1
  ['tasks', 'runs', 'messages', 'conversation_members', 'mailbox', 'team_chat'],
  // Level 3: Depend on Level 2
  ['task_tags', 'task_actors', 'task_dependencies', 'task_stage_log', 'heartbeats', 'machine_snapshots'],
];

/** Tables with self-referential FKs that need two-pass insert */
export const SELF_REFERENTIAL_COLUMNS: Record<string, string> = {
  tasks: 'parent_id',
  messages: 'reply_to_id',
  conversations: 'parent_message_id',
};

/**
 * Get the import level for a table. Returns -1 if not in the graph.
 */
function getTableLevel(table: string): number {
  for (let i = 0; i < IMPORT_LEVELS.length; i++) {
    if (IMPORT_LEVELS[i].includes(table)) return i;
  }
  return -1;
}

/**
 * Sort tables by their import level (ascending).
 * Unknown tables are appended at the end.
 */
export function sortByImportOrder(tables: string[]): string[] {
  return [...tables].sort((a, b) => {
    const la = getTableLevel(a);
    const lb = getTableLevel(b);
    const effectiveA = la === -1 ? 999 : la;
    const effectiveB = lb === -1 ? 999 : lb;
    return effectiveA - effectiveB;
  });
}

/**
 * Get the primary key column(s) for known tables.
 * Most tables use 'id', but some have composite keys.
 */
export function getPrimaryKey(table: string): string[] {
  const compositeKeys: Record<string, string[]> = {
    task_tags: ['task_id', 'tag_id'],
    task_actors: ['task_id', 'actor_type', 'actor_id', 'role'],
    task_dependencies: ['task_id', 'depends_on_id'],
    conversation_members: ['conversation_id', 'actor_type', 'actor_id'],
    notification_preferences: ['actor_type', 'actor_id', 'channel'],
  };
  return compositeKeys[table] ?? ['id'];
}
