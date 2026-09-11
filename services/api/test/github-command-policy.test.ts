import { describe, expect, it, vi } from "vitest";
import {
  githubIssueCommandMatches,
  githubSenderCanStartAgent,
  requestedGithubCommands,
} from "../src/agents/github-command-policy.js";
import type { GithubClientFactory } from "../src/github/client.js";

const commands = new Set(["/architect", "/builder"]);
const payload = (body: string) => ({
  action: "created",
  issue: { number: 42, state: "open" },
  comment: { body },
});

describe("GitHub issue command admission", () => {
  it.each([
    "/builder",
    "/builder: implement the accepted plan",
    "Context\n /builder please",
  ])("accepts a single explicit command: %s", (body) => {
    expect(githubIssueCommandMatches("/builder", commands, "issue_comment", payload(body))).toBe(
      true,
    );
  });

  it.each([
    "Please use /builder later",
    "/builder-extra",
    "/architect\n/builder",
    "> /builder",
    "    /builder",
    "\t/builder",
    "```text\n/builder\n```",
    "~~~\n/builder\n~~~",
    "`/builder`",
  ])("does not interpret prose, examples, or ambiguous commands as acceptance: %s", (body) => {
    expect(githubIssueCommandMatches("/builder", commands, "issue_comment", payload(body))).toBe(
      false,
    );
  });

  it("reads a real command after a fenced example", () => {
    expect(requestedGithubCommands("````text\n/architect\n```\n/builder\n````\n/builder")).toEqual(
      new Set(["/builder"]),
    );
  });

  it("refuses assignment replays, edits, closed issues, and PR comments", () => {
    const event = payload("/builder");
    expect(
      githubIssueCommandMatches("/builder", commands, "issues", { ...event, action: "assigned" }),
    ).toBe(false);
    expect(
      githubIssueCommandMatches("/builder", commands, "issue_comment", {
        ...event,
        action: "edited",
      }),
    ).toBe(false);
    expect(
      githubIssueCommandMatches("/builder", commands, "issue_comment", {
        ...event,
        issue: { ...event.issue, state: "closed" },
      }),
    ).toBe(false);
    expect(
      githubIssueCommandMatches("/builder", commands, "issue_comment", {
        ...event,
        issue: { ...event.issue, pull_request: { url: "https://example.test/pulls/42" } },
      }),
    ).toBe(false);
  });
});

describe("authoritative GitHub sender permission", () => {
  function fixture(permission: unknown = "write") {
    const request = vi.fn().mockResolvedValue({ data: { permission } });
    const factory = vi.fn().mockResolvedValue({ request }) as unknown as GithubClientFactory;
    return {
      request,
      factory,
      input: {
        factory,
        installationId: 123,
        owner: "acme",
        repo: "app",
        sender: { type: "User", login: "contributor" },
      },
    };
  }

  it.each([
    "write",
    "admin",
  ])("admits current %s access through the scoped installation", async (permission) => {
    const { request, factory, input } = fixture(permission);
    await expect(githubSenderCanStartAgent(input)).resolves.toBe(true);
    expect(factory).toHaveBeenCalledWith(123);
    expect(request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
      {
        owner: "acme",
        repo: "app",
        username: "contributor",
      },
    );
  });

  it.each([
    "read",
    "triage",
    "none",
    "",
    undefined,
    {},
    true,
  ])("denies insufficient or malformed permission %s", async (permission) => {
    const { input, request } = fixture();
    request.mockResolvedValue({ data: { permission } });
    await expect(githubSenderCanStartAgent(input)).resolves.toBe(false);
  });

  it("rechecks access after revocation and never trusts webhook association", async () => {
    const { request, input } = fixture();
    await expect(githubSenderCanStartAgent(input)).resolves.toBe(true);
    request.mockResolvedValue({ data: { permission: "read" } });
    await expect(
      githubSenderCanStartAgent({
        ...input,
        sender: { ...input.sender, author_association: "OWNER" },
      }),
    ).resolves.toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("admits maintainers through GitHub's base permission mapping, not role_name", async () => {
    const { request, input } = fixture();
    request.mockResolvedValue({ data: { permission: "write", role_name: "maintain" } });
    await expect(githubSenderCanStartAgent(input)).resolves.toBe(true);
    request.mockResolvedValue({ data: { permission: "read", role_name: "maintain" } });
    await expect(githubSenderCanStartAgent(input)).resolves.toBe(false);
  });

  it.each([
    { type: "Bot", login: "automation[bot]" },
    { login: "contributor" },
    { type: "User", login: "../other" },
    null,
  ])("denies bots and malformed senders before calling GitHub", async (sender) => {
    const { factory, input } = fixture();
    await expect(githubSenderCanStartAgent({ ...input, sender })).resolves.toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    401, 403, 404,
  ])("denies revoked credentials or unavailable membership (%s)", async (status) => {
    const { request, input } = fixture();
    request.mockRejectedValue({ status });
    await expect(githubSenderCanStartAgent(input)).resolves.toBe(false);
    const factory = vi.fn().mockRejectedValue({ status });
    await expect(githubSenderCanStartAgent({ ...input, factory })).resolves.toBe(false);
  });

  it("retries provider failures without admitting a turn", async () => {
    const { request, input } = fixture();
    const failure = Object.assign(new Error("GitHub unavailable"), { status: 503 });
    request.mockRejectedValue(failure);
    await expect(githubSenderCanStartAgent(input)).rejects.toBe(failure);
  });

  it("keeps a throttled permission lookup retryable and rechecks current permission", async () => {
    const { request, input } = fixture();
    const failure = { status: 403, response: { headers: { "x-ratelimit-remaining": "0" } } };
    request.mockRejectedValueOnce(failure);
    await expect(githubSenderCanStartAgent(input)).rejects.toBe(failure);
    await expect(githubSenderCanStartAgent(input)).resolves.toBe(true);
    request.mockResolvedValueOnce({ data: { permission: "read" } });
    await expect(githubSenderCanStartAgent(input)).resolves.toBe(false);
  });
});
