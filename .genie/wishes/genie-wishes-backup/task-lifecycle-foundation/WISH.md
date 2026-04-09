# Wish: Task Lifecycle Foundation

| Field | Value |
|-------|-------|
| **Status** | DONE |
| **Slug** | `task-lifecycle-foundation` |
| **Date** | 2026-03-21 |
| **Revised** | 2026-03-22 (v9: unified event capture — wire ALL systems to `audit_events` PG table, replace file-based event/audit logs. Conversations model from v8.) |
| **Design** | [DESIGN.md](../../brainstorms/task-lifecycle-ontology/DESIGN.md) |
| **Review** | [ONTOLOGY-REVIEW.md](/home/genie/agents/sofia/.genie/brainstorms/office-session-2026-03-20/ONTOLOGY-REVIEW.md) |

## Summary

Add task lifecycle tables, a unified messaging system, AND a unified event capture layer to Genie's embedded pgserve — task management + human-like communication + full observability for humans AND AI agents. 11 tables, 1 built-in type (`software` with 7-stage pipeline), dynamic type creation for future use cases. PG is the sole source of truth — file-based task state, file-based messaging, AND file-based event/audit logs ALL eliminated. Wish `.md` files remain as agent-readable templates.

Messaging follows the WhatsApp/Slack model: conversations (DMs, groups, task-linked, team channels) + messages (with replies and threaded sub-conversations). Replaces file-based mailbox, inbox, and team chat with a single PG-backed system. Works standalone (tmux delivery) and with Omni (multi-channel delivery).

Unified event capture: ALL systems write to the existing `audit_events` PG table — CLI commands (success/error), tool call outcomes, auto-approve decisions, worker state transitions, team events, stage changes. Replaces file-based `auto-approve-audit.jsonl` and `events/<pane>.jsonl`. Enables: "all agents hit this same error today", per-task history, pattern detection, data annotation.

Incorporates learnings from ClickUp ontology (priority, due dates, short IDs, notification preferences, recursive hierarchy, enhanced dependencies) and Omni's pgserve patterns (orphan cleanup, 10-port retry, shutdown timeout).

## Scope

### IN
- **Migration consolidation:** rewrite 001+002+003 into clean `001_core.sql` (scheduler/runs/heartbeats/audit/checkpoints/snapshots — all existing tables merged with extensions inline). Add `002_task_lifecycle.sql` with **11 tables**: `task_types`, `tasks`, `task_actors`, `task_dependencies`, `task_stage_log`, `conversations`, `conversation_members`, `messages`, `tags`, `task_tags`, `notification_preferences`. No production DB exists — clean slate.
- 1 built-in type seeded: `software` — 7-stage pipeline: draft→brainstorm→wish→build→review→qa→ship
- 6 default tags seeded: bug, feature, improvement, chore, urgent, idea
- **Priority field** (urgent/high/normal/low) on tasks — queryable, indexed
- **Due date + start date** on tasks — for sprint planning and deadline tracking
- **Human-friendly sequential IDs** (`#47`) per repo, with UUID as internal PK
- **Estimated effort** field — flexible text ("2h", "3 points", "M")
- **Blocked reason** text — soft blocks beyond structural dependencies
- **Conversations + Messages** — unified messaging model (WhatsApp/Slack pattern). Conversations can be DMs (2 members), groups (N members), task-linked (auto-created when task gets actors), or team channels. Messages support replies (quote within conversation) and threaded sub-conversations (new conversation spawned from a message). Replaces file-based mailbox + team chat.
- **Conversation members** — permission = membership. You can only see/write conversations you're a member of. Spawned workers auto-join team + task conversations only.
- **File-based messaging elimination:** rewrite `genie send/inbox/broadcast/chat` → PG backend, delete `.genie/mailbox/*.json` and `.genie/chat/*.jsonl`
- **Notification preferences** table — per-actor channel preferences (WhatsApp, Telegram, email, tmux) with priority threshold
- **Recursive parent_id** — unlimited nesting depth (wish→groups→subtasks→...)
- **Enhanced dependencies** — type field (blocks, depends_on, relates_to) for richer automation
- Stage validation trigger (rejects invalid stage for type)
- LISTEN/NOTIFY on task stage changes, new messages, dependency changes
- `OmniConfigSchema` added to `GenieConfigSchema` (optional, nullable)
- `task-service.ts` — PG CRUD for all 11 tables (tasks, conversations, messages, etc.)
- `genie type create` — agentic type creation (agent configures new pipelines without code changes)
- CLI commands: `genie task create/list/show/move/assign/tag/comment`, `genie type list/show/create`, `genie tag list/create`, `genie send/inbox/chat` (PG-backed, replaces file-based)
- `genie release create/list` for grouping tasks into releases
- Repo-scoped queries via `repo_path` (standalone mode, no external deps)
- **File-state elimination:** rewrite `wish-state.ts` → PG backend, deprecate `local-tasks.ts`
- **Wish .md files stay** as agent-readable templates — PG tracks stage state, files hold content/structure
- **Execution locking:** `checkout_run_id` + `execution_locked_at` + `checkout_timeout_ms` on tasks — `genie work` atomically claims task, prevents concurrent execution. Stale checkouts auto-expire after timeout (default 10min).
- **Inline comments on all mutations** — `--comment` flag on move, assign, block, done, create. Creates a message in the task's conversation. One command does both.
> **Moved to wish: genie-full-observability**
- **Unified event capture via `audit_events`** — wire ALL systems to the existing PG table (schema already in 001_core.sql). Every significant action = one row. Entity types: `task`, `conversation`, `worker`, `cli`, `approval`, `team`, `schedule`. Replaces:
  - `~/.genie/auto-approve-audit.jsonl` → `audit_events` with `entity_type='approval'`
  - `~/.genie/events/<pane>.jsonl` → `audit_events` with `entity_type='worker'`
  - Scheduler log events (keep file log as backup, but primary = PG)
- **CLI command instrumentation** — every `genie` CLI command records success/error to `audit_events`. Captures: command name, args, exit result, error message, actor, duration.
- **LISTEN/NOTIFY on audit_events** — new trigger fires `genie_audit_event` on insert. Enables real-time dashboards and pattern detection.
- **`genie events` CLI** — query audit_events: `genie events list [--type X] [--entity X] [--since 1h] [--errors-only]`, `genie events errors` (aggregated error patterns)
> **Moved to wish: genie-full-observability**
- **OpenTelemetry collector** — lightweight OTLP receiver in Genie that captures Claude Code telemetry from all spawned agents:
  - Receives `claude_code.tool_result` (tool success/fail, duration, errors), `claude_code.api_request` (cost, tokens, model), `claude_code.api_error` (failures, status codes), `claude_code.user_prompt`, `claude_code.tool_decision`
  - Writes ALL events to `audit_events` PG table with entity_type='otel', enriched with agent name, team, wish slug from resource attributes
  - Receives metrics (cost, tokens, LOC, sessions, active time) → stores as `audit_events` with entity_type='metric'
  - `genie spawn` auto-injects OTel env vars (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, endpoint, resource attributes with agent/team/wish context)
  - Enables: cost per task, error patterns across agents, tool usage analytics, API performance monitoring
