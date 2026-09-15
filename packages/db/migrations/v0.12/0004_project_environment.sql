ALTER TABLE projects ADD COLUMN environment_secrets jsonb NOT NULL DEFAULT '{}'::jsonb;
