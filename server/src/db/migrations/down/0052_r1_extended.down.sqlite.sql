-- 0052 DOWN (SQLite): roll back r1_extended to the 0051 state.
-- Reverses server/src/db/migrations/0052_r1_extended.sqlite.sql exactly.
-- SQLite note: DROP COLUMN requires SQLite >= 3.35 (bundled with Node 22's better-sqlite3).
-- Legacy indexes disappear with their tables; explicit drops kept for clarity.

DROP INDEX IF EXISTS r1_checkpoints_task_sequence_idx;
DROP INDEX IF EXISTS r1_leases_expires_idx;
DROP INDEX IF EXISTS r1_compensations_task_idx;
DROP INDEX IF EXISTS r1_feedback_project_result_idx;
DROP INDEX IF EXISTS r1_contradictions_project_idx;
DROP INDEX IF EXISTS r1_durable_approvals_project_state_idx;
DROP INDEX IF EXISTS r1_telemetry_spans_trace_idx;
DROP INDEX IF EXISTS r1_telemetry_spans_task_idx;

-- SQLite does not accept DROP COLUMN IF EXISTS in supported runtime versions.
-- This DOWN migration is an exact reverse of 0052 and must only run once,
-- after dependent R1 objects are removed.
ALTER TABLE r1_tasks DROP COLUMN lease_owner;
ALTER TABLE r1_tasks DROP COLUMN lease_expires_at;
ALTER TABLE r1_tasks DROP COLUMN retry_attempts;

DROP TABLE IF EXISTS r1_telemetry_spans;
DROP TABLE IF EXISTS r1_durable_approvals;
DROP TABLE IF EXISTS r1_quarantine;
DROP TABLE IF EXISTS r1_kill_switch;
DROP TABLE IF EXISTS r1_contradictions;
DROP TABLE IF EXISTS r1_feedback;
DROP TABLE IF EXISTS r1_compensations;
DROP TABLE IF EXISTS r1_leases;
DROP TABLE IF EXISTS r1_checkpoints;
