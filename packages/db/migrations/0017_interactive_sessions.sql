ALTER TABLE steer_messages ADD COLUMN kind text NOT NULL DEFAULT 'steer';
ALTER TABLE steer_messages
  ADD CONSTRAINT steer_messages_kind_check CHECK (kind in ('steer', 'interrupt'));

ALTER TABLE runs ADD COLUMN session_state_uri text;

CREATE TABLE conversations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  agent_def_id text NOT NULL REFERENCES agent_defs(id),
  title text,
  last_run_id text REFERENCES runs(id),
  engine_session_id text,
  status text NOT NULL DEFAULT 'idle',
  created_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_status_check CHECK (status in ('idle', 'running'))
);

CREATE INDEX conversations_org_project_idx ON conversations(org_id, project_id);

CREATE TABLE conversation_messages (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  conversation_id text NOT NULL REFERENCES conversations(id),
  seq integer NOT NULL,
  role text NOT NULL,
  body text NOT NULL,
  run_id text REFERENCES runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_messages_role_check CHECK (role in ('user', 'agent', 'system')),
  CONSTRAINT conversation_messages_seq_positive_check CHECK (seq > 0),
  CONSTRAINT conversation_messages_conversation_seq_uidx UNIQUE (conversation_id, seq)
);

CREATE INDEX conversation_messages_org_conversation_idx
  ON conversation_messages(org_id, conversation_id);
