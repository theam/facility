-- A plan can be represented by more than one approval proposal. The architect
-- run is the durable plan identity, so enforce one builder dispatch for it
-- across proposal retries, duplicates, and concurrent approvals.
CREATE UNIQUE INDEX IF NOT EXISTS runs_plan_acceptance_architect_run_uidx
  ON runs (org_id, ((trigger->>'architectRunId')))
  WHERE trigger->>'source' = 'plan_acceptance';
