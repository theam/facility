import { describe, expect, it } from "vitest";
import {
  AVATAR_MODE_ENV,
  avatarMode,
  avatarSrcFor,
  principalAvatarSrc,
} from "../lib/avatar-policy";

describe("avatar delivery policy", () => {
  it("defaults to same-origin proxying and treats unknown values as off", () => {
    expect(avatarMode(undefined)).toBe("proxy");
    expect(avatarMode("")).toBe("proxy");
    expect(avatarMode("proxy")).toBe("proxy");
    expect(avatarMode(" PROXY ")).toBe("proxy");
    expect(avatarMode("off")).toBe("off");
    // Fail closed: anything unrecognized disables remote images entirely.
    for (const hostile of ["direct", "bogus", "https://evil.example"]) {
      expect(avatarMode(hostile)).toBe("off");
    }
  });

  it(`reads ${AVATAR_MODE_ENV} at the boundary between proxy and off`, () => {
    // The env var is inlined at build time; these pin the accepted values.
    expect(avatarMode("proxy")).toBe("proxy");
    expect(avatarMode("off")).toBe("off");
  });

  describe("assignee avatars", () => {
    it("serves every login from this deployment's own origin", () => {
      const src = avatarSrcFor("octocat");
      expect(src).toBe("/api/avatars/u/octocat");
      expect(new URL(src ?? "", "https://app.example").host).toBe("app.example");
    });

    it("encodes the login so it cannot shape or escape the proxy path", () => {
      expect(avatarSrcFor("../admin")).toBe("/api/avatars/u/..%2Fadmin");
      expect(avatarSrcFor("a/b?c")).toBe("/api/avatars/u/a%2Fb%3Fc");
    });

    it("offers nothing to draw for a blank login", () => {
      expect(avatarSrcFor("")).toBeNull();
      expect(avatarSrcFor("   ")).toBeNull();
    });

    it("draws no image at all when avatars are disabled", () => {
      expect(avatarSrcFor("octocat", "off")).toBeNull();
    });
  });

  describe("principal avatars", () => {
    it("rewrites known GitHub avatar URLs onto the same-origin proxy", () => {
      expect(
        principalAvatarSrc("https://avatars.githubusercontent.com/u/583231?v=4", "octocat"),
      ).toBe("/api/avatars/id/583231");
      expect(principalAvatarSrc("https://github.com/octocat.png", "someone-else")).toBe(
        "/api/avatars/u/octocat",
      );
    });

    it("never points the browser at an unreviewed host from a stored URL", () => {
      const hostile = [
        "http://avatars.githubusercontent.com/u/583231?v=4",
        "https://evil.example/u/583231",
        "https://avatars.githubusercontent.com.evil.example/u/583231",
        "https://github.com/octocat/avatar",
        "not a url",
      ];
      for (const url of hostile) {
        const src = principalAvatarSrc(url, "octocat");
        expect(src).toBe("/api/avatars/u/octocat");
      }
    });

    it("falls back to the login when the stored URL is absent", () => {
      expect(principalAvatarSrc(null, "octocat")).toBe("/api/avatars/u/octocat");
      expect(principalAvatarSrc(undefined, " octocat ")).toBe("/api/avatars/u/octocat");
    });

    it("draws nothing when there is neither a usable URL nor a login", () => {
      expect(principalAvatarSrc(null, null)).toBeNull();
      expect(principalAvatarSrc(null, "")).toBeNull();
    });

    it("draws nothing at all when avatars are disabled, whatever is stored", () => {
      expect(
        principalAvatarSrc("https://avatars.githubusercontent.com/u/583231?v=4", "octocat", "off"),
      ).toBeNull();
      expect(principalAvatarSrc(null, "octocat", "off")).toBeNull();
    });
  });
});
