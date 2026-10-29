CREATE TABLE model_calls (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  purpose text NOT NULL,
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  reservation_id text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  state text NOT NULL DEFAULT 'reserved',
  claim_token text,
  estimated_cents numeric NOT NULL,
  cost_cents numeric,
  input_tokens bigint,
  output_tokens bigint,
  cache_read_tokens bigint,
  cache_write_tokens bigint,
  error_code text,
  started_at timestamptz,
  expires_at timestamptz NOT NULL,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_calls_purpose_check CHECK (purpose IN ('title', 'consultation')),
  CONSTRAINT model_calls_provider_check CHECK (provider IN ('openai', 'anthropic')),
  CONSTRAINT model_calls_state_check CHECK (state IN ('reserved', 'started', 'confirmed', 'unconfirmed', 'unbilled')),
  CONSTRAINT model_calls_identity_check CHECK (length(request_key) BETWEEN 1 AND 200 AND length(fingerprint) = 43 AND length(model) BETWEEN 1 AND 160),
  CONSTRAINT model_calls_cost_check CHECK (
    estimated_cents >= 0 AND estimated_cents < 'Infinity'::numeric AND
    (cost_cents IS NULL OR (cost_cents >= 0 AND cost_cents < 'Infinity'::numeric)) AND
    (state NOT IN ('confirmed', 'unbilled') OR cost_cents IS NOT NULL)
  ),
  CONSTRAINT model_calls_tokens_check CHECK (
    (input_tokens IS NULL OR input_tokens BETWEEN 0 AND 9007199254740991) AND
    (output_tokens IS NULL OR output_tokens BETWEEN 0 AND 9007199254740991) AND
    (cache_read_tokens IS NULL OR cache_read_tokens BETWEEN 0 AND 9007199254740991) AND
    (cache_write_tokens IS NULL OR cache_write_tokens BETWEEN 0 AND 9007199254740991)
  ),
  CONSTRAINT model_calls_phase_check CHECK (
    (started_at IS NULL) = (claim_token IS NULL) AND expires_at > created_at AND
    (state != 'started' OR started_at IS NOT NULL)
  ),
  CONSTRAINT model_calls_settlement_check CHECK (
    (settled_at IS NULL) = (state IN ('reserved', 'started')) AND
    (state != 'confirmed' OR started_at IS NOT NULL) AND
    (state != 'unbilled' OR (cost_cents = 0 AND coalesce(input_tokens, 0) = 0 AND
      coalesce(output_tokens, 0) = 0 AND coalesce(cache_read_tokens, 0) = 0 AND coalesce(cache_write_tokens, 0) = 0))
  ),
  CONSTRAINT model_calls_story_scope_fk FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories (org_id, project_id, id)
);
CREATE UNIQUE INDEX model_calls_scope_uidx ON model_calls (org_id, project_id, story_id, id);
CREATE UNIQUE INDEX model_calls_request_uidx ON model_calls (org_id, project_id, story_id, purpose, request_key);
CREATE INDEX model_calls_project_idx ON model_calls (org_id, project_id, state);
CREATE INDEX model_calls_expiry_idx ON model_calls (state, expires_at);

ALTER TABLE budget_reservations ADD COLUMN model_call_id text;
CREATE UNIQUE INDEX budget_reservations_model_call_uidx ON budget_reservations (model_call_id) WHERE model_call_id IS NOT NULL;
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_model_call_check CHECK (model_call_id IS NULL OR purpose = 'title');
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_model_call_scope_fk
  FOREIGN KEY (org_id, project_id, story_id, model_call_id) REFERENCES model_calls (org_id, project_id, story_id, id);
