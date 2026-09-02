-- Facility 0.12 is a clean baseline. It intentionally contains no 0.11 run,
-- receipt, proposal, budget, registry, gateway, or preview-sandbox tables.

CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text,
  avatar_url text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_identities (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  provider text NOT NULL,
  provider_subject text NOT NULL,
  login text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_identities_provider_subject_uidx UNIQUE (provider, provider_subject),
  CONSTRAINT user_identities_user_provider_uidx UNIQUE (user_id, provider)
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

CREATE TABLE orgs (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id text PRIMARY KEY,
  org_id text REFERENCES orgs(id),
  name text NOT NULL,
  description text,
  permissions text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roles_org_name_uidx
  ON roles (coalesce(org_id, '__bundled__'), name);

CREATE TABLE org_members (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  user_id text NOT NULL REFERENCES users(id),
  role_id text NOT NULL REFERENCES roles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_members_org_user_uidx UNIQUE (org_id, user_id)
);
CREATE INDEX org_members_org_idx ON org_members (org_id);

CREATE TABLE projects (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_org_slug_uidx UNIQUE (org_id, slug),
  CONSTRAINT projects_org_id_uidx UNIQUE (org_id, id)
);
CREATE INDEX projects_org_idx ON projects (org_id);

CREATE TABLE api_keys (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  name text NOT NULL,
  prefix text NOT NULL,
  last4 text NOT NULL,
  hash text NOT NULL,
  scope_type text NOT NULL,
  project_id text REFERENCES projects(id),
  role_id text NOT NULL REFERENCES roles(id),
  created_by text,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_keys_scope_check CHECK (
    (scope_type = 'org' AND project_id IS NULL) OR
    (scope_type = 'project' AND project_id IS NOT NULL)
  )
);
CREATE INDEX api_keys_org_idx ON api_keys (org_id);
CREATE INDEX api_keys_prefix_idx ON api_keys (prefix);

CREATE TABLE github_installations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  installation_id bigint NOT NULL UNIQUE,
  account_id bigint NOT NULL,
  account_login text NOT NULL,
  target_type text NOT NULL,
  suspended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_installations_org_id_uidx UNIQUE (org_id, id)
);

CREATE TABLE oauth_artifacts (
  model text NOT NULL,
  id_hash text NOT NULL,
  payload text NOT NULL,
  grant_id_hash text,
  user_code_hash text,
  uid_hash text,
  expires_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model, id_hash)
);
CREATE INDEX oauth_artifacts_grant_idx ON oauth_artifacts (grant_id_hash);
CREATE INDEX oauth_artifacts_user_code_idx ON oauth_artifacts (user_code_hash);
CREATE INDEX oauth_artifacts_uid_idx ON oauth_artifacts (uid_hash);
CREATE INDEX oauth_artifacts_expiry_idx ON oauth_artifacts (expires_at);

CREATE TABLE idempotency_records (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  principal_id text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  key_hash text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  status_code integer,
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_records_state_check CHECK (state IN ('pending', 'completed'))
);
CREATE INDEX idempotency_records_expiry_idx ON idempotency_records (expires_at);

CREATE TABLE project_repositories (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  installation_id text,
  owner text NOT NULL,
  name text NOT NULL,
  default_branch text NOT NULL,
  role text NOT NULL DEFAULT 'related',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_repositories_org_owner_name_uidx UNIQUE (org_id, owner, name),
  CONSTRAINT project_repositories_role_check CHECK (role IN ('primary', 'related')),
  CONSTRAINT project_repositories_project_scope_fk
    FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id),
  CONSTRAINT project_repositories_installation_scope_fk
    FOREIGN KEY (org_id, installation_id) REFERENCES github_installations(org_id, id)
);
CREATE INDEX project_repositories_org_project_idx
  ON project_repositories (org_id, project_id);
CREATE UNIQUE INDEX project_repositories_primary_uidx
  ON project_repositories (project_id) WHERE role = 'primary';

CREATE TABLE github_webhook_events (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  installation_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  verified boolean NOT NULL DEFAULT true,
  processed_at timestamptz,
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_webhook_events_installation_scope_fk
    FOREIGN KEY (org_id, installation_id) REFERENCES github_installations(org_id, id)
);
CREATE INDEX github_webhook_events_org_received_idx
  ON github_webhook_events (org_id, received_at DESC);

CREATE TABLE stories (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  provider text NOT NULL,
  external_id text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'ready',
  active_agent_name text,
  branch text,
  pull_request_number integer,
  pull_request_url text,
  created_by jsonb NOT NULL,
  completed_at timestamptz,
  archived_at timestamptz,
  archived_from_status text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stories_project_external_uidx UNIQUE (project_id, provider, external_id),
  CONSTRAINT stories_org_project_id_uidx UNIQUE (org_id, project_id, id),
  CONSTRAINT stories_status_check
    CHECK (status IN ('ready', 'working', 'attention', 'review', 'done', 'archived')),
  CONSTRAINT stories_provider_check CHECK (provider IN ('github', 'manual', 'schedule')),
  CONSTRAINT stories_project_scope_fk
    FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);
