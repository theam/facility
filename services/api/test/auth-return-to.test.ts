import { describe, expect, it } from "vitest";
import { safeReturnTo } from "../src/auth/return-to.js";

const preview = `/api/workspace-preview-login/ws_${"a".repeat(32)}/web?challenge=${"b".repeat(43)}`;
describe("Facility login continuations", () => {
  it("allows only the existing OAuth interaction and exact native preview continuation", () => {
    for (const path of ["/", "/oauth/interaction/test_123", preview])
      expect(safeReturnTo(path)).toBe(path);
  });
  it.each([
    undefined,
    "https://evil.test/",
    "//evil.test/",
    `/\\evil.test${preview}`,
    "/projects",
    preview.replace("ws_", "proj_"),
    preview.replace("/web?", "/../auth/logout?"),
    preview.replace("/web?", "/web%2fother?"),
    preview.slice(0, -1),
    `${preview}&next=https://evil.test`,
    `${preview}&challenge=${"c".repeat(43)}`,
    `${preview}#fragment`,
    `${preview}\n`,
  ])("rejects malformed or unrelated destination %s", (path) => {
    expect(safeReturnTo(path)).toBe("/");
  });
});
