import { createPrivateKey } from "node:crypto";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BatchGetProjectsCommand,
  type BatchGetProjectsCommandOutput,
  CodeBuildClient,
} from "@aws-sdk/client-codebuild";
import { BUNDLED_ROLES } from "@facility/core";
import {
  actionTypes,
  roles,
  sandboxProfiles,
  schedulerWatermarks,
  verifyAuditChain,
} from "@facility/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyEnvelopeRoundTrip } from "./envelopes.js";
import { createGithubAppMetadataReader, type GithubAppMetadataReader } from "./github/client.js";
import { verifyStoredReceipts } from "./receipt-integrity.js";
import { DockerSandboxDriver } from "./sandbox/docker.js";
import type { AppConfig } from "./types.js";

type Db = FastifyInstance["facilityDb"];

export type DoctorCodeBuildSender = {
  send(command: BatchGetProjectsCommand): Promise<BatchGetProjectsCommandOutput>;
};

export type DoctorVercelClient = {
  list(input: {
    token: string;
    teamId: string;
    projectId: string;
    limit: number;
  }): Promise<unknown>;
};

export const DoctorCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["pass", "warn", "fail"]),
  ok: z.boolean(),
  message: z.string(),
  remediation: z.string().optional(),
});

export const DoctorResponseSchema = z.object({
  ok: z.boolean(),
  generatedAt: z.string(),
  checks: z.array(DoctorCheckSchema),
});

export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;
export type DoctorResponse = z.infer<typeof DoctorResponseSchema>;

const ESSENTIAL_ACTION_TYPES = [
  "budget_override",
  "guard_candidate",
  "issue_update",
  "kb_amendment",
  "kickstart_review",
  "learning_validation",
  "mcp_tool_call",
  "plan_acceptance",
  "rule_proposal",
  "skill_proposal",
  "task_creation",
];

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export async function runReadinessDoctor(input: {
  db: Db;
  config: AppConfig;
  orgId: string;
  now?: Date;
  codeBuildClient?: DoctorCodeBuildSender;
  vercelClient?: DoctorVercelClient;
  githubAppMetadataReader?: GithubAppMetadataReader;
}): Promise<DoctorResponse> {
  const now = input.now ?? new Date();
  const githubApp = checkGithubApp(input.config);
  const checks = await Promise.all([
    checkDatabase(input.db),
    checkObjectStorage(input.config, input.orgId, now),
    checkSeedEssentials(input.db, input.orgId),
    checkWorkerHeartbeat(input.db, now),
    checkSandboxRunner(input.db, input.config, input.orgId),
    ...(input.config.sandboxDriver === "aws"
      ? [checkAwsSandbox(input.config, input.codeBuildClient)]
      : []),
    ...(input.config.sandboxDriver === "vercel"
      ? [checkVercelSandbox(input.config, input.vercelClient)]
      : []),
    githubApp,
    checkGithubCheckRunSubscription(input.config, input.githubAppMetadataReader, githubApp),
    checkAuthConfig(input.config),
    checkPreviewProtection(input.config),
    checkAuditHashChain(input.db, input.orgId),
    checkReceiptIntegrity(input.db, input.orgId),
  ]);
  return {
    ok: checks.every((check) => check.status !== "fail"),
    generatedAt: now.toISOString(),
    checks,
  };
}