CREATE INDEX stories_org_project_status_idx ON stories (org_id, project_id, status);

CREATE TABLE workspaces (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  provider text NOT NULL,
  external_ref text,
  volume_ref text NOT NULL,
  state text NOT NULL DEFAULT 'creating',
  setup_checksum text,
  next_event_seq bigint NOT NULL DEFAULT 1,
  environment jsonb NOT NULL DEFAULT '{}'::jsonb,
  endpoints jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  destroyed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_org_project_id_uidx UNIQUE (org_id, project_id, id),
  CONSTRAINT workspaces_org_id_uidx UNIQUE (org_id, id),
  CONSTRAINT workspaces_provider_check CHECK (provider IN ('docker', 'vercel', 'fake')),
  CONSTRAINT workspaces_next_event_seq_check CHECK (next_event_seq > 0),
  CONSTRAINT workspaces_state_check CHECK (
    state IN ('creating', 'running', 'sleeping', 'error', 'deleting', 'destroyed')
  ),
  CONSTRAINT workspaces_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories(org_id, project_id, id)
);
CREATE UNIQUE INDEX workspaces_story_active_uidx ON workspaces (story_id)
  WHERE state IN ('creating', 'running', 'sleeping', 'error');
CREATE INDEX workspaces_org_project_state_idx ON workspaces (org_id, project_id, state);

CREATE TABLE story_conversations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  summary text,
  next_seq integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_conversations_story_uidx UNIQUE (story_id),
  CONSTRAINT story_conversations_org_project_id_uidx UNIQUE (org_id, project_id, id),
  CONSTRAINT story_conversations_next_seq_check CHECK (next_seq > 0),
  CONSTRAINT story_conversations_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories(org_id, project_id, id)
);
CREATE INDEX story_conversations_org_project_idx
  ON story_conversations (org_id, project_id);

CREATE TABLE turns (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  conversation_id text NOT NULL REFERENCES story_conversations(id),
  agent_name text NOT NULL,
  manifest_hash text NOT NULL,
  manifest jsonb NOT NULL,
  engine text NOT NULL,
  model text NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  trigger_type text NOT NULL,
  trigger_key text,
  scheduled_for timestamptz,
  error text,
  next_event_seq bigint NOT NULL DEFAULT 1,
  started_at timestamptz,
  ended_at timestamptz,
  created_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT turns_org_project_id_uidx UNIQUE (org_id, project_id, id),
  CONSTRAINT turns_story_scope_uidx UNIQUE (org_id, project_id, story_id, id),
  CONSTRAINT turns_message_scope_uidx
    UNIQUE (org_id, project_id, story_id, conversation_id, id),
  CONSTRAINT turns_engine_check CHECK (engine IN ('claude_code', 'codex')),
  CONSTRAINT turns_next_event_seq_check CHECK (next_event_seq > 0),
  CONSTRAINT turns_state_check
    CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  CONSTRAINT turns_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories(org_id, project_id, id),
  CONSTRAINT turns_conversation_scope_fk
    FOREIGN KEY (org_id, project_id, conversation_id)
    REFERENCES story_conversations(org_id, project_id, id)
);
CREATE UNIQUE INDEX turns_story_active_uidx ON turns (story_id)
  WHERE state IN ('queued', 'running');
CREATE UNIQUE INDEX turns_schedule_uidx
  ON turns (project_id, agent_name, trigger_key, scheduled_for)
  WHERE scheduled_for IS NOT NULL;
CREATE INDEX turns_org_story_created_idx ON turns (org_id, story_id, created_at DESC);

