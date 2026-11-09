CREATE TABLE story_delivery_acceptance_requests (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 100000),
  requested_by jsonb NOT NULL CHECK (jsonb_typeof(requested_by) = 'object' AND coalesce(requested_by->>'type' IN ('user', 'service'), false) AND octet_length(requested_by::text) <= 2048),
  bound_user_id text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_user_id text,
  CONSTRAINT story_delivery_acceptance_requests_scope_uidx UNIQUE (org_id, project_id, story_id, id),
  CONSTRAINT story_delivery_acceptance_requests_story_fk FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories(org_id, project_id, id),
  CONSTRAINT story_delivery_acceptance_requests_expiry_check CHECK (expires_at > requested_at),
  CONSTRAINT story_delivery_acceptance_requests_consumed_check CHECK ((consumed_at IS NULL) = (consumed_by_user_id IS NULL))
);
CREATE INDEX story_delivery_acceptance_requests_pending_idx
  ON story_delivery_acceptance_requests(org_id, project_id, story_id, expires_at) WHERE consumed_at IS NULL;

CREATE TABLE story_delivery_acceptances (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  request_id text NOT NULL UNIQUE,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 100000),
  confirmed_by jsonb NOT NULL CHECK (jsonb_typeof(confirmed_by) = 'object' AND coalesce(confirmed_by->>'type' = 'user', false) AND octet_length(confirmed_by::text) <= 2048),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL DEFAULT 'interactive_session' CHECK (method = 'interactive_session'),
  CONSTRAINT story_delivery_acceptances_revision_uidx UNIQUE (story_id, revision),
  CONSTRAINT story_delivery_acceptances_story_fk FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories(org_id, project_id, id),
  CONSTRAINT story_delivery_acceptances_request_fk FOREIGN KEY (org_id, project_id, story_id, request_id) REFERENCES story_delivery_acceptance_requests(org_id, project_id, story_id, id)
);
