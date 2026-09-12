import { createHash } from "node:crypto";
import type { BacklogItem } from "../stories/backlog.js";
import type { PreviewSite } from "./preview-sites.js";

/** Desired state, not a command, webhook, or proof of provider destruction. */
export function previewRegistrationState(
  item: BacklogItem,
  workspace: { id: string; state: string } | null,
) {
  if (!workspace) return { state: "unknown", reason: "workspace_missing" } as const;
  if (["deleting", "destroyed"].includes(workspace.state))
    return { state: "closed", reason: "workspace_deleted" } as const;
  // Even a delivered/archived story can still have an in-flight turn. Do not
  // remove its integrations underneath that turn; reconcile again afterwards.
  if (item.activity.state !== "idle") return { state: "active", reason: "active_turn" } as const;
  if (item.phase === "archived" || item.story?.status === "done")
    return { state: "closed", reason: item.reason } as const;
  // Fail conservatively when GitHub delivery evidence is missing or stale.
  // Never treat a missing item/404 or an old mirror as a deletion instruction.
  if (item.story?.provider === "github" && (!item.issue || item.issue.stale))
    return { state: "unknown", reason: "github_state_unavailable" } as const;
  return {
    state: item.phase === "done" ? ("closed" as const) : ("active" as const),
    reason: item.reason,
  };
}

export function previewRegistrationSnapshot(input: {
  orgId: string;
  projectId: string;
  storyId: string;
  item: BacklogItem;
  workspace: { id: string; state: string } | null;
  sites: PreviewSite[];
  now: Date;
}) {
  const registration = previewRegistrationState(input.item, input.workspace);
  const body = {
    schemaVersion: 1,
    orgId: input.orgId,
    projectId: input.projectId,
    storyId: input.storyId,
    workspaceId: input.workspace?.id ?? null,
    registration,
    phase: input.item.phase,
    activity: input.item.activity.state,
    sites: input.sites
      .filter(
        (site) =>
          site.orgId === input.orgId &&
          site.projectId === input.projectId &&
          site.workspaceId === input.workspace?.id,
      )
      .map((site) => ({ id: site.id, service: site.service, origin: site.origin }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  // Opaque content revision, not a monotonic sequence or an event id. Excludes
  // observation time and all credentials; reopening can revisit an old revision.
  return {
    ...body,
    revision: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    observedAt: input.now.toISOString(),
  };
}
