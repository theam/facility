ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS github_delivery_id text;

-- Historical retry races may already have produced more than one run for one
-- webhook delivery. Preserve every run for audit, but bind the durable key to
-- only the first before enforcing idempotency for new dispatches.
WITH ranked_github_runs AS (
  SELECT
    id,
    trigger->>'delivery' AS delivery_id,
    row_number() OVER (
      PARTITION BY org_id, trigger->>'delivery'
      ORDER BY created_at, id
    ) AS rank
  FROM runs
  WHERE trigger->>'type' = 'github_event'
    AND nullif(trigger->>'delivery', '') IS NOT NULL
)
UPDATE runs AS run
SET github_delivery_id = ranked.delivery_id
FROM ranked_github_runs AS ranked
WHERE run.id = ranked.id
  AND ranked.rank = 1
  AND run.github_delivery_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS runs_org_github_delivery_uidx
  ON runs(org_id, github_delivery_id)
  WHERE github_delivery_id IS NOT NULL;
