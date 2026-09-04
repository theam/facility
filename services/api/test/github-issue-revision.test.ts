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

  it("ignores current and legacy Facility queued-run acknowledgements from bots", () => {
    const baseline = githubIssueRevisionSha256(githubIssueRevisionContext(issue, comments));
    const queueComments = ["/architect", "release planner", "architect.v2"].flatMap(
      (agentName, index) => {
        const legacyRunId = `run_legacy${String(index)}`;
        const markedRunId = `run_marked${String(index)}`;
        return [
          {
            id: 5 + index * 2,
            author: "facility-agent[bot]",
            authorType: "Bot",
            body: `Facility queued ${agentName} run ${legacyRunId} (triggered from the control plane).`,
            createdAt: `2026-08-26T10:0${String(4 + index * 2)}:00Z`,
            url: `https://github.test/comments/${String(5 + index * 2)}`,
          },
          {
            id: 6 + index * 2,
            author: "facility-agent[bot]",
            authorType: "Bot",
            body: `<!-- facility-run-queued run=${markedRunId} -->\nFacility queued ${agentName} run ${markedRunId} (triggered through an approved MCP proposal).`,
            createdAt: `2026-08-26T10:0${String(5 + index * 2)}:00Z`,
            url: `https://github.test/comments/${String(6 + index * 2)}`,
          },
        ];
      },
    );
    const legacyQueueComment = queueComments[0];
    const markedQueueComment = queueComments[1];
    if (!legacyQueueComment || !markedQueueComment) {
      throw new Error("queue comment fixtures are incomplete");
    }
    expect(
      githubIssueRevisionSha256(githubIssueRevisionContext(issue, [...comments, ...queueComments])),
    ).toBe(baseline);

    expect(
      githubIssueRevisionSha256(
        githubIssueRevisionContext(issue, [
          ...comments,
          { ...legacyQueueComment, authorType: "User" },
        ]),
      ),
    ).not.toBe(baseline);
    expect(
      githubIssueRevisionSha256(
        githubIssueRevisionContext(issue, [
          ...comments,
          { ...legacyQueueComment, body: `${legacyQueueComment.body} Also change the API.` },
        ]),
      ),
    ).not.toBe(baseline);
    expect(
      githubIssueRevisionSha256(
        githubIssueRevisionContext(issue, [
          ...comments,
          { ...markedQueueComment, body: `${markedQueueComment.body} Also change the API.` },
        ]),
      ),
    ).not.toBe(baseline);
    expect(
      githubIssueRevisionSha256(
        githubIssueRevisionContext(issue, [
          ...comments,
          {
            ...markedQueueComment,
            body: "<!-- facility-run-queued run=run_expected -->\nFacility queued /architect run run_other (triggered from the control plane).",
          },
        ]),
      ),
    ).not.toBe(baseline);
    expect(
      githubIssueRevisionSha256(
        githubIssueRevisionContext(issue, [
          ...comments,
          {
            ...markedQueueComment,
            body: "<!-- facility-run-queued run=run_empty -->\nFacility queued  run run_empty (triggered from the control plane).",
          },
        ]),
      ),
    ).not.toBe(baseline);
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
