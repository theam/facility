-- Worker liveness and the alarm sample. These rows are counts and timestamps
-- only: no turn text, webhook bodies, or other transcripts.

CREATE TABLE worker_heartbeats (
  id text PRIMARY KEY,
  seen_at timestamptz NOT NULL
);

CREATE TABLE webhook_rejections (
  id text PRIMARY KEY,
  reason text NOT NULL CHECK (reason IN ('signature', 'payload')),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_rejections_received_idx ON webhook_rejections (received_at);

CREATE TABLE mirror_syncs (
  project_id text PRIMARY KEY REFERENCES projects(id),
  org_id text NOT NULL REFERENCES orgs(id),
  synced_at timestamptz NOT NULL,
  CONSTRAINT mirror_syncs_project_scope_fk
    FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);

CREATE INDEX turns_queued_created_idx ON turns (created_at) WHERE state = 'queued';
