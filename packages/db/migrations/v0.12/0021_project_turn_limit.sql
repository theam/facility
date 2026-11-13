-- One generic maximum per agent turn, stored with the monthly project budget.
-- NULL keeps every existing project without a per-turn limit.
ALTER TABLE project_budgets ADD COLUMN turn_limit_cents integer;

ALTER TABLE project_budgets
  ADD CONSTRAINT project_budgets_turn_limit_check
  CHECK (turn_limit_cents IS NULL OR turn_limit_cents > 0);
