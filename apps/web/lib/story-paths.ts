/**
 * Browser-side paths for the story view's lazily loaded collections. They go
 * through the same-origin /api proxy, so this module stays free of server-only
 * imports and is safe to use from client components.
 */
/** Page size for the story view's long collections; the server pages the full data. */
export const STORY_PAGE_SIZE = 10;

/** Browser-side paths for lazily loaded story collections (proxied through /api). */
export function storyConversationPath(projectId: string, storyId: string, before?: number) {
  return `${storyPath(projectId, storyId)}/conversation?order=desc&limit=${STORY_PAGE_SIZE}${before ? `&before=${before}` : ""}`;
}
export function storyActivityPath(
  projectId: string,
  storyId: string,
  turnId: string,
  before?: number,
) {
  return `${storyPath(projectId, storyId)}/turns/${encodeURIComponent(turnId)}/activity?limit=${STORY_PAGE_SIZE}${before === undefined ? "" : `&before=${before}`}`;
}
export function storyTurnEventPath(
  projectId: string,
  storyId: string,
  turnId: string,
  seq: number,
) {
  return `${storyPath(projectId, storyId)}/turns/${encodeURIComponent(turnId)}/events/${seq}`;
}
export function storyTimelinePath(projectId: string, storyId: string, before?: string) {
  return `${storyPath(projectId, storyId)}/timeline?limit=${STORY_PAGE_SIZE}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
}
export function storyEnvironmentPath(projectId: string, storyId: string, before?: number) {
  return `${storyPath(projectId, storyId)}/environment?limit=${STORY_PAGE_SIZE}${before ? `&before=${before}` : ""}`;
}
function storyPath(projectId: string, storyId: string) {
  return `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories/${encodeURIComponent(storyId)}`;
}