export async function checkVercelSandbox(
  config: AppConfig,
  providedClient?: DoctorVercelClient,
): Promise<DoctorCheck> {
  const token = config.vercelToken;
  const teamId = config.vercelTeamId;
  const projectId = config.vercelProjectId;
  const missing = [
    !token && "VERCEL_TOKEN or VERCEL_OIDC_TOKEN",
    !teamId && "VERCEL_TEAM_ID",
    !projectId && "VERCEL_PROJECT_ID",
  ].filter((value): value is string => Boolean(value));
  if (missing.length > 0 || !token || !teamId || !projectId) {
    return fail(
      "vercel_sandbox",
      "Vercel Sandbox reachability",
      `The Vercel sandbox provider is missing ${missing.join(", ")}; platform-lane runs cannot start.`,
      "Bind Facility to a Vercel team and project, then provide a scoped token or workload OIDC token.",
    );
  }

  const client = providedClient ?? {
    async list(input: { token: string; teamId: string; projectId: string; limit: number }) {
      const { Sandbox } = await import("@vercel/sandbox");
      return Sandbox.list(input);
    },
  };
  try {
    await client.list({ token, teamId, projectId, limit: 1 });
    return pass(
      "vercel_sandbox",
      "Vercel Sandbox reachability",
      `Vercel project "${projectId}" is reachable for team "${teamId}".`,
    );
  } catch (error) {
    const status = httpStatus(error);
    if (status === 401 || status === 403 || status === 404) {
      return fail(
        "vercel_sandbox",
        "Vercel Sandbox reachability",
        `The configured Vercel project binding was rejected (${status}).`,
        "Verify the team/project ids and rotate the scoped Vercel provider token.",
      );
    }
    return warn(
      "vercel_sandbox",
      "Vercel Sandbox reachability",
      "Vercel reachability could not be verified because of a transient provider error.",
      "Retry facility doctor; if the warning persists, inspect Vercel service health and egress.",
    );
  }
}

export async function checkAwsSandbox(
  config: AppConfig,
  providedClient?: DoctorCodeBuildSender,
): Promise<DoctorCheck> {
  const project = config.awsCodeBuildProject;
  const region = config.awsRegion;
  const cacheBaseLocation = config.awsCodeBuildCacheBaseLocation;
  if (!project) {
    return fail(
      "aws_sandbox",
      "AWS CodeBuild sandbox reachability",
      "The CodeBuild project is not configured; platform-lane runs cannot start.",
      "Set FACILITY_AWS_CODEBUILD_PROJECT to the runner project created for this deployment.",
    );
  }
  if (!region) {
    return fail(
      "aws_sandbox",
      "AWS CodeBuild sandbox reachability",
      "The AWS region is not configured; CodeBuild reachability cannot be verified.",
      "Set AWS_REGION to the region containing the Facility runner project.",
    );
  }
  if (!cacheBaseLocation) {
    return fail(
      "aws_sandbox",
      "AWS CodeBuild sandbox reachability",
      "The per-project CodeBuild cache location is not configured; cached runs cannot be tenant-isolated.",
      "Set FACILITY_AWS_CODEBUILD_CACHE_BASE_LOCATION to the cache prefix created for this deployment.",
    );
  }

  const client = providedClient ?? new CodeBuildClient({ region });
  try {
    const output = await client.send(new BatchGetProjectsCommand({ names: [project] }));
    const found = output.projects?.find((candidate) => candidate.name === project);
    if (!found || output.projectsNotFound?.includes(project)) {
      return fail(
        "aws_sandbox",
        "AWS CodeBuild sandbox reachability",
        `CodeBuild project "${project}" does not exist in ${region}.`,
        "Apply the AWS Terraform stack or correct FACILITY_AWS_CODEBUILD_PROJECT.",
      );
    }
    const image = found.environment?.image?.trim();
    if (!image) {
      return fail(
        "aws_sandbox",
        "AWS CodeBuild sandbox reachability",
        `CodeBuild project "${project}" has no runner image configured.`,
        "Rebuild and deploy the CodeBuild runner project with a runner image.",
      );
    }
    if (found.cache?.type !== "NO_CACHE") {
      return fail(
        "aws_sandbox",
        "AWS CodeBuild sandbox reachability",
        `CodeBuild project "${project}" has a shared default cache instead of the fail-closed NO_CACHE default.`,
        "Apply the current AWS Terraform module; Facility enables an isolated S3 prefix separately for every run.",
      );
    }
    return pass(
      "aws_sandbox",
      "AWS CodeBuild sandbox reachability",
      `CodeBuild project "${project}" is reachable in ${region}, runs "${image}", and defaults to no shared cache.`,
    );
  } catch (error) {
    const errorCode = awsErrorCode(error);
    if (isAwsConfigurationError(error)) {
      return fail(
        "aws_sandbox",
        "AWS CodeBuild sandbox reachability",
        `The AWS account, region, or task role cannot reach CodeBuild (${errorCode}).`,
        "Verify AWS_REGION and the ECS task role permission to inspect the configured CodeBuild project.",
      );
    }
    return warn(
      "aws_sandbox",
      "AWS CodeBuild sandbox reachability",
      `CodeBuild reachability could not be verified because of a transient AWS error (${errorCode}).`,
      "Retry facility doctor; if the warning persists, inspect AWS networking and CodeBuild service health.",
    );
  }
}

function awsErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "UnknownError";
  const candidate = error as { name?: unknown; Code?: unknown; code?: unknown };
  for (const value of [candidate.name, candidate.Code, candidate.code]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "UnknownError";
}

function isAwsConfigurationError(error: unknown) {
  const candidate = error as { name?: unknown; Code?: unknown; code?: unknown; message?: unknown };
  const text = [candidate?.name, candidate?.Code, candidate?.code, candidate?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /UnrecognizedClient|InvalidClientTokenId|AccessDenied|CredentialsProviderError|Could not load credentials|Region.*not|ConfigError/i.test(
    text,
  );
}

async function checkWorkerHeartbeat(db: Db, now: Date): Promise<DoctorCheck> {
  try {
    const heartbeat = (
      await db
        .select({ lastTick: schedulerWatermarks.lastTick })
        .from(schedulerWatermarks)
        .where(eq(schedulerWatermarks.name, "agent.schedules"))
        .limit(1)
    )[0];
    if (!heartbeat) {
      return fail(
        "worker_heartbeat",
        "Worker scheduler heartbeat",
        "The worker has not recorded a scheduler tick.",
        "Start the worker service, wait one minute, and rerun facility doctor.",
      );
    }
    const ageMs = now.getTime() - heartbeat.lastTick.getTime();
    if (ageMs < -5 * 60_000) {
      return fail(
        "worker_heartbeat",
        "Worker scheduler heartbeat",
        `The worker heartbeat is ${Math.ceil(Math.abs(ageMs) / 60_000)} minute(s) in the future.`,
        "Synchronize clocks on the API, worker, and database hosts.",
      );
    }
    if (ageMs > 3 * 60_000) {
      return fail(
        "worker_heartbeat",
        "Worker scheduler heartbeat",
        `The last worker scheduler tick is ${Math.floor(ageMs / 60_000)} minute(s) old.`,
        "Inspect worker logs and pg-boss connectivity; restart the worker after resolving the fault.",
      );
    }
    return pass(
      "worker_heartbeat",
      "Worker scheduler heartbeat",
      `The worker scheduler ticked at ${heartbeat.lastTick.toISOString()}.`,
    );
  } catch (error) {
    return fail(
      "worker_heartbeat",
      "Worker scheduler heartbeat",
      error instanceof Error ? error.message : "Worker heartbeat check failed.",
      "Verify migration 0020 is applied and the worker can write scheduler_watermarks.",
    );
  }
}

async function expectedMigrationNames(): Promise<string[]> {
  const candidates = [
    // Production `pnpm deploy` installs @facility/db in node_modules rather
    // than preserving the monorepo layout. Resolve its public entrypoint and
    // walk back from dist/ so doctor observes the same migration assets the
    // one-shot migrator actually used.
    join(dirname(require.resolve("@facility/db")), "..", "migrations"),
    join(here, "../../../packages/db/migrations"),
    join(here, "../../packages/db/migrations"),
  ];
  for (const dir of candidates) {
    try {
      return (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
    } catch {
      // Try the next source/dist relative path.
    }
  }
  throw new Error("Could not locate packages/db/migrations");
}

async function checkDatabase(db: Db): Promise<DoctorCheck> {
  try {
    await db.execute(sql`select 1`);
    const expected = await expectedMigrationNames();
    const appliedRows = (await db.execute(
      sql`select name from _facility_migrations order by name`,
    )) as Iterable<{ name: string }>;
    const applied = new Set(Array.from(appliedRows).map((row) => row.name));
    const missing = expected.filter((name) => !applied.has(name));
    if (missing.length > 0) {
      return fail(
        "database",
        "Database connectivity and migrations",
        `Database is reachable, but ${missing.length} migration(s) are missing.`,
        `Run \`pnpm --filter @facility/db migrate\`; first missing migration: ${missing[0]}.`,
      );
    }
    return pass(
      "database",
      "Database connectivity and migrations",
      `Database is reachable; ${expected.length} migration(s) applied.`,
    );
  } catch (error) {
    return fail(
      "database",
      "Database connectivity and migrations",
      error instanceof Error ? error.message : "Database readiness check failed.",
      "Verify DATABASE_URL and run `pnpm --filter @facility/db migrate`.",
    );
  }
}

async function checkObjectStorage(
  config: AppConfig,
  orgId: string,
  now: Date,
): Promise<DoctorCheck> {
  if (!config.s3Bucket) {
    return fail(
      "object_storage",
      "Object storage envelope round trip",
      "Object storage not configured: S3_BUCKET is empty.",
      "Set S3_BUCKET plus S3_ENDPOINT for S3-compatible stores, or AWS_REGION/AWS credentials for AWS S3.",
    );
  }
  const payload = { type: "facility-doctor", orgId, at: now.toISOString() };
  try {
    const roundTrip = await verifyEnvelopeRoundTrip({
      config,
      orgId,
      requestId: `doctor_${now.getTime()}`,
      payload,
      now,
    });
    if (JSON.stringify(roundTrip.loaded) !== JSON.stringify(payload)) {
      return fail(
        "object_storage",
        "Object storage envelope round trip",
        "Envelope store returned different content than it wrote.",
        "Check bucket routing, credentials, and any proxy in front of the S3-compatible endpoint.",
      );
    }
    return pass(
      "object_storage",
      "Object storage envelope round trip",
      `Wrote and read ${roundTrip.uri}.`,
    );
  } catch (error) {
    return fail(
      "object_storage",
      "Object storage envelope round trip",
      error instanceof Error ? error.message : "Object storage round trip failed.",
      "Verify S3_BUCKET, S3_ENDPOINT/AWS_REGION, and write/read permissions for the API and gateway tasks.",
    );
  }
}

async function checkSeedEssentials(db: Db, orgId: string): Promise<DoctorCheck> {
  try {
    const bundledRoleNames = BUNDLED_ROLES.filter((role) =>
      ["owner", "operator", "viewer"].includes(role.name),
    ).map((role) => role.name);
    const seededRoles = await db
      .select({ name: roles.name })
      .from(roles)
      .where(and(isNull(roles.orgId), inArray(roles.name, bundledRoleNames)));
    const seededActionTypes = await db
      .select({ name: actionTypes.name })
      .from(actionTypes)
      .where(and(eq(actionTypes.orgId, orgId), inArray(actionTypes.name, ESSENTIAL_ACTION_TYPES)));
    const seededSandboxProfiles = await db
      .select({ id: sandboxProfiles.id })
      .from(sandboxProfiles)
      .where(eq(sandboxProfiles.orgId, orgId))
      .limit(1);
    const missingRoles = bundledRoleNames.filter(
      (name) => !seededRoles.some((role) => role.name === name),
    );
    const missingActionTypes = ESSENTIAL_ACTION_TYPES.filter(
      (name) => !seededActionTypes.some((actionType) => actionType.name === name),
    );
    const missing = [
      ...missingRoles.map((name) => `role:${name}`),
      ...missingActionTypes.map((name) => `action:${name}`),
      ...(seededSandboxProfiles.length > 0 ? [] : ["sandbox:default"]),
    ];
    if (missing.length > 0) {
      return fail(
        "seed_essentials",
        "Bundled seed essentials",
        `Missing ${missing.length} seed essential(s): ${missing.join(", ")}.`,
        "Run `FACILITY_SEED_DEMO=0 pnpm --filter @facility/db seed` after migrations.",
      );
    }
    return pass(
      "seed_essentials",
      "Bundled seed essentials",
      "Owner/operator/viewer roles, action types, and a sandbox profile are present.",
    );
  } catch (error) {
    return fail(
      "seed_essentials",
      "Bundled seed essentials",
      error instanceof Error ? error.message : "Seed readiness check failed.",
      "Run database migrations, then seed the deployment.",
    );
  }
}

// A sandbox profile can run a platform-lane agent (Claude Code, Codex) only if
// its image ships the Facility runner as its entrypoint. A bare base image like
// node:22-bookworm silently only supports BYO-command runs — that is the
// false-ready trap this check closes.
async function checkSandboxRunner(db: Db, config: AppConfig, orgId: string): Promise<DoctorCheck> {
  try {
    const profiles = await db
      .select({ image: sandboxProfiles.image, driver: sandboxProfiles.driver })
      .from(sandboxProfiles)
      .where(eq(sandboxProfiles.orgId, orgId));
    if (profiles.length === 0) {
      // Absence of any profile is already reported by checkSeedEssentials.
      return fail(
        "sandbox_runner",
        "Sandbox runner profile",
        "No sandbox profiles exist, so platform-lane runs cannot start.",
        "Seed the deployment with FACILITY_SANDBOX_DRIVER + FACILITY_RUNNER_IMAGE set for your platform.",
      );
    }
    // A profile can run a platform-lane agent only if its driver matches the
    // deployment and its image ships the runner. Docker launches the profile
    // image directly; managed drivers boot the profile image inside their
    // project-scoped compute boundary.
    const runnerImage = config.sandboxRunnerImage;
    const driver = config.sandboxDriver;
    const canRunRunner = profiles.some(
      (profile) =>
        profile.driver === driver &&
        (profile.image === runnerImage || /runner/i.test(profile.image)),
    );
    if (!canRunRunner) {
      // Fail (not warn): platform-lane execution is the platform's primary
      // capability, so a deployment where no profile can run the runner is not
      // production-ready. `facility doctor` blocks the go/no-go on it.
      const expectation =
        driver === "aws"
          ? `driver "aws"`
          : `driver "${driver}" and the runner image (${runnerImage})`;
      return fail(
        "sandbox_runner",
        "Sandbox runner profile",
        `No sandbox profile matches this deployment (${expectation}); platform-lane runs (Claude Code, Codex) will not start.`,
        "Set FACILITY_SANDBOX_DRIVER and FACILITY_RUNNER_IMAGE to match this deployment, then re-seed.",
      );
    }
    // For the docker driver, config alone isn't enough — the worker must be able
    // to reach the Docker daemon to launch sandboxes. Probe it so a self-host
    // where the socket isn't mounted fails readiness instead of at first run.
    if (driver === "docker") {
      const dockerDriver = new DockerSandboxDriver();
      try {
        await dockerDriver.status("facility-doctor-probe");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/connect|socket|permission|ENOENT|EACCES|refused/i.test(message)) {
          return fail(
            "sandbox_runner",
            "Sandbox runner profile",
            `A docker sandbox profile is configured, but the Docker daemon is unreachable: ${message}`,
            "Give the worker access to the Docker socket (mount /var/run/docker.sock), or select a configured managed sandbox driver.",
          );
        }
        // A missing probe container is expected — it proves the daemon answered.
      }
      // The daemon answered — is the runner image actually there? A missing image
      // isn't fatal (the worker pulls on first launch), but a local-only tag or an
      // unreachable registry makes that pull fail, so surface it as a warning
      // rather than letting the first run be where it's discovered.
      try {
        if (!(await dockerDriver.imageExists(runnerImage))) {
          return warn(
            "sandbox_runner",
            "Sandbox runner image",
            `The runner image "${runnerImage}" is not present on the Docker daemon; the first platform-lane run will try to pull it.`,
            `Pre-build or pull it (e.g. \`docker build -f runner/Dockerfile -t ${runnerImage} .\`) — a local-only tag or an unreachable registry will fail that pull.`,
          );
        }
      } catch {
        // Image inspection failed for a non-not-found reason; the daemon probe
        // already passed, so don't block readiness on it.
      }
    }
    return pass(
      "sandbox_runner",
      "Sandbox runner profile",
      `A sandbox profile can run the Facility runner on the "${driver}" driver.`,
    );
  } catch (error) {
    return fail(
      "sandbox_runner",
      "Sandbox runner image",
      error instanceof Error ? error.message : "Sandbox runner readiness check failed.",
      "Run database migrations, then seed the deployment.",
    );
  }
}

export function checkGithubApp(config: AppConfig): DoctorCheck {
  const values = {
    GITHUB_APP_ID: config.githubAppId,
    GITHUB_APP_PRIVATE_KEY: config.githubAppPrivateKey,
    GITHUB_APP_WEBHOOK_SECRET: config.githubAppWebhookSecret,
    GITHUB_APP_SLUG: config.githubAppSlug,
  };
  const present = Object.entries(values).filter(([, value]) => Boolean(value));
  if (present.length === 0) {
    return warn(
      "github_app",
      "GitHub App configuration",
      "GitHub App is not enabled.",
      "Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET, and GITHUB_APP_SLUG before using repo automation.",
    );
  }
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    return fail(
      "github_app",
      "GitHub App configuration",
      `GitHub App is partially configured; missing ${missing.join(", ")}.`,
      "Complete the GitHub App environment variables or remove all of them to disable GitHub automation.",
    );
  }
  try {
    createPrivateKey(config.githubAppPrivateKey ?? "");
  } catch {
    return fail(
      "github_app",
      "GitHub App configuration",
      "The configured GitHub App private key is not a valid PEM private key.",
      "Replace GITHUB_APP_PRIVATE_KEY with the unmodified private key downloaded for this GitHub App.",
    );
  }
  return pass("github_app", "GitHub App configuration", "Required GitHub App values are set.");
}

