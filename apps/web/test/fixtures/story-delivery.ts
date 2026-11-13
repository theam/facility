import type { StoryDelivery } from "@facility/sdk";

export const at = "2026-10-21T10:00:00.000Z";
export function snapshot(revision = 1): StoryDelivery {
  const pullRequests = ["app", "api", "worker"].map((name, index) => ({
    repositoryId: `repo-${name}`,
    repository: `example/${name}`,
    number: index + 1,
    required: true,
    primary: index === 0,
    origin: "registered" as const,
    title: `Feature in ${name}`,
    url: `https://github.com/example/${name}/pull/${index + 1}`,
    state: index === 0 ? ("merged" as const) : ("open" as const),
    draft: false,
    headSha: "a".repeat(40),
    headRef: "feature",
    baseRef: "main",
    observedAt: at,
    stale: false,
    checks: { state: "success" as const, headSha: "b".repeat(40), current: false, observedAt: at },
    reviews: {
      state: "unobserved" as const,
      currentHeadCount: 0,
      unverifiedHeadCount: 0,
      truncated: false,
      latest: [],
    },
  }));
  return {
    schemaVersion: 1,
    orgId: "org-a",
    projectId: "project-a",
    storyId: "story-a",
    generatedAt: at,
    scope: {
      revision,
      declaredComplete: true,
      origin: "registered",
      updatedAt: at,
      updatedBy: { type: "user", id: "person-a" },
    },
    pullRequests,
    candidate: {
      revision: "d".repeat(64),
      state: "recorded",
      requiredCount: 3,
      mergedCount: 1,
      allRequiredMerged: false,
    },
    available: {
      items: [
        {
          repositoryId: "repo-extra",
          repository: "example/extra",
          number: 4,
          title: "Another required change",
          url: "https://github.com/example/extra/pull/4",
          headSha: "c".repeat(40),
          state: "open",
          draft: false,
          stale: false,
        },
      ],
      hasMore: false,
      nextOffset: null,
    },
  };
}
