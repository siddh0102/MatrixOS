-- Phase E migration 014: add scheduled_jobs.name + consecutive_failures columns.
-- name backfilled from prompt prefix; consecutive_failures defaults to 0.
-- Auto-disable policy in scheduler/engine.rs uses consecutive_failures.

ALTER TABLE scheduled_jobs ADD COLUMN name TEXT;
UPDATE scheduled_jobs SET name = SUBSTR(prompt, 1, 50) WHERE name IS NULL;

ALTER TABLE scheduled_jobs ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
