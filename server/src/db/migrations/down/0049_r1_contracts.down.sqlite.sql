-- 0049 DOWN (SQLite): roll back R1 governed runtime persistence to the pre-R1 state.
-- Reverses server/src/db/migrations/0049_r1_contracts.sqlite.sql exactly.
-- WARNING: destroys ALL R1 data. Backup first (file copy of the SQLite database).

DROP TRIGGER IF EXISTS r1_receipts_no_update;
DROP TRIGGER IF EXISTS r1_evidence_no_update;

DROP TABLE IF EXISTS r1_action_receipts;
DROP INDEX IF EXISTS r1_receipts_project_created_idx;
DROP TABLE IF EXISTS r1_evidence;
DROP INDEX IF EXISTS r1_evidence_project_created_idx;
DROP TABLE IF EXISTS r1_approvals;
DROP INDEX IF EXISTS r1_approvals_pending_idx;
DROP TABLE IF EXISTS r1_capabilities;
DROP TABLE IF EXISTS r1_memories;
DROP INDEX IF EXISTS r1_memories_project_idx;
DROP TABLE IF EXISTS r1_task_steps;
DROP INDEX IF EXISTS r1_tasks_project_state_idx;
DROP TABLE IF EXISTS r1_tasks;

-- `mode`, `scope` and `idempotency_key` are owned by the base application schema
-- (schema-sqlite.ts projects); 0049 only creates them when `projects` is absent.
-- SQLite cannot drop a UNIQUE column, and rollback must not remove application
-- columns, so this down removes only R1-owned tables and indexes.
