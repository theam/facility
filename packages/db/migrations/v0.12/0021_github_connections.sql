-- Null connection_id retains the existing environment-configured GitHub App.
CREATE TABLE github_connections (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  name text NOT NULL,
  app_id bigint NOT NULL UNIQUE,
  slug text NOT NULL,
  credentials text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_connections_org_id_uidx UNIQUE (org_id, id)
);
ALTER TABLE github_installations ADD COLUMN connection_id text;
ALTER TABLE github_installations ADD CONSTRAINT github_installations_connection_scope_fk
  FOREIGN KEY (org_id, connection_id) REFERENCES github_connections(org_id, id);
ALTER TABLE project_repositories ADD COLUMN github_repository_id bigint;
