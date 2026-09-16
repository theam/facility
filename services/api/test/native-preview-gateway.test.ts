import { describe, expect, it } from "vitest";

const gatewayModule = new URL("../../../runner/facility-preview-gateway.mjs", import.meta.url).href;
const { previewReturnTo, sealPreviewLogin, openPreviewLogin } = await import(gatewayModule);
const secret = "g".repeat(43),
  verifier = "v".repeat(43);

describe("gateway browser-bound login state", () => {
  it("preserves application paths and queries without including them in the Facility redirect", () => {
    for (const path of [
      "/",
      "/projects/123?tab=files",
      "/files/My%20File.pdf?download=1",
      "/auth/callback?code=app&state=x%2Fy",
    ]) {
      const cookie = sealPreviewLogin(secret, verifier, path, 1000);
      expect(openPreviewLogin(secret, cookie, 2000)).toEqual({ verifier, returnTo: path });
    }
  });
  it.each([
    "https://evil.test/",
    "//evil.test/",
    "/\\evil.test/",
    "/%2f/evil.test/",
    "/%5cevil.test/",
    "/.facility/callback?code=x",
    "/a/../.facility/callback",
    "/%2efacility/callback",
    "/%0d%0aLocation:evil",
    "/foo\nbar",
    "/foo#fragment",
    `/${"a".repeat(2048)}`,
  ])("does not redirect to unsafe or reserved destination %s", (path) => {
    expect(previewReturnTo(path)).toBe("/");
  });
  it("rejects tampered, expired, wrong-gateway and malformed state", () => {
    const cookie = sealPreviewLogin(secret, verifier, "/private?tab=2", 1000);
    expect(() => openPreviewLogin(secret, cookie, 121000)).toThrow();
    expect(() => openPreviewLogin("other".repeat(10), cookie, 2000)).toThrow();
    expect(() =>
      openPreviewLogin(secret, cookie.replace(verifier, "b".repeat(43)), 2000),
    ).toThrow();
    const parts = cookie.split(".");
    parts[1] = Buffer.from(
      JSON.stringify({ returnTo: "https://evil.test", expiresAt: 121000 }),
    ).toString("base64url");
    expect(() => openPreviewLogin(secret, parts.join("."), 2000)).toThrow();
    for (const bad of ["", verifier, `${cookie}.extra`, "x".repeat(4001)])
      expect(() => openPreviewLogin(secret, bad, 2000)).toThrow();
  });
});
