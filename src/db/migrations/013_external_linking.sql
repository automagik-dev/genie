-- Add external linking columns to tasks table
-- Allows linking genie tasks to GitHub Issues, Jira tickets, or any external tracker
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS external_url TEXT;
