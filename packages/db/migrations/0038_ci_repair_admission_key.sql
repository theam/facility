ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS ci_repair_key text;

-- workflow_run deliveries have different GitHub delivery ids even when they
-- describe the same failing PR head. Enforce the repair decision at the
-- database boundary so multiple worker replicas cannot both spend against it.
CREATE UNIQUE INDEX IF NOT EXISTS runs_org_ci_repair_key_uidx
  ON runs(org_id, ci_repair_key)
  WHERE ci_repair_key IS NOT NULL;
