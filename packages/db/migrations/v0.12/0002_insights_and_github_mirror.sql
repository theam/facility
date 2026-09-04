-- Cost controls, operational telemetry, and the GitHub delivery mirror remain
-- part of the 0.12 story-workspace model. They share the existing database and
-- worker; no gateway or watchtower service is required.

CREATE UNIQUE INDEX project_repositories_org_project_id_uidx
  ON project_repositories (org_id, project_id, id);

ALTER TABLE github_webhook_events ADD COLUMN project_id text REFERENCES projects(id);
ALTER TABLE github_webhook_events ADD COLUMN repository_id text REFERENCES project_repositories(id);
ALTER TABLE github_webhook_events ADD CONSTRAINT github_webhook_events_project_scope_fk
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id);
ALTER TABLE github_webhook_events ADD CONSTRAINT github_webhook_events_repository_scope_fk
  FOREIGN KEY (org_id, project_id, repository_id)
  REFERENCES project_repositories(org_id, project_id, id);
CREATE INDEX github_webhook_events_project_received_idx
  ON github_webhook_events (org_id, project_id, received_at DESC);

ALTER TABLE stories DROP CONSTRAINT stories_project_external_uidx;
ALTER TABLE stories ADD COLUMN repository_id text REFERENCES project_repositories(id);
ALTER TABLE stories ADD CONSTRAINT stories_repository_scope_fk
  FOREIGN KEY (org_id, project_id, repository_id)
  REFERENCES project_repositories(org_id, project_id, id);
CREATE UNIQUE INDEX stories_project_repository_external_uidx
  ON stories (project_id, provider, coalesce(repository_id, '__none__'), external_id);

CREATE TABLE github_issues (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  repository_id text NOT NULL REFERENCES project_repositories(id),
  number integer NOT NULL,
  title text NOT NULL,
  body text,
  state text NOT NULL CHECK (state IN ('open', 'closed')),
  labels text[] NOT NULL DEFAULT '{}',
  assignees text[] NOT NULL DEFAULT '{}',
  author text,
  html_url text NOT NULL,
  comments_count integer NOT NULL DEFAULT 0,
  github_created_at timestamptz,
  github_updated_at timestamptz,
  closed_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_issues_repository_number_uidx UNIQUE (repository_id, number),
  CONSTRAINT github_issues_project_scope_fk
    FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id),
  CONSTRAINT github_issues_repository_scope_fk
    FOREIGN KEY (org_id, project_id, repository_id)
    REFERENCES project_repositories(org_id, project_id, id)
);
CREATE INDEX github_issues_project_state_idx ON github_issues (org_id, project_id, state);

CREATE TABLE github_pull_requests (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  repository_id text NOT NULL REFERENCES project_repositories(id),
  number integer NOT NULL,
  title text NOT NULL,
  body text,
  state text NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  draft boolean NOT NULL DEFAULT false,
  author text,
  head_ref text NOT NULL,
  head_sha text NOT NULL,
  base_ref text NOT NULL,
  html_url text NOT NULL,
  closing_issues integer[] NOT NULL DEFAULT '{}',
  ci_state text CHECK (ci_state IS NULL OR ci_state IN ('pending', 'success', 'failure')),
  ci_head_sha text,
  ci_failure_names text[] NOT NULL DEFAULT '{}',
  ci_updated_at timestamptz,
  github_created_at timestamptz,
  github_updated_at timestamptz,
  closed_at timestamptz,
  merged_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_pull_requests_repository_number_uidx UNIQUE (repository_id, number),
  CONSTRAINT github_pull_requests_project_scope_fk
    FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id),
  CONSTRAINT github_pull_requests_repository_scope_fk
    FOREIGN KEY (org_id, project_id, repository_id)
    REFERENCES project_repositories(org_id, project_id, id)
);
CREATE INDEX github_pull_requests_project_state_idx
  ON github_pull_requests (org_id, project_id, state);

CREATE TABLE github_ci_events (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  repository_id text NOT NULL REFERENCES project_repositories(id),
  pull_number integer NOT NULL,
  head_sha text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'success', 'failure')),
  failure_names text[] NOT NULL DEFAULT '{}',
  source_event_id text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_ci_events_project_scope_fk
    FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id),
  CONSTRAINT github_ci_events_repository_scope_fk
    FOREIGN KEY (org_id, project_id, repository_id)
    REFERENCES project_repositories(org_id, project_id, id)
);
CREATE INDEX github_ci_events_project_observed_idx
  ON github_ci_events (org_id, project_id, observed_at DESC);
CREATE UNIQUE INDEX github_ci_events_source_uidx
  ON github_ci_events (source_event_id) WHERE source_event_id IS NOT NULL;

CREATE TABLE project_budgets (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  monthly_limit_cents integer NOT NULL CHECK (monthly_limit_cents >= 0),
  warning_percent integer NOT NULL DEFAULT 80 CHECK (warning_percent BETWEEN 1 AND 100),
  enabled boolean NOT NULL DEFAULT true,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_budgets_project_uidx UNIQUE (project_id),
  CONSTRAINT project_budgets_project_scope_fk
    FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);
CREATE INDEX project_budgets_org_idx ON project_budgets (org_id);

CREATE TABLE turn_usage (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  turn_id text NOT NULL REFERENCES turns(id),
  agent_name text NOT NULL,
  engine text NOT NULL,
  model text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  cost_cents numeric,
  priced boolean NOT NULL,
  source text NOT NULL CHECK (source IN ('provider', 'price_book', 'unpriced')),
  duration_ms integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT turn_usage_turn_uidx UNIQUE (turn_id),
  CONSTRAINT turn_usage_tokens_check CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND
    cache_read_tokens >= 0 AND cache_write_tokens >= 0
  ),
  CONSTRAINT turn_usage_turn_scope_fk
    FOREIGN KEY (org_id, project_id, story_id, turn_id)
    REFERENCES turns(org_id, project_id, story_id, id)
);
CREATE INDEX turn_usage_project_created_idx
  ON turn_usage (org_id, project_id, created_at DESC);

CREATE TABLE audit_events (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text REFERENCES projects(id),
  actor jsonb NOT NULL,
  action text NOT NULL,
  target jsonb NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_project_scope_fk
    FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);
CREATE INDEX audit_events_org_created_idx ON audit_events (org_id, created_at DESC);
CREATE INDEX audit_events_project_created_idx
  ON audit_events (org_id, project_id, created_at DESC);
