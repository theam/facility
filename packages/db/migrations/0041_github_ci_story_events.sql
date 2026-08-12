ALTER TABLE gh_pull_requests
  ADD COLUMN ci_failure_names text[] NOT NULL DEFAULT '{}';

CREATE TABLE gh_ci_events (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  repo_id text NOT NULL REFERENCES repos(id),
  pull_number integer NOT NULL,
  head_sha text NOT NULL,
  state text NOT NULL,
  failure_names text[] NOT NULL DEFAULT '{}',
  source_event_id text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gh_ci_events_state_check CHECK (state IN ('pending', 'success', 'failure'))
);

CREATE INDEX gh_ci_events_repo_pull_observed_idx
  ON gh_ci_events(repo_id, pull_number, observed_at);

CREATE INDEX gh_ci_events_org_project_observed_idx
  ON gh_ci_events(org_id, project_id, observed_at);

CREATE UNIQUE INDEX gh_ci_events_source_pull_uidx
  ON gh_ci_events(source_event_id, repo_id, pull_number)
  WHERE source_event_id IS NOT NULL;
