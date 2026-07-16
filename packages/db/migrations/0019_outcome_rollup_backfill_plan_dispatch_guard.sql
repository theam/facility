-- A proposal decision is guarded, but explicit execution retries can race.
-- The trigger carries the durable proposal link; enforce one builder run for it
-- at the database boundary and let the executor reuse the winning row.
CREATE UNIQUE INDEX IF NOT EXISTS runs_plan_acceptance_proposal_uidx
  ON runs (org_id, ((trigger->>'proposalId')))
  WHERE trigger->>'source' = 'plan_acceptance';

-- Development databases may have applied an earlier local copy of 0018 that
-- marked every historical closed PR rejected. Restore those evidence-less
-- rows to unassessed before rebuilding the rollup. Normal collection after
-- these migrations continues to assess newly closed, unmerged PRs as false.
UPDATE outcomes
SET accepted = NULL
WHERE fate = 'closed'
  AND accepted = false
  AND issue_number IS NULL
  AND merged_by IS NULL
  AND merge_method IS NULL;

-- Migration 0018 changes the acceptance numerator and the one-shot rate's
-- denominator. analytics_daily can contain 30+ days built under the legacy
-- merged=accepted definition while the normal worker only rebuilds 3 days.
-- Recompute the evidence-derived fields for every materialized day now so a
-- 30-day query never mixes old numerators with new denominators.
UPDATE analytics_daily
SET outcomes_assessed = 0,
    outcomes_accepted = 0,
    outcomes_one_shot = 0;

WITH evidence_rollup AS (
  SELECT
    org_id,
    project_id,
    date_trunc('day', terminal_at)::date AS day,
    count(*) FILTER (WHERE accepted IS NOT NULL)::int AS assessed,
    count(*) FILTER (WHERE accepted = true)::int AS accepted,
    count(*) FILTER (
      WHERE fate = 'merged' AND review_rounds = 0 AND fixup_commits = 0
    )::int AS one_shot
  FROM outcomes
  WHERE terminal_at IS NOT NULL
  GROUP BY 1, 2, 3
)
UPDATE analytics_daily AS daily
SET outcomes_assessed = evidence.assessed,
    outcomes_accepted = evidence.accepted,
    outcomes_one_shot = evidence.one_shot,
    updated_at = now()
FROM evidence_rollup AS evidence
WHERE daily.org_id = evidence.org_id
  AND daily.project_id = evidence.project_id
  AND daily.day = evidence.day
  AND daily.model = 'outcomes'
  AND daily.agent_def_id IS NULL;
