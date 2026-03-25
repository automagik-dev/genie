-- 008_boards.sql — Boards and board templates (replaces task_types as primary pipeline)
-- boards: project-scoped, flexible columns with gates/actions
-- board_templates: reusable board blueprints (builtin + custom)

-- ============================================================================
-- Table: boards — Project-scoped pipeline boards
-- ============================================================================
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY DEFAULT 'board-' || substr(gen_random_uuid()::text, 1, 8),
  name TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  description TEXT,
  columns JSONB NOT NULL DEFAULT '[]',
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_boards_project ON boards(project_id);

-- ============================================================================
-- Table: board_templates — Reusable board blueprints
-- ============================================================================
CREATE TABLE IF NOT EXISTS board_templates (
  id TEXT PRIMARY KEY DEFAULT 'tmpl-' || substr(gen_random_uuid()::text, 1, 8),
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  icon TEXT,
  columns JSONB NOT NULL DEFAULT '[]',
  is_builtin BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Add board_id and column_id to tasks
-- ============================================================================
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS board_id TEXT REFERENCES boards(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS column_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(board_id) WHERE board_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_column ON tasks(column_id) WHERE column_id IS NOT NULL;

-- ============================================================================
-- Seed builtin board templates
-- ============================================================================

-- 1. Software (8-stage pipeline with triage)
INSERT INTO board_templates (name, description, icon, is_builtin, columns) VALUES
('software', 'Full software delivery pipeline with triage', 'code', true,
  ('[' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"triage","label":"Triage","gate":"agent","action":"/trace","auto_advance":false,"transitions":[],"roles":["*"],"color":"#94a3b8","parallel":false,"on_fail":null,"position":0},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"draft","label":"Draft","gate":"human","action":"/brainstorm","auto_advance":false,"transitions":[],"roles":["*"],"color":"#64748b","parallel":false,"on_fail":null,"position":1},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"brainstorm","label":"Brainstorm","gate":"human+agent","action":"/brainstorm","auto_advance":false,"transitions":[],"roles":["business","engineering"],"color":"#3b82f6","parallel":false,"on_fail":null,"position":2},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"wish","label":"Wish","gate":"human","action":"/wish","auto_advance":false,"transitions":[],"roles":["engineering"],"color":"#8b5cf6","parallel":false,"on_fail":null,"position":3},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"build","label":"Build","gate":"agent","action":"/work","auto_advance":true,"transitions":[],"roles":["*"],"color":"#f97316","parallel":false,"on_fail":null,"position":4},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"review","label":"Review","gate":"human","action":"/review","auto_advance":false,"transitions":[],"roles":["*"],"color":"#eab308","parallel":false,"on_fail":null,"position":5},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"qa","label":"QA","gate":"agent","action":"/qa","auto_advance":true,"transitions":[],"roles":["engineering"],"color":"#06b6d4","parallel":false,"on_fail":null,"position":6},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"ship","label":"Ship","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["admin"],"color":"#10b981","parallel":false,"on_fail":null,"position":7}'
  || ']')::jsonb)
ON CONFLICT (name) DO NOTHING;

-- 2. Sales (6-stage, all human-gated)
INSERT INTO board_templates (name, description, icon, is_builtin, columns) VALUES
('sales', 'Sales pipeline from lead to close', 'dollar-sign', true,
  ('[' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"lead","label":"Lead","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#94a3b8","parallel":false,"on_fail":null,"position":0},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"qualified","label":"Qualified","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#3b82f6","parallel":false,"on_fail":null,"position":1},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"proposal","label":"Proposal","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#8b5cf6","parallel":false,"on_fail":null,"position":2},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"negotiation","label":"Negotiation","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#f97316","parallel":false,"on_fail":null,"position":3},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"closed-won","label":"Closed Won","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#10b981","parallel":false,"on_fail":null,"position":4},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"closed-lost","label":"Closed Lost","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#ef4444","parallel":false,"on_fail":null,"position":5}'
  || ']')::jsonb)
ON CONFLICT (name) DO NOTHING;

-- 3. Hiring (5-stage, all human-gated)
INSERT INTO board_templates (name, description, icon, is_builtin, columns) VALUES
('hiring', 'Hiring pipeline from sourcing to hire', 'users', true,
  ('[' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"sourcing","label":"Sourcing","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#94a3b8","parallel":false,"on_fail":null,"position":0},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"screening","label":"Screening","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#3b82f6","parallel":false,"on_fail":null,"position":1},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"interview","label":"Interview","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#8b5cf6","parallel":false,"on_fail":null,"position":2},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"offer","label":"Offer","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#f97316","parallel":false,"on_fail":null,"position":3},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"hired","label":"Hired","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#10b981","parallel":false,"on_fail":null,"position":4}'
  || ']')::jsonb)
ON CONFLICT (name) DO NOTHING;

-- 4. Ops (4-stage, human-gated)
INSERT INTO board_templates (name, description, icon, is_builtin, columns) VALUES
('ops', 'Operations workflow', 'settings', true,
  ('[' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"identified","label":"Identified","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#94a3b8","parallel":false,"on_fail":null,"position":0},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"planning","label":"Planning","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#3b82f6","parallel":false,"on_fail":null,"position":1},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"in-progress","label":"In Progress","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#f97316","parallel":false,"on_fail":null,"position":2},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"done","label":"Done","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#10b981","parallel":false,"on_fail":null,"position":3}'
  || ']')::jsonb)
