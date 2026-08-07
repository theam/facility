-- Early pre-release databases could create this index for every non-null run_id.
-- A legacy NULL migration checksum can only be trusted and backfilled, so converge
-- those databases explicitly: terminal preview records remain audit evidence but
-- must not prevent a failed, expired, or destroyed preview from being replaced.
DROP INDEX IF EXISTS preview_sandboxes_run_uidx;

CREATE UNIQUE INDEX preview_sandboxes_run_uidx
  ON preview_sandboxes(run_id)
  WHERE run_id IS NOT NULL
    AND status IN ('provisioning', 'running');