export async function checkGithubCheckRunSubscription(
  config: AppConfig,
  providedReader?: GithubAppMetadataReader,
  appConfiguration = checkGithubApp(config),
): Promise<DoctorCheck> {
  if (appConfiguration.status !== "pass") {
    return warn(
      "github_check_run",
      "GitHub Check run subscription",
      "Check run delivery was not verified because the GitHub App is disabled or incomplete.",
      "Configure the GitHub App first, then rerun facility doctor.",
    );
  }
  try {
    const metadata = await (providedReader ?? createGithubAppMetadataReader(config))();
    const checksPermission = metadata.permissions?.checks?.toLowerCase();
    const hasChecksPermission = checksPermission === "read" || checksPermission === "write";
    const hasCheckRunEvent = metadata.events?.includes("check_run") === true;
    if (!metadata.permissions || !metadata.events) {
      return fail(
        "github_check_run",
        "GitHub Check run subscription",
        "GitHub returned incomplete App permissions or event metadata, so Check run delivery cannot be verified.",
        "Verify the GitHub App credentials and rerun facility doctor.",
      );
    }
    if (!hasChecksPermission || !hasCheckRunEvent) {
      const missing = [
        !hasChecksPermission ? "Checks: Read permission" : null,
        !hasCheckRunEvent ? "Check run event subscription" : null,
      ].filter((value): value is string => value !== null);
      return fail(
        "github_check_run",
        "GitHub Check run subscription",
        `GitHub App is missing ${missing.join(" and ")}; CI rollups will not update from check runs.`,
        "In the GitHub App settings, grant Repository permissions → Checks: Read-only, then subscribe to Check run under events.",
      );
    }
    return pass(
      "github_check_run",
      "GitHub Check run subscription",
      "GitHub App can read checks and is subscribed to Check run events.",
    );
  } catch (error) {
    const status = httpStatus(error);
    if (status === 401 || status === 403 || status === 404) {
      return fail(
        "github_check_run",
        "GitHub Check run subscription",
        `GitHub rejected App metadata verification (${status}).`,
        "Verify GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, then rerun facility doctor.",
      );
    }
    return warn(
      "github_check_run",
      "GitHub Check run subscription",
      "GitHub App permissions and event subscriptions could not be verified because of a transient provider error.",
      "Retry facility doctor; if the warning persists, inspect GitHub service health and deployment egress.",
    );
  }
}

