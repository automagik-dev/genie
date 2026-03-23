-- 002_task_lifecycle.sql — Task lifecycle, messaging, and metadata tables
-- 11 tables: task_types, tasks, task_actors, task_dependencies, task_stage_log,
--            conversations, conversation_members, messages, tags, task_tags, notification_preferences

-- ============================================================================
-- Table 1: task_types — Dynamic pipeline definitions
-- ============================================================================
CREATE TABLE task_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  stages JSONB NOT NULL,
  is_builtin BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Table 2: tasks — Unified work entity (human + agent)
-- ============================================================================
CREATE TABLE tasks (
  id TEXT PRIMARY KEY DEFAULT 'task-' || substr(gen_random_uuid()::text, 1, 8),
  seq INTEGER NOT NULL,
  parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,

  -- Scoping
  repo_path TEXT NOT NULL,
  genie_os_folder_id UUID,

  -- Wish bridge
  wish_file TEXT,
  group_name TEXT,

  -- Identity
  title TEXT NOT NULL,
  description TEXT,
  acceptance_criteria TEXT,

  -- Type + dynamic stage
  type_id TEXT NOT NULL DEFAULT 'software' REFERENCES task_types(id),
  stage TEXT NOT NULL DEFAULT 'draft',
  status VARCHAR(20) NOT NULL DEFAULT 'ready'
    CHECK (status IN ('blocked', 'ready', 'in_progress', 'done', 'failed', 'cancelled')),

  -- Priority (human-essential, indexed)
  priority VARCHAR(10) NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('urgent', 'high', 'normal', 'low')),

  -- Timeline (planning + execution)
  start_date TIMESTAMPTZ,
  due_date TIMESTAMPTZ,
  estimated_effort TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,

  -- Blocking
  blocked_reason TEXT,

  -- Release bundling
  release_id TEXT,

  -- Execution locking (atomic checkout)
  checkout_run_id TEXT,
  execution_locked_at TIMESTAMPTZ,
  checkout_timeout_ms INTEGER DEFAULT 600000,

  -- Execution link
  session_id TEXT,
  pane_id TEXT,
  trace_id TEXT,

  -- Extensible metadata
  metadata JSONB DEFAULT '{}',

  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(parent_id, group_name)
);

