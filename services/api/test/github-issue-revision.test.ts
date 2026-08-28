import { describe, expect, it } from "vitest";
import {
  githubIssueRevisionContext,
  githubIssueRevisionSha256,
} from "../src/github/issue-revision.js";

describe("GitHub issue revision", () => {
  const issue = {
    title: "Keep sources consistent",
    body: "Apply the same rule on every surface.",
    state: "open",
    user: { login: "requester" },
    labels: [{ name: "frontend" }, "delivery"],
    html_url: "https://github.test/theam/aifindr-ui/issues/116",
  };
  const comments = [
    {
      id: 1,
      author: "requester",
      authorType: "User",
      body: "/architect\nInclude the permission fix.",
      createdAt: "2026-08-26T10:00:00Z",
      url: "https://github.test/comments/1",
    },
    {
      id: 2,
      author: "facility-agent[bot]",
      authorType: "Bot",
      body: "<!-- facility-run-progress run=run_1 -->\n_Last updated: now_",
      createdAt: "2026-08-26T10:01:00Z",
      url: "https://github.test/comments/2",
    },
    {
      id: 3,
      author: "maintainer",
      authorType: "User",
      body: "/builder",
      createdAt: "2026-08-26T10:02:00Z",
      url: "https://github.test/comments/3",
    },
    {
      id: 4,
      author: "facility-agent[bot]",
      authorType: "Bot",
      body: "<!-- facility:architect-plan:run_1:prop_1 -->\nPublished plan",
      createdAt: "2026-08-26T10:03:00Z",
      url: "https://github.test/comments/4",
    },
  ];

  it("is stable across label ordering and Facility or approval-only comments", () => {
    const [requestComment, progressComment, approvalComment] = comments;
    if (!requestComment || !progressComment || !approvalComment) {
      throw new Error("issue revision comments fixture is incomplete");
    }
    const baseline = githubIssueRevisionSha256(githubIssueRevisionContext(issue, comments));
    const updated = githubIssueRevisionSha256(
      githubIssueRevisionContext({ ...issue, labels: ["delivery", { name: "frontend" }] }, [
        requestComment,
        { ...progressComment, body: "<!-- facility-run-progress run=run_1 -->\nchanged" },
        { ...approvalComment, body: " /codex-builder! " },
      ]),
    );
    expect(updated).toBe(baseline);
  });

  it("changes for material issue, state, or comment edits", () => {
    const baseline = githubIssueRevisionSha256(githubIssueRevisionContext(issue, comments));
    expect(
      githubIssueRevisionSha256(
        githubIssueRevisionContext(issue, [
          ...comments,
          {
            id: 5,
            author: "maintainer",
            authorType: "User",
            body: "/builder and also change the API contract",
            createdAt: "2026-08-26T10:04:00Z",
            url: "https://github.test/comments/5",
          },
        ]),
      ),
    ).not.toBe(baseline);
    expect(
      githubIssueRevisionSha256(
        githubIssueRevisionContext({ ...issue, state: "closed" }, comments),
      ),
    ).not.toBe(baseline);
    expect(
      githubIssueRevisionSha256(
        githubIssueRevisionContext({ ...issue, body: "A changed scope." }, comments),
      ),
    ).not.toBe(baseline);
  });
});
