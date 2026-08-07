import { describe, expect, it } from "vitest";
import type { Octokit } from "../src/github/client.js";
import { collectGithubSecuritySweepEvidence } from "../src/github/security-sweep.js";

const HEAD_SHA = "a".repeat(40);

type FakeRequest = (route: string, args?: Record<string, unknown>) => Promise<{ data: unknown }>;

function octokit(request?: FakeRequest): Octokit {
  return {
    request: request as Octokit["request"],
    rest: {
      repos: {
        getBranch: async () => ({ data: { commit: { sha: HEAD_SHA } } }),
      },
    },
  } as unknown as Octokit;
}

describe("GitHub security-sweep evidence", () => {
  it("binds bounded scanner evidence to the run and repository head", async () => {
    const evidence = await collectGithubSecuritySweepEvidence({
      octokit: octokit(async (route) => ({
        data: route.includes("dependency-graph") ? { sbom: { packages: [] } } : [],
      })),
      runId: "run_security",
      owner: "acme",
      repo: "widget",
      ref: "main",
      now: new Date("2026-08-07T10:00:00.000Z"),
    });

    expect(evidence).toEqual({
      schema: "facility.security.sweep-input.v1",
      runId: "run_security",
      collectedAt: "2026-08-07T10:00:00.000Z",
      repository: { owner: "acme", name: "widget", ref: "main", headSha: HEAD_SHA },
      sources: {
        codeScanning: [],
        dependabot: [],
        secretScanning: [],
        sbom: { sbom: { packages: [] } },
      },
    });
  });

  it("records unavailable endpoints without treating them as clean", async () => {
    const evidence = await collectGithubSecuritySweepEvidence({
      octokit: octokit(),
      runId: "run_security",
      owner: "acme",
      repo: "widget",
      ref: "main",
    });

    expect(evidence.sources).toEqual({
      codeScanning: {
        unavailable: true,
        source: "code-scanning",
        reason: "endpoint_unavailable",
      },
      dependabot: { unavailable: true, source: "dependabot", reason: "endpoint_unavailable" },
      secretScanning: {
        unavailable: true,
        source: "secret-scanning",
        reason: "endpoint_unavailable",
      },
      sbom: { unavailable: true, source: "sbom", reason: "endpoint_unavailable" },
    });
  });

  it("turns malformed and denied scanner responses into explicit unavailable evidence", async () => {
    const evidence = await collectGithubSecuritySweepEvidence({
      octokit: octokit(async (route) => {
        if (route.includes("dependabot")) throw Object.assign(new Error("denied"), { status: 403 });
        return { data: route.includes("dependency-graph") ? [] : { unexpected: true } };
      }),
      runId: "run_security",
      owner: "acme",
      repo: "widget",
      ref: "main",
    });

    expect(evidence.sources.codeScanning).toMatchObject({
      unavailable: true,
      reason: "malformed_response",
    });
    expect(evidence.sources.dependabot).toEqual({
      unavailable: true,
      source: "dependabot",
      reason: "request_failed",
      status: 403,
    });
    expect(evidence.sources.sbom).toMatchObject({
      unavailable: true,
      reason: "malformed_response",
    });
  });

  it("collects every alert page instead of presenting the first page as complete", async () => {
    const requestedPages: number[] = [];
    const evidence = await collectGithubSecuritySweepEvidence({
      octokit: octokit(async (route, args) => {
        if (route.includes("dependency-graph")) return { data: { sbom: { packages: [] } } };
        if (!route.includes("code-scanning")) return { data: [] };
        requestedPages.push(Number(args?.page));
        return {
          data:
            args?.page === 1
              ? Array.from({ length: 100 }, (_, number) => ({ number }))
              : [{ number: 100 }],
        };
      }),
      runId: "run_security",
      owner: "acme",
      repo: "widget",
      ref: "main",
    });

    expect(requestedPages).toEqual([1, 2]);
    expect(evidence.sources.codeScanning).toHaveLength(101);
  });

  it("marks a source unavailable instead of silently truncating above 1,000 alerts", async () => {
    const requestedPages: number[] = [];
    const evidence = await collectGithubSecuritySweepEvidence({
      octokit: octokit(async (route, args) => {
        if (route.includes("dependency-graph")) return { data: { sbom: { packages: [] } } };
        if (!route.includes("code-scanning")) return { data: [] };
        requestedPages.push(Number(args?.page));
        return {
          data: Array.from({ length: 100 }, (_, offset) => ({
            number: (Number(args?.page) - 1) * 100 + offset,
          })),
        };
      }),
      runId: "run_security",
      owner: "acme",
      repo: "widget",
      ref: "main",
    });

    expect(requestedPages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(evidence.sources.codeScanning).toEqual({
      unavailable: true,
      source: "code-scanning",
      reason: "response_too_many_items",
    });
  });
});
