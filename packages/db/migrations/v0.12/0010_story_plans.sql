-- The global message primary key already guarantees this scoped identity is unique.
ALTER TABLE story_messages ADD CONSTRAINT story_messages_scope_identity_uidx
  UNIQUE (org_id, project_id, story_id, id);

CREATE TABLE story_plan_revisions (
  org_id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  markdown text NOT NULL CHECK (length(markdown) > 0 AND octet_length(markdown) <= 400000),
  repositories jsonb NOT NULL CHECK (jsonb_typeof(repositories) = 'array' AND jsonb_array_length(repositories) BETWEEN 1 AND 50 AND octet_length(repositories::text) <= 100000),
  agents jsonb NOT NULL CHECK (jsonb_typeof(agents) = 'array' AND jsonb_array_length(agents) BETWEEN 1 AND 20 AND octet_length(agents::text) <= 100000),
  proposed_by jsonb NOT NULL CHECK (jsonb_typeof(proposed_by) = 'object' AND coalesce(proposed_by->>'type' IN ('user', 'service'), false) AND octet_length(proposed_by::text) <= 2048),
  source_message_id text,
  source jsonb,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, revision),
  CONSTRAINT story_plan_revisions_scope_uidx UNIQUE (org_id, project_id, story_id, revision),
  CONSTRAINT story_plan_revisions_digest_uidx UNIQUE (org_id, project_id, story_id, revision, digest),
  CONSTRAINT story_plan_revisions_story_fk FOREIGN KEY (org_id, project_id, story_id)
    REFERENCES stories(org_id, project_id, id),
  CONSTRAINT story_plan_revisions_source_fk FOREIGN KEY (org_id, project_id, story_id, source_message_id)
    REFERENCES story_messages(org_id, project_id, story_id, id),
  CONSTRAINT story_plan_revisions_source_check CHECK (
    (source_message_id IS NULL AND source IS NULL) OR
    (source_message_id IS NOT NULL AND source IS NOT NULL AND jsonb_typeof(source) = 'object'
      AND coalesce(source->>'messageId' = source_message_id, false) AND octet_length(source::text) <= 2048)
  )
);

CREATE TABLE story_plan_repository_refs (
  org_id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  revision integer NOT NULL,
  repository_id text NOT NULL,
  PRIMARY KEY (story_id, revision, repository_id),
  CONSTRAINT story_plan_repository_refs_plan_fk FOREIGN KEY (org_id, project_id, story_id, revision)
    REFERENCES story_plan_revisions(org_id, project_id, story_id, revision),
  CONSTRAINT story_plan_repository_refs_repo_fk FOREIGN KEY (org_id, project_id, repository_id)
    REFERENCES project_repositories(org_id, project_id, id)
);

CREATE TABLE story_plan_states (
  story_id text PRIMARY KEY,
  org_id text NOT NULL,
  project_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  decision_revision integer NOT NULL DEFAULT 0 CHECK (decision_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_plan_states_current_fk FOREIGN KEY (org_id, project_id, story_id, revision)
    REFERENCES story_plan_revisions(org_id, project_id, story_id, revision)
);

CREATE TABLE story_plan_requests (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  plan_revision integer NOT NULL CHECK (plan_revision > 0),
  plan_digest text NOT NULL,
  decision_revision integer NOT NULL CHECK (decision_revision >= 0),
  intent text NOT NULL CHECK (intent IN ('approve', 'reject')),
  reason text CHECK (reason IS NULL OR octet_length(reason) <= 8000),
  requested_by jsonb NOT NULL CHECK (jsonb_typeof(requested_by) = 'object' AND coalesce(requested_by->>'type' IN ('user', 'service'), false) AND octet_length(requested_by::text) <= 2048),
  bound_user_id text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_user_id text,
  CONSTRAINT story_plan_requests_scope_uidx UNIQUE (org_id, project_id, story_id, id),
  CONSTRAINT story_plan_requests_target_fk FOREIGN KEY (org_id, project_id, story_id, plan_revision, plan_digest)
    REFERENCES story_plan_revisions(org_id, project_id, story_id, revision, digest),
  CONSTRAINT story_plan_requests_expiry_check CHECK (expires_at > requested_at),
  CONSTRAINT story_plan_requests_rejection_check CHECK (intent <> 'reject' OR (reason IS NOT NULL AND length(reason) > 0)),
  CONSTRAINT story_plan_requests_consumed_check CHECK ((consumed_at IS NULL) = (consumed_by_user_id IS NULL))
);
CREATE INDEX story_plan_requests_pending_idx ON story_plan_requests(org_id, project_id, story_id, expires_at) WHERE consumed_at IS NULL;

CREATE TABLE story_plan_decisions (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  plan_revision integer NOT NULL CHECK (plan_revision > 0),
  plan_digest text NOT NULL,
  decision_revision integer NOT NULL CHECK (decision_revision > 0),
  request_id text NOT NULL UNIQUE,
  intent text NOT NULL CHECK (intent IN ('approve', 'reject')),
  reason text CHECK (reason IS NULL OR octet_length(reason) <= 8000),
  confirmed_by jsonb NOT NULL CHECK (jsonb_typeof(confirmed_by) = 'object' AND coalesce(confirmed_by->>'type' = 'user', false) AND octet_length(confirmed_by::text) <= 2048),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL DEFAULT 'interactive_session' CHECK (method = 'interactive_session'),
  CONSTRAINT story_plan_decisions_revision_uidx UNIQUE (story_id, decision_revision),
  CONSTRAINT story_plan_decisions_target_fk FOREIGN KEY (org_id, project_id, story_id, plan_revision, plan_digest)
    REFERENCES story_plan_revisions(org_id, project_id, story_id, revision, digest),
  CONSTRAINT story_plan_decisions_request_fk FOREIGN KEY (org_id, project_id, story_id, request_id)
    REFERENCES story_plan_requests(org_id, project_id, story_id, id),
  CONSTRAINT story_plan_decisions_rejection_check CHECK (intent <> 'reject' OR (reason IS NOT NULL AND length(reason) > 0))
);
