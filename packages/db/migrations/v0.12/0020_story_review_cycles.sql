CREATE TABLE story_review_cycles (
  origin_turn_id text PRIMARY KEY,
  org_id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  phase text NOT NULL DEFAULT 'waiting_for_evidence',
  deadline timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL,
  CONSTRAINT story_review_cycle_origin_fk FOREIGN KEY (org_id, project_id, story_id, origin_turn_id)
    REFERENCES turns (org_id, project_id, story_id, id),
  CONSTRAINT story_review_cycle_phase_check CHECK (
    phase IN ('waiting_for_evidence', 'review', 'correction', 'human_review', 'decision_required')
  )
);

CREATE INDEX story_review_cycles_scope_idx
  ON story_review_cycles (org_id, project_id, story_id, created_at DESC);

CREATE UNIQUE INDEX story_review_cycles_active_uidx ON story_review_cycles (story_id)
  WHERE phase IN ('waiting_for_evidence', 'review', 'correction');
