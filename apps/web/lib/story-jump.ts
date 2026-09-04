export type StoryMatch = {
  number: number;
  repoId: string;
  repoOwner: string;
  repoName: string;
  storyType: "issue" | "pull_request";
};

export type LocalJumpResolution =
  | { kind: "match"; story: StoryMatch }
  | { kind: "ambiguous"; matches: StoryMatch[] }
  | { kind: "not-found" };

/**
 * Resolve a bare story number against stories already loaded on the board.
 * Two repositories can share the same number, so this reports ambiguity
 * explicitly rather than silently returning the first match.
 */
export function resolveLocalJump(
  stories: readonly StoryMatch[],
  number: number,
): LocalJumpResolution {
  const matches = stories.filter((story) => story.number === number);
  if (matches.length === 0) return { kind: "not-found" };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "match", story: matches[0] as StoryMatch };
}

export type ApiJumpOutcome =
  | { kind: "match"; story: StoryMatch }
  | { kind: "ambiguous"; matches: StoryMatch[] }
  | { kind: "not-found" }
  | { kind: "error" };

/**
 * Interpret a GET /stories/:number response. A non-2xx status that isn't a
 * genuine 404 or a 409 (ambiguous) is a real failure (server error, network
 * hiccup) — reported as "error", never folded into "not-found", so the UI
 * doesn't claim a story doesn't exist when the truth is "couldn't check".
 */
export async function interpretJumpResponse(res: Response): Promise<ApiJumpOutcome> {
  if (res.status === 404) return { kind: "not-found" };
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    const matches = Array.isArray(body?.error?.details?.matches)
      ? (body.error.details.matches as StoryMatch[])
      : [];
    return { kind: "ambiguous", matches };
  }
  if (!res.ok) return { kind: "error" };
  const story = (await res.json().catch(() => null)) as StoryMatch | null;
  if (!story) return { kind: "error" };
  return { kind: "match", story };
}
