ALTER TABLE stories
  ADD COLUMN integration_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN integration_state_revision integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT stories_integration_state_check CHECK (
    jsonb_typeof(integration_state) = 'object' AND octet_length(integration_state::text) <= 16384
  ),
  ADD CONSTRAINT stories_integration_state_revision_check CHECK (integration_state_revision >= 0);

CREATE TABLE story_integration_notifications (
  story_id text PRIMARY KEY REFERENCES stories(id),
  org_id text NOT NULL,
  project_id text NOT NULL,
  story_revision text,
  workspace_revision text,
  pending jsonb NOT NULL DEFAULT '[]'::jsonb,
  lease_token text,
  lease_until timestamptz,
  observed_at timestamptz NOT NULL DEFAULT '1970-01-01'::timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_error_code text,
  last_delivered_at timestamptz,
  CONSTRAINT story_integration_notifications_scope_fk FOREIGN KEY (org_id, project_id, story_id)
    REFERENCES stories(org_id, project_id, id)
);
CREATE INDEX story_integration_notifications_due_idx ON story_integration_notifications(next_attempt_at, observed_at);
