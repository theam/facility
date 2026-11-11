CREATE UNIQUE INDEX model_calls_scope_purpose_uidx ON model_calls (org_id, project_id, story_id, id, purpose);
ALTER TABLE budget_reservations DROP CONSTRAINT budget_reservations_model_call_scope_fk;
ALTER TABLE budget_reservations DROP CONSTRAINT budget_reservations_model_call_check;
ALTER TABLE budget_reservations DROP CONSTRAINT budget_reservations_purpose_check;
ALTER TABLE budget_reservations DROP CONSTRAINT budget_reservations_subject_check;
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_model_call_check CHECK (
  (model_call_id IS NULL OR purpose IN ('title', 'consultation')) AND
  (purpose != 'consultation' OR model_call_id IS NOT NULL)
);
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_purpose_check CHECK (purpose IN ('turn', 'title', 'consultation'));
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_subject_check CHECK (
  (purpose = 'turn' AND turn_id IS NOT NULL AND state = 'open') OR
  (purpose IN ('title', 'consultation') AND turn_id IS NULL)
);
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_model_call_scope_fk
  FOREIGN KEY (org_id, project_id, story_id, model_call_id, purpose) REFERENCES model_calls (org_id, project_id, story_id, id, purpose);

CREATE TABLE story_consultations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  principal_type text NOT NULL,
  principal_id text NOT NULL,
  actor_name text,
  surface text NOT NULL,
  agent_name text NOT NULL,
  engine text NOT NULL,
  model text NOT NULL,
  reasoning_effort text,
  agent_hash text NOT NULL,
  agent_prompt text NOT NULL,
  catalog_repository_id text NOT NULL,
  catalog_sha text NOT NULL,
  provider text NOT NULL,
  provider_model text,
  source_inputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  request text NOT NULL,
  through_message_seq integer NOT NULL,
  saved_summary text,
  summary_omitted boolean NOT NULL DEFAULT false,
  context_prompt text,
  context_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  context_hash text,
  state text NOT NULL DEFAULT 'queued',
  processing_token text,
  lease_expires_at timestamptz,
  model_call_id text,
  call_purpose text NOT NULL DEFAULT 'consultation',
  result text,
  result_hash text,
  error_code text,
  started_at timestamptz,
  ended_at timestamptz,
  expires_at timestamptz NOT NULL,
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_consultations_identity_check CHECK (
    length(request_key) BETWEEN 8 AND 200 AND length(fingerprint) = 43 AND
    principal_type IN ('user', 'key') AND length(principal_id) BETWEEN 1 AND 200 AND surface IN ('ui', 'mcp')
  ),
  CONSTRAINT story_consultations_agent_check CHECK (
    ((engine = 'codex' AND provider = 'openai') OR (engine = 'claude_code' AND provider = 'anthropic')) AND
    length(agent_name) BETWEEN 1 AND 64 AND length(model) BETWEEN 1 AND 160 AND
    length(agent_hash) BETWEEN 1 AND 128 AND catalog_sha ~ '^[a-f0-9]{40}$'
  ),
  CONSTRAINT story_consultations_text_check CHECK (
    octet_length(request) BETWEEN 1 AND 8000 AND octet_length(agent_prompt) <= 12000 AND
    (saved_summary IS NULL OR octet_length(saved_summary) <= 4096) AND
    (context_prompt IS NULL OR octet_length(context_prompt) <= 65536) AND
    (result IS NULL OR octet_length(result) <= 32768)
  ),
  CONSTRAINT story_consultations_context_check CHECK (
    through_message_seq >= 0 AND jsonb_typeof(source_inputs) = 'array' AND jsonb_array_length(source_inputs) <= 4 AND
    jsonb_typeof(context_data) = 'object' AND (context_hash IS NULL OR length(context_hash) = 43) AND
    (result_hash IS NULL OR length(result_hash) = 43) AND (result IS NULL) = (result_hash IS NULL)
  ),
  CONSTRAINT story_consultations_state_check CHECK (
    state IN ('queued', 'preparing', 'running', 'succeeded', 'incomplete', 'failed', 'canceled') AND call_purpose = 'consultation'
  ),
  CONSTRAINT story_consultations_phase_check CHECK (
    expires_at > created_at AND (ended_at IS NULL) = (state IN ('queued', 'preparing', 'running')) AND
    (state NOT IN ('preparing', 'running') OR (processing_token IS NOT NULL AND lease_expires_at IS NOT NULL)) AND
    (state != 'queued' OR (processing_token IS NULL AND lease_expires_at IS NULL)) AND
    (state != 'running' OR (started_at IS NOT NULL AND model_call_id IS NOT NULL AND context_hash IS NOT NULL AND context_prompt IS NOT NULL)) AND
    (state != 'succeeded' OR (result IS NOT NULL AND started_at IS NOT NULL AND model_call_id IS NOT NULL))
  ),
  CONSTRAINT story_consultations_story_scope_fk FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories (org_id, project_id, id),
  CONSTRAINT story_consultations_model_call_scope_fk FOREIGN KEY (org_id, project_id, story_id, model_call_id, call_purpose) REFERENCES model_calls (org_id, project_id, story_id, id, purpose)
);
CREATE UNIQUE INDEX story_consultations_scope_uidx ON story_consultations (org_id, project_id, story_id, id);
CREATE UNIQUE INDEX story_consultations_request_uidx ON story_consultations (org_id, project_id, story_id, request_key);
CREATE UNIQUE INDEX story_consultations_active_story_uidx ON story_consultations (org_id, project_id, story_id) WHERE state IN ('queued', 'preparing', 'running');
CREATE INDEX story_consultations_project_state_idx ON story_consultations (org_id, project_id, state);
CREATE INDEX story_consultations_story_created_idx ON story_consultations (org_id, project_id, story_id, created_at DESC, id);
CREATE INDEX story_consultations_expiry_idx ON story_consultations (state, expires_at);
