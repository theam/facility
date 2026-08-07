import type { Octokit } from "./client.js";

const SOURCE_MAX_BYTES = 256 * 1024;
const SOURCE_PAGE_SIZE = 100;
const SOURCE_MAX_ITEMS = 1_000;

type SecuritySource = "code-scanning" | "dependabot" | "secret-scanning" | "sbom";

export type GithubSecuritySweepEvidence = {
  schema: "facility.security.sweep-input.v1";
  runId: string;
  collectedAt: string;
  repository: {
    owner: string;
    name: string;
    ref: string;
    headSha: string;
  };
  sources: {
    codeScanning: unknown;
    dependabot: unknown;
    secretScanning: unknown;
    sbom: unknown;
  };
};

export async function collectGithubSecuritySweepEvidence(input: {
  octokit: Octokit;
  runId: string;
  owner: string;
  repo: string;
  ref: string;
  now?: Date;
}): Promise<GithubSecuritySweepEvidence> {
  const { octokit, runId, owner, repo, ref } = input;
  const branch = await octokit.rest.repos.getBranch({ owner, repo, branch: ref });
  const headSha = branch.data.commit.sha;
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new Error("github_security_sweep_head_sha_invalid");
  }

  const request = octokit.request?.bind(octokit);
  const [codeScanning, dependabot, secretScanning, sbom] = await Promise.all([
    collectAlertSource("code-scanning", request, "GET /repos/{owner}/{repo}/code-scanning/alerts", {
      owner,
      repo,
      state: "open",
    }),
    collectAlertSource("dependabot", request, "GET /repos/{owner}/{repo}/dependabot/alerts", {
      owner,
      repo,
      state: "open",
    }),
    collectAlertSource(
      "secret-scanning",
      request,
      "GET /repos/{owner}/{repo}/secret-scanning/alerts",
      { owner, repo, state: "open" },
    ),
    collectSingleSource("sbom", request, "GET /repos/{owner}/{repo}/dependency-graph/sbom", {
      owner,
      repo,
    }),
  ]);

  return {
    schema: "facility.security.sweep-input.v1",
    runId,
    collectedAt: (input.now ?? new Date()).toISOString(),
    repository: { owner, name: repo, ref, headSha },
    sources: { codeScanning, dependabot, secretScanning, sbom },
  };
}

async function collectAlertSource(
  source: Exclude<SecuritySource, "sbom">,
  request: Octokit["request"],
  route: string,
  args: Record<string, unknown>,
) {
  if (!request) return unavailable(source, "endpoint_unavailable");
  try {
    const alerts: unknown[] = [];
    for (let page = 1; ; page += 1) {
      const response = await request(route, {
        ...args,
        per_page: SOURCE_PAGE_SIZE,
        page,
      });
      if (!Array.isArray(response.data)) return unavailable(source, "malformed_response");
      if (alerts.length >= SOURCE_MAX_ITEMS && response.data.length > 0) {
        return unavailable(source, "response_too_many_items");
      }
      alerts.push(...response.data);
      if (!withinSizeLimit(alerts)) return unavailable(source, "response_too_large");
      if (response.data.length < SOURCE_PAGE_SIZE) return alerts;
    }
  } catch (error) {
    return unavailable(source, "request_failed", statusCode(error));
  }
}

async function collectSingleSource(
  source: "sbom",
  request: Octokit["request"],
  route: string,
  args: Record<string, unknown>,
) {
  if (!request) return unavailable(source, "endpoint_unavailable");
  try {
    const data = (await request(route, args)).data;
    if (!plainObject(data) || !Object.hasOwn(data, "sbom")) {
      return unavailable(source, "malformed_response");
    }
    return withinSizeLimit(data) ? data : unavailable(source, "response_too_large");
  } catch (error) {
    return unavailable(source, "request_failed", statusCode(error));
  }
}

function withinSizeLimit(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value)) <= SOURCE_MAX_BYTES;
}

function unavailable(source: SecuritySource, reason: string, status?: number) {
  return {
    unavailable: true,
    source,
    reason,
    ...(status === undefined ? {} : { status }),
  };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function statusCode(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}
