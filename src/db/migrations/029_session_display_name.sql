-- Add display_name column to sessions for user-facing conversation names
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS display_name TEXT;
