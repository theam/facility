ALTER TABLE preview_sandboxes
  ADD COLUMN IF NOT EXISTS provision_claimed_at timestamptz;

CREATE INDEX IF NOT EXISTS preview_sandboxes_unbound_provision_idx
  ON preview_sandboxes(status, provision_claimed_at, created_at)
  WHERE status = 'provisioning' AND ref IS NULL;