-- Tasks indexes
CREATE INDEX idx_tasks_repo ON tasks(repo_path);
CREATE INDEX idx_tasks_seq ON tasks(repo_path, seq);
CREATE INDEX idx_tasks_folder ON tasks(genie_os_folder_id) WHERE genie_os_folder_id IS NOT NULL;
CREATE INDEX idx_tasks_wish ON tasks(wish_file) WHERE wish_file IS NOT NULL;
CREATE INDEX idx_tasks_parent ON tasks(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_tasks_type_stage ON tasks(type_id, stage);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_priority ON tasks(priority);
CREATE INDEX idx_tasks_due ON tasks(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX idx_tasks_trace ON tasks(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX idx_tasks_release ON tasks(release_id) WHERE release_id IS NOT NULL;
CREATE INDEX idx_tasks_repo_status ON tasks(repo_path, status);
CREATE INDEX idx_tasks_repo_priority ON tasks(repo_path, status, priority);

-- ============================================================================
-- Table 3: task_actors — Polymorphic assignment
-- ============================================================================
CREATE TABLE task_actors (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_type VARCHAR(20) NOT NULL
    CHECK (actor_type IN ('local', 'genie_os_user', 'omni_agent')),
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL,
  permissions JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, actor_type, actor_id, role)
);

CREATE INDEX idx_task_actors_actor ON task_actors(actor_type, actor_id);
CREATE INDEX idx_task_actors_role ON task_actors(role);

-- ============================================================================
-- Table 4: task_dependencies — Enhanced with type
-- ============================================================================
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dep_type VARCHAR(20) NOT NULL DEFAULT 'depends_on'
    CHECK (dep_type IN ('depends_on', 'blocks', 'relates_to')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id != depends_on_id)
);

CREATE INDEX idx_task_deps_depends ON task_dependencies(depends_on_id);
CREATE INDEX idx_task_deps_type ON task_dependencies(dep_type);

-- ============================================================================
-- Table 5: task_stage_log — Audit trail with run traceability
-- ============================================================================
CREATE TABLE task_stage_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  actor_type VARCHAR(20),
  actor_id TEXT,
  run_id TEXT,
  gate_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stage_log_task ON task_stage_log(task_id);
CREATE INDEX idx_stage_log_created ON task_stage_log(created_at DESC);

-- ============================================================================
-- Table 6: conversations — Unified chat container
-- ============================================================================
CREATE TABLE conversations (
  id TEXT PRIMARY KEY DEFAULT 'conv-' || substr(gen_random_uuid()::text, 1, 8),
  parent_message_id BIGINT,
  name TEXT,
  type VARCHAR(10) NOT NULL DEFAULT 'group'
    CHECK (type IN ('dm', 'group')),
  linked_entity TEXT,
  linked_entity_id TEXT,
  created_by_type VARCHAR(20)
    CHECK (created_by_type IN ('local', 'genie_os_user', 'omni_agent', 'system')),
  created_by_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_conv_linked ON conversations(linked_entity, linked_entity_id) WHERE linked_entity IS NOT NULL;
CREATE INDEX idx_conv_parent_msg ON conversations(parent_message_id) WHERE parent_message_id IS NOT NULL;
CREATE INDEX idx_conv_created ON conversations(created_at DESC);

-- ============================================================================
-- Table 7: conversation_members — Permission = membership
-- ============================================================================
CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_type VARCHAR(20) NOT NULL
    CHECK (actor_type IN ('local', 'genie_os_user', 'omni_agent')),
  actor_id TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'member'
    CHECK (role IN ('member', 'admin', 'read_only')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, actor_type, actor_id)
);

CREATE INDEX idx_conv_members_actor ON conversation_members(actor_type, actor_id);

-- ============================================================================
-- Table 8: messages — Everything anyone says, anywhere
-- ============================================================================
CREATE TABLE messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reply_to_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  sender_type VARCHAR(20) NOT NULL
    CHECK (sender_type IN ('local', 'genie_os_user', 'omni_agent', 'system')),
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FK from conversations.parent_message_id -> messages.id
ALTER TABLE conversations ADD CONSTRAINT fk_conv_parent_msg
  FOREIGN KEY (parent_message_id) REFERENCES messages(id) ON DELETE CASCADE;

CREATE INDEX idx_messages_conv ON messages(conversation_id);
CREATE INDEX idx_messages_reply ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE INDEX idx_messages_sender ON messages(sender_type, sender_id);
CREATE INDEX idx_messages_created ON messages(conversation_id, created_at DESC);

-- ============================================================================
-- Table 9: tags — Classification
-- ============================================================================
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#9ca3af',
  type_id TEXT REFERENCES task_types(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id, type_id)
);

CREATE INDEX idx_tags_type ON tags(type_id);

-- ============================================================================
-- Table 10: task_tags — Join table
-- ============================================================================
CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  added_by_type VARCHAR(20),
  added_by_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, tag_id)
);

CREATE INDEX idx_task_tags_tag ON task_tags(tag_id);

-- ============================================================================
-- Table 11: notification_preferences — Per-actor channel config
-- ============================================================================
CREATE TABLE notification_preferences (
  actor_type VARCHAR(20) NOT NULL
    CHECK (actor_type IN ('local', 'genie_os_user', 'omni_agent')),
  actor_id TEXT NOT NULL,
  channel VARCHAR(20) NOT NULL
    CHECK (channel IN ('whatsapp', 'telegram', 'email', 'slack', 'discord', 'tmux')),
  priority_threshold VARCHAR(10) NOT NULL DEFAULT 'normal'
    CHECK (priority_threshold IN ('urgent', 'high', 'normal', 'low')),
  is_default BOOLEAN DEFAULT false,
  enabled BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_type, actor_id, channel)
);

CREATE INDEX idx_notif_actor ON notification_preferences(actor_type, actor_id);

-- ============================================================================
-- Triggers
-- ============================================================================

