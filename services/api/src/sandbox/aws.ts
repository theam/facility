import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  type GetLogEventsCommandOutput,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  BatchGetBuildsCommand,
  type BatchGetBuildsCommandOutput,
  CodeBuildClient,
  StartBuildCommand,
  type StartBuildCommandOutput,
  StopBuildCommand,
  type StopBuildCommandOutput,
} from "@aws-sdk/client-codebuild";
import type { LaunchSpec, SandboxDriver } from "./driver.js";

type CodeBuildCommand = StartBuildCommand | BatchGetBuildsCommand | StopBuildCommand;
type CodeBuildCommandOutput =
  | StartBuildCommandOutput
  | BatchGetBuildsCommandOutput
  | StopBuildCommandOutput;

type CodeBuildSender = {
  send(command: CodeBuildCommand): Promise<CodeBuildCommandOutput>;
};

type LogsSender = {
  send(command: GetLogEventsCommand): Promise<GetLogEventsCommandOutput>;
};

type AwsSandboxConfig = {
  region: string;
  project: string;
};

type AwsSandboxLaunchConfig = AwsSandboxConfig & {
  cacheBaseLocation: string;
};

const CACHE_PATHS = ["/work/.local/share/pnpm/store/**/*", "/work/.npm/_cacache/**/*"] as const;

const STARTING_PHASES = new Set([
  "SUBMITTED",
  "QUEUED",
  "PROVISIONING",
  "DOWNLOAD_SOURCE",
  "INSTALL",
]);
const EXITED_STATUSES = new Set(["SUCCEEDED", "FAILED", "FAULT", "STOPPED", "TIMED_OUT"]);

