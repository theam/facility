CREATE TABLE story_preview_generations (
  org_id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  generation text NOT NULL,
  delivery_revision text NOT NULL,
  repositories jsonb NOT NULL,
  source_observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, generation),
  CONSTRAINT story_preview_generations_identity_check CHECK (
    generation ~ '^[a-f0-9]{64}$' AND delivery_revision ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT story_preview_generations_repositories_check CHECK (
    jsonb_typeof(repositories) = 'array'
    AND jsonb_array_length(repositories) BETWEEN 1 AND 50
    AND octet_length(repositories::text) <= 65536
  ),
  CONSTRAINT story_preview_generations_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id)
    REFERENCES stories(org_id, project_id, id)
);
CREATE INDEX story_preview_generations_scope_idx
  ON story_preview_generations(org_id, project_id, story_id, created_at);

CREATE TABLE story_preview_convergences (
  story_id text PRIMARY KEY REFERENCES stories(id),
  org_id text NOT NULL,
  project_id text NOT NULL,
  desired_generation text NOT NULL,
  desired_observed_at timestamptz NOT NULL,
  deployed_generation text,
  last_good_generation text,
  state text NOT NULL DEFAULT 'pending',
  revision integer NOT NULL DEFAULT 1 CONSTRAINT story_preview_convergences_revision_check CHECK (revision > 0),
  lease_token text,
  lease_generation text,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_preview_convergences_state_check CHECK (
    state IN ('pending', 'waiting', 'applying', 'blocked', 'failed', 'ready', 'suspended')
  ),
  CONSTRAINT story_preview_convergences_lease_check CHECK (
    (lease_token IS NULL AND lease_generation IS NULL AND lease_expires_at IS NULL)
    OR (state = 'applying' AND lease_token IS NOT NULL AND lease_generation IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT story_preview_convergences_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id)
    REFERENCES stories(org_id, project_id, id),
  CONSTRAINT story_preview_convergences_desired_generation_fk
    FOREIGN KEY (story_id, desired_generation)
    REFERENCES story_preview_generations(story_id, generation),
  CONSTRAINT story_preview_convergences_deployed_generation_fk
    FOREIGN KEY (story_id, deployed_generation)
    REFERENCES story_preview_generations(story_id, generation),
  CONSTRAINT story_preview_convergences_last_good_generation_fk
    FOREIGN KEY (story_id, last_good_generation)
    REFERENCES story_preview_generations(story_id, generation)
);
CREATE INDEX story_preview_convergences_recovery_idx
  ON story_preview_convergences(state, retry_at, lease_expires_at);

CREATE TABLE story_preview_attempts (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  generation text NOT NULL,
  attempt integer NOT NULL CONSTRAINT story_preview_attempts_attempt_check CHECK (attempt > 0),
  lease_token text NOT NULL,
  state text NOT NULL DEFAULT 'applying',
  workspace_id text,
  cause jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_preview_attempts_state_check CHECK (
    state IN ('applying', 'succeeded', 'failed', 'blocked', 'superseded')
  ),
  CONSTRAINT story_preview_attempts_ended_check CHECK (
    (state = 'applying' AND ended_at IS NULL)
    OR (state != 'applying' AND ended_at IS NOT NULL)
  ),
  CONSTRAINT story_preview_attempts_cause_check CHECK (
    jsonb_typeof(cause) = 'object' AND octet_length(cause::text) <= 16384
  ),
  CONSTRAINT story_preview_attempts_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id)
    REFERENCES stories(org_id, project_id, id),
  CONSTRAINT story_preview_attempts_generation_fk
    FOREIGN KEY (story_id, generation)
    REFERENCES story_preview_generations(story_id, generation),
  CONSTRAINT story_preview_attempts_story_attempt_uidx UNIQUE (story_id, attempt),
  CONSTRAINT story_preview_attempts_story_lease_uidx UNIQUE (story_id, lease_token)
);
CREATE INDEX story_preview_attempts_scope_idx
  ON story_preview_attempts(org_id, project_id, story_id);
