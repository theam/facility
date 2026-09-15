-- Immutable, tenant-scoped lineage for governed Builder successor attempts.
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS retry_of_run_id text;

CREATE UNIQUE INDEX IF NOT EXISTS runs_org_project_id_uidx
  ON runs (org_id, project_id, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'runs_retry_parent_fk'
      AND conrelid = 'runs'::regclass
  ) THEN
    ALTER TABLE runs
      ADD CONSTRAINT runs_retry_parent_fk
      FOREIGN KEY (org_id, project_id, retry_of_run_id)
      REFERENCES runs (org_id, project_id, id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'runs_retry_not_self_check'
      AND conrelid = 'runs'::regclass
  ) THEN
    ALTER TABLE runs
      ADD CONSTRAINT runs_retry_not_self_check
      CHECK (retry_of_run_id IS NULL OR retry_of_run_id <> id);
  END IF;
END $$;

-- A parent has at most one direct successor. Repeated attempts form a linear
-- root -> child -> child chain rather than a tree of competing executions.
CREATE UNIQUE INDEX IF NOT EXISTS runs_retry_of_run_uidx
  ON runs (org_id, project_id, retry_of_run_id)
  WHERE retry_of_run_id IS NOT NULL;

-- Proposal and Architect-run uniqueness identify only the canonical root.
-- Governed successors deliberately carry the byte-identical accepted trigger.
DROP INDEX IF EXISTS runs_plan_acceptance_proposal_uidx;
CREATE UNIQUE INDEX runs_plan_acceptance_proposal_uidx
  ON runs (org_id, ((trigger->>'proposalId')))
  WHERE trigger->>'source' = 'plan_acceptance'
    AND retry_of_run_id IS NULL;

DROP INDEX IF EXISTS runs_plan_acceptance_architect_run_uidx;
CREATE UNIQUE INDEX runs_plan_acceptance_architect_run_uidx
  ON runs (org_id, ((trigger->>'architectRunId')))
  WHERE trigger->>'source' = 'plan_acceptance'
    AND retry_of_run_id IS NULL;

CREATE OR REPLACE FUNCTION enforce_governed_run_retry_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent runs%ROWTYPE;
  has_child boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.retry_of_run_id IS NULL THEN
      RETURN NEW;
    END IF;

    IF NEW.retry_of_run_id = NEW.id THEN
      RAISE EXCEPTION 'run retry cannot reference itself'
        USING ERRCODE = '23514', CONSTRAINT = 'runs_retry_not_self_check';
    END IF;

    SELECT * INTO parent
    FROM runs
    WHERE id = NEW.retry_of_run_id
      AND org_id = NEW.org_id
      AND project_id = NEW.project_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'run retry parent is not in the same organization and project'
        USING ERRCODE = '23503', CONSTRAINT = 'runs_retry_parent_fk';
    END IF;
    IF parent.status <> 'failed'
      OR parent.mode NOT IN ('builder', 'codex-builder')
      OR parent.trigger->>'source' IS DISTINCT FROM 'plan_acceptance'
    THEN
      RAISE EXCEPTION 'run retry parent is not a failed plan-linked Builder'
        USING ERRCODE = '23514', CONSTRAINT = 'runs_retry_parent_state_check';
    END IF;
    IF NEW.status <> 'queued'
      OR NEW.trigger IS DISTINCT FROM parent.trigger
      OR NEW.agent_def_id IS DISTINCT FROM parent.agent_def_id
      OR NEW.mode IS DISTINCT FROM parent.mode
      OR NEW.engine IS DISTINCT FROM parent.engine
    THEN
      RAISE EXCEPTION 'run retry identity must exactly match its parent'
        USING ERRCODE = '23514', CONSTRAINT = 'runs_retry_identity_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.retry_of_run_id IS DISTINCT FROM OLD.retry_of_run_id THEN
    RAISE EXCEPTION 'run retry lineage is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'runs_retry_lineage_immutable';
  END IF;

  -- A failed plan-linked Builder is a sealed execution record, whether or not
  -- its successor has committed yet. Freezing the parent unconditionally
  -- closes the concurrent INSERT-child / UPDATE-parent snapshot race: whichever
  -- statement obtains the parent row lock first, the other statement either
  -- observes a non-failed parent and rejects or this UPDATE rejects here.
  IF OLD.status = 'failed'
    AND OLD.mode IN ('builder', 'codex-builder')
    AND OLD.trigger->>'source' = 'plan_acceptance'
  THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'failed plan-linked Builder status is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'runs_retry_parent_status_immutable';
    END IF;
    IF NEW.org_id IS DISTINCT FROM OLD.org_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.trigger IS DISTINCT FROM OLD.trigger
      OR NEW.agent_def_id IS DISTINCT FROM OLD.agent_def_id
      OR NEW.mode IS DISTINCT FROM OLD.mode
      OR NEW.engine IS DISTINCT FROM OLD.engine
    THEN
      RAISE EXCEPTION 'failed plan-linked Builder execution identity is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'runs_retry_parent_identity_immutable';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM runs child
    WHERE child.org_id = OLD.org_id
      AND child.project_id = OLD.project_id
      AND child.retry_of_run_id = OLD.id
  ) INTO has_child;
  IF (OLD.retry_of_run_id IS NOT NULL OR has_child)
    AND (
      NEW.org_id IS DISTINCT FROM OLD.org_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.trigger IS DISTINCT FROM OLD.trigger
      OR NEW.agent_def_id IS DISTINCT FROM OLD.agent_def_id
      OR NEW.mode IS DISTINCT FROM OLD.mode
      OR NEW.engine IS DISTINCT FROM OLD.engine
    )
  THEN
    RAISE EXCEPTION 'run retry execution identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'runs_retry_identity_immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS runs_governed_retry_lineage_guard ON runs;
CREATE TRIGGER runs_governed_retry_lineage_guard
BEFORE INSERT OR UPDATE OF retry_of_run_id, org_id, project_id, trigger, agent_def_id, mode, engine, status
ON runs
FOR EACH ROW
EXECUTE FUNCTION enforce_governed_run_retry_lineage();
