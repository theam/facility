import type { StoryCompletion } from "@facility/core";
import { describe, expect, it } from "vitest";
import {
  completionCloseObservation,
  storyCompletionNextAction,
  storyDeliveryNotice,
} from "../src/stories/completion.js";

const scope = { orgId: "org_one", projectId: "proj_one", storyId: "story_one" };

function projection(
  changes: {
    candidate?: Partial<StoryCompletion["candidate"]>;
    integration?: Partial<StoryCompletion["integration"]>;
    source?: Partial<StoryCompletion["source"]>;
    completion?: Partial<StoryCompletion["completion"]>;
  } = {},
): StoryCompletion {
  return {
    schemaVersion: 1,
    ...scope,
    generatedAt: "2026-10-22T12:00:00.000Z",
    candidate: {
      revision: "a".repeat(64),
      state: "recorded",
      requiredCount: 2,
      mergedCount: 2,
      allRequiredMerged: true,
      ...changes.candidate,
    },
    integration: {
      policy: { mode: "none", repository: null },
      candidateRevision: null,
      state: "not_required",
      attempt: 0,
      eventId: null,
      repository: null,
      summary: null,
      evidenceUrl: null,
      errorCode: null,
      recordedBy: null,
      recordedAt: null,
      ...changes.integration,
    },
    source: {
      kind: "github_issue",
      state: "open",
      url: "https://example.test/issues/1",
      ...changes.source,
    },
    completion: {
      candidateRevision: null,
      state: "not_requested",
      attempt: 0,
      errorCode: null,
      requestedBy: null,
      requestedAt: null,
      completedAt: null,
      ...changes.completion,
    },
    notices: { in_app: true },
    retention: {
      workspaceState: "running",
      computeSuspended: false,
      storageRetained: true,
      archived: false,
      deleted: false,
    },
    nextAction: "request_completion",
  };
}

function action(value: StoryCompletion) {
  return storyCompletionNextAction({
    candidate: value.candidate,
    integration: value.integration,
    source: value.source,
    completion: value.completion,
  });
}

describe("story completion projection", () => {
  it("keeps declaration, merge, integration and completion as separate next actions", () => {
    expect(action(projection({ candidate: { revision: null, state: "scope_incomplete" } }))).toBe(
      "declare_delivery",
    );
    expect(action(projection({ candidate: { mergedCount: 0, allRequiredMerged: false } }))).toBe(
      "review",
    );
    expect(action(projection({ candidate: { mergedCount: 1, allRequiredMerged: false } }))).toBe(
      "merge",
    );
    expect(
      action(
        projection({
          integration: {
            policy: { mode: "manual", repository: null },
            state: "pending",
          },
        }),
      ),
    ).toBe("record_integration");
    expect(
      action(
        projection({
          integration: {
            policy: { mode: "repository_dispatch", repository: "acme/app" },
            state: "dispatched",
          },
        }),
      ),
    ).toBe("wait_integration");
    expect(action(projection({ integration: { state: "failed" } }))).toBe(
      "inspect_integration_failure",
    );
    expect(action(projection())).toBe("request_completion");
    expect(action(projection({ completion: { state: "pending" } }))).toBe("wait_completion");
    expect(action(projection({ completion: { state: "failed" } }))).toBe("retry_completion");
    expect(
      action(
        projection({
          source: { state: "closed" },
          completion: { state: "completed" },
        }),
      ),
    ).toBe("completed");
  });

  it("uses stable semantic notice identities and changes them for a new failure occurrence", () => {
    const ready = projection();
    const first = storyDeliveryNotice(scope, ready);
    expect(first).toMatchObject({
      kind: "delivery_completion",
      title: "Complete the source issue",
    });
    expect(storyDeliveryNotice(scope, ready)?.id).toBe(first?.id);

    const failed = projection({
      completion: { state: "failed", attempt: 1, errorCode: "github_http_503" },
    });
    failed.nextAction = "retry_completion";
    const retried = projection({
      completion: { state: "failed", attempt: 2, errorCode: "github_http_503" },
    });
    retried.nextAction = "retry_completion";
    expect(storyDeliveryNotice(scope, failed)?.id).not.toBe(
      storyDeliveryNotice(scope, retried)?.id,
    );
    const pending = projection({ completion: { state: "pending" } });
    pending.nextAction = "wait_completion";
    expect(storyDeliveryNotice(scope, pending)).toBeNull();
  });
});

describe("completion close observations", () => {
  it("orders the result by updated_at while preserving the closure date", () => {
    expect(
      completionCloseObservation(
        {
          number: 7,
          state: "closed",
          closed_at: "2026-10-26T10:00:00Z",
          updated_at: "2026-10-26T10:01:00Z",
        },
        7,
      ),
    ).toEqual({
      closedAt: new Date("2026-10-26T10:00:00Z"),
      updatedAt: new Date("2026-10-26T10:01:00Z"),
    });
  });
  it.each([
    null,
    { number: 8, state: "closed" },
    { number: 7, state: "open" },
    { number: 7, state: "closed", updated_at: "invalid" },
    {
      number: 7,
      state: "closed",
      closed_at: "2026-10-26T10:01:00Z",
      updated_at: "2026-10-26T10:00:00Z",
    },
  ])("rejects an unverifiable close result: %j", (data) => {
    expect(() => completionCloseObservation(data, 7)).toThrow("github_completion_unverified");
  });
});
