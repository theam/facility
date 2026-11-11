import { createHash } from "node:crypto";

export const PREVIEW_MANAGED_REF = "refs/facility/preview-managed";
const PREVIEW_BRANCH_PREFIX = "facility/preview/";

/** Local to one retained story workspace and repository; never a remote work branch. */
export function previewBranchRefs(workspaceId: string, repositoryPath: string) {
  const key = createHash("sha256")
    .update(JSON.stringify([workspaceId, repositoryPath]))
    .digest("hex");
  const branch = `${PREVIEW_BRANCH_PREFIX}${key}`;
  return {
    branch,
    ref: `refs/heads/${branch}`,
    ownershipRef: `refs/facility/preview-branches/${key}`,
  };
}

export function isPreviewBranch(branch: string) {
  return branch.startsWith(PREVIEW_BRANCH_PREFIX);
}
