-- Architect contracts require the same provisioned environment as builders so
-- they can validate plans against real services. Move only the legacy bundled
-- assignment once; operators remain free to choose another profile afterward.
UPDATE agent_defs AS agent
SET sandbox_profile_id = full_profile.id,
    updated_at = now()
FROM sandbox_profiles AS analysis_profile
JOIN sandbox_profiles AS full_profile
  ON full_profile.org_id = analysis_profile.org_id
  AND full_profile.project_id IS NULL
  AND full_profile.id = CASE
    WHEN analysis_profile.org_id = 'org_dev_the_agile_monkeys' THEN 'sbx_dev_default'
    ELSE 'sbx_default_' || analysis_profile.org_id
  END
WHERE agent.org_id = analysis_profile.org_id
  AND agent.sandbox_profile_id = analysis_profile.id
  AND analysis_profile.project_id IS NULL
  AND analysis_profile.id = CASE
    WHEN analysis_profile.org_id = 'org_dev_the_agile_monkeys' THEN 'sbx_dev_analysis'
    ELSE 'sbx_analysis_' || analysis_profile.org_id
  END
  AND agent.name IN ('architect', 'codex-architect');
