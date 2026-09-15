import { describe, expect, it } from "vitest";
import {
  canViewPreview,
  equalPreviewSecret,
  nativePreviewOrigin,
  previewChallenge,
  previewTokenHash,
} from "../src/workspaces/native-preview.js";

describe("native preview scope primitives", () => {
  it("grants view permission without requiring command execution", () => {
    for (const permission of ["previews:read", "previews:*", "workspaces:execute", "*"])
      expect(canViewPreview([permission])).toBe(true);
    for (const permission of ["projects:read", "workspaces:read", "previews:write"])
      expect(canViewPreview([permission])).toBe(false);
  });
  it("hashes valid verifiers and rejects malformed inputs", () => {
    expect(previewChallenge("a".repeat(43))).toHaveLength(43);
    expect(previewTokenHash("a".repeat(43))).toHaveLength(64);
    expect(previewChallenge("a".repeat(42))).toBe("invalid");
    expect(previewTokenHash("a".repeat(44))).toBe("invalid");
    expect(equalPreviewSecret("a".repeat(43), "a".repeat(43))).toBe(true);
    for (const candidate of [undefined, "", "a".repeat(42), "b".repeat(43)])
      expect(equalPreviewSecret(candidate, "a".repeat(43))).toBe(false);
  });
  it("accepts only exact provider-discovered native HTTPS origins", () => {
    const endpoint = { service: "web", access: "native", url: "https://preview-one.vercel.run" };
    expect(nativePreviewOrigin([endpoint], "web")).toBe(endpoint.url);
    expect(nativePreviewOrigin([endpoint], "other")).toBeUndefined();
    expect(nativePreviewOrigin([{ ...endpoint, access: undefined }], "web")).toBeUndefined();
    for (const url of [
      "http://preview-one.vercel.run",
      "https://preview-one.vercel.run/",
      "https://preview-one.vercel.run/callback",
      "https://preview-one.vercel.run.evil.test",
      "https://user@preview-one.vercel.run",
      "https://a.b.vercel.run",
      "https://preview-one.vercel.run:1234",
    ])
      expect(nativePreviewOrigin([{ ...endpoint, url }], "web")).toBeUndefined();
  });
});