- **Omni auto-registration:** `genie agent register` auto-creates agent in Omni when configured

### OUT (this wish)
- Wish bridge full rewrite (Delivery 2 — `genie wish create` / `genie done` writing to PG)
- Workers/teams migration to PG (Delivery 3)
- A2A messaging routing (future — depends on Omni-side D4/D6 changes)
- ClickUp sync (future — evaluate replace vs sync)
- Triage automation (Phase 3 — agent auto-processes raw input)

### OUT (Genie OS scope — future wish, uses this PG as backend)
- **Auto-comment from agent output** — OS app extracts agent's last response from runs/transcripts, writes as message in task conversation with `metadata.source: "agent_output"`. Zero agent overhead.
- **Stage action auto-dispatch** — OS app watches `genie_task_stage` NOTIFY, triggers appropriate skill runtime when task enters a stage with `action` defined
- **Permission enforcement UI** — OS app reads `task_actors.permissions` JSONB, enforces field-level edit permissions in the UI
- **Kanban board** — visual task management reading from genie's PG
- **Conversation UI** — rich discussion view on tasks with threaded sub-conversations, DMs, agent output auto-inserted
- **Task detail panel** — embedded tmux panes, artifact previews, stage history timeline

## Decisions

| Decision | Rationale |
|----------|-----------|
| PG sole source of truth for task state | 80 concurrent agents caused filesystem lock contention + machine crashes. PG handles concurrency natively via `SELECT FOR UPDATE SKIP LOCKED`. |
| Kill file-based state NOW | `.genie/state/*.json` has caused perf crashes. Full migration, no dual-write, no traces. |
| Wish .md files stay on filesystem | Agent uses filesystem to read/write wish content. PG tracks lifecycle state. Hybrid model. |
| Triage + Draft = single DRAFT stage | Human dumps raw context → agent auto-refines within same step → human gate to advance. No separate triage stage. |
| 1 type (`software`) not 3 | Focus on software dev first (we're doing it now). Keep schema extensible — other use cases come via agentic type creation, not code changes. |
| Type creation is agentic | Dynamic data pipeline — agent configures new types/pipelines. Adding a use case = data config, not code. |
| Stage format: `{name, label, gate, action, auto_advance, roles, color}` | Per-stage gate behavior. `action` maps to skills (/brainstorm, /wish, /work, /review). `auto_advance` controls auto-move on gate clearance. |
| Priority as column, not JSONB | Humans filter/sort by priority constantly. Column = indexed, queryable. Same for due_date, start_date. |
| Sequential short IDs per repo | Humans say "move task 47 to review" in chat. UUID is internal PK. `#47` is display. Seq auto-increments per repo_path. |
| Recursive parent_id (unlimited depth) | Software uses 2-level (wish→groups). Hiring pipeline needs deeper nesting. Schema shouldn't limit. |
| Conversations + Messages, not task_comments | WhatsApp/Slack model: 2 entities (conversations, messages) cover DMs, groups, task comments, team channels, and threaded sub-conversations. A task comment IS a message in a task-linked conversation. A thread IS a sub-conversation spawned from a message. One model, not separate tables per use case. Replaces file-based mailbox + chat + task_comments with a single PG-backed system. |
| Permission = conversation membership | You see what you're a member of. Spawned workers auto-join task + team conversations only — they don't know other teams exist. Registered agents (Omni) get explicit membership grants. Same model works standalone (tmux) and with Omni (multi-channel). |
| Enhanced dependency types | `blocks` vs `depends_on` vs `relates_to` — enables smarter automation (auto-unblock, parallel execution, impact analysis). |
| Notification preferences per actor | Each human/agent chooses their channel + priority threshold. Resolves via Omni when connected, falls back to tmux. |
| `OmniConfigSchema` included now | Every subsequent Omni integration needs this config. Adding it here avoids revisiting genie-config.ts later. |
| Omni auto-registration in scope | Agents auto-register in Omni directory for identity reconciliation + A2A reachability. |
> **Moved to wish: genie-full-observability**
| `audit_events` as unified event store | Table already exists (001_core.sql) but has ZERO writers. Wire everything here: CLI commands, tool calls, auto-approve decisions, stage changes, messages, worker state. One table, one query surface. Enables "all agents hit same error" analysis, per-task full history, data annotation. Replaces file-based audit/event logs. |
> **Moved to wish: genie-full-observability**
| File-based event logs eliminated | `auto-approve-audit.jsonl` and `events/<pane>.jsonl` replaced by `audit_events` PG table. Scheduler log file stays as backup (low-risk, append-only) but PG is primary. |
> **Moved to wish: genie-full-observability**
| OpenTelemetry collector built into Genie | Claude Code already exports rich telemetry (tool results, API costs, errors, tokens) via OTLP. Instead of setting up external Prometheus/Grafana, Genie runs a lightweight OTLP receiver that writes directly to `audit_events`. Same PG table, same query surface. Every spawned agent auto-injects OTel env vars with agent/team/wish context in resource attributes. |
> **Moved to wish: genie-full-observability**
| OTel resource attributes carry context | `OTEL_RESOURCE_ATTRIBUTES` includes `agent.name`, `team.name`, `wish.slug` — injected by `genie spawn`. This means every tool call, every API request, every error is automatically tagged with which agent, which team, which wish produced it. Zero agent code needed. |
| `repo_path TEXT NOT NULL` as primary scope | Works standalone (filesystem path). Genie OS `project_folders` enrichment is optional (future). |
| `task_actors` polymorphic (local/genie_os_user/omni_agent) | Standalone: local names. Integrated: UUIDs link to external systems. Resolution at query time. |
| Tags are global + type-agnostic | Both scopes needed. Type-specific tags via `tags.type_id` FK. |
| Dynamic fields everywhere | JSONB metadata on tasks + stages. Future use cases work without schema changes. |
| Estimated effort as TEXT | Flexible: "2h", "3 points", "M", "1 sprint". No enforced unit — teams choose their own estimation style. |
| Execution locking (from Paperclip) | `checkout_run_id` + `checkout_timeout_ms` prevents concurrent work. `genie work` checks out task atomically. Done/fail releases. Stale locks auto-expire after timeout (default 10min). Same pattern as Paperclip's atomic checkout. |
| Permissions individually assignable | `task_actors.permissions JSONB` — not role templates. PM gets all fields, worker gets limited. Enforcement is Genie OS concern; schema stores the grants. |
| CLI supports inline comments on ALL mutations | `--comment` flag on move, assign, block, done, create. Most efficient path — no second command needed. Agents and humans both benefit. |
| Genie = backend + CLI, Genie OS = UI app layer | Genie owns PG state + CLI. Genie OS adds: auto-comment from agent output (reads runs, writes comment), stage action auto-dispatch (watches NOTIFY), permission enforcement UI, kanban. Don't overengineer genie itself. |
| Auto-comment from agent output = Genie OS scope | OS app extracts agent's last output and writes it as message in task conversation. No extra agent behavior needed. Schema supports it (conversations + messages + metadata). NOT in this wish. |

## Schema: Migration 002_task_lifecycle.sql

### Table 1: `task_types` — Dynamic pipeline definitions
```sql
CREATE TABLE task_types (
  id TEXT PRIMARY KEY,                     -- 'software', 'hiring', 'sales'
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  stages JSONB NOT NULL,                   -- [{ name, label, gate, action, auto_advance, roles, color }]
  is_builtin BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Table 2: `tasks` — Unified work entity (human + agent)
```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY DEFAULT 'task-' || substr(gen_random_uuid()::text, 1, 8),
  seq INTEGER NOT NULL,                    -- human-friendly #47 per repo
  parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,  -- recursive, unlimited depth

  -- Scoping
  repo_path TEXT NOT NULL,
  genie_os_folder_id UUID,                -- optional enrichment when Genie OS connected

  -- Wish bridge
  wish_file TEXT,                          -- '.genie/wishes/<slug>/WISH.md'
  group_name TEXT,

  -- Identity
  title TEXT NOT NULL,
  description TEXT,
  acceptance_criteria TEXT,

  -- Type + dynamic stage
  type_id TEXT NOT NULL DEFAULT 'software' REFERENCES task_types(id),
  stage TEXT NOT NULL DEFAULT 'draft',
  status VARCHAR(20) NOT NULL DEFAULT 'ready'
    CHECK (status IN ('blocked','ready','in_progress','done','failed','cancelled')),

  -- Priority (human-essential, indexed)
  priority VARCHAR(10) NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('urgent','high','normal','low')),

  -- Timeline (planning + execution)
  start_date TIMESTAMPTZ,                  -- planned start (sprint planning)
  due_date TIMESTAMPTZ,                    -- deadline
  estimated_effort TEXT,                   -- flexible: "2h", "3 points", "M"
  started_at TIMESTAMPTZ,                  -- actual execution start
  ended_at TIMESTAMPTZ,                    -- actual completion

  -- Blocking
  blocked_reason TEXT,                     -- soft blocks: "waiting on client feedback"

  -- Release bundling
  release_id TEXT,

  -- Execution locking (atomic checkout — prevents concurrent work on same task)
  checkout_run_id TEXT,                    -- which run/session owns this task (NULL = unclaimed)
  execution_locked_at TIMESTAMPTZ,         -- when lock was acquired
  checkout_timeout_ms INTEGER DEFAULT 600000,  -- lock expiry (default 10min); stale checkouts auto-released

  -- Execution link
  session_id TEXT,
  pane_id TEXT,
  trace_id TEXT,                           -- links to runs.trace_id for cost/duration

  -- Extensible metadata
  metadata JSONB DEFAULT '{}',

  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(parent_id, group_name)
);
```

### Table 3: `task_actors` — Polymorphic assignment
```sql
CREATE TABLE task_actors (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_type VARCHAR(20) NOT NULL
    CHECK (actor_type IN ('local', 'genie_os_user', 'omni_agent')),
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL,                      -- 'assignee', 'creator', 'reviewer', 'approver', 'watcher'
  permissions JSONB DEFAULT '{}',          -- individually assignable: {"can_edit_title":true,"can_move_stage":true,...}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, actor_type, actor_id, role)
);
```

### Table 4: `task_dependencies` — Enhanced with type
```sql
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dep_type VARCHAR(20) NOT NULL DEFAULT 'depends_on'
    CHECK (dep_type IN ('depends_on', 'blocks', 'relates_to')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id != depends_on_id)
);
```

### Table 5: `task_stage_log` — Audit trail with run traceability
```sql
CREATE TABLE task_stage_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  actor_type VARCHAR(20),
  actor_id TEXT,
  run_id TEXT,                             -- links transition to agent run (NULL for human actions)
  gate_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Table 6: `conversations` — Unified chat container (DMs, groups, task-linked, team channels)
