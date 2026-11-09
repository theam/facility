ALTER TABLE workspaces ADD CONSTRAINT workspaces_story_identity_uidx UNIQUE (org_id, project_id, story_id, id);

CREATE TABLE story_input_files (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  workspace_id text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 180),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 26214400),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 120),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','uploading','available','failed','removed')),
  upload_attempt_id text,
  authorizer jsonb NOT NULL CHECK (coalesce(jsonb_typeof(authorizer) = 'object' AND authorizer->>'type' IN ('user','key') AND jsonb_typeof(authorizer->'id') = 'string' AND octet_length(authorizer::text) <= 2048, false)),
  allow_resume boolean NOT NULL DEFAULT false,
  dedupe_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  received_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_input_files_scope_uidx UNIQUE (org_id, project_id, story_id, id),
  CONSTRAINT story_input_files_dedupe_uidx UNIQUE (story_id, dedupe_key),
  CONSTRAINT story_input_files_story_fk FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories(org_id, project_id, id),
  CONSTRAINT story_input_files_workspace_fk FOREIGN KEY (org_id, project_id, story_id, workspace_id) REFERENCES workspaces(org_id, project_id, story_id, id)
);
CREATE INDEX story_input_files_scope_idx ON story_input_files(org_id, project_id, story_id, created_at);
