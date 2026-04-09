-- 031_mailbox_delivery_status.sql — Add delivery retry tracking to mailbox
--
-- Adds delivery_status and delivery_attempts columns to support automatic
-- retry of failed pane deliveries with escalation after max attempts.

-- Add delivery tracking columns
ALTER TABLE mailbox
  ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS delivery_attempts INT NOT NULL DEFAULT 0;

-- Constraint: valid delivery statuses
ALTER TABLE mailbox
  ADD CONSTRAINT chk_mailbox_delivery_status
  CHECK (delivery_status IN ('pending', 'delivered', 'failed', 'escalated'));

-- Index for retry queries: find failed messages that haven't exceeded max attempts
CREATE INDEX IF NOT EXISTS idx_mailbox_delivery_retry
  ON mailbox(delivery_status, delivery_attempts)
  WHERE delivery_status = 'failed';

-- Backfill: mark already-delivered rows
UPDATE mailbox
  SET delivery_status = 'delivered'
  WHERE delivered_at IS NOT NULL AND delivery_status = 'pending';