```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY DEFAULT 'conv-' || substr(gen_random_uuid()::text, 1, 8),
  parent_message_id BIGINT,               -- if set, this is a threaded sub-conversation spawned from a message
  name TEXT,                               -- "Task #47", "Team feat/auth", NULL for DMs
  type VARCHAR(10) NOT NULL DEFAULT 'group'
    CHECK (type IN ('dm', 'group')),       -- DM = 2 members, group = N members
  linked_entity TEXT,                      -- 'task', 'team', NULL (pure DM/group)
  linked_entity_id TEXT,                   -- task_id, team_name, NULL
  created_by_type VARCHAR(20)
    CHECK (created_by_type IN ('local', 'genie_os_user', 'omni_agent', 'system')),
  created_by_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- FK added after messages table exists:
-- ALTER TABLE conversations ADD CONSTRAINT fk_conv_parent_msg
--   FOREIGN KEY (parent_message_id) REFERENCES messages(id) ON DELETE CASCADE;
```

### Table 7: `conversation_members` — Permission = membership
```sql
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
```

### Table 8: `messages` — Everything anyone says, anywhere
```sql
CREATE TABLE messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reply_to_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,  -- quote/reply within same conversation
  sender_type VARCHAR(20) NOT NULL
    CHECK (sender_type IN ('local', 'genie_os_user', 'omni_agent', 'system')),
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',             -- attachments, mentions, reactions, source
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Now add the FK from conversations.parent_message_id → messages.id
ALTER TABLE conversations ADD CONSTRAINT fk_conv_parent_msg
  FOREIGN KEY (parent_message_id) REFERENCES messages(id) ON DELETE CASCADE;
```

### Table 9: `tags` — Classification
```sql
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#9ca3af',
  type_id TEXT REFERENCES task_types(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id, type_id)
);
```

### Table 10: `task_tags` — Join table
```sql
CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  added_by_type VARCHAR(20),
  added_by_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, tag_id)
);
```

### Table 11: `notification_preferences` — Per-actor channel config
```sql
CREATE TABLE notification_preferences (
  actor_type VARCHAR(20) NOT NULL
    CHECK (actor_type IN ('local', 'genie_os_user', 'omni_agent')),
  actor_id TEXT NOT NULL,
  channel VARCHAR(20) NOT NULL
    CHECK (channel IN ('whatsapp', 'telegram', 'email', 'slack', 'discord', 'tmux')),
  priority_threshold VARCHAR(10) NOT NULL DEFAULT 'normal'
    CHECK (priority_threshold IN ('urgent','high','normal','low')),
  is_default BOOLEAN DEFAULT false,        -- default channel for this actor
  enabled BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}',             -- channel-specific config (instance_id, chat_id, etc.)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_type, actor_id, channel)
);
```