ON CONFLICT (name) DO NOTHING;

-- 5. Bug (6-stage, mostly agent-gated)
INSERT INTO board_templates (name, description, icon, is_builtin, columns) VALUES
('bug', 'Bug triage and fix pipeline', 'bug', true,
  ('[' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"triage","label":"Triage","gate":"agent","action":"/trace","auto_advance":false,"transitions":[],"roles":["*"],"color":"#94a3b8","parallel":false,"on_fail":null,"position":0},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"draft","label":"Draft","gate":"agent","action":null,"auto_advance":false,"transitions":[],"roles":["*"],"color":"#64748b","parallel":false,"on_fail":null,"position":1},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"build","label":"Build","gate":"agent","action":"/work","auto_advance":true,"transitions":[],"roles":["*"],"color":"#f97316","parallel":false,"on_fail":null,"position":2},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"review","label":"Review","gate":"agent","action":"/review","auto_advance":false,"transitions":[],"roles":["*"],"color":"#eab308","parallel":false,"on_fail":null,"position":3},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"qa","label":"QA","gate":"agent","action":"/qa","auto_advance":true,"transitions":[],"roles":["*"],"color":"#06b6d4","parallel":false,"on_fail":null,"position":4},' ||
    '{"id":"' || gen_random_uuid()::text || '","name":"ship","label":"Ship","gate":"human","action":null,"auto_advance":false,"transitions":[],"roles":["admin"],"color":"#10b981","parallel":false,"on_fail":null,"position":5}'
  || ']')::jsonb)
ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- Migration from task_types to boards
-- ============================================================================

-- For each existing task_type, create a corresponding board (no project scope — global boards)
INSERT INTO boards (name, description, columns)
SELECT
  tt.name,
  tt.description,
  -- Map task_type stages JSONB to board columns JSONB format
  -- task_type stages have: name, label, gate, action, auto_advance, roles, color
  -- board columns add: id, transitions, parallel, on_fail, position
  (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', gen_random_uuid()::text,
        'name', s->>'name',
        'label', COALESCE(s->>'label', s->>'name'),
        'gate', COALESCE(s->>'gate', 'human'),
        'action', s->'action',
        'auto_advance', COALESCE((s->>'auto_advance')::boolean, false),
        'transitions', '[]'::jsonb,
        'roles', COALESCE(s->'roles', '["*"]'::jsonb),
        'color', COALESCE(s->>'color', '#94a3b8'),
        'parallel', false,
        'on_fail', null,
        'position', pos.idx
      ) ORDER BY pos.idx
    )
    FROM jsonb_array_elements(tt.stages) WITH ORDINALITY AS pos(s, idx)
  )
FROM task_types tt
ON CONFLICT (project_id, name) DO NOTHING;

-- Link tasks to boards by resolving type_id -> board name
UPDATE tasks t
SET board_id = b.id
FROM boards b
JOIN task_types tt ON tt.name = b.name AND b.project_id IS NULL
WHERE t.type_id = tt.id
  AND t.board_id IS NULL;

-- Resolve stage -> column_id for each task with a board
UPDATE tasks t
SET column_id = col->>'id'
FROM boards b,
     jsonb_array_elements(b.columns) AS col
WHERE t.board_id = b.id
  AND t.column_id IS NULL
  AND col->>'name' = t.stage;

-- ============================================================================
-- Updated stage validation trigger (supports both board_id and legacy type_id)
-- ============================================================================
CREATE OR REPLACE FUNCTION validate_task_stage()
RETURNS trigger AS $$
DECLARE
  valid_stages JSONB;
  stage_names TEXT[];
BEGIN
  -- If task has a board_id, validate column_id against board's columns
  IF NEW.board_id IS NOT NULL THEN
    SELECT columns INTO valid_stages FROM boards WHERE id = NEW.board_id;
    IF valid_stages IS NULL THEN
      RAISE EXCEPTION 'Unknown board: %', NEW.board_id;
    END IF;
    SELECT array_agg(s->>'name') INTO stage_names FROM jsonb_array_elements(valid_stages) s;
    IF NOT (NEW.stage = ANY(stage_names)) THEN
      RAISE EXCEPTION 'Invalid stage "%" for board "%". Valid: %', NEW.stage, NEW.board_id, stage_names;
    END IF;
    RETURN NEW;
  END IF;

  -- Legacy: validate against task_types
  SELECT stages INTO valid_stages FROM task_types WHERE id = NEW.type_id;
  IF valid_stages IS NULL THEN
    RAISE EXCEPTION 'Unknown task type: %', NEW.type_id;
  END IF;
  SELECT array_agg(s->>'name') INTO stage_names FROM jsonb_array_elements(valid_stages) s;
  IF NOT (NEW.stage = ANY(stage_names)) THEN
    RAISE EXCEPTION 'Invalid stage "%" for type "%". Valid: %', NEW.stage, NEW.type_id, stage_names;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
