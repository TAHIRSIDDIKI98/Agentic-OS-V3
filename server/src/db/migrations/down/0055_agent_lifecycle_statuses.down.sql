-- Roll back 0055 only when no persisted agent uses a lifecycle state that the
-- previous constraint cannot represent; never silently strand live rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agents WHERE status IN ('paused', 'terminated')) THEN
    RAISE EXCEPTION 'Cannot roll back 0055: agents remain paused or terminated';
  END IF;
END $$;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agent_status_check;
ALTER TABLE agents ADD CONSTRAINT agent_status_check
  CHECK (status IN ('idle', 'thinking', 'executing_tool', 'errored', 'quarantined', 'completed'));
