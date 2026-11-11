CREATE TABLE story_delivery_scopes (
  story_id text PRIMARY KEY REFERENCES stories(id),
  org_id text NOT NULL,
  project_id text NOT NULL,
  revision integer NOT NULL CONSTRAINT story_delivery_scopes_revision_check CHECK (revision > 0),
  declared_complete boolean NOT NULL DEFAULT false,
  updated_by jsonb NOT NULL CONSTRAINT story_delivery_scopes_actor_check CHECK (jsonb_typeof(updated_by) = 'object' AND octet_length(updated_by::text) <= 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_delivery_scopes_story_scope_fk FOREIGN KEY (org_id, project_id, story_id)
    REFERENCES stories(org_id, project_id, id)
);

CREATE TABLE story_delivery_pull_requests (
  org_id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  repository_id text NOT NULL,
  pull_number integer NOT NULL CONSTRAINT story_delivery_pull_requests_number_check CHECK (pull_number > 0),
  required boolean NOT NULL DEFAULT true,
  is_primary boolean NOT NULL DEFAULT false,
  PRIMARY KEY (story_id, repository_id, pull_number),
  CONSTRAINT story_delivery_pull_requests_primary_required_check CHECK (NOT is_primary OR required),
  CONSTRAINT story_delivery_pull_requests_story_scope_fk FOREIGN KEY (org_id, project_id, story_id)
    REFERENCES stories(org_id, project_id, id),
  CONSTRAINT story_delivery_pull_requests_repository_scope_fk FOREIGN KEY (org_id, project_id, repository_id)
    REFERENCES project_repositories(org_id, project_id, id),
  CONSTRAINT story_delivery_pull_requests_observed_pr_fk FOREIGN KEY (repository_id, pull_number)
    REFERENCES github_pull_requests(repository_id, number)
);
CREATE UNIQUE INDEX story_delivery_pull_requests_primary_uidx ON story_delivery_pull_requests(story_id) WHERE is_primary;
CREATE INDEX story_delivery_pull_requests_scope_idx ON story_delivery_pull_requests(org_id, project_id, story_id);
CREATE INDEX story_delivery_pull_requests_repository_idx ON story_delivery_pull_requests(repository_id, pull_number);
