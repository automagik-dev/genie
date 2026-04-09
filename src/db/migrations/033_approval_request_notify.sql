-- 033_approval_request_notify.sql — Notify on new approval requests
--
-- Fires pg_notify('genie_approval_request', ...) on INSERT to approvals table.
-- Enables the desktop app to show real-time toast notifications for new approvals.

CREATE OR REPLACE FUNCTION notify_approval_request()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('genie_approval_request',
    json_build_object(
      'id', NEW.id,
      'executor_id', NEW.executor_id,
      'agent_name', NEW.agent_name,
      'tool_name', NEW.tool_name,
      'tool_input_preview', LEFT(NEW.tool_input_preview, 200),
      'timeout_at', NEW.timeout_at,
      'created_at', NEW.created_at
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_approval_request ON approvals;

CREATE TRIGGER trg_notify_approval_request
  AFTER INSERT ON approvals
  FOR EACH ROW EXECUTE FUNCTION notify_approval_request();
