ALTER TABLE runs
  ADD COLUMN workspace_base_sha text;

ALTER TABLE run_deliveries
  ADD COLUMN base_sha text;