function checkAuthConfig(config: AppConfig): DoctorCheck {
  const upstreamConfigured =
    config.authIdentityProvider === "oidc"
      ? Boolean(config.oidcIssuer && config.oidcClientId && config.facilityInstanceId)
      : Boolean(config.githubOauthClientId && config.githubOauthClientSecret);
  const mcpConfigured = Boolean(config.oauthIssuer && config.oauthJwks && config.mcpPublicUrl);
  if (!upstreamConfigured) {
    const level = config.facilityInsecureDev ? warn : fail;
    return level(
      "auth_config",
      "Authentication configuration",
      config.facilityInsecureDev
        ? "GitHub/OIDC login is not configured; only internal test helpers are available."
        : "GitHub/OIDC login is not configured — production authentication is unavailable.",
      "Configure the selected AUTH_IDENTITY_PROVIDER and its client credentials.",
    );
  }
  if (!mcpConfigured) {
    return warn(
      "auth_config",
      "Authentication configuration",
      "Interactive login is configured but the per-instance MCP OAuth server is disabled.",
      "Set FACILITY_OAUTH_ISSUER, FACILITY_OAUTH_JWKS, and MCP_PUBLIC_URL.",
    );
  }
  return pass(
    "auth_config",
    "Authentication configuration",
    "GitHub/OIDC login and instance MCP OAuth are configured.",
  );
}