-- Stage validation: reject invalid stage names for the task's type
CREATE OR REPLACE FUNCTION validate_task_stage()
RETURNS trigger AS $$
DECLARE valid_stages JSONB; stage_names TEXT[];
BEGIN
  SELECT stages INTO valid_stages FROM task_types WHERE id = NEW.type_id;
  IF valid_stages IS NULL THEN RAISE EXCEPTION 'Unknown task type: %', NEW.type_id; END IF;
  SELECT array_agg(s->>'name') INTO stage_names FROM jsonb_array_elements(valid_stages) s;
  IF NOT (NEW.stage = ANY(stage_names)) THEN
    RAISE EXCEPTION 'Invalid stage "%" for type "%". Valid: %', NEW.stage, NEW.type_id, stage_names;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_stage
  BEFORE INSERT OR UPDATE OF stage ON tasks
  FOR EACH ROW EXECUTE FUNCTION validate_task_stage();

-- Auto-increment seq per repo_path (advisory lock prevents race)
CREATE OR REPLACE FUNCTION assign_task_seq()
RETURNS trigger AS $$
DECLARE lock_id BIGINT;
BEGIN
  lock_id := hashtext(NEW.repo_path);
  PERFORM pg_advisory_xact_lock(lock_id);
  SELECT COALESCE(MAX(seq), 0) + 1 INTO NEW.seq FROM tasks WHERE repo_path = NEW.repo_path;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assign_seq
  BEFORE INSERT ON tasks
  FOR EACH ROW EXECUTE FUNCTION assign_task_seq();

-- NOTIFY on stage changes
CREATE OR REPLACE FUNCTION notify_task_stage_change()
RETURNS trigger AS $$
BEGIN
  IF OLD.stage IS DISTINCT FROM NEW.stage THEN
    PERFORM pg_notify('genie_task_stage', NEW.id || ':' || COALESCE(OLD.stage, '') || ':' || NEW.stage);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_stage
  AFTER UPDATE OF stage ON tasks
  FOR EACH ROW EXECUTE FUNCTION notify_task_stage_change();

-- NOTIFY on new messages
CREATE OR REPLACE FUNCTION notify_new_message()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('genie_message', NEW.conversation_id || ':' || NEW.id || ':' || NEW.sender_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_message
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION notify_new_message();

-- NOTIFY on dependency changes
CREATE OR REPLACE FUNCTION notify_task_dep_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_notify('genie_task_dep', NEW.task_id || ':added:' || NEW.depends_on_id || ':' || NEW.dep_type);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('genie_task_dep', OLD.task_id || ':removed:' || OLD.depends_on_id || ':' || OLD.dep_type);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_dep
  AFTER INSERT OR DELETE ON task_dependencies
  FOR EACH ROW EXECUTE FUNCTION notify_task_dep_change();

-- ============================================================================
-- Seed data
-- ============================================================================

-- Built-in type: Software (7-stage pipeline)
INSERT INTO task_types (id, name, description, icon, is_builtin, stages) VALUES
('software', 'Software Development', 'Full software delivery pipeline', 'code', true,
  '[
    {"name":"draft","label":"Draft","gate":"human","action":"/brainstorm","auto_advance":false,"roles":["*"],"color":"#64748b"},
    {"name":"brainstorm","label":"Brainstorm","gate":"human+agent","action":"/brainstorm","auto_advance":false,"roles":["business","engineering"],"color":"#3b82f6"},
    {"name":"wish","label":"Wish","gate":"human","action":"/wish","auto_advance":false,"roles":["engineering"],"color":"#8b5cf6"},
    {"name":"build","label":"Build","gate":"agent","action":"/work","auto_advance":true,"roles":["*"],"color":"#f97316"},
    {"name":"review","label":"Review","gate":"human","action":"/review","auto_advance":false,"roles":["*"],"color":"#eab308"},
    {"name":"qa","label":"QA","gate":"agent","action":"/qa","auto_advance":true,"roles":["engineering"],"color":"#06b6d4"},
    {"name":"ship","label":"Ship","gate":"human","action":null,"auto_advance":false,"roles":["admin"],"color":"#10b981"}
  ]'::jsonb);

-- Default tags
INSERT INTO tags (id, name, color) VALUES
  ('bug', 'Bug', '#ef4444'),
  ('feature', 'Feature', '#3b82f6'),
  ('improvement', 'Improvement', '#8b5cf6'),
  ('chore', 'Chore', '#9ca3af'),
  ('urgent', 'Urgent', '#f97316'),
  ('idea', 'Idea', '#eab308');
