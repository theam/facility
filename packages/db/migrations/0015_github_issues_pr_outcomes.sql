CREATE TABLE gh_issues (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  repo_id text NOT NULL REFERENCES repos(id),
  number integer NOT NULL,
  title text NOT NULL,
  state text NOT NULL,
  author text,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  assignees jsonb NOT NULL DEFAULT '[]'::jsonb,
  html_url text NOT NULL,
  body_md text,
  comments_count integer NOT NULL DEFAULT 0,
  gh_created_at timestamptz,
  gh_updated_at timestamptz,
  closed_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gh_issues_state_check CHECK (state IN ('open', 'closed')),
  CONSTRAINT gh_issues_repo_number_uidx UNIQUE (repo_id, number)
);

CREATE INDEX gh_issues_org_project_state_idx ON gh_issues (org_id, project_id, state);
CREATE INDEX gh_issues_org_project_updated_idx ON gh_issues (org_id, project_id, gh_updated_at DESC);

ALTER TABLE outcomes ADD COLUMN run_id text REFERENCES runs(id);
