import { describe, expect, it } from "vitest";
import { GITHUB_READ_ONLY_PERMISSIONS } from "../src/github/client.js";
import { reviewerEnvironment } from "../src/turns/dispatcher.js";

describe("read-only Reviewer turn", () => {
  it("keeps engine credentials and removes the project's other secrets", () => {
    expect(
      reviewerEnvironment(
        {
          ANTHROPIC_API_KEY: "engine",
          VERCEL_TOKEN: "deploy",
          DATABASE_URL: "service",
          NODE_ENV: "test",
          GH_TOKEN: "read-only-token",
        },
        ["ANTHROPIC_API_KEY", "VERCEL_TOKEN", "DATABASE_URL"],
      ),
    ).toEqual({ ANTHROPIC_API_KEY: "engine", NODE_ENV: "test", GH_TOKEN: "read-only-token" });
  });

  it("asks GitHub only for read permissions", () => {
    expect(Object.values(GITHUB_READ_ONLY_PERMISSIONS).every((level) => level === "read")).toBe(
      true,
    );
  });
});
