-- 027_audit_events_notify.sql — LISTEN/NOTIFY for audit_events stream
-- Mirror of the trigger already on genie_runtime_events (migration 010).

CREATE OR REPLACE FUNCTION notify_audit_event()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('genie_audit_event', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_audit_event ON audit_events;

CREATE TRIGGER trg_notify_audit_event
  AFTER INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION notify_audit_event();