function checkPreviewProtection(config: AppConfig): DoctorCheck {
  const configured =
    config.authIdentityProvider === "oidc"
      ? Boolean(config.oidcIssuer && config.oidcClientId && config.facilityInstanceId)
      : Boolean(config.githubOauthClientId && config.githubOauthClientSecret);
  if (configured) {
    return pass(
      "preview_protection",
      "Protected preview sessions",
      "Preview creation and access are protected by Facility sessions.",
    );
  }
  const level = config.facilityInsecureDev ? warn : fail;
  return level(
    "preview_protection",
    "Protected preview sessions",
    config.facilityInsecureDev
      ? "Native previews require an internal test session in local development."
      : "Native preview creation fails closed because interactive login is incomplete.",
    "Configure GitHub or OIDC interactive authentication.",
  );
}

async function checkAuditHashChain(db: Db, orgId: string): Promise<DoctorCheck> {
  const result = await verifyAuditChain(db, orgId);
  if (!result.ok) {
    return fail(
      "audit_hash_chain",
      "Audit hash-chain verification",
      `Audit chain breaks at sequence ${result.firstBreakSeq}.`,
      "Stop writes, preserve the database, and investigate audit_events before resuming production traffic.",
    );
  }
  return pass("audit_hash_chain", "Audit hash-chain verification", "Audit chain verifies.");
}

async function checkReceiptIntegrity(db: Db, orgId: string): Promise<DoctorCheck> {
  const report = await verifyStoredReceipts(db, orgId);
  if (!report.ok) {
    return fail(
      "receipt_integrity",
      "Agent receipt integrity",
      `${report.invalidRunIds.length} invalid and ${report.unauditedRunIds.length} unaudited receipts found across ${report.checked} runs.`,
      "Stop outcome and learning jobs, preserve audit_events and runs, then investigate receipt mutation or an outdated runner.",
    );
  }
  return pass(
    "receipt_integrity",
    "Agent receipt integrity",
    `${report.checked} stored agent receipts verify against the audit chain.`,
  );
}

function httpStatus(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };
  return candidate.status ?? candidate.statusCode ?? candidate.response?.status;
}

function pass(id: string, label: string, message: string): DoctorCheck {
  return { id, label, status: "pass", ok: true, message };
}

function warn(id: string, label: string, message: string, remediation?: string): DoctorCheck {
  return { id, label, status: "warn", ok: true, message, remediation };
}

function fail(id: string, label: string, message: string, remediation?: string): DoctorCheck {
  return { id, label, status: "fail", ok: false, message, remediation };
}
