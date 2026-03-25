-- 004_cleanup_test_data.sql — Remove test pollution from production tables
-- Context: 93.9% of tasks (5,785/6,189) are from test runs with /tmp/* repo_paths.
-- 68.6% of messages (304/443) have test* sender_ids.
-- Additionally, orphaned test schemas from crashed test runs are cleaned up.

-- ============================================================================
-- Step 1: Clean up test tasks and related data
-- ============================================================================

-- Delete tasks with /tmp/* repo_paths (cascades to task_actors, task_dependencies,
-- task_stage_log, task_tags via ON DELETE CASCADE)
DELETE FROM tasks WHERE repo_path LIKE '/tmp/%';

-- Delete orphaned projects that pointed to /tmp/* paths (no tasks remain)
DELETE FROM projects WHERE repo_path LIKE '/tmp/%';

-- ============================================================================
-- Step 2: Clean up test messages
-- ============================================================================

-- Messages with test* sender_ids are from test runs.
-- Must delete messages first (FK to conversations), then orphaned conversations.
DELETE FROM messages WHERE sender_id LIKE 'test%';

-- Delete conversations that have zero remaining messages
DELETE FROM conversations c
WHERE NOT EXISTS (
  SELECT 1 FROM messages m WHERE m.conversation_id = c.id
);

-- Delete conversation_members for deleted conversations (ON DELETE CASCADE handles this,
-- but clean up any orphans just in case)
DELETE FROM conversation_members cm
WHERE NOT EXISTS (
  SELECT 1 FROM conversations c WHERE c.id = cm.conversation_id
);

-- ============================================================================
-- Step 3: Clean up orphaned test schemas (only when running in public schema)
-- ============================================================================

-- Drop any leftover test_* schemas from crashed test runs.
-- Guarded: only runs when current schema is public (not during test schema setup,
-- which would drop sibling test schemas in concurrent runs).
DO $$
DECLARE
  schema_rec RECORD;
  current_schema_name TEXT;
BEGIN
  SELECT current_schema INTO current_schema_name;
  IF current_schema_name != 'public' THEN
    RETURN;  -- Skip when running inside a test schema
  END IF;

  FOR schema_rec IN
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'test_%'
  LOOP
    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', schema_rec.schema_name);
  END LOOP;
END;
$$;

-- Note: VACUUM ANALYZE cannot run inside a transaction (migration runner wraps
-- in BEGIN/COMMIT). PostgreSQL's autovacuum will reclaim space automatically.
-- Run `VACUUM ANALYZE tasks, messages, conversations, projects;` manually if needed.
