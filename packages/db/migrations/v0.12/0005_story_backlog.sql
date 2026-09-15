-- Unified backlog: story title provenance and explicit human participation.
ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS title_source text NOT NULL DEFAULT 'user';
ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS title_generation jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'stories_title_source_check'
      AND conrelid = 'stories'::regclass
  ) THEN
    ALTER TABLE stories
      ADD CONSTRAINT stories_title_source_check
      CHECK (title_source IN ('user', 'github', 'schedule', 'pending', 'generated', 'fallback'));
  END IF;
END $$;

-- Stories that already carry a GitHub or schedule identity did not receive a
-- user-written title; record their provenance so consumers can tell them apart.
UPDATE stories SET title_source = provider
WHERE provider IN ('github', 'schedule') AND title_source = 'user';

-- Facility-side assignees. GitHub assignees stay on the mirrored issue and are
-- merged with these rows at read time, so neither source overwrites the other.
CREATE TABLE IF NOT EXISTS story_assignees (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  story_id text NOT NULL REFERENCES stories(id),
  kind text NOT NULL,
  subject text NOT NULL,
  source text NOT NULL DEFAULT 'facility',
  added_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_assignees_story_subject_uidx UNIQUE (story_id, kind, subject),
  CONSTRAINT story_assignees_kind_check CHECK (kind IN ('user', 'github')),
  CONSTRAINT story_assignees_source_check CHECK (source IN ('facility', 'github')),
  CONSTRAINT story_assignees_story_scope_fk
    FOREIGN KEY (org_id, project_id, story_id) REFERENCES stories(org_id, project_id, id)
);
CREATE INDEX IF NOT EXISTS story_assignees_org_project_subject_idx
  ON story_assignees (org_id, project_id, kind, subject);
