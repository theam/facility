CREATE TABLE story_delivery_integrations (
  story_id text PRIMARY KEY REFERENCES stories(id),
  org_id text NOT NULL,
  project_id text NOT NULL,
  candidate_revision text NOT NULL,
  mode text NOT NULL,
  repository_id text,
  state text NOT NULL DEFAULT 'pending',
  attempt integer NOT NULL DEFAULT 0,
  event_id text,
  lease_token text,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  summary text,
  evidence_url text,
  recorded_by jsonb,
  recorded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_delivery_integrations_candidate_check CHECK (candidate_revision ~ '^[a-f0-9]{64}$'),
  CONSTRAINT story_delivery_integrations_mode_check CHECK (mode IN ('manual', 'repository_dispatch')),
  CONSTRAINT story_delivery_integrations_state_check CHECK (state IN ('pending', 'dispatching', 'dispatched', 'succeeded', 'failed')),
  CONSTRAINT story_delivery_integrations_attempt_check CHECK (attempt >= 0),
  CONSTRAINT story_delivery_integrations_repository_check CHECK (
    (mode = 'manual' AND repository_id IS NULL)
    OR (mode = 'repository_dispatch' AND repository_id IS NOT NULL)
  ),
  CONSTRAINT story_delivery_integrations_lease_check CHECK (
    (lease_token IS NULL AND lease_until IS NULL)
    OR (state = 'dispatching' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
  ),
  CONSTRAINT story_delivery_integrations_result_check CHECK (
    (state = 'succeeded' AND summary IS NOT NULL AND recorded_by IS NOT NULL AND recorded_at IS NOT NULL AND error_code IS NULL)
    OR (state = 'failed' AND (
      (summary IS NOT NULL AND recorded_by IS NOT NULL AND recorded_at IS NOT NULL AND error_code IS NULL)
      OR (summary IS NULL AND evidence_url IS NULL AND recorded_by IS NULL AND recorded_at IS NULL AND error_code IS NOT NULL)
    ))
    OR (state IN ('pending', 'dispatching', 'dispatched') AND summary IS NULL AND evidence_url IS NULL AND recorded_by IS NULL AND recorded_at IS NULL AND error_code IS NULL)
  ),
  CONSTRAINT story_delivery_integrations_summary_check CHECK (summary IS NULL OR octet_length(summary) <= 2000),
  CONSTRAINT story_delivery_integrations_evidence_check CHECK (evidence_url IS NULL OR octet_length(evidence_url) <= 2000),
  CONSTRAINT story_delivery_integrations_actor_check CHECK (
    recorded_by IS NULL OR (jsonb_typeof(recorded_by) = 'object' AND octet_length(recorded_by::text) <= 512)
  ),
  CONSTRAINT story_delivery_integrations_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id)
    REFERENCES stories(org_id, project_id, id),
  CONSTRAINT story_delivery_integrations_repository_scope_fk
    FOREIGN KEY (org_id, project_id, repository_id)
    REFERENCES project_repositories(org_id, project_id, id)
);
CREATE INDEX story_delivery_integrations_due_idx
  ON story_delivery_integrations(state, next_attempt_at, lease_until);

CREATE TABLE story_completion_operations (
  story_id text PRIMARY KEY REFERENCES stories(id),
  org_id text NOT NULL,
  project_id text NOT NULL,
  candidate_revision text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempt integer NOT NULL DEFAULT 0,
  lease_token text,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  requested_by jsonb NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_completion_operations_candidate_check CHECK (candidate_revision ~ '^[a-f0-9]{64}$'),
  CONSTRAINT story_completion_operations_state_check CHECK (state IN ('pending', 'closing', 'failed', 'completed')),
  CONSTRAINT story_completion_operations_attempt_check CHECK (attempt >= 0),
  CONSTRAINT story_completion_operations_lease_check CHECK (
    (lease_token IS NULL AND lease_until IS NULL)
    OR (state = 'closing' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
  ),
  CONSTRAINT story_completion_operations_completed_check CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT story_completion_operations_actor_check CHECK (
    jsonb_typeof(requested_by) = 'object' AND octet_length(requested_by::text) <= 512
  ),
  CONSTRAINT story_completion_operations_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id)
    REFERENCES stories(org_id, project_id, id)
);
CREATE INDEX story_completion_operations_due_idx
  ON story_completion_operations(state, next_attempt_at, lease_until);
