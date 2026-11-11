-- Expand the persisted agent lifecycle vocabulary to match runtime transitions.
-- `pauseAgent` and `terminateAgent` already persist these states; the prior
-- constraint rejected them at the database boundary.
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agent_status_check;
ALTER TABLE agents ADD CONSTRAINT agent_status_check
  CHECK (status IN ('idle', 'thinking', 'executing_tool', 'errored', 'quarantined', 'completed', 'paused', 'terminated'));
