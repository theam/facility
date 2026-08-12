import { generateKeyPairSync } from "node:crypto";
import {
  BatchGetProjectsCommand,
  type BatchGetProjectsCommandOutput,
} from "@aws-sdk/client-codebuild";
import { describe, expect, it } from "vitest";
import {
  checkAwsSandbox,
  checkGithubApp,
  checkGithubCheckRunSubscription,
  checkVercelSandbox,
  type DoctorCodeBuildSender,
  type DoctorVercelClient,
} from "../src/doctor.js";
import type { AppConfig } from "../src/types.js";

const baseConfig: AppConfig = {
  databaseUrl: "postgres://facility:facility@localhost:5432/facility",
  secretMasterKey: Buffer.alloc(32, 9).toString("base64"),
  port: 4400,
  publicUrl: "https://facility.example.com",
  sandboxApiUrl: "https://facility.example.com",
  sandboxGatewayUrl: "https://facility.example.com",
  gatewayUrl: "http://gateway:4410",
  sandboxRunnerImage: "facility-runner:latest",
  sandboxDriver: "aws",
  facilityInsecureDev: false,
  awsRegion: "us-east-1",
  awsCodeBuildProject: "facility-prod-runner",
  awsCodeBuildCacheBaseLocation: "facility-prod-objects/codebuild-cache",
  logLevel: "silent",
};

describe("AWS production doctor", () => {
  it("fails closed before AWS calls when project, region, or cache location is missing", async () => {
    const client = new FakeCodeBuildClient({ projects: [] });

    await expect(
      checkAwsSandbox({ ...baseConfig, awsCodeBuildProject: undefined }, client),
    ).resolves.toMatchObject({ id: "aws_sandbox", status: "fail", ok: false });
    await expect(
      checkAwsSandbox({ ...baseConfig, awsRegion: undefined }, client),
    ).resolves.toMatchObject({ id: "aws_sandbox", status: "fail", ok: false });
    await expect(
      checkAwsSandbox({ ...baseConfig, awsCodeBuildCacheBaseLocation: undefined }, client),
    ).resolves.toMatchObject({ id: "aws_sandbox", status: "fail", ok: false });
    expect(client.commands).toHaveLength(0);
  });

  it("proves the configured project and runner image with one read", async () => {
    const client = new FakeCodeBuildClient({
      projects: [
        {
          name: "facility-prod-runner",
          environment: {
            type: "LINUX_CONTAINER",
            computeType: "BUILD_GENERAL1_SMALL",
            image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/facility-runner:sha-abc",
          },
          source: { type: "NO_SOURCE" },
          artifacts: { type: "NO_ARTIFACTS" },
          cache: { type: "NO_CACHE" },
          serviceRole: "test-role",
        },
      ],
      projectsNotFound: [],
    });

    const check = await checkAwsSandbox(baseConfig, client);

    expect(check).toMatchObject({ id: "aws_sandbox", status: "pass", ok: true });
    expect(check.message).toContain("facility-prod-runner");
    expect(check.message).toContain("facility-runner:sha-abc");
    expect(check.message).toContain("no shared cache");
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(BatchGetProjectsCommand);
    expect(client.commands[0]?.input).toEqual({ names: ["facility-prod-runner"] });
  });

  it("fails for a missing project or runner image", async () => {
    const missing = await checkAwsSandbox(
      baseConfig,
      new FakeCodeBuildClient({ projects: [], projectsNotFound: ["facility-prod-runner"] }),
    );
    const imageMissing = await checkAwsSandbox(
      baseConfig,
      new FakeCodeBuildClient({
        projects: [
          {
            name: "facility-prod-runner",
            environment: {
              type: "LINUX_CONTAINER",
              computeType: "BUILD_GENERAL1_SMALL",
              image: "",
            },
            source: { type: "NO_SOURCE" },
            artifacts: { type: "NO_ARTIFACTS" },
            cache: { type: "NO_CACHE" },
            serviceRole: "test-role",
          },
        ],
      }),
    );

    expect(missing.status).toBe("fail");
    expect(imageMissing.status).toBe("fail");
  });

  it("rejects a project-level S3 cache that would be shared when an override is omitted", async () => {
    const check = await checkAwsSandbox(
      baseConfig,
      new FakeCodeBuildClient({
        projects: [
          {
            name: "facility-prod-runner",
            environment: {
              type: "LINUX_CONTAINER",
              computeType: "BUILD_GENERAL1_SMALL",
              image: "facility-runner:latest",
            },
            source: { type: "NO_SOURCE" },
            artifacts: { type: "NO_ARTIFACTS" },
            cache: {
              type: "S3",
              location: "facility-prod-objects/codebuild-cache",
            },
            serviceRole: "test-role",
          },
        ],
      }),
    );

    expect(check).toMatchObject({ id: "aws_sandbox", status: "fail", ok: false });
    expect(check.message).toContain("shared default cache");
  });

  it.each([
    "UnrecognizedClientException",
    "AccessDeniedException",
  ])("fails for permanent AWS configuration error %s without leaking details", async (name) => {
    const error = Object.assign(new Error("arn:aws:iam::123456789012:role/secret-role"), {
      name,
    });
    const check = await checkAwsSandbox(baseConfig, new FakeCodeBuildClient(error));

    expect(check.status).toBe("fail");
    expect(check.message).toContain(name);
    expect(JSON.stringify(check)).not.toContain("arn:");
    expect(JSON.stringify(check)).not.toContain("secret-role");
  });

  it("warns instead of making readiness flaky for transient AWS errors", async () => {
    const error = Object.assign(new Error("try later"), { name: "ThrottlingException" });

    await expect(
      checkAwsSandbox(baseConfig, new FakeCodeBuildClient(error)),
    ).resolves.toMatchObject({ id: "aws_sandbox", status: "warn", ok: true });
  });
});