### Indexes
```sql
-- Tasks
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

-- Actors
CREATE INDEX idx_task_actors_actor ON task_actors(actor_type, actor_id);
CREATE INDEX idx_task_actors_role ON task_actors(role);

-- Dependencies
CREATE INDEX idx_task_deps_depends ON task_dependencies(depends_on_id);
CREATE INDEX idx_task_deps_type ON task_dependencies(dep_type);

-- Stage log
CREATE INDEX idx_stage_log_task ON task_stage_log(task_id);
CREATE INDEX idx_stage_log_created ON task_stage_log(created_at DESC);

-- Conversations
CREATE INDEX idx_conv_linked ON conversations(linked_entity, linked_entity_id) WHERE linked_entity IS NOT NULL;
CREATE INDEX idx_conv_parent_msg ON conversations(parent_message_id) WHERE parent_message_id IS NOT NULL;
CREATE INDEX idx_conv_created ON conversations(created_at DESC);

-- Conversation members
CREATE INDEX idx_conv_members_actor ON conversation_members(actor_type, actor_id);

-- Messages
CREATE INDEX idx_messages_conv ON messages(conversation_id);
CREATE INDEX idx_messages_reply ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE INDEX idx_messages_sender ON messages(sender_type, sender_id);
CREATE INDEX idx_messages_created ON messages(conversation_id, created_at DESC);

-- Tags
CREATE INDEX idx_tags_type ON tags(type_id);
CREATE INDEX idx_task_tags_tag ON task_tags(tag_id);

-- Notification preferences
CREATE INDEX idx_notif_actor ON notification_preferences(actor_type, actor_id);
```

### Triggers
```sql
-- Stage validation
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

-- Auto-increment seq per repo_path (advisory lock prevents race under concurrent inserts)
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
    PERFORM pg_notify('genie_task_stage', NEW.id || ':' || COALESCE(OLD.stage,'') || ':' || NEW.stage);
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

-- NOTIFY on audit events (unified event stream)
CREATE OR REPLACE FUNCTION notify_audit_event()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('genie_audit_event', NEW.entity_type || ':' || NEW.event_type || ':' || NEW.entity_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_audit
  AFTER INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION notify_audit_event();
```

### Built-in type: Software (7-stage pipeline)
```sql
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

INSERT INTO tags (id, name, color) VALUES
  ('bug', 'Bug', '#ef4444'),
  ('feature', 'Feature', '#3b82f6'),
  ('improvement', 'Improvement', '#8b5cf6'),
  ('chore', 'Chore', '#9ca3af'),
  ('urgent', 'Urgent', '#f97316'),
  ('idea', 'Idea', '#eab308');
```

## Success Criteria

### Migration + Schema
- [ ] `002_task_lifecycle.sql` applied by `genie db migrate` — all 11 tables created alongside 001_core
- [ ] `software` type seeded: 7 stages, draft has human gate + agentic processing
- [ ] Stage definitions include `action`, `auto_advance`, `gate`, `roles`, `color` in JSONB
- [ ] PG trigger validates stage name against type pipeline — rejects invalid stages
- [ ] Sequential ID trigger assigns `seq` per repo_path (unique, auto-increment)
- [ ] `LISTEN/NOTIFY` fires on: stage changes, new comments, dependency changes
- [ ] `OmniConfigSchema` exists in `genie-config.ts`
- [ ] Config with/without `omni` field loads without error

### Task CRUD + CLI
- [ ] `genie task create "Fix bug" --priority high --due 2026-03-25` creates task at `draft` with seq `#1`
- [ ] `genie task list` shows tasks with `#seq`, title, stage, priority, assignee, due date
- [ ] `genie task list --priority urgent --stage draft` filters correctly
- [ ] `genie task show <id>` or `genie task show #47` — displays detail with actors, deps, tags, conversation messages
- [ ] `genie task move <id> --to brainstorm` validates and advances stage, logs transition
- [ ] `genie task move <id> --to invalid_stage` fails with validation error
- [ ] `genie task assign <id> --to engineer` creates local actor assignment
- [ ] `genie task tag <id> urgent` adds tag to task
- [ ] `genie task comment <id> "blocking on client feedback"` adds message to task conversation
- [ ] `genie task block <id> --reason "waiting on API access"` sets blocked status + reason
- [ ] Subtasks: `genie task create "subtask" --parent <id>` creates child at any depth

### Type System (agentic creation)
- [ ] `genie type list` shows `software` built-in type
- [ ] `genie type show software` displays 7-stage pipeline with gates/actions
- [ ] `genie type create hiring --stages '<json>'` creates custom type (e.g., sourcing→screening→interview→offer→hired)
- [ ] `genie tag list` shows 6 default tags
- [ ] `genie tag create security --color "#dc2626"` creates custom tag

### Dependencies (enhanced)
- [ ] `genie task dep <id> --depends-on <id2>` creates depends_on link
- [ ] `genie task dep <id> --blocks <id2>` creates blocks link
- [ ] `genie task dep <id> --relates-to <id2>` creates relates_to link
- [ ] NOTIFY fires on dep add/remove

### Messaging (conversations + messages)
- [ ] `genie task comment <id> "message"` creates message in task's conversation (auto-created on first use)
- [ ] `genie task show <id>` includes conversation messages
- [ ] Replies within conversation supported (`reply_to_id`)
- [ ] Threaded sub-conversations: `genie chat thread <message_id>` spawns new conversation from message
- [ ] `genie send "msg" --to <agent>` creates/reuses DM conversation, sends message via PG
- [ ] `genie inbox` lists conversations where current actor is member, with unread indicator
- [ ] `genie chat <conversation_id> "message"` sends to specific conversation
- [ ] NOTIFY fires on new message
- [ ] File-based mailbox (`.genie/mailbox/`) no longer written by any code path
- [ ] File-based team chat (`.genie/chat/`) no longer written by any code path

### Notification Preferences
- [ ] `genie notify set --channel whatsapp --priority high` sets actor's default
- [ ] `genie notify list` shows current actor's preferences
- [ ] Multiple channels per actor supported (e.g., urgent→WhatsApp, normal→tmux)
- [ ] Preferences respected when task reaches human gate (future integration)

### Execution Locking
- [ ] `genie task checkout #47` — atomically claims task, sets checkout_run_id + status=in_progress
- [ ] Second checkout on same task by different run → fails with clear error
- [ ] `genie task release #47` — releases claim, sets status=ready
- [ ] `genie work` integration: auto-checkouts task before executing
- [ ] `genie task unlock #47` — force-releases stale checkout regardless of owner
- [ ] Stale checkouts (locked longer than `checkout_timeout_ms`) auto-released by `expireStaleCheckouts`

### Inline Comments
- [ ] `genie task move #47 --to review --comment "tests passing"` — moves AND comments in one operation
- [ ] `genie task done #47 --comment "PR #123"` — marks done AND comments
- [ ] `genie task assign #47 --to eng --comment "you're up"` — assigns AND comments
- [ ] `genie task create "Fix X" --assign eng --comment "from standup"` — creates with assignment AND comment
- [ ] `--comment` flag available on: create, move, assign, block, unblock, done

### Releases
- [ ] `genie release create v0.1 --tasks <id1> <id2>` sets release_id on tasks
- [ ] `tasks.release_id` groups tasks for batch ship

### File-State Elimination
- [ ] `wish-state.ts` rewritten to PG backend — no `.genie/state/*.json` reads/writes
- [ ] `local-tasks.ts` deprecated — no `.genie/tasks.json` reads/writes
- [ ] Wish `.md` files still created/readable on filesystem (template content stays)
- [ ] Existing workflows (`genie wish`, `genie work`) still function with PG backend

### Omni Auto-Registration
- [ ] `genie agent register` auto-creates agent in Omni when `OMNI_API_URL` is set
- [ ] Agent registered with correct configs for separate sessions per person + channel
- [ ] Graceful no-op when `OMNI_API_URL` is not set

