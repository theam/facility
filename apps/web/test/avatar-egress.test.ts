import { describe, expect, it } from "vitest";
import {
  type BucketLimit,
  isFresh,
  newBucket,
  overCapacity,
  sessionTokenFrom,
  spendToken,
} from "../lib/avatar-egress";
import { isAllowedAvatarUpstream, nextAvatarRedirect } from "../lib/avatar-proxy";

describe("reading the viewer's session token", () => {
  it("finds the session cookie among others", () => {
    expect(sessionTokenFrom("theme=dark; facility_session=abc123; last_project=p_1")).toBe(
      "abc123",
    );
    expect(sessionTokenFrom("facility_session=abc123")).toBe("abc123");
  });

  it("reports no token rather than an empty one", () => {
    expect(sessionTokenFrom(null)).toBeNull();
    expect(sessionTokenFrom("")).toBeNull();
    expect(sessionTokenFrom("theme=dark")).toBeNull();
    expect(sessionTokenFrom("facility_session=")).toBeNull();
    expect(sessionTokenFrom("facility_session")).toBeNull();
  });

  it("does not mistake a cookie whose name merely ends in the session name", () => {
    expect(sessionTokenFrom("not_facility_session=abc123")).toBeNull();
    expect(sessionTokenFrom("xfacility_session=abc; facility_session=real")).toBe("real");
  });
});

describe("the per-viewer upstream allowance", () => {
  const limit: BucketLimit = { burst: 3, perMinute: 60 };

  it("spends one token per fetch and then denies", () => {
    let state = newBucket(limit, 0);
    for (const expected of [true, true, true, false]) {
      const result = spendToken(state, limit, 0);
      expect(result.allowed).toBe(expected);
      state = result.state;
    }
  });

  it("refills over time, up to the burst ceiling", () => {
    let state = newBucket(limit, 0);
    for (let i = 0; i < 3; i += 1) state = spendToken(state, limit, 0).state;
    expect(spendToken(state, limit, 0).allowed).toBe(false);

    // One token per second at 60/minute.
    expect(spendToken(state, limit, 1_000).allowed).toBe(true);

    // An idle hour cannot bank more than the burst.
    const rested = spendToken(state, limit, 3_600_000);
    expect(rested.allowed).toBe(true);
    expect(rested.state.tokens).toBe(limit.burst - 1);
  });

  it("treats a clock that goes backwards as no elapsed time", () => {
    const state = { tokens: 0, updatedAt: 10_000 };
    expect(spendToken(state, limit, 0).allowed).toBe(false);
  });
});

describe("bounding a store", () => {
  it("reports how many entries must go", () => {
    expect(overCapacity(3, 10)).toBe(0);
    expect(overCapacity(10, 10)).toBe(0);
    expect(overCapacity(13, 10)).toBe(3);
  });

  it("treats an entry as stale at its expiry instant", () => {
    expect(isFresh({ expiresAt: 100 }, 99)).toBe(true);
    expect(isFresh({ expiresAt: 100 }, 100)).toBe(false);
    expect(isFresh({ expiresAt: 100 }, 101)).toBe(false);
  });
});

describe("vetting an upstream URL", () => {
  it("permits only the two GitHub avatar hosts over https", () => {
    expect(isAllowedAvatarUpstream("https://github.com/octocat.png?size=40")).toBe(true);
    expect(isAllowedAvatarUpstream("https://avatars.githubusercontent.com/u/1?v=4")).toBe(true);
  });

  it("refuses another host, another scheme, and a lookalike host", () => {
    for (const hostile of [
      "http://github.com/octocat.png",
      "https://evil.example/octocat.png",
      "https://github.com.evil.example/octocat.png",
      "https://evilgithub.com/octocat.png",
      "https://user:pass@evil.example/x.png",
      "file:///etc/passwd",
      "not a url",
      "https://127.0.0.1/x.png",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      expect(isAllowedAvatarUpstream(hostile), hostile).toBe(false);
    }
  });
});

describe("deciding a redirect hop", () => {
  const from = "https://github.com/octocat.png?size=40";

  it("is not a redirect when the status is not one", () => {
    expect(nextAvatarRedirect(200, null, from)).toBeNull();
    expect(nextAvatarRedirect(404, null, from)).toBeNull();
    // A Location on a non-redirect is not a hop either.
    expect(nextAvatarRedirect(200, "https://evil.example/x.png", from)).toBeNull();
  });

  it("follows a hop that stays on a permitted host", () => {
    expect(
      nextAvatarRedirect(302, "https://avatars.githubusercontent.com/u/583231?v=4", from),
    ).toEqual({ kind: "follow", url: "https://avatars.githubusercontent.com/u/583231?v=4" });
  });

  it("resolves a relative Location against the URL that produced it", () => {
    expect(nextAvatarRedirect(301, "/other.png", from)).toEqual({
      kind: "follow",
      url: "https://github.com/other.png",
    });
  });

  it("denies a hop off the permitted hosts, however it is written", () => {
    for (const [status, location] of [
      [302, "https://evil.example/x.png"],
      [301, "//evil.example/x.png"],
      [303, "http://github.com/octocat.png"],
      [307, "https://github.com.evil.example/x.png"],
      [308, "file:///etc/passwd"],
      [302, null],
      [302, ""],
    ] as const) {
      expect(nextAvatarRedirect(status, location, from), `${status} ${location}`).toEqual({
        kind: "deny",
      });
    }
  });

  it("denies every redirect status equally", () => {
    for (const status of [301, 302, 303, 307, 308]) {
      expect(nextAvatarRedirect(status, "https://evil.example/x.png", from)).toEqual({
        kind: "deny",
      });
    }
  });
});
