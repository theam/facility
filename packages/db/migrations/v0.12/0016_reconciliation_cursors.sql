CREATE TABLE IF NOT EXISTS reconciliation_cursors (
  name text PRIMARY KEY,
  last_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
