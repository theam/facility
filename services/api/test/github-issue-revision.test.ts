import { describe, expect, it } from "vitest";
import {
  githubIssueRevisionContext,
  githubIssueRevisionSha256,
} from "../src/github/issue-revision.js";
import { githubRequestContext } from "../src/github/router.js";

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

describe("GitHub issue revision producers agree", () => {
  // Two different producers feed the same digest. At Architect dispatch the
  // router stores `githubRequestContext(...)` in `run.trigger.request`, and
  // `ensureArchitectPlanAcceptance` seals its digest into the proposal payload.
  // At Builder dispatch `resolveBuilderPlanFreshnessForProposal` re-derives the
  // digest from a live `GET /issues/:number` read. A project on
  // `builderPlanPolicy: "required"` compares the two, so they have to agree
  // whenever the issue itself did not change.
  const issueWithBody = (body: string | null) => ({
    number: 204,
    title: "Keep sources consistent",
    body,
    state: "open",
    user: { login: "requester" },
    labels: [{ name: "frontend" }, "delivery"],
    html_url: "https://github.test/theam/aifindr-ui/issues/116",
  });
  type LiveIssue = ReturnType<typeof issueWithBody>;

  /** What Facility sealed into the proposal at Architect time. */
  const storedDigest = (issue: LiveIssue) =>
    githubIssueRevisionSha256(githubRequestContext({ issue }, []));

  /** What the Builder gate observes from GitHub at dispatch time. */
  const liveDigest = (issue: LiveIssue) =>
    githubIssueRevisionSha256(githubIssueRevisionContext(issue, []));

  it.each([
    ["absent since creation", null],
    ["cleared after creation", ""],
    ["spaces only", "   "],
    ["a newline only", "\n"],
    ["CRLF only", "\r\n"],
    ["ordinary prose", "Apply the same rule on every surface."],
  ])("digests an unchanged issue whose body is %s identically on both sides", (_case, body) => {
    const issue = issueWithBody(body);
    expect(liveDigest(issue)).toBe(storedDigest(issue));
  });

  it("still detects an issue that gained or lost material body text", () => {
    const empty = issueWithBody("");
    const filled = issueWithBody("A changed scope.");
    expect(liveDigest(filled)).not.toBe(storedDigest(empty));
    expect(liveDigest(empty)).not.toBe(storedDigest(filled));
  });
});
