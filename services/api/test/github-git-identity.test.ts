import { describe, expect, it, vi } from "vitest";
import { createGithubGitIdentityLoader } from "../src/github/git-identity.js";

function fixture(user = { id: 12345, login: "my-app[bot]", type: "Bot" }) {
  const source = {
    app: vi.fn(async () => ({ slug: "my-app" })),
    user: vi.fn(async (_login: string, _token: string) => user),
  };
  return { source, load: createGithubGitIdentityLoader(source) };
}

describe("GitHub App commit identity", () => {
  it("uses the authenticated App's bot ID and login, sharing successful lookups", async () => {
    const { source, load } = fixture();
    const expected = {
      name: "my-app[bot]",
      email: "12345+my-app[bot]@users.noreply.github.com",
    };
    await expect(
      Promise.all([load("installation-token"), load("installation-token")]),
    ).resolves.toEqual([expected, expected]);
    await expect(load("installation-token")).resolves.toEqual(expected);
    expect(source.app).toHaveBeenCalledTimes(1);
    expect(source.user).toHaveBeenCalledExactlyOnceWith("my-app[bot]", "installation-token");
  });

  it.each([
    "",
    "../another-app",
    "app\nname",
    "app@evil.test",
  ])("rejects malformed App slug %j before looking up a user", async (slug) => {
    const { source, load } = fixture();
    source.app.mockResolvedValue({ slug });
    await expect(load("installation-token")).rejects.toThrow("valid bot slug");
    expect(source.user).not.toHaveBeenCalled();
  });

  it.each([
    { id: 12345, login: "my-app[bot]", type: "User" },
    { id: 12345, login: "another-app[bot]", type: "Bot" },
    { id: 0, login: "my-app[bot]", type: "Bot" },
    { id: -1, login: "my-app[bot]", type: "Bot" },
    { id: 1.5, login: "my-app[bot]", type: "Bot" },
    { id: Number.MAX_SAFE_INTEGER + 1, login: "my-app[bot]", type: "Bot" },
  ])("rejects an unverified bot record: %j", async (user) => {
    await expect(fixture(user).load("installation-token")).rejects.toThrow("could not be verified");
  });

  it.each([
    401, 403, 404, 429,
  ])("fails closed on HTTP %s and allows a later retry", async (status) => {
    const { source, load } = fixture();
    const error = Object.assign(new Error("GitHub lookup failed"), { status });
    source.user.mockRejectedValueOnce(error);
    await expect(load("installation-token")).rejects.toBe(error);
    await expect(load("installation-token")).resolves.toMatchObject({ name: "my-app[bot]" });
    expect(source.app).toHaveBeenCalledTimes(2);
  });
});
