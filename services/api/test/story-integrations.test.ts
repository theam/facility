import { describe, expect, it } from "vitest";
import type { BacklogItem } from "../src/stories/backlog.js";
import { lifecycleChanges } from "../src/stories/integration-notifications.js";
import {
  IntegrationStateBody,
  replaceIntegrationNamespace,
} from "../src/stories/integration-state.js";
import { storyLifecycleSnapshot } from "../src/stories/lifecycle.js";

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
  story: { status: "working", completedAt: null, archivedAt: null, deletedAt: null },
  item: {
    phase: "in_progress",
    reason: "started",
    activity: { state: "idle" },
    story: { provider: "github", repositoryId: "repo_a", externalId: "issue:1" },
    issue: { state: "open", number: 1, repositoryId: "repo_a", stale: false },
  } as BacklogItem,
  workspace: { id: "ws_a", state: "sleeping" },
  sites: [site],
  now: new Date(),
};

describe("generic story integration contracts", () => {
  it("reports facts rather than Auth0 registration policy and never leaks credentials", () => {
    const value = storyLifecycleSnapshot({
      ...input,
      sites: [site, { ...site, projectId: "other" }],
    });
    expect(value).toMatchObject({
      issue: { state: "open", stale: false },
      workspace: { state: "sleeping", sites: [{ id: "site", origin: site.origin }] },
    });
    expect(value.workspace?.sites).toHaveLength(1);
    expect(value).not.toHaveProperty("registration");
    expect(JSON.stringify(value)).not.toContain("secret");
  });
  it("empty configured sites and missing workspace are distinct facts, not deletion instructions", () => {
    expect(storyLifecycleSnapshot({ ...input, sites: [] }).workspace?.sites).toEqual([]);
    expect(storyLifecycleSnapshot({ ...input, workspace: null }).workspace).toBeNull();
  });
  it("exposes exact PR source and freshness without requiring issue evidence", () => {
    if (!input.item.story) throw new Error("Fixture requires a story");
    const item = {
      ...input.item,
      story: { ...input.item.story, externalId: "pull-request:2" },
      issue: null,
      phase: "review",
      pullRequest: { repositoryId: "repo_a", number: 2, state: "open", stale: false },
    } as BacklogItem;
    const value = storyLifecycleSnapshot({ ...input, item });
    if (!item.pullRequest) throw new Error("Fixture requires a PR");
    expect(value).toMatchObject({
      repositoryId: "repo_a",
      externalId: "pull-request:2",
      issue: null,
      phase: "review",
      activity: "idle",
      pullRequest: { repositoryId: "repo_a", number: 2, state: "open", stale: false },
    });
    const changed = storyLifecycleSnapshot({
      ...input,
      item: {
        ...item,
        pullRequest: { ...item.pullRequest, stale: true },
      },
    });
    expect(changed.pullRequest?.stale).toBe(true);
    expect(changed.revision).not.toBe(value.revision);
    const initial = lifecycleChanges(
      value,
      "repo_a",
      { storyRevision: null, workspaceRevision: null },
      input.now,
    );
    expect(
      lifecycleChanges(changed, "repo_a", initial, input.now).pending.map((e) => e.type),
    ).toEqual(["story.updated"]);
    const missing = storyLifecycleSnapshot({ ...input, item: { ...item, pullRequest: null } });
    expect(missing.externalId).toBe("pull-request:2");
    expect(missing.pullRequest).toBeNull();
    expect(missing.issue).toBeNull();
  });
  it("content revisions ignore observation time, not GitHub freshness or site changes", () => {
    const value = storyLifecycleSnapshot(input);
    if (!input.item.issue) throw new Error("Fixture requires a GitHub issue");
    expect(storyLifecycleSnapshot({ ...input, now: new Date(0) }).revision).toBe(value.revision);
    expect(storyLifecycleSnapshot({ ...input, sites: [] }).revision).not.toBe(value.revision);
    expect(
      storyLifecycleSnapshot({
        ...input,
        item: { ...input.item, issue: { ...input.item.issue, stale: true } },
      }).revision,
    ).not.toBe(value.revision);
  });
  it("emits only the appropriate coarse notification with fresh event identity on reopen", () => {
    const snapshot = storyLifecycleSnapshot(input);
    if (!snapshot.workspace) throw new Error("Fixture requires a workspace");
    const initial = lifecycleChanges(
      snapshot,
      "repo_a",
      { storyRevision: null, workspaceRevision: null },
      new Date(),
    );
    expect(initial.pending.map((e) => e.type)).toEqual(["story.updated", "workspace.updated"]);
    expect(lifecycleChanges(snapshot, "repo_a", initial, new Date()).pending).toEqual([]);
    expect(
      lifecycleChanges(
        { ...snapshot, workspace: { ...snapshot.workspace, sites: [] } },
        "repo_a",
        initial,
        new Date(),
      ).pending.map((e) => e.type),
    ).toEqual(["workspace.updated"]);
    const closed = lifecycleChanges(
      { ...snapshot, story: { ...snapshot.story, status: "done" } },
      "repo_a",
      initial,
      new Date(),
    );
    expect(closed.pending.map((e) => e.type)).toEqual(["story.updated"]);
    expect(lifecycleChanges(snapshot, "repo_a", closed, new Date()).pending[0]?.eventId).not.toBe(
      initial.pending[0]?.eventId,
    );
  });
  it("replaces one namespace, preserves others and bounds JSON size", () => {
    const original = { auth0: { status: "pending" }, other: { id: 1 } };
    expect(replaceIntegrationNamespace(original, "auth0", { status: "registered" })).toEqual({
      auth0: { status: "registered" },
      other: { id: 1 },
    });
    expect(replaceIntegrationNamespace(original, "auth0", null)).toEqual({ other: { id: 1 } });
    expect(original.auth0.status).toBe("pending");
    expect(() => replaceIntegrationNamespace({}, "auth0", { log: "x".repeat(16384) })).toThrow(
      /16 KiB/,
    );
  });
  it.each([
    "__proto__",
    "constructor",
    "prototype",
    "Auth0",
    "../other",
  ])("rejects unsafe namespace %s", (namespace) => {
    expect(
      IntegrationStateBody.safeParse({ namespace, expected_revision: 0, value: {} }).success,
    ).toBe(false);
  });
  it("requires an explicit revision, object or null, and no extra fields", () => {
    for (const body of [
      { namespace: "auth0", value: {} },
      { namespace: "auth0", value: [], expected_revision: 0 },
      { namespace: "auth0", value: {}, expected_revision: -1 },
      { namespace: "auth0", value: {}, expected_revision: 0, orgId: "other" },
    ])
      expect(IntegrationStateBody.safeParse(body).success).toBe(false);
  });
});
