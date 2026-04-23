-- 040_listen_channel_split.sql — per-prefix LISTEN channels
-- Wish: genie-serve-structured-observability (Group 1).
--
-- Replace the single broadcast `genie_runtime_event` channel with per-prefix
-- channels so role-scoped subscribers only wake for the event families they
-- are authorized to read. The prefix is derived from the first dot-segment of
-- `kind` (e.g. `mailbox.delivery.sent` → channel `genie_events.mailbox`).
--
-- Migration 041_rbac_roles (Group 5) grants LISTEN per-prefix per role. Until
-- that migration lands, all prefixes are effectively world-listenable.

-- ---------------------------------------------------------------------------
-- 1. Channel-split notify function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_runtime_event_split()
RETURNS trigger AS $$
DECLARE
  prefix TEXT;
  channel TEXT;
BEGIN
  prefix := split_part(coalesce(NEW.kind, 'unknown'), '.', 1);
  IF prefix IS NULL OR length(prefix) = 0 THEN
    prefix := 'unknown';
  END IF;
  channel := 'genie_events.' || prefix;
  -- pg_notify enforces channel names fit in NAMEDATALEN (63 chars).
  -- Prefixes come from the closed event registry (Group 2) so this is safe.
  PERFORM pg_notify(channel, NEW.id::text);

  -- Dual-broadcast on the legacy channel during Wave 1/2 rollout so existing
  -- subscribers (src/lib/event-listener.ts) keep working until Group 4 ships
  -- the new consumer. The legacy trigger was installed by migration 010 /
  -- re-installed by 038; calling it again here is a no-op for subscribers not
  -- yet migrated.
  PERFORM pg_notify('genie_runtime_event', NEW.id::text);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 2. Replace the trigger on genie_runtime_events (partitioned parent).
-- Triggers on partitioned parents propagate to all current and future
-- partitions in PG 11+.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_notify_runtime_event ON genie_runtime_events;
DROP TRIGGER IF EXISTS trg_notify_runtime_event_split ON genie_runtime_events;

CREATE TRIGGER trg_notify_runtime_event_split
  AFTER INSERT ON genie_runtime_events
  FOR EACH ROW EXECUTE FUNCTION notify_runtime_event_split();

-- ---------------------------------------------------------------------------
-- 3. Do the same for sibling tables so subscribers that LISTEN on
-- `genie_events.<prefix>` receive events regardless of which tier they land
-- in. Debug stays on its own prefix for noise isolation.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_notify_runtime_event_debug ON genie_runtime_events_debug;
CREATE TRIGGER trg_notify_runtime_event_debug
  AFTER INSERT ON genie_runtime_events_debug
  FOR EACH ROW EXECUTE FUNCTION notify_runtime_event_split();

DROP TRIGGER IF EXISTS trg_notify_runtime_event_audit ON genie_runtime_events_audit;
CREATE TRIGGER trg_notify_runtime_event_audit
  AFTER INSERT ON genie_runtime_events_audit
  FOR EACH ROW EXECUTE FUNCTION notify_runtime_event_split();

-- ---------------------------------------------------------------------------
-- 4. Per-prefix LISTEN ACL is enforced by migration 041_rbac_roles. Until
-- then, all roles can LISTEN on any channel. This migration deliberately does
-- NOT revoke LISTEN from PUBLIC: doing so before the new consumer ships in
-- Group 4 would break the running event-listener.
-- ---------------------------------------------------------------------------
