import { describe, expect, it } from "vitest";
import { assertPreviewOriginSurface } from "../src/origin-isolation.js";
import {
  siteRequestHeaders,
  siteResponseCookies,
} from "../src/routes/v1/workspace-preview-sites.js";
import type { AppConfig } from "../src/types.js";
import {
  assertSiteSession,
  parsePreviewSites,
  SITE_COOKIE,
} from "../src/workspaces/preview-sites.js";

const site = {
  id: "app",
  orgId: "org_a",
  projectId: "proj_a",
  workspaceId: "ws_a",
  service: "app",
  origin: "https://one.cloudfront.net",
  surfaceToken: "a".repeat(43),
};
const config = {
  publicUrl: "https://api.example.com",
  webUrl: "https://example.com",
  previewUrl: "https://legacy.cloudfront.net",
  previewSurfaceToken: "l".repeat(43),
  previewSites: [site],
} as AppConfig;
describe("isolated stable preview sites", () => {
  it("accepts provider-assigned sites without requiring a custom domain", () => {
    expect(parsePreviewSites(JSON.stringify([site]), config)).toEqual([site]);
  });
  it.each([
    { origin: "https://preview.example.com" },
    { origin: "http://one.cloudfront.net" },
    { origin: "https://one.cloudfront.net/path" },
    { origin: "https://legacy.cloudfront.net" },
    { surfaceToken: "short" },
    { id: "../app" },
  ])("rejects unsafe operator configuration without leaking secrets: %j", (change) => {
    expect(() => parsePreviewSites(JSON.stringify([{ ...site, ...change }]), config)).toThrow(
      "FACILITY_PREVIEW_SITES",
    );
  });
  it("rejects shared sites, credentials, and workspace-service bindings", () => {
    for (const change of [
      { origin: site.origin },
      { surfaceToken: site.surfaceToken },
      { workspaceId: site.workspaceId },
    ]) {
      const other = {
        ...site,
        id: "other",
        origin: "https://two.cloudfront.net",
        surfaceToken: "b".repeat(43),
        workspaceId: "ws_b",
        ...change,
      };
      expect(() => parsePreviewSites(JSON.stringify([site, other]), config)).toThrow();
    }
  });
  it("requires the exact proxy credential and cannot expose control-plane routes", () => {
    expect(() =>
      assertPreviewOriginSurface(
        config,
        "api.example.com",
        "/workspace-preview-site/app/clients",
        site.surfaceToken,
      ),
    ).not.toThrow();
    for (const token of [undefined, "invalid", config.previewSurfaceToken]) {
      expect(() =>
        assertPreviewOriginSurface(
          config,
          "api.example.com",
          "/workspace-preview-site/app/",
          token,
        ),
      ).toThrow();
    }
    for (const path of [
      "/v1/projects",
      "/workspace-preview-auth/test",
      "/workspace-preview-site/other/",
    ]) {
      expect(() =>
        assertPreviewOriginSurface(config, "api.example.com", path, site.surfaceToken),
      ).toThrow();
    }
    expect(() =>
      assertPreviewOriginSurface(config, "one.cloudfront.net", "/v1/projects"),
    ).toThrow();
  });
  it.each([
    "orgId",
    "projectId",
    "workspaceId",
    "service",
  ] as const)("binds sessions to %s", (key) => {
    expect(() => assertSiteSession(site, { ...site, [key]: "other" })).toThrow();
  });
  it("forwards app cookies and trusted external origin without leaking Facility credentials", () => {
    const result = siteRequestHeaders(
      {
        cookie: `${SITE_COOKIE}=secret; app=session; facility_session=control`,
        "x-forwarded-host": "attacker.test",
        "x-facility-preview-surface": "secret",
        connection: "x-private",
        "x-private": "hidden",
        "next-action": "action",
        origin: site.origin,
      },
      site,
      "gateway",
    );
    expect(result.cookie?.trim()).toBe("app=session");
    expect(result["x-forwarded-host"]).toBe("one.cloudfront.net");
    expect(result["x-forwarded-proto"]).toBe("https");
    expect(result["next-action"]).toBe("action");
    expect(result).not.toHaveProperty("x-facility-preview-surface");
    expect(result).not.toHaveProperty("x-private");
  });
  it("keeps application cookies host-only and prevents preview-grant replacement", () => {
    expect(
      siteResponseCookies([
        "app=token; Domain=localhost; Path=/; HttpOnly; Secure; SameSite=Lax",
        `${SITE_COOKIE}=forged; Path=/; Secure`,
        "facility_session=forged",
      ]),
    ).toEqual(["app=token; Path=/; HttpOnly; Secure; SameSite=Lax"]);
  });
});
