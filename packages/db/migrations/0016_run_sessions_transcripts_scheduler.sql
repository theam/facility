ALTER TABLE runs ADD COLUMN engine_session_id text;
ALTER TABLE runs ADD COLUMN transcript_uri text;

ALTER TABLE agent_defs ADD COLUMN last_scheduled_at timestamptz;
