-- A run is retry-eligible with zero lease rows only after a runner that speaks
-- the tracked write protocol has completed its authenticated hello handshake.
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS repository_write_tracking_version integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_repository_write_tracking_version_check'
      AND conrelid = 'runs'::regclass
  ) THEN
    ALTER TABLE runs
      ADD CONSTRAINT runs_repository_write_tracking_version_check
      CHECK (repository_write_tracking_version IN (0, 1));
  END IF;
END
$$;

-- Version 1 is evidence, not ordinary mutable configuration. Historical rows
-- always insert at 0; the only promotion is the authenticated one-shot hello
-- claim that moves the same run from provisioning to running.
CREATE OR REPLACE FUNCTION enforce_repository_write_tracking_handshake()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.repository_write_tracking_version <> 0 THEN
      RAISE EXCEPTION 'repository write tracking must be negotiated by hello'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.repository_write_tracking_version IS DISTINCT FROM OLD.repository_write_tracking_version
    AND NOT (
      OLD.repository_write_tracking_version = 0
      AND NEW.repository_write_tracking_version = 1
      AND OLD.status = 'provisioning'
      AND NEW.status = 'running'
    )
  THEN
    RAISE EXCEPTION 'invalid repository write tracking transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS runs_repository_write_tracking_guard ON runs;

CREATE TRIGGER runs_repository_write_tracking_guard
BEFORE INSERT OR UPDATE OF repository_write_tracking_version
ON runs
FOR EACH ROW
EXECUTE FUNCTION enforce_repository_write_tracking_handshake();

-- A repository write credential can outlive the runner request that obtained
-- it. Persist the exact repository/base/branch intent before issuance so a
-- later governed retry can prove that no ambiguous remote output exists.
CREATE TABLE IF NOT EXISTS run_repository_write_leases (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  project_id text NOT NULL REFERENCES projects(id),
  run_id text NOT NULL REFERENCES runs(id),
  repo_id text NOT NULL REFERENCES repos(id),
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  requested_branch text NOT NULL,
  authorized_branch text NOT NULL,
  base_sha text NOT NULL,
  permissions jsonb NOT NULL,
  issued_at timestamptz,
  expires_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_repository_write_leases_provider_check
    CHECK (provider IN ('github_installation', 'configured_fallback')),
  CONSTRAINT run_repository_write_leases_status_check
    CHECK (status IN ('reserved', 'issued', 'failed')),
  CONSTRAINT run_repository_write_leases_base_sha_check
    CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT run_repository_write_leases_branch_check
    CHECK (
      char_length(requested_branch) BETWEEN 1 AND 255
      AND requested_branch = btrim(requested_branch)
      AND requested_branch !~ '[[:cntrl:]]'
      AND char_length(authorized_branch) BETWEEN 1 AND 255
      AND authorized_branch = btrim(authorized_branch)
      AND authorized_branch !~ '[[:cntrl:]]'
    ),
  CONSTRAINT run_repository_write_leases_permissions_check
    CHECK (permissions IN ('["contents"]'::jsonb, '["contents", "workflows"]'::jsonb)),
  CONSTRAINT run_repository_write_leases_state_check
    CHECK (
      (
        status = 'reserved'
        AND issued_at IS NULL
        AND expires_at IS NULL
        AND failure_reason IS NULL
      )
      OR (
        status = 'failed'
        AND issued_at IS NULL
        AND expires_at IS NULL
        AND failure_reason IS NOT NULL
      )
      OR (
        status = 'issued'
        AND issued_at IS NOT NULL
        AND failure_reason IS NULL
        AND (
          (
            provider = 'github_installation'
            AND expires_at IS NOT NULL
            AND expires_at > issued_at
          )
          OR (provider = 'configured_fallback' AND expires_at IS NULL)
        )
      )
    )
);

CREATE INDEX IF NOT EXISTS run_repository_write_leases_run_created_idx
  ON run_repository_write_leases (run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS run_repository_write_leases_repo_branch_idx
  ON run_repository_write_leases (org_id, project_id, repo_id, authorized_branch, created_at DESC);

-- IDs are globally unique, but the duplicated tenant columns are deliberate:
-- they make every later eligibility query tenant-scoped. A trigger prevents a
-- malformed/manual insert from binding a run or repository from another scope.
CREATE OR REPLACE FUNCTION enforce_run_repository_write_lease_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM runs AS r
    JOIN repos AS repo
      ON repo.id = NEW.repo_id
    WHERE r.id = NEW.run_id
      AND r.org_id = NEW.org_id
      AND r.project_id = NEW.project_id
      AND repo.org_id = NEW.org_id
      AND repo.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'run repository write lease scope mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS run_repository_write_leases_scope_guard
  ON run_repository_write_leases;

CREATE TRIGGER run_repository_write_leases_scope_guard
BEFORE INSERT OR UPDATE OF org_id, project_id, run_id, repo_id
ON run_repository_write_leases
FOR EACH ROW
EXECUTE FUNCTION enforce_run_repository_write_lease_scope();

CREATE OR REPLACE FUNCTION enforce_run_repository_write_lease_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'run repository write lease evidence is append-only'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(
    NEW.org_id,
    NEW.project_id,
    NEW.run_id,
    NEW.repo_id,
    NEW.provider,
    NEW.requested_branch,
    NEW.authorized_branch,
    NEW.base_sha,
    NEW.permissions,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.org_id,
    OLD.project_id,
    OLD.run_id,
    OLD.repo_id,
    OLD.provider,
    OLD.requested_branch,
    OLD.authorized_branch,
    OLD.base_sha,
    OLD.permissions,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'run repository write lease identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'reserved' OR NEW.status NOT IN ('issued', 'failed') THEN
    RAISE EXCEPTION 'invalid run repository write lease transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS run_repository_write_leases_evidence_guard
  ON run_repository_write_leases;

CREATE TRIGGER run_repository_write_leases_evidence_guard
BEFORE UPDATE OR DELETE
ON run_repository_write_leases
FOR EACH ROW
EXECUTE FUNCTION enforce_run_repository_write_lease_evidence();
