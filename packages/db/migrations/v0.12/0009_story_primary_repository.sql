-- Manual and scheduled stories deliver through the project's primary repository.
-- Earlier releases stored them without one, so the GitHub mirror could never link
-- their pull requests and a merge left the story working with compute running.
-- updated_at is preserved because pull-request linking orders candidates by it.
UPDATE stories AS story
SET repository_id = repository.id
FROM project_repositories AS repository
WHERE story.repository_id IS NULL
  AND story.provider IN ('manual', 'schedule')
  AND repository.org_id = story.org_id
  AND repository.project_id = story.project_id
  AND repository.role = 'primary'
  AND NOT EXISTS (
    SELECT 1
    FROM stories AS existing
    WHERE existing.project_id = story.project_id
      AND existing.provider = story.provider
      AND existing.repository_id = repository.id
      AND existing.external_id = story.external_id
  );
