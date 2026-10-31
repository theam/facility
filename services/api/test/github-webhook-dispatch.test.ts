import { describe, expect, it } from "vitest";
import { githubWebhookNeedsDispatch } from "../src/routes/webhooks.js";

describe("GitHub webhook duplicate delivery recovery", () => {
  it("only re-enqueues unprocessed worker events", () => {
    expect(githubWebhookNeedsDispatch(null, "issues", { action: "opened" })).toBe(true);
    expect(githubWebhookNeedsDispatch(new Date(), "issues", { action: "opened" })).toBe(false);
    expect(githubWebhookNeedsDispatch(null, "workflow_run", { action: "requested" })).toBe(false);
    expect(githubWebhookNeedsDispatch(null, "issues", null)).toBe(false);
  });
});
