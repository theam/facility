import { describe, expect, it } from "vitest";
import { shouldRefreshPullRequestCi } from "../src/github/mirror.js";
import { githubRateLimitRetryAt } from "../src/github/rate-limit.js";

describe("GitHub retry deadlines", () => {
  const now = Date.parse("2026-09-01T12:00:00Z");
  it("honors the hourly reset without treating a rate limit as permission denial", () => {
    const reset = now / 1_000 + 3_000;
    expect(
      githubRateLimitRetryAt(
        {
          status: 403,
          response: {
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(reset),
              "retry-after": "120",
            },
          },
        },
        now,
      )?.getTime(),
    ).toBe(reset * 1_000 + 1_000);
  });
  it("honors secondary Retry-After and falls back for missing or malformed deadlines", () => {
    expect(
      githubRateLimitRetryAt(
        { status: 403, response: { headers: { "retry-after": "120" } } },
        now,
      )?.getTime(),
    ).toBe(now + 120_000);
    for (const headers of [
      {},
      { "retry-after": "NaN" },
      { "retry-after": "-1" },
      { "retry-after": "99999999999999999999999" },
    ]) {
      expect(githubRateLimitRetryAt({ status: 429, response: { headers } }, now)?.getTime()).toBe(
        now + 60_000,
      );
    }
    expect(
      githubRateLimitRetryAt(
        {
          status: 403,
          response: { data: { message: "You have exceeded a secondary rate limit." } },
        },
        now,
      )?.getTime(),
    ).toBe(now + 60_000);
  });

  it("bounds parseable but implausible provider dates instead of stranding the receipt", () => {
    for (const headers of [
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "99999999999" },
      { "retry-after": "99999999999" },
    ]) {
      expect(githubRateLimitRetryAt({ status: 403, response: { headers } }, now)?.getTime()).toBe(
        now + 86_400_000,
      );
    }
    expect(
      githubRateLimitRetryAt(
        { status: 429, response: { headers: { "retry-after": "7200" } } },
        now,
      )?.getTime(),
    ).toBe(now + 7_200_000);
  });
  it.each([
    null,
    { status: 403 },
    { status: 403, response: { data: { message: "Resource not accessible by integration" } } },
    { status: 401, response: { headers: { "retry-after": "120" } } },
    { status: 404 },
    { status: 503 },
  ])("does not reclassify unrelated errors: %s", (error) => {
    expect(githubRateLimitRetryAt(error, now)).toBeUndefined();
  });
});

describe("historical pull request CI polling", () => {
  const terminal = {
    state: "closed",
    headSha: "a",
    ciHeadSha: "a",
    ciState: "success",
    githubUpdatedAt: new Date("2026-09-01"),
    ciUpdatedAt: new Date("2026-09-02"),
  };
  it("retains current terminal CI for unchanged closed and merged pulls", () => {
    expect(shouldRefreshPullRequestCi(terminal)).toBe(false);
    expect(shouldRefreshPullRequestCi({ ...terminal, state: "merged", ciState: "failure" })).toBe(
      false,
    );
  });
  it.each([
    { state: "open" },
    { ciHeadSha: "b" },
    { ciState: "pending" },
    { ciState: null },
    { ciUpdatedAt: null },
    { githubUpdatedAt: new Date("2026-09-03") },
  ])("refreshes active, changed, missing, or unfinished CI: %s", (change) => {
    expect(shouldRefreshPullRequestCi({ ...terminal, ...change })).toBe(true);
  });
});
