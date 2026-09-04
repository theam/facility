-- Repository capability inventory and durable, reviewable story evidence.

CREATE TABLE project_skills (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  commit_sha text NOT NULL,
  path text NOT NULL,
  directory text NOT NULL CHECK (directory IN ('.agents', '.claude')),
  description text NOT NULL,
  content_hash text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_skills_project_path_uidx UNIQUE (project_id, path),
  CONSTRAINT project_skills_project_scope_fk
    FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);
CREATE INDEX project_skills_org_project_idx ON project_skills (org_id, project_id);

CREATE TABLE turn_git_evidence (
  turn_id text PRIMARY KEY REFERENCES turns(id),
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  engine_session_id text NOT NULL,
  initial_branch text,
  initial_sha text NOT NULL,
  final_branch text,
  final_sha text,
  commits jsonb NOT NULL DEFAULT '[]'::jsonb,
  changed_files jsonb NOT NULL DEFAULT '[]'::jsonb,
  dirty boolean NOT NULL DEFAULT false,
  capture_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT turn_git_evidence_turn_scope_fk
    FOREIGN KEY (org_id, project_id, story_id, turn_id)
    REFERENCES turns(org_id, project_id, story_id, id),
  CONSTRAINT turn_git_evidence_workspace_scope_fk
    FOREIGN KEY (org_id, project_id, workspace_id)
    REFERENCES workspaces(org_id, project_id, id)
);
CREATE INDEX turn_git_evidence_story_completed_idx
  ON turn_git_evidence (org_id, story_id, completed_at DESC);
CREATE INDEX turn_git_evidence_final_sha_idx
  ON turn_git_evidence (org_id, project_id, final_sha)
  WHERE final_sha IS NOT NULL;

CREATE TABLE story_evidence_events (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  turn_id text,
  source text NOT NULL CHECK (source IN ('facility', 'workspace', 'github')),
  type text NOT NULL,
  external_key text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_evidence_events_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories(org_id, project_id, id),
  CONSTRAINT story_evidence_events_turn_scope_fk
    FOREIGN KEY (org_id, project_id, story_id, turn_id)
    REFERENCES turns(org_id, project_id, story_id, id)
);
CREATE UNIQUE INDEX story_evidence_events_external_uidx
  ON story_evidence_events (story_id, source, external_key)
  WHERE external_key IS NOT NULL;
CREATE INDEX story_evidence_events_story_occurred_idx
  ON story_evidence_events (org_id, story_id, occurred_at DESC);

CREATE TABLE github_branches (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  repository_id text NOT NULL REFERENCES project_repositories(id),
  name text NOT NULL,
  head_sha text NOT NULL,
  protected boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_branches_repository_name_uidx UNIQUE (repository_id, name),
  CONSTRAINT github_branches_repository_scope_fk
    FOREIGN KEY (org_id, project_id, repository_id)
    REFERENCES project_repositories(org_id, project_id, id)
);
CREATE INDEX github_branches_project_updated_idx
  ON github_branches (org_id, project_id, updated_at DESC);

CREATE TABLE github_pull_request_reviews (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  repository_id text NOT NULL REFERENCES project_repositories(id),
  pull_number integer NOT NULL,
  review_id text NOT NULL,
  state text NOT NULL,
  author text,
  body text,
  html_url text,
  commit_sha text,
  submitted_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_pull_request_reviews_repository_review_uidx
    UNIQUE (repository_id, review_id),
  CONSTRAINT github_pull_request_reviews_repository_scope_fk
    FOREIGN KEY (org_id, project_id, repository_id)
    REFERENCES project_repositories(org_id, project_id, id)
);
CREATE INDEX github_pull_request_reviews_pull_idx
  ON github_pull_request_reviews (repository_id, pull_number, submitted_at DESC);

CREATE TABLE github_checks (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  repository_id text NOT NULL REFERENCES project_repositories(id),
  pull_number integer,
  check_id text NOT NULL,
  head_sha text NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  conclusion text,
  details_url text,
  started_at timestamptz,
  completed_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_checks_repository_check_uidx UNIQUE (repository_id, check_id),
  CONSTRAINT github_checks_repository_scope_fk
    FOREIGN KEY (org_id, project_id, repository_id)
    REFERENCES project_repositories(org_id, project_id, id)
);
CREATE INDEX github_checks_head_idx ON github_checks (repository_id, head_sha, updated_at DESC);
