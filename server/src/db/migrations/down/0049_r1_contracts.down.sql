-- 0049 DOWN (PostgreSQL): roll back R1 governed runtime persistence — returns the
-- database to the pre-R1 state (0003/0046–0048). Reverses
-- server/src/db/migrations/0049_r1_contracts.sql exactly.
-- ORDER MATTERS: run only after 0054→0050 down-scripts have removed their dependent
-- tables; IF EXISTS keeps this safe regardless.
-- WARNING: destroys ALL R1 data (tasks, memories, evidence, receipts). Backup first.

DROP TRIGGER IF EXISTS r1_receipts_no_update ON r1_action_receipts;
DROP TRIGGER IF EXISTS r1_evidence_no_update ON r1_evidence;
DROP FUNCTION IF EXISTS prevent_r1_append_only_mutation();

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

DROP INDEX IF EXISTS projects_r1_idempotency_key_idx;
-- `mode`, `scope` and `idempotency_key` are owned by the base application schema
-- (schema.ts projects); 0049 only adds them defensively with IF NOT EXISTS.
-- Rollback must not remove application columns, only R1-owned objects.
