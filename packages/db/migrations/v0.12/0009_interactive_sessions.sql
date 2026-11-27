ALTER TABLE turns ADD COLUMN interactive jsonb;
ALTER TABLE turns ADD CONSTRAINT turns_interactive_check CHECK (
  (trigger_type = 'interactive') = (interactive IS NOT NULL)
);

CREATE TABLE session_waiters (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  transport_id text NOT NULL,
  waiting boolean NOT NULL DEFAULT true,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_waiters_story_scope_fk FOREIGN KEY (org_id, project_id, story_id)
    REFERENCES stories(org_id, project_id, id)
);
CREATE INDEX session_waiters_story_idx ON session_waiters(story_id, created_at);

UPDATE roles SET permissions = array_append(permissions, 'sessions:observe')
WHERE org_id IS NULL AND name = 'viewer' AND NOT permissions @> ARRAY['sessions:observe'];