describe("GitHub App production doctor", () => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 1024 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const configured = {
    ...baseConfig,
    githubAppId: "1",
    githubAppPrivateKey: privateKey,
    githubAppWebhookSecret: "webhook-secret",
    githubAppSlug: "facility",
  };

  it("accepts a parseable private key and rejects malformed key material without echoing it", () => {
    expect(checkGithubApp(configured).status).toBe("pass");

    const invalid = checkGithubApp({ ...configured, githubAppPrivateKey: "private-secret" });
    expect(invalid.status).toBe("fail");
    expect(JSON.stringify(invalid)).not.toContain("private-secret");
  });

  it("verifies both Checks permission and the Check run event subscription", async () => {
    await expect(
      checkGithubCheckRunSubscription(configured, async () => ({
        permissions: { checks: "read" },
        events: ["check_run", "pull_request"],
      })),
    ).resolves.toMatchObject({ id: "github_check_run", status: "pass", ok: true });

    await expect(
      checkGithubCheckRunSubscription(configured, async () => ({
        permissions: { checks: "read" },
        events: ["pull_request"],
      })),
    ).resolves.toMatchObject({ id: "github_check_run", status: "fail", ok: false });
    await expect(
      checkGithubCheckRunSubscription(configured, async () => ({
        permissions: { contents: "read" },
        events: ["check_run"],
      })),
    ).resolves.toMatchObject({ id: "github_check_run", status: "fail", ok: false });
  });

  it("fails on rejected or malformed App metadata and warns on transient errors", async () => {
    await expect(
      checkGithubCheckRunSubscription(configured, async () => ({ events: ["check_run"] })),
    ).resolves.toMatchObject({ status: "fail", ok: false });
    await expect(
      checkGithubCheckRunSubscription(configured, async () => {
        throw Object.assign(new Error("revoked private key"), { status: 401 });
      }),
    ).resolves.toMatchObject({ status: "fail", ok: false });
    await expect(
      checkGithubCheckRunSubscription(configured, async () => {
        throw new Error("provider unavailable");
      }),
    ).resolves.toMatchObject({ status: "warn", ok: true });
  });
});

describe("Vercel production doctor", () => {
  const config: AppConfig = {
    ...baseConfig,
    sandboxDriver: "vercel",
    vercelToken: "provider-secret",
    vercelTeamId: "team_facility",
    vercelProjectId: "prj_facility",
  };

  it("fails closed before provider calls when the project binding is incomplete", async () => {
    const client = new FakeVercelClient();
    await expect(
      checkVercelSandbox({ ...config, vercelToken: undefined }, client),
    ).resolves.toMatchObject({ id: "vercel_sandbox", status: "fail", ok: false });
    await expect(
      checkVercelSandbox({ ...config, vercelProjectId: undefined }, client),
    ).resolves.toMatchObject({ id: "vercel_sandbox", status: "fail", ok: false });
    expect(client.inputs).toHaveLength(0);
  });

  it("proves the exact team/project binding without leaking the token", async () => {
    const client = new FakeVercelClient();
    const check = await checkVercelSandbox(config, client);

    expect(check).toMatchObject({ id: "vercel_sandbox", status: "pass", ok: true });
    expect(check.message).toContain("team_facility");
    expect(check.message).toContain("prj_facility");
    expect(JSON.stringify(check)).not.toContain("provider-secret");
    expect(client.inputs).toEqual([
      {
        token: "provider-secret",
        teamId: "team_facility",
        projectId: "prj_facility",
        limit: 1,
      },
    ]);
  });

  it("fails for rejected bindings and warns only for transient errors", async () => {
    const denied = new FakeVercelClient(httpError(403));
    const transient = new FakeVercelClient(new Error("provider unavailable"));

    await expect(checkVercelSandbox(config, denied)).resolves.toMatchObject({
      status: "fail",
      ok: false,
    });
    await expect(checkVercelSandbox(config, transient)).resolves.toMatchObject({
      status: "warn",
      ok: true,
    });
  });
});

class FakeCodeBuildClient implements DoctorCodeBuildSender {
  readonly commands: BatchGetProjectsCommand[] = [];

  constructor(private readonly result: Omit<BatchGetProjectsCommandOutput, "$metadata"> | Error) {}

  async send(command: BatchGetProjectsCommand): Promise<BatchGetProjectsCommandOutput> {
    this.commands.push(command);
    if (this.result instanceof Error) throw this.result;
    return { ...this.result, $metadata: {} };
  }
}

class FakeVercelClient implements DoctorVercelClient {
  readonly inputs: Array<Parameters<DoctorVercelClient["list"]>[0]> = [];

  constructor(private readonly error?: Error) {}

  async list(input: Parameters<DoctorVercelClient["list"]>[0]) {
    this.inputs.push(input);
    if (this.error) throw this.error;
    return {};
  }
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}