> **Moved to wish: genie-full-observability**

### Unified Event Capture
- [ ] Every `genie` CLI command writes to `audit_events` on completion (entity_type='cli', event_type='command_success' or 'command_error')
- [ ] CLI errors include: command name, args, error message, actor, duration_ms in `details` JSONB
- [ ] `moveTask` writes to `audit_events` (entity_type='task', event_type='stage_changed')
- [ ] `sendMessage` writes to `audit_events` (entity_type='conversation', event_type='message_sent')
- [ ] Auto-approve decisions write to `audit_events` (entity_type='approval') — replaces JSONL file
- [ ] Worker state changes write to `audit_events` (entity_type='worker', event_type='state_changed')
- [ ] LISTEN/NOTIFY fires `genie_audit_event` on every insert
- [ ] `genie events list` queries audit_events with filters (--type, --entity, --since, --errors-only)
- [ ] `genie events errors` shows aggregated error patterns (grouped by error message, sorted by count)
- [ ] `~/.genie/auto-approve-audit.jsonl` no longer written by any code path
- [ ] `~/.genie/events/<pane>.jsonl` no longer written by any code path
- [ ] Per-task history: `SELECT * FROM audit_events WHERE entity_id = '<task_id>'` returns full timeline

> **Moved to wish: genie-full-observability**

### OpenTelemetry Collector
- [ ] Genie starts OTLP receiver (gRPC) on pgserve port + 1 (default 19643), lazy start with first spawn
- [ ] `genie spawn` auto-injects OTel env vars: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`, endpoint, `OTEL_LOG_TOOL_DETAILS=1`
- [ ] `OTEL_RESOURCE_ATTRIBUTES` includes `agent.name`, `team.name`, `wish.slug` from spawn context
- [ ] `claude_code.tool_result` events → `audit_events` with entity_type='otel_tool', details includes tool_name, success, duration_ms, error
- [ ] `claude_code.api_request` events → `audit_events` with entity_type='otel_api', details includes model, cost_usd, tokens, duration_ms
- [ ] `claude_code.api_error` events → `audit_events` with entity_type='otel_api', details includes error, status_code
- [ ] `genie events costs --today --by-agent` shows cost breakdown from OTel api_request events
- [ ] `genie events errors --since 1h` aggregates tool_result + api_error events by error message

### Quality Gate
- [ ] `bun run check` passes (typecheck + lint + dead-code + test)

## Execution Strategy

### Wave 1 (foundation — must land first)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Migration consolidation (001→001_core, delete 002+003, new 002_task_lifecycle) + OmniConfigSchema |

### Wave 2 (after Wave 1 — service + state migration)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Task + messaging service library (PG CRUD for all 11 tables) |
| 3 | engineer | Rewrite `wish-state.ts` → PG backend, deprecate `local-tasks.ts` |

### Wave 3 (after Wave 2 — CLI + registration)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | CLI commands (task, type, tag, release, notify) + short ID resolution |
| 5 | engineer | Omni auto-registration in `genie agent register` |

### Wave 4 (after Wave 3)
| Group | Agent | Description |
|-------|-------|-------------|
| 6 | reviewer | Review all groups, run `bun run check` |

## Execution Groups

### Group 1: Migration Consolidation + Config

**Goal:** Consolidate 001+002+003 into clean `001_core.sql`, add `002_task_lifecycle.sql` with 11 tables (task + messaging + metadata), add Omni config. No production DB exists — clean slate.

**Deliverables:**

1. `src/db/migrations/001_core.sql` — **Rewrite** (merge existing 001+002+003 into one clean file):
   - `schedules` — with `interval_ms` and `run_spec JSONB` inline (was ALTER in 002)
   - `triggers` — with `idempotency_key`, `leased_by`, `leased_until` inline (was ALTER in 002)
   - `runs` — with `trace_id`, `lease_timeout_ms`, `exit_code` inline (was ALTER in 002)
   - `heartbeats` — unchanged
   - `audit_events` — unchanged
   - `agent_checkpoints` — unchanged
   - `machine_snapshots` — moved from 003
   - All indexes consolidated (no `IF NOT EXISTS` needed — clean create)
   - `notify_trigger_due()` trigger function + trigger

2. **Delete** `src/db/migrations/002_scheduler_extensions.sql` (merged into 001)

3. **Delete** `src/db/migrations/003_machine_snapshots.sql` (merged into 001)

4. `src/db/migrations/002_task_lifecycle.sql` — **New** (all 11 tables):
   - `task_types`, `tasks`, `task_actors`, `task_dependencies`, `task_stage_log` (task layer)
   - `conversations`, `conversation_members`, `messages` (messaging layer)
   - `tags`, `task_tags`, `notification_preferences` (metadata layer)
   - All schema exactly as defined in the Schema section above
   - All indexes (20+ covering all query patterns)
   - 5 triggers: stage validation, seq assignment (with advisory lock), stage change notify, message notify, dependency notify
   - Seed: `software` type (7 stages) + 6 default tags

5. `src/types/genie-config.ts` — Add:
   - `OmniConfigSchema` (z.object with apiUrl, apiKey optional, defaultInstanceId optional)
   - `omni: OmniConfigSchema.optional()` field on `GenieConfigSchema`

6. `src/lib/db.ts` — Harden pgserve lifecycle (learnings from Omni's production-grade pattern):
   - **Orphan cleanup:** Add `killOrphanedPostgres(dataDir)` — before `ensurePgRunning()`, read `postmaster.pid`, verify PID is actually postgres via `ps -o command=`, SIGTERM → 5s wait → SIGKILL. Prevents stale postgres from blocking startup after crash.
   - **10-port retry:** Increase fallback from 3 to 10 offsets (`MAX_PORT_RETRIES = 10`). With 80 concurrent agents, 3 retries is too few.
   - **Shutdown timeout:** Change `sqlClient.end()` to `sqlClient.end({ timeout: 5 })` — prevents indefinite hang on connection drain.
   - **Credential masking:** If logging connection URL, sanitize with `.replace(/\/\/.*@/, '//***@')`.
   - Update migration runner to handle renumbered files (verify `runMigrations()` works with 001+002 instead of 001+002+003)

**Acceptance Criteria:**
- [ ] Only 2 migration files exist: `001_core.sql` + `002_task_lifecycle.sql`
- [ ] `001_core.sql` contains all scheduler/runs/heartbeats/audit/checkpoints/snapshots tables with extensions inline
- [ ] `002_task_lifecycle.sql` contains all 11 tables (5 task + 3 messaging + 3 metadata)
- [ ] `genie db migrate` on fresh DB creates ALL tables (scheduler + task lifecycle)
- [ ] `software` type has 7 stages: draft(human)→brainstorm(human+agent)→wish(human)→build(agent)→review(human)→qa(agent)→ship(human)
- [ ] Stage validation trigger rejects invalid stage names
- [ ] Seq trigger uses advisory lock — concurrent inserts get unique seq numbers
- [ ] LISTEN/NOTIFY fires on stage update, message insert, dep insert/delete
- [ ] `OmniConfigSchema` exported from `genie-config.ts` with `apiUrl` (required), `apiKey` (optional), `defaultInstanceId` (optional)
- [ ] `GenieConfigSchema` has `omni: OmniConfigSchema.optional()` field
- [ ] Config loads with and without `omni` field (backward compatible)
- [ ] Existing scheduler/daemon/resume features still work after migration rewrite
- [ ] `killOrphanedPostgres(dataDir)` cleans stale postgres before startup — reads `postmaster.pid`, validates PID is postgres, SIGTERM→SIGKILL
- [ ] Port retry loop attempts 10 offsets (was 3) — `MAX_PORT_RETRIES = 10`
- [ ] `sqlClient.end({ timeout: 5 })` used in shutdown — no indefinite hang
- [ ] Connection URL never logged without credential masking

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

### Group 2: Task Service

**Goal:** Core library for CRUD operations across all 11 tables.

**Deliverables:**

1. `src/lib/task-service.ts` — Functions:
   - `getRepoPath()` — resolves repo root via `git rev-parse --show-toplevel`, falls back to cwd
   - **Tasks:** `createTask(input)`, `listTasks(filters)`, `getTask(idOrSeq)`, `moveTask(id, toStage, actor?, comment?)`, `updateTask(id, updates, comment?)`, `blockTask(id, reason, comment?)`, `unblockTask(id, comment?)`
   - **Checkout:** `checkoutTask(id, runId)` — atomic claim (sets checkout_run_id, status=in_progress, execution_locked_at). Fails if already claimed by different run. `releaseTask(id, runId)` — release claim, set status=ready. `getCheckoutOwner(id)` — who owns it. `expireStaleCheckouts(repoPath)` — releases tasks where `execution_locked_at < now() - checkout_timeout_ms` (prevents permanent lock on agent crash).
   - **Actors:** `assignTask(id, actor)`, `getTaskActors(taskId)`, `removeActor(taskId, actor)`
   - **Dependencies:** `addDependency(taskId, dependsOnId, type)`, `removeDependency(taskId, dependsOnId)`, `getBlockers(taskId)`, `getDependents(taskId)`
   - **Conversations:** `findOrCreateConversation(opts)` — finds existing or creates new. `opts` can specify: `{type: 'dm', members: [a,b]}` for DMs, `{linked_entity: 'task', linked_entity_id: taskId}` for task chats, `{linked_entity: 'team', linked_entity_id: teamName}` for team channels, `{parent_message_id: msgId}` for threaded sub-conversations. `getConversation(id)`, `listConversations(actor)` — all conversations where actor is a member. `addMember(convId, actor, role?)`, `removeMember(convId, actor)`, `getMembers(convId)`.
   - **Messages:** `sendMessage(convId, sender, body, replyToId?)`, `getMessages(convId, opts?)` — with pagination + since timestamp. `getMessage(id)`, `updateMessage(id, body)`. For task comments: `commentOnTask(taskId, actor, body, replyToId?)` — finds-or-creates task conversation, sends message. For inline comments: used by `moveTask`, `assignTask`, etc. when `--comment` flag is passed.
   - **Tags:** `tagTask(taskId, tagIds)`, `untagTask(taskId, tagId)`, `listTags()`, `createTag(input)`
   - **Types:** `createType(input)`, `listTypes()`, `getType(id)`
   - **Releases:** `setRelease(taskIds, releaseId)`, `listReleases(repoPath)`
   - **Notifications:** `setPreference(actor, channel, config)`, `getPreferences(actor)`, `resolveChannels(actor, priority)` — returns ordered list of channels that meet priority threshold
   - **ID resolution:** `resolveTaskId(idOrSeq, repoPath)` — accepts `#47` or `task-abc123`, returns internal ID