export class AwsSandboxDriver implements SandboxDriver {
  readonly name = "aws" as const;
  private readonly codebuild: CodeBuildSender;
  private readonly cloudwatchLogs: LogsSender;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    codebuild: CodeBuildSender = new CodeBuildClient({ region: process.env.AWS_REGION }),
    cloudwatchLogs: LogsSender = new CloudWatchLogsClient({ region: process.env.AWS_REGION }),
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.codebuild = codebuild;
    this.cloudwatchLogs = cloudwatchLogs;
    this.env = env;
  }

  async launch(spec: LaunchSpec): Promise<{ ref: string; endpoint?: string }> {
    const config = this.launchConfig();
    const cachePartition = codeBuildCachePartition(spec.cachePartition);
    const output = (await this.codebuild.send(
      new StartBuildCommand({
        projectName: config.project,
        idempotencyToken: spec.runId,
        computeTypeOverride: codeBuildComputeType(spec.cpu, spec.memoryMb),
        // CodeBuild requires a finite lease. Give agent runs the provider's
        // maximum and rely on periodic Facility checkpoints for continuation
        // across lease renewal; previews retain their explicit product TTL.
        timeoutInMinutesOverride:
          spec.kind === "preview" ? clamp(Math.round(spec.timeoutMin), 5, 2160) : 2160,
        environmentVariablesOverride: Object.entries(spec.env)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, value]) => ({ name, value, type: "PLAINTEXT" })),
        // The project default is deliberately NO_CACHE. Every run must receive
        // its own unguessable S3 prefix or it starts without a cache rather than
        // falling back to a cache shared by every Facility tenant.
        cacheOverride: {
          type: "S3",
          location: `${config.cacheBaseLocation}/${cachePartition}`,
        },
        ...(spec.cmd ? { buildspecOverride: codeBuildBuildspec(spec.cmd) } : {}),
      }),
    )) as StartBuildCommandOutput;
    const buildId = output.build?.id;
    if (!buildId) throw new Error("CodeBuild StartBuild did not return a build id");
    return { ref: buildId };
  }

  async status(ref: string): Promise<"starting" | "running" | "exited" | "lost"> {
    const build = await this.getBuild(ref);
    if (!build) return "lost";
    if (build.buildStatus === "IN_PROGRESS") {
      return !build.currentPhase || STARTING_PHASES.has(build.currentPhase)
        ? "starting"
        : "running";
    }
    if (build.buildStatus && EXITED_STATUSES.has(build.buildStatus)) return "exited";
    return "lost";
  }

  async *logs(ref: string, afterLine = 0): AsyncIterable<string> {
    this.config();
    const build = await this.getBuild(ref);
    const logGroupName = build?.logs?.groupName;
    const logStreamName = build?.logs?.streamName;
    if (!logGroupName || !logStreamName) return;

    let nextToken: string | undefined;
    let lineNo = 0;
    do {
      let output: GetLogEventsCommandOutput;
      try {
        output = await this.cloudwatchLogs.send(
          new GetLogEventsCommand({
            logGroupName,
            logStreamName,
            nextToken,
            startFromHead: true,
          }),
        );
      } catch (error) {
        if (isResourceNotFound(error)) return;
        throw error;
      }
      for (const event of output.events ?? []) {
        const message = event.message;
        if (!message) continue;
        for (const line of message.split(/\r?\n/)) {
          if (!line) continue;
          lineNo += 1;
          if (lineNo > afterLine) yield line;
        }
      }
      if (!output.nextForwardToken || output.nextForwardToken === nextToken) return;
      nextToken = output.nextForwardToken;
    } while (nextToken);
  }

  async stop(ref: string, _opts: { kill?: boolean } = {}): Promise<void> {
    this.config();
    await this.codebuild.send(new StopBuildCommand({ id: ref }));
  }

  async destroy(ref: string): Promise<void> {
    await this.stop(ref, { kill: true });
  }

  private async getBuild(ref: string) {
    this.config();
    const output = (await this.codebuild.send(
      new BatchGetBuildsCommand({ ids: [ref] }),
    )) as BatchGetBuildsCommandOutput;
    return output.builds?.[0];
  }

  private config(): AwsSandboxConfig {
    const region = stringEnv(this.env.AWS_REGION);
    const project = stringEnv(this.env.FACILITY_AWS_CODEBUILD_PROJECT);
    const missing: string[] = [];
    if (!region) missing.push("AWS_REGION");
    if (!project) missing.push("FACILITY_AWS_CODEBUILD_PROJECT");
    if (missing.length > 0) this.notConfigured(missing.join(", "));
    if (!region || !project) this.notConfigured("AWS sandbox env");
    return { region, project };
  }

  private launchConfig(): AwsSandboxLaunchConfig {
    const config = this.config();
    const cacheBaseLocation = stringEnv(
      this.env.FACILITY_AWS_CODEBUILD_CACHE_BASE_LOCATION,
    )?.replace(/\/+$/, "");
    if (!cacheBaseLocation) this.notConfigured("FACILITY_AWS_CODEBUILD_CACHE_BASE_LOCATION");
    return { ...config, cacheBaseLocation };
  }

  private notConfigured(missing: string): never {
    const error = new Error(`AWS sandbox driver is not configured; missing ${missing}`);
    (error as Error & { code: string }).code = "not_configured";
    throw error;
  }
}

function stringEnv(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function codeBuildComputeType(cpu: number, memoryMb: number) {
  if (cpu > 8 || memoryMb > 15_360) return "BUILD_GENERAL1_XLARGE" as const;
  if (cpu > 4 || memoryMb > 7_168) return "BUILD_GENERAL1_LARGE" as const;
  if (cpu > 2 || memoryMb > 3_072) return "BUILD_GENERAL1_MEDIUM" as const;
  return "BUILD_GENERAL1_SMALL" as const;
}

function codeBuildBuildspec(cmd: string[]) {
  const command = ["/app/codebuild-runner.sh", ...cmd].map(shellQuote).join(" ");
  const paths = CACHE_PATHS.map((path) => `    - ${JSON.stringify(path)}`).join("\n");
  return `version: 0.2\nrun-as: root\nphases:\n  build:\n    commands:\n      - ${JSON.stringify(command)}\ncache:\n  paths:\n${paths}\n`;
}

function codeBuildCachePartition(value: string | undefined) {
  if (value && /^[a-f0-9]{64}$/.test(value)) return value;
  const error = new Error("AWS sandbox cache partition is missing or invalid");
  (error as Error & { code: string }).code = "not_configured";
  throw error;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isResourceNotFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { name?: string }).name === "ResourceNotFoundException" ||
      (error as { Code?: string }).Code === "ResourceNotFoundException")
  );
}
