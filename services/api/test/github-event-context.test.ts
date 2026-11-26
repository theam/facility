import { describe, expect, it } from "vitest";
import {
  GITHUB_EVENT_CONTEXT_LIMIT,
  type GithubEventContext,
  githubEventContextJson,
} from "../src/agents/github-event-context.js";

const context = (
  event: string,
  objects: Partial<Omit<GithubEventContext, "delivery" | "repository" | "event" | "action">>,
): GithubEventContext => ({
  delivery: "delivery-1",
  repository: "acme/app",
  event,
  action: "created",
  issue: null,
  comment: null,
  pull_request: null,
  review: null,
  check_suite: null,
  workflow_run: null,
  ...objects,
});

// GitHub accepts issue, pull request and comment bodies of up to 65,536 characters.
const longBody = "x".repeat(65_536);

describe("GitHub event context", () => {
  it("keeps short context complete and unchanged", () => {
    const value = context("pull_request_review", {
      review: { id: 7, body: "Please cover the empty input path.", state: "changes_requested" },
    });
    const parsed = JSON.parse(githubEventContextJson(value));
    expect(parsed).toEqual(value);
  });

  it("keeps the triggering comment when the issue body is long", () => {
    const json = githubEventContextJson(
      context("issue_comment", {
        issue: { number: 42, title: "Long report", body: longBody, state: "open" },
        comment: { id: 9, body: "/builder implement the accepted plan" },
      }),
    );
    expect(json.length).toBeLessThanOrEqual(GITHUB_EVENT_CONTEXT_LIMIT);
    const parsed = JSON.parse(json);
    expect(parsed.comment.body).toBe("/builder implement the accepted plan");
    expect(parsed.issue.number).toBe(42);
    expect(parsed.issue.body).toMatch(/characters omitted\]$/);
  });

  it("puts the triggering object first", () => {
    const json = githubEventContextJson(
      context("issue_comment", {
        issue: { number: 42, body: "Issue" },
        comment: { id: 9, body: "Comment" },
      }),
    );
    expect(Object.keys(JSON.parse(json)).slice(0, 6)).toEqual([
      "delivery",
      "repository",
      "event",
      "action",
      "comment",
      "issue",
    ]);
  });

  it("keeps every field of a later object when an earlier body is long", () => {
    const parsed = JSON.parse(
      githubEventContextJson(
        context("workflow_run", {
          pull_request: { number: 5, title: "Fix", body: longBody, state: "open" },
          workflow_run: { id: 3, conclusion: "failure", head_branch: "feature/repair-ci" },
        }),
      ),
    );
    expect(parsed.workflow_run).toEqual({
      id: 3,
      conclusion: "failure",
      head_branch: "feature/repair-ci",
    });
    expect(parsed.pull_request.number).toBe(5);
  });

  it("shortens the triggering body last and still returns complete JSON", () => {
    const json = githubEventContextJson(
      context("issue_comment", {
        issue: { number: 42, body: longBody },
        comment: { id: 9, body: longBody },
      }),
    );
    expect(json.length).toBeLessThanOrEqual(GITHUB_EVENT_CONTEXT_LIMIT);
    const parsed = JSON.parse(json);
    expect(parsed.issue.body).toBe(`… [${longBody.length} characters omitted]`);
    expect(parsed.comment.body.length).toBeGreaterThan(parsed.issue.body.length);
    expect(parsed.comment.body).toMatch(/^x+… \[\d+ characters omitted\]$/);
  });

  it("stays within the limit for every supported event with long text", () => {
    for (const event of [
      "issues",
      "issue_comment",
      "pull_request",
      "pull_request_review",
      "check_suite",
      "workflow_run",
    ]) {
      const json = githubEventContextJson(
        context(event, {
          issue: { number: 1, title: "t".repeat(256), body: longBody },
          comment: { id: 2, body: longBody },
          pull_request: { number: 3, title: "t".repeat(256), body: longBody },
          review: { id: 4, body: longBody, state: "commented" },
        }),
      );
      expect(json.length).toBeLessThanOrEqual(GITHUB_EVENT_CONTEXT_LIMIT);
      expect(() => JSON.parse(json)).not.toThrow();
    }
  });
});
