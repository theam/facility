CREATE TABLE IF NOT EXISTS idempotency_records (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  principal_id text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  key_hash text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  status_code integer,
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_records_state_check CHECK (state IN ('pending', 'completed'))
);

CREATE INDEX IF NOT EXISTS idempotency_records_expiry_idx
  ON idempotency_records (expires_at);
