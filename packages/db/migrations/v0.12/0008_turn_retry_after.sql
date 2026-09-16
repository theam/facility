-- Keep provider admission retries durable without changing the scheduled occurrence.
ALTER TABLE turns ADD COLUMN IF NOT EXISTS retry_after timestamptz;
