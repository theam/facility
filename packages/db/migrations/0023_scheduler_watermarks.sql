CREATE TABLE IF NOT EXISTS scheduler_watermarks (
  name text PRIMARY KEY,
  last_tick timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