2. `src/lib/task-service.test.ts` — Comprehensive tests covering all functions, including:
   - CRUD lifecycle, short ID resolution (`#47`), recursive parent chains
   - Enhanced dep types (blocks/depends_on/relates_to)
   - Conversations: DM creation, group creation, task-linked auto-create, threaded sub-conversations
   - Messages: send, reply, thread, pagination
   - Notification preference CRUD + channel resolution with priority threshold
   - Type creation with custom stages

**Key implementation patterns:**
- Import `getSql` from `./db.js` for PG connection (existing lazy singleton)
- `repo_path` resolved via `execSync('git rev-parse --show-toplevel')` with cwd fallback
- `moveTask` catches PG trigger exception for invalid stage → user-friendly error
- All list queries scoped by `repo_path` by default
- `resolveTaskId` accepts `#N` (parses int, queries seq+repo_path) or `task-*` (direct PK lookup)
- Return types match SQL columns with camelCase convention

**Acceptance Criteria:**
- [ ] All CRUD functions work against pgserve
- [ ] Short ID resolution: `#47` → internal task ID
- [ ] `moveTask` to invalid stage throws with clear error message
- [ ] `moveTask` logs transition in `task_stage_log`
- [ ] Enhanced deps: blocks/depends_on/relates_to all work
- [ ] Conversations: DM, group, task-linked, threaded sub-conversation — all CRUD works
- [ ] Messages: send, reply (quote), list with pagination, update
- [ ] `commentOnTask` creates task conversation on first use, reuses on subsequent
- [ ] Threaded conversation: create sub-conversation from message, messages in thread isolated from parent
- [ ] Notification prefs: CRUD + resolution with priority threshold
- [ ] Type creation with custom stages validated
- [ ] All list filters (stage, type, status, priority, due_date) work correctly
- [ ] Tasks scoped by repo_path automatically
- [ ] `expireStaleCheckouts` releases tasks locked longer than `checkout_timeout_ms`
- [ ] Tests pass

**Validation:**
```bash
bun test src/lib/task-service.test.ts
```

**depends-on:** Group 1

---

### Group 3: File-State Elimination

**Goal:** Rewrite `wish-state.ts` to PG backend, update all callers, delete `local-tasks.ts`.

**Wish-to-task mapping strategy:**
- A wish's execution groups map to child tasks under a parent task (the wish itself)
- Parent task: `type_id='software'`, `wish_file='.genie/wishes/<slug>/WISH.md'`, `stage` tracks overall wish stage
- Child tasks: one per group, `parent_id` → parent, `group_name` = group identifier
- Group `status` maps directly: blocked→blocked, ready→ready, in_progress→in_progress, done→done
- Dependencies: `task_dependencies` rows replace the in-memory `dependsOn` arrays
- Assignee: `task_actors` with role='assignee' replaces `group.assignee` string
- The wish `.md` file stays as the template/content; PG is the state machine

**Deliverables:**

1. `src/lib/wish-state.ts` — Rewrite:
   - Replace all `.genie/state/*.json` reads/writes with PG queries via task-service
   - `createState()` → creates parent task + child tasks + task_dependencies in PG
   - `startGroup()` → `checkoutTask()` + `moveTask()` to in_progress
   - `completeGroup()` → `moveTask()` to done + recalculate dependents via task_dependencies
   - `getState()` → query PG, return same shape for backward compat
   - `findGroupByAssignee()` → query task_actors WHERE role='assignee'
   - `resetGroup()` → `releaseTask()` + status back to ready
   - Wish `.md` files stay on filesystem (template/content) — PG tracks state
   - Maintain existing function signatures for backward compat with callers
   - Delete file-locking logic (PG handles concurrency)

