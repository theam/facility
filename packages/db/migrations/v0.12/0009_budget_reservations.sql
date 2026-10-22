-- Hold a priced estimate against the monthly budget until measured usage
-- replaces it, or until the call ends without usage and the hold is released.
CREATE TABLE budget_reservations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  turn_id text REFERENCES turns(id),
  purpose text NOT NULL,
  state text NOT NULL DEFAULT 'open',
  model text NOT NULL,
  reserved_cents numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_reservations_purpose_check CHECK (purpose IN ('turn', 'title')),
  CONSTRAINT budget_reservations_state_check CHECK (state IN ('open', 'settled')),
  CONSTRAINT budget_reservations_cents_check CHECK (reserved_cents >= 0),
  CONSTRAINT budget_reservations_subject_check CHECK (
    (purpose = 'turn' AND turn_id IS NOT NULL AND state = 'open')
    OR (purpose = 'title' AND turn_id IS NULL)
  ),
  CONSTRAINT budget_reservations_project_scope_fk
    FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id),
  CONSTRAINT budget_reservations_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories (org_id, project_id, id),
  CONSTRAINT budget_reservations_turn_scope_fk
    FOREIGN KEY (org_id, project_id, story_id, turn_id)
    REFERENCES turns (org_id, project_id, story_id, id)
);

CREATE UNIQUE INDEX budget_reservations_turn_uidx
  ON budget_reservations (turn_id) WHERE turn_id IS NOT NULL;
CREATE UNIQUE INDEX budget_reservations_open_title_uidx
  ON budget_reservations (story_id) WHERE purpose = 'title' AND state = 'open';
CREATE INDEX budget_reservations_project_idx
  ON budget_reservations (org_id, project_id, state);
