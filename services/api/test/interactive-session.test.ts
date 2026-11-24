import { describe, expect, it } from "vitest";
import { interactiveSessionCookie } from "../src/auth/interactive-session.js";

describe("interactiveSessionCookie", () => {
  it("recognizes only the authenticated user's cookie without bearer authentication", () => {
    const principal = { type: "user" as const };
    const cookies = { facility_session: "fixture-only" };
    expect(interactiveSessionCookie({ principal, cookies, headers: {} })).toBe("fixture-only");
    expect(
      interactiveSessionCookie({
        principal,
        cookies,
        headers: { authorization: "Bearer fixture" },
      }),
    ).toBeUndefined();
    expect(interactiveSessionCookie({ principal, cookies: {}, headers: {} })).toBeUndefined();
    expect(interactiveSessionCookie({ cookies, headers: {} })).toBeUndefined();
    expect(
      interactiveSessionCookie({ principal: { type: "key" }, cookies, headers: {} }),
    ).toBeUndefined();
  });
});
