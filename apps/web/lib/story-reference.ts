import type { LinkReference } from "@/components/markdown";

type ReferenceStory = {
  number: number;
  repoId: string;
  repoOwner: string;
  repoName: string;
  prs: readonly { number: number }[];
};

type ReferenceTarget = Pick<ReferenceStory, "number" | "repoId">;

/**
 * Resolve GitHub references into the owning Facility story when that target is
 * present in the story index. Pull request numbers are aliases for the story
 * they belong to, so linked PRs do not lead to a nonexistent orphan-PR page.
 */
export function createStoryReferenceLink(input: {
  projectId: string;
  currentStory: ReferenceStory;
  stories: readonly ReferenceStory[];
}): LinkReference {
  const repoIdByName = new Map<string, string>();
  const targetByRepoAndNumber = new Map<string, ReferenceTarget>();
  const indexedStories = [...input.stories, input.currentStory];

  for (const story of indexedStories) {
    repoIdByName.set(repoNameKey(story.repoOwner, story.repoName), story.repoId);
    const target = { number: story.number, repoId: story.repoId };
    targetByRepoAndNumber.set(referenceKey(story.repoId, story.number), target);
    for (const pull of story.prs) {
      targetByRepoAndNumber.set(referenceKey(story.repoId, pull.number), target);
    }
  }

  return (reference) => {
    const owner = reference.owner ?? input.currentStory.repoOwner;
    const repo = reference.repo ?? input.currentStory.repoName;
    const fallback =
      reference.githubUrl ?? `https://github.com/${owner}/${repo}/issues/${reference.number}`;
    const repoId =
      reference.owner && reference.repo
        ? repoIdByName.get(repoNameKey(reference.owner, reference.repo))
        : input.currentStory.repoId;
    if (!repoId) return fallback;
    const target = targetByRepoAndNumber.get(referenceKey(repoId, reference.number));
    if (!target) return fallback;
    const query = new URLSearchParams({ repoId: target.repoId });
    return `/projects/${input.projectId}/stories/${target.number}?${query}`;
  };
}

function repoNameKey(owner: string, repo: string) {
  return `${owner}/${repo}`.toLowerCase();
}

function referenceKey(repoId: string, number: number) {
  return `${repoId}:${number}`;
}