2. `src/lib/local-tasks.ts` — **Delete** (zero callers confirmed by grep):
   - Remove file entirely
   - Remove `.genie/tasks.json` reads/writes
   - Remove associated test file if it exists

3. **Update callers** of wish-state.ts (3 files):
   - `src/term-commands/dispatch.ts` (lines ~349-351, ~507-516) — calls `createState()`, `startGroup()`. Update to work with PG-backed wish-state. No API change needed if function signatures preserved.
   - `src/term-commands/state.ts` (lines ~183-191) — calls `completeGroup()`, `getState()`. Same: preserved signatures, PG backend.
   - `src/lib/protocol-router-spawn.ts` (lines ~258-259) — calls `findGroupByAssignee()`. Same approach.
   - **Strategy:** Since wish-state.ts preserves function signatures, callers don't need code changes — only verification that they work against PG backend.

**Acceptance Criteria:**
- [ ] No `.genie/state/*.json` files written by any code path
- [ ] No `.genie/tasks.json` files written or read (file deleted)
- [ ] `local-tasks.ts` deleted from codebase
- [ ] Wish `.md` files still created on filesystem
- [ ] `genie wish create <slug>` creates parent + child tasks in PG
- [ ] `genie work <agent> <slug>#<group>` checks out task + starts group via PG
- [ ] `genie done <slug>#<group>` completes task in PG + recalculates dependents
- [ ] `genie status <slug>` reads from PG, displays same format
- [ ] `dispatch.ts` works against PG backend (verified by existing dispatch tests)
- [ ] `state.ts` works against PG backend (verified by existing state tests)
- [ ] `protocol-router-spawn.ts` findGroupByAssignee works against PG
- [ ] No file-locking code remains for task/wish state

**Validation:**
```bash
bun test && grep -r 'state.*json\|tasks\.json\|local-tasks' src/ --include='*.ts' | grep -v test | grep -v '.d.ts'
```

**depends-on:** Group 1, Group 2

---

### Group 4: CLI Commands

**Goal:** Full CLI surface with short ID support, messaging, notification config, enhanced deps. Rewrite `genie send/inbox/chat` to PG backend.

**Deliverables:**

1. `src/term-commands/task.ts` — Task commands:
   - `task create <title> [--type software] [--priority high] [--due YYYY-MM-DD] [--tags t1,t2] [--parent <id>] [--assign <name>] [--description text] [--effort "2h"] [--comment "context"]`
   - `task list [--stage X] [--type X] [--status X] [--priority X] [--release X] [--due-before X] [--mine]`
   - `task show <id|#seq>` — detail: all fields, actors, deps (with type), tags, conversation messages, stage history
   - `task move <id|#seq> --to <stage> [--comment "reason"]`
   - `task assign <id|#seq> --to <name> [--comment "context"]`
   - `task tag <id|#seq> <tag1> [tag2...]`
   - `task comment <id|#seq> "<message>" [--reply-to <msg_id>]` — add message to task's conversation
   - `task block <id|#seq> --reason "<reason>" [--comment "details"]`
   - `task unblock <id|#seq> [--comment "resolved"]`
   - `task done <id|#seq> [--comment "shipped in PR #123"]` — mark done + optional comment
   - `task checkout <id|#seq>` — atomic claim for current run (prevents concurrent work)
   - `task release <id|#seq>` — release claim, return to ready
   - `task unlock <id|#seq>` — force-release stale checkout (admin override, clears checkout_run_id + execution_locked_at regardless of owner)
   - `task dep <id|#seq> --depends-on|--blocks|--relates-to <id2|#seq2>`

2. `src/term-commands/type.ts` — Type commands:
   - `type list` — table: id, name, stage count, is_builtin
   - `type show <id>` — full stage pipeline with gates/actions
   - `type create <name> --stages '<json>'` — create custom type

3. `src/term-commands/tag.ts` — Tag commands:
   - `tag list` — table: id, name, color
   - `tag create <name> [--color hex]`

4. `src/term-commands/release.ts` — Release commands:
   - `release create <name> --tasks <id1> [id2...]`
   - `release list`

5. `src/term-commands/notify.ts` — Notification preference commands:
   - `notify set --channel whatsapp [--priority high] [--default]`
   - `notify list`
   - `notify remove --channel <channel>`

6. `src/term-commands/msg.ts` — **Rewrite** messaging commands (PG backend, replaces file-based):
   - `send "<message>" --to <agent>` — find-or-create DM conversation, send message via PG. Delivery: LISTEN/NOTIFY + tmux inject (standalone) or Omni (when connected)
   - `inbox` — list conversations where current actor is member, most recent message, unread count
   - `chat <conversation_id> "<message>" [--reply-to <msg_id>]` — send to specific conversation
   - `chat thread <message_id> [--name "Thread title"]` — create threaded sub-conversation from message
   - `chat list [--type dm|group] [--linked task|team]` — list conversations with filters
   - `broadcast "<message>"` — send to team conversation (team-scoped, PG-backed)
   - Delete file-based mailbox writes (`.genie/mailbox/*.json`)
   - Delete file-based team chat writes (`.genie/chat/*.jsonl`)

7. `src/genie.ts` — Register all new commands

**Acceptance Criteria:**
- [ ] All commands accept both `task-uuid` and `#seq` short IDs
- [ ] `genie task create` returns task with `#seq` display ID
- [ ] `genie task list` shows priority, due date, `#seq` columns
- [ ] `genie task show` displays full detail including conversation messages and enhanced deps
- [ ] `genie task comment` adds message to task conversation, shows in task detail
- [ ] `genie send --to <agent>` creates DM conversation in PG, delivers message
- [ ] `genie inbox` lists conversations with most recent message and unread count
- [ ] `genie chat thread <msg_id>` creates threaded sub-conversation from message
- [ ] `genie broadcast` sends to team conversation (PG-backed)
- [ ] No `.genie/mailbox/*.json` files written by any code path
- [ ] No `.genie/chat/*.jsonl` files written by any code path
- [ ] `genie task dep` creates typed dependencies
- [ ] `genie type create` creates custom type, validates stage JSON
- [ ] `genie notify set/list/remove` manage preferences
- [ ] `genie task unlock #47` force-releases stale checkout regardless of owner
- [ ] All commands registered in genie.ts, appear in `genie --help`

**Validation:**
```bash
bun run check
```

**depends-on:** Group 1, Group 2, Group 3

---

### Group 5: Omni Auto-Registration

**Goal:** `genie agent register` auto-creates agent in Omni with correct session/channel configs.

**Deliverables:**

1. Update `genie agent register` handler:
   - When `OMNI_API_URL` or `config.omni.apiUrl` is set, POST to Omni API to create agent
   - Set up agent with separate sessions per person + per channel
   - Store `omniAgentId` in agent's directory entry
   - Graceful no-op when Omni is not configured

2. Omni API integration helper:
   - `registerAgentInOmni(agentName, config)` — creates agent + A2A identity
   - Error handling: Omni unreachable → warn, don't block

