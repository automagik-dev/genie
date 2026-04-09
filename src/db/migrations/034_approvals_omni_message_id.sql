-- 034_approvals_omni_message_id.sql — Track Omni message IDs for reaction matching
--
-- When an approval notification is sent via Omni (WhatsApp), the returned
-- message ID is stored so that reaction emoji on that message can be
-- correlated back to the approval row.

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS omni_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_approvals_omni_message
  ON approvals(omni_message_id)
  WHERE omni_message_id IS NOT NULL;
