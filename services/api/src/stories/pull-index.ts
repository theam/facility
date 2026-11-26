export type PullLookupRecord = {
  key: string;
  repositoryId: string;
  number: number;
  headRef: string;
  closingIssues: number[];
};

export type StoryPullLookup = {
  repositoryId: string | null;
  provider: string;
  pullRequestNumber: number | null;
  externalId: string;
  branch: string | null;
};

export function indexPullRequests<T extends PullLookupRecord>(pulls: T[]) {
  const pullOrder = new Map(pulls.map((pull, index) => [pull.key, index]));
  const pullsByStoryMatch = new Map<string, Map<string, T[]>>();
  const pullsByClosingIssue = new Map<string, Map<number, T[]>>();
  const addStoryMatch = (repositoryId: string, match: string, pull: T) => {
    const byMatch = pullsByStoryMatch.get(repositoryId) ?? new Map<string, T[]>();
    const matches = byMatch.get(match) ?? [];
    matches.push(pull);
    byMatch.set(match, matches);
    pullsByStoryMatch.set(repositoryId, byMatch);
  };
  for (const pull of pulls) {
    addStoryMatch(pull.repositoryId, `number:${pull.number}`, pull);
    addStoryMatch(pull.repositoryId, `external:pull-request:${pull.number}`, pull);
    addStoryMatch(pull.repositoryId, `branch:${pull.headRef}`, pull);

    const byNumber = pullsByClosingIssue.get(pull.repositoryId) ?? new Map<number, T[]>();
    for (const issueNumber of new Set(pull.closingIssues)) {
      const matches = byNumber.get(issueNumber) ?? [];
      matches.push(pull);
      byNumber.set(issueNumber, matches);
    }
    pullsByClosingIssue.set(pull.repositoryId, byNumber);
  }

  return {
    forStory(story: StoryPullLookup): T[] {
      if (!story.repositoryId) return [];
      const byMatch = pullsByStoryMatch.get(story.repositoryId);
      const matches = new Map<string, T>();
      const indexes =
        story.provider === "github" && story.externalId.startsWith("pull-request:")
          ? [`external:${story.externalId}`]
          : [
              story.pullRequestNumber === null ? null : `number:${story.pullRequestNumber}`,
              story.branch === null ? null : `branch:${story.branch}`,
            ];
      for (const index of indexes) {
        for (const pull of (index ? byMatch?.get(index) : undefined) ?? []) {
          matches.set(pull.key, pull);
        }
      }
      return [...matches.values()].sort(
        (left, right) => (pullOrder.get(left.key) ?? 0) - (pullOrder.get(right.key) ?? 0),
      );
    },
    forIssue(issue: { repositoryId: string; number: number }): T[] {
      return pullsByClosingIssue.get(issue.repositoryId)?.get(issue.number) ?? [];
    },
  };
}