CREATE TABLE story_messages (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  conversation_id text NOT NULL REFERENCES story_conversations(id),
  seq integer NOT NULL,
  role text NOT NULL,
  body text NOT NULL,
  actor jsonb NOT NULL,
  turn_id text,
  requested_agent_name text,
  requested_trigger jsonb,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_messages_conversation_seq_uidx UNIQUE (conversation_id, seq),
  CONSTRAINT story_messages_role_check CHECK (role IN ('user', 'agent', 'system')),
  CONSTRAINT story_messages_seq_check CHECK (seq > 0),
  CONSTRAINT story_messages_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories(org_id, project_id, id),
  CONSTRAINT story_messages_conversation_scope_fk
    FOREIGN KEY (org_id, project_id, conversation_id)
    REFERENCES story_conversations(org_id, project_id, id),
  CONSTRAINT story_messages_turn_scope_fk
    FOREIGN KEY (org_id, project_id, story_id, conversation_id, turn_id)
    REFERENCES turns(org_id, project_id, story_id, conversation_id, id)
);
CREATE UNIQUE INDEX story_messages_conversation_dedupe_uidx
  ON story_messages (conversation_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX story_messages_org_story_seq_idx ON story_messages (org_id, story_id, seq);

CREATE TABLE engine_sessions (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  agent_name text NOT NULL,
  engine text NOT NULL,
  model text NOT NULL,
  native_session_id text NOT NULL,
  state_path text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  last_turn_id text,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engine_sessions_workspace_native_uidx
    UNIQUE (workspace_id, engine, native_session_id),
  CONSTRAINT engine_sessions_engine_check CHECK (engine IN ('claude_code', 'codex')),
  CONSTRAINT engine_sessions_status_check CHECK (status IN ('active', 'corrupt', 'closed')),
  CONSTRAINT engine_sessions_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories(org_id, project_id, id),
  CONSTRAINT engine_sessions_workspace_scope_fk
    FOREIGN KEY (org_id, project_id, workspace_id) REFERENCES workspaces(org_id, project_id, id),
  CONSTRAINT engine_sessions_turn_scope_fk
    FOREIGN KEY (org_id, project_id, story_id, last_turn_id)
    REFERENCES turns(org_id, project_id, story_id, id)
);
CREATE UNIQUE INDEX engine_sessions_compatible_active_uidx
  ON engine_sessions (workspace_id, agent_name, engine, model) WHERE status = 'active';
CREATE INDEX engine_sessions_org_story_idx
  ON engine_sessions (org_id, story_id, last_used_at DESC);

CREATE TABLE turn_events (
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  turn_id text NOT NULL REFERENCES turns(id),
  seq bigint NOT NULL,
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (turn_id, seq),
  CONSTRAINT turn_events_turn_scope_fk
    FOREIGN KEY (org_id, project_id, story_id, turn_id)
    REFERENCES turns(org_id, project_id, story_id, id)
);
CREATE INDEX turn_events_org_story_idx ON turn_events (org_id, story_id, created_at);

CREATE TABLE story_artifacts (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  turn_id text,
  kind text NOT NULL,
  label text NOT NULL,
  uri text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_artifacts_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories(org_id, project_id, id),
  CONSTRAINT story_artifacts_turn_scope_fk
    FOREIGN KEY (org_id, project_id, story_id, turn_id)
    REFERENCES turns(org_id, project_id, story_id, id)
);
CREATE INDEX story_artifacts_org_story_idx ON story_artifacts (org_id, story_id);

CREATE TABLE attention_items (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  turn_id text,
  kind text NOT NULL,
  title text NOT NULL,
  detail text,
  status text NOT NULL DEFAULT 'open',
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attention_items_status_check CHECK (status IN ('open', 'resolved')),
  CONSTRAINT attention_items_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories(org_id, project_id, id),
  CONSTRAINT attention_items_turn_scope_fk
    FOREIGN KEY (org_id, project_id, story_id, turn_id)
    REFERENCES turns(org_id, project_id, story_id, id)
);
CREATE INDEX attention_items_org_story_status_idx
  ON attention_items (org_id, story_id, status);

CREATE TABLE agent_manifests (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  commit_sha text NOT NULL,
  path text NOT NULL,
  content_hash text NOT NULL,
  manifest jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_manifests_project_name_uidx UNIQUE (project_id, name),
  CONSTRAINT agent_manifests_project_scope_fk
    FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);
CREATE INDEX agent_manifests_org_project_idx ON agent_manifests (org_id, project_id);

CREATE TABLE agent_schedules (
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  agent_name text NOT NULL,
  trigger_name text NOT NULL,
  manifest_hash text NOT NULL,
  cron text NOT NULL,
  timezone text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL,
  last_scheduled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, agent_name, trigger_name),
  CONSTRAINT agent_schedules_project_scope_fk
    FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id)
);
CREATE INDEX agent_schedules_due_idx ON agent_schedules (enabled, next_run_at);

CREATE TABLE preview_sessions (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  user_id text NOT NULL REFERENCES users(id),
  service text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT preview_sessions_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories(org_id, project_id, id),
  CONSTRAINT preview_sessions_workspace_scope_fk
    FOREIGN KEY (org_id, project_id, workspace_id) REFERENCES workspaces(org_id, project_id, id),
  CONSTRAINT preview_sessions_member_scope_fk
    FOREIGN KEY (org_id, user_id) REFERENCES org_members(org_id, user_id)
);
CREATE INDEX preview_sessions_workspace_expiry_idx
  ON preview_sessions (workspace_id, expires_at);

CREATE TABLE workspace_events (
  org_id text NOT NULL REFERENCES orgs(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  seq bigint NOT NULL,
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, seq),
  CONSTRAINT workspace_events_workspace_scope_fk
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces(org_id, id)
);
CREATE INDEX workspace_events_org_workspace_idx
  ON workspace_events (org_id, workspace_id, seq);
