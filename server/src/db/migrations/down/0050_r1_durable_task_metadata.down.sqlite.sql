-- 0050 DOWN (SQLite): roll back r1_durable_task_metadata to the 0049 state.
-- Reverses server/src/db/migrations/0050_r1_durable_task_metadata.sqlite.sql exactly.
-- SQLite trigger drop has no ON clause; column drops require SQLite >= 3.35.

DROP TRIGGER IF EXISTS r1_task_created_event;
DROP INDEX IF EXISTS r1_task_events_project_task_sequence_idx;
DROP TABLE IF EXISTS r1_task_events;

-- SQLite does not accept DROP COLUMN IF EXISTS in supported runtime versions.
-- This DOWN migration is an exact reverse of 0050 and must only run once,
-- after the 0050 tables/triggers are removed.
ALTER TABLE r1_tasks DROP COLUMN current_step_id;
ALTER TABLE r1_tasks DROP COLUMN input_reference;
ALTER TABLE r1_tasks DROP COLUMN policy_version;
ALTER TABLE r1_tasks DROP COLUMN capability_ids;
ALTER TABLE r1_tasks DROP COLUMN goal;
ALTER TABLE r1_tasks DROP COLUMN agent_id;
ALTER TABLE r1_tasks DROP COLUMN principal_id;
