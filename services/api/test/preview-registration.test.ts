import { describe, expect, it } from "vitest";
import type { BacklogItem } from "../src/stories/backlog.js";
import {
  previewRegistrationSnapshot,
  previewRegistrationState,
} from "../src/workspaces/preview-registration.js";

const item = (extra: Partial<BacklogItem> = {}) =>
  ({
    phase: "in_progress",
    reason: "started",
    activity: { state: "idle" },
    story: { id: "story_a", status: "working", provider: "manual" },
    issue: null,
    ...extra,
  }) as BacklogItem;
const workspace = { id: "ws_a", state: "sleeping" };

describe("external preview registration lifecycle", () => {
  it.each([
    "running",
    "sleeping",
    "creating",
    "error",
  ])("retains registrations for an open story on %s compute", (state) => {
    expect(previewRegistrationState(item(), { ...workspace, state }).state).toBe("active");
  });
  it.each([
    "done",
    "archived",
  ] as const)("removes registrations on %s without destroying retained storage", (phase) => {
    expect(previewRegistrationState(item({ phase }), workspace).state).toBe("closed");
  });
  it.each([
    "running",
    "queued",
  ] as const)("defers completion cleanup while a turn is %s", (state) => {
    expect(
      previewRegistrationState(
        item({ phase: "done", activity: { state } as BacklogItem["activity"] }),
        workspace,
      ).state,
    ).toBe("active");
  });
  it.each(["deleting", "destroyed"])("closes explicit workspace %s", (state) => {
    expect(previewRegistrationState(item(), { ...workspace, state }).state).toBe("closed");
  });
  it("does not mistake missing workspace or stale GitHub evidence for completion", () => {
    expect(previewRegistrationState(item(), null).state).toBe("unknown");
    const github = { ...item().story, provider: "github" } as NonNullable<BacklogItem["story"]>;
    expect(previewRegistrationState(item({ story: github, phase: "done" }), workspace).state).toBe(
      "unknown",
    );
    expect(
      previewRegistrationState(
        item({ story: github, phase: "done", issue: { stale: true } as BacklogItem["issue"] }),
        workspace,
      ).state,
    ).toBe("unknown");
    expect(
      previewRegistrationState(
        item({ story: github, phase: "done", issue: { stale: false } as BacklogItem["issue"] }),
        workspace,
      ).state,
    ).toBe("closed");
  });
  it("returns the same scope-bound origin on reopen, without credentials or replay commands", () => {
    const site = {
      id: "site",
      orgId: "org_a",
      projectId: "proj_a",
      workspaceId: "ws_a",
      service: "app",
      origin: "https://one.cloudfront.net",
      surfaceToken: "secret",
    };
    const input = {
      orgId: "org_a",
      projectId: "proj_a",
      storyId: "story_a",
      workspace,
      sites: [site, { ...site, orgId: "other", id: "other" }],
      now: new Date(),
    };
    const active = previewRegistrationSnapshot({ ...input, item: item() });
    const closed = previewRegistrationSnapshot({ ...input, item: item({ phase: "done" }) });
    const reopened = previewRegistrationSnapshot({ ...input, now: new Date(0), item: item() });
    expect(active.sites).toEqual([{ id: "site", service: "app", origin: site.origin }]);
    expect(closed.sites).toEqual(active.sites);
    expect(reopened.revision).toBe(active.revision);
    expect(closed.revision).not.toBe(active.revision);
    expect(JSON.stringify(active)).not.toContain("secret");
  });
});
