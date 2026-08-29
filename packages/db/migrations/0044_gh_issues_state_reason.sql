-- GitHub's reason for an issue's current state. Without it a story abandoned
-- as `not_planned` is indistinguishable from delivered work in the mirror, and
-- the pipeline classifies both as Shipped.
ALTER TABLE gh_issues
  ADD COLUMN IF NOT EXISTS state_reason text;

ALTER TABLE gh_issues
  ADD CONSTRAINT gh_issues_state_reason_check
  CHECK (state_reason IS NULL OR state_reason IN ('completed', 'not_planned', 'duplicate', 'reopened'))
  NOT VALID;

ALTER TABLE gh_issues
  VALIDATE CONSTRAINT gh_issues_state_reason_check;
