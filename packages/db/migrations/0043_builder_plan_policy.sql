-- 0042 is reserved by the workspace/base provenance work in #166. Keeping
-- this policy migration at 0043 lets the two contributions compose cleanly.
ALTER TABLE projects
  ADD COLUMN builder_plan_policy text NOT NULL DEFAULT 'optional';

ALTER TABLE projects
  ADD CONSTRAINT projects_builder_plan_policy_check
  CHECK (builder_plan_policy IN ('optional', 'required'));
