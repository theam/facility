-- A merged PR is not automatically an accepted outcome. Keep the raw terminal
-- fate, but record the evidence needed for the Facility definition of accepted:
-- a human merged the PR with the repository's enforced squash method. NULL
-- accepted means the evidence was insufficient, not rejection.
--
-- IF NOT EXISTS makes this safe for development databases that briefly applied
-- the same change under an earlier local migration number before 0015–0017
-- landed on the integration branch.
ALTER TABLE outcomes
  ADD COLUMN IF NOT EXISTS accepted boolean,
  ADD COLUMN IF NOT EXISTS issue_number integer,
  ADD COLUMN IF NOT EXISTS issue_opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS merged_by text,
  ADD COLUMN IF NOT EXISTS merger_type text,
  ADD COLUMN IF NOT EXISTS merge_method text,
  ADD COLUMN IF NOT EXISTS hours_issue_to_merge numeric;

-- Historical rows remain NULL. Although an old unmerged PR is known not to
-- have been accepted, assessing only historical failures would make the first
-- 30-day acceptance window read as a misleading 0%. New terminal PRs are
-- assessed by the evidence collector after this migration.

-- Analytics reports both the acceptance numerator and its assessed denominator,
-- so missing GitHub evidence cannot silently turn into either success or failure.
ALTER TABLE analytics_daily
  ADD COLUMN IF NOT EXISTS outcomes_assessed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outcomes_accepted integer NOT NULL DEFAULT 0;

-- Existing installations seeded plan_acceptance as a record-only action. It
-- now has a real internal executor that dispatches the builder run.
UPDATE action_types
SET executor = '{"type":"internal","config":{}}'::jsonb,
    updated_at = now()
WHERE name = 'plan_acceptance'
  AND coalesce(executor->>'type', 'none') = 'none';