**Acceptance Criteria:**
- [ ] `genie agent register` creates agent in Omni when configured
- [ ] Agent has correct session isolation (per person + per channel)
- [ ] `omniAgentId` persisted in directory entry
- [ ] No-op when `OMNI_API_URL` not set
- [ ] Omni API failure doesn't block registration

**Validation:**
```bash
bun run check
```

**depends-on:** Group 1 (OmniConfigSchema)

---

### Group 6: Review + QA

**Goal:** Full review and quality gate across all groups.

**depends-on:** Group 1-5

---

## QA Criteria

### Unit/Integration (per group)
- [ ] Only 2 migrations exist: `001_core.sql` + `002_task_lifecycle.sql`
- [ ] `genie db migrate` on fresh install creates ALL tables (scheduler + task lifecycle) + seeds
- [ ] Full lifecycle: create (with #seq) → list → move (7 stages) → assign → tag → comment → dep → show
- [ ] Short IDs: `#47` resolves correctly in all commands
- [ ] Priority + due_date: filter, sort, display
- [ ] Conversations: DM, group, task-linked, threaded sub-conversation — all working
- [ ] Messages: send, reply, thread, display in task show
- [ ] File-based messaging eliminated: no `.genie/mailbox/` or `.genie/chat/` writes
- [ ] Enhanced deps: depends_on, blocks, relates_to — all three types work
- [ ] Notification prefs: set channel + priority threshold, list, remove
- [ ] Recursive subtasks: create child of child, display hierarchy
- [ ] Type creation: create hiring pipeline with custom stages, create tasks against it
- [ ] File-state elimination: no `.genie/state/*.json` or `.genie/tasks.json` written
- [ ] `local-tasks.ts` deleted from codebase
- [ ] Wish `.md` files still created and readable
- [ ] Config backward compatibility: existing config.json without `omni` loads fine
- [ ] Omni auto-registration works when configured, no-ops when not
- [ ] `bun run check` passes clean (typecheck + lint + dead-code + test)

### End-to-End (all groups together)
- [ ] **Full wish lifecycle via PG:**
  ```bash
  # 1. Migration
  genie db migrate
  # 2. Create task via CLI
  genie task create "E2E test" --priority high --type software
  # 3. Verify short ID works
  genie task show #1
  # 4. Move through stages with inline comment
  genie task move #1 --to brainstorm --comment "ready for design"
  # 5. Assign
  genie task assign #1 --to engineer --comment "go"
  # 6. Checkout
  genie task checkout #1
  # 7. Complete
  genie task done #1 --comment "shipped"
  # 8. Verify in PG
  genie task show #1  # should show stage=ship, status=done, 3 comments
  ```
- [ ] **Wish dispatch via PG** (backward compat):
  ```bash
  # Verify genie work still functions with PG-backed wish-state
  genie status <existing-slug>  # reads from PG, not .genie/state/*.json
  ```
- [ ] **Concurrent seq safety**: create 10 tasks simultaneously, verify all get unique seq numbers

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| pgserve not running when CLI commands are invoked | Low | Existing pattern: pgserve auto-starts on demand via lazy singleton in db.ts. v7 adds orphan cleanup (kill stale postgres before start) and 10-port retry. |
| Migration renumbering breaks runner | Low | Runner reads `src/db/migrations/*.sql` lexicographically. Verify `runMigrations()` in db.ts handles 001+002 (was 001+002+003). No prod DB to worry about — clean slate. |
| Commander.js subcommand nesting conflicts with existing commands | Low | Use `.command('task')` group pattern, test that existing commands still work |
| `gen_random_uuid()` not available in pgserve | Low | pgserve bundles PostgreSQL 18, which includes `gen_random_uuid()` natively |
| `wish-state.ts` rewrite breaks existing wish workflows | Medium | Keep function signatures identical. 3 callers identified: dispatch.ts, state.ts, protocol-router-spawn.ts. All verified by existing tests + E2E validation. |
| Omni API schema mismatch | Medium | Verify Omni API endpoints with Guga/Cezar before implementing. Graceful fallback. |
| Sequential ID race condition (concurrent inserts) | Low (mitigated) | `assign_task_seq()` uses `pg_advisory_xact_lock(hashtext(repo_path))` — transaction-scoped advisory lock ensures unique seq under concurrency. |
| Deep recursive parent chains slow down queries | Low | Recursive CTE with depth limit. Monitor query times. Add `depth INTEGER` column if needed. |
| Messaging rewrite breaks existing send/inbox | Medium | File-based mailbox + team-chat replaced by PG. Callers of `genie send/inbox/broadcast/chat` get PG backend. Existing `.genie/mailbox/` files not migrated (no history import). New conversations start clean. |
| LISTEN/NOTIFY is fire-and-forget | Low | If listener PG connection drops, subscription is lost. Reconnection logic follows existing scheduler-daemon pattern. Not durable for remote subscribers — polling recommended for external consumers. |
| Dev environment migration renaming | Low | Dev environments with existing 001-003 migrations applied require `DROP DATABASE genie` and fresh pgserve data dir before re-migrating. Migration runner uses filename as unique key — renamed files are treated as new migrations. |

## Files to Create/Modify

```
NEW:
  src/db/migrations/002_task_lifecycle.sql  (11 tables: task + messaging + metadata)
  src/lib/task-service.ts              (PG CRUD for tasks, conversations, messages, all entities)
  src/lib/task-service.test.ts
  src/lib/audit.ts                     (unified event writer: writeAuditEvent(entity_type, entity_id, event_type, actor, details))
  src/lib/otel-collector.ts            (lightweight OTLP gRPC receiver → audit_events PG)
  src/term-commands/task.ts            (task create/list/show/move/assign/tag/comment/block/dep/checkout)
  src/term-commands/type.ts            (type list/show/create)
  src/term-commands/tag.ts             (tag list/create)
  src/term-commands/release.ts         (release create/list)
  src/term-commands/notify.ts          (notify set/list/remove)
  src/term-commands/events.ts          (rewrite: genie events list/errors — PG-backed queries)

REWRITE:
  src/db/migrations/001_core.sql       (consolidate 001+002+003 into single clean file + audit_events NOTIFY trigger)
  src/term-commands/msg.ts             (rewrite: PG-backed send/inbox/chat/broadcast, delete file-based)

DELETE:
  src/db/migrations/002_scheduler_extensions.sql  (merged into 001_core)
  src/db/migrations/003_machine_snapshots.sql     (merged into 001_core)
  src/lib/local-tasks.ts               (zero callers confirmed)
  src/lib/batch-manager.ts             (zero callers confirmed, superseded by PG tasks)

MODIFIED:
  src/types/genie-config.ts            (add OmniConfigSchema)
  src/genie.ts                         (register task/type/tag/release/notify/msg/events commands + CLI instrumentation wrapper)
  src/lib/wish-state.ts                (rewrite: PG backend, preserve function signatures)
  src/lib/db.ts                        (orphan cleanup, 10-port retry, shutdown timeout, migration runner)
  src/lib/auto-approve-engine.ts       (write to audit_events instead of JSONL file)
  src/lib/protocol-router-spawn.ts     (inject OTel env vars on spawn)
  src/term-commands/agents.ts          (add Omni auto-registration to register handler)
```
